/**
 * Generación del sitio publicado.
 *
 * El resultado es un conjunto de archivos: HTML de entrada, manifiesto,
 * medios y el tiempo de ejecución del visor. El paquete no construye el visor
 * —eso lo hace el empaquetador de `apps/viewer-web`—, sino que lo recibe como
 * entrada. La razón es que un paquete sin herramientas de compilación no puede
 * producir un bundle de JavaScript, y fingir que sí lo hace llevaría a generar
 * un sitio que no arranca.
 *
 * Decisiones que vale la pena justificar:
 *
 *  - El manifiesto es un archivo aparte y no va incrustado en el HTML. Así el
 *    visor puede recargarlo sin recargar la página, y un cliente puede
 *    inspeccionarlo con un editor de texto para comprobar qué se publicó.
 *  - Todas las rutas son relativas. Un sitio con rutas absolutas sólo
 *    funciona en la raíz del dominio, y la mitad de las publicaciones acaban
 *    en una subcarpeta de la intranet del cliente.
 *  - El HTML lleva una política de seguridad de contenido restrictiva. El
 *    recorrido publicado es contenido estático: no necesita evaluar código ni
 *    cargar recursos de terceros, y declararlo cierra la puerta a que un
 *    guion inyectado lo haga.
 */
import { collectFrameOrigins, frameSrcDirective } from './frame-origins';
import { toManifest, type Manifest, type Media, type Project, type Uuid } from '@it360/domain';
import { auditForSecrets, planPublication, type PlanOptions, type PublishPlan } from './plan';

/** Archivo del paquete: ruta relativa y contenido. */
export interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Tiempo de ejecución del visor, tal como lo produce su empaquetador.
 *
 * Las claves son rutas relativas (`viewer/app.js`, `viewer/app.css`). Se
 * recibe como dato para que el exportador sea comprobable sin ejecutar un
 * empaquetador: las pruebas pasan dos archivos de mentira y verifican que
 * acaban en el sitio correcto y referenciados desde el HTML.
 */
export type ViewerRuntime = ReadonlyMap<string, Uint8Array>;

export interface SiteOptions extends PlanOptions {
  readonly publishedAt: string;
  readonly appVersion: string;
  /** Endpoint del servicio de telemetría, si el recorrido la usa. */
  readonly telemetryEndpoint?: string;
  /**
   * Orígenes que el recorrido necesita enmarcar, de `collectFrameOrigins`.
   *
   * Si no se pasa ninguno, la política queda en `frame-src 'self'`: lo justo
   * para mostrar un PDF del paquete y nada más.
   */
  readonly frameOrigins?: readonly string[];
  readonly offlineCapable?: boolean;
  /** Título de la pestaña; por defecto, el del proyecto. */
  readonly title?: string;
  readonly runtime: ViewerRuntime;
  /** Contenido de los medios, por ruta relativa del proyecto. */
  readonly mediaFiles: ReadonlyMap<string, Uint8Array>;
  /**
   * Panorámicas reducidas por perfil de visor que ya se han escrito (N12).
   *
   * Las escribe quien prepara los medios, no el exportador: aquí sólo se
   * declaran en el manifiesto, y se filtran por las que de verdad vienen entre
   * los archivos. Una entrada que apuntara a un archivo ausente dejaría la
   * escena en negro dentro de las gafas.
   */
  readonly vrPanoramas?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface SiteResult {
  readonly files: readonly PackageFile[];
  readonly manifest: Manifest;
  readonly plan: PublishPlan;
  readonly warnings: readonly string[];
  readonly totalBytes: number;
}

const encoder = new TextEncoder();

/** Escapa texto para insertarlo en HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Política de seguridad del recorrido publicado.
 *
 * `connect-src` incluye el endpoint de telemetría sólo si el recorrido lo
 * usa, y `frame-src` sólo los orígenes que el autor declaró en sus Webframes:
 * una política que permite conectar o enmarcar cualquier sitio «por si acaso»
 * no es una política.
 *
 * `'self'` entra en `frame-src` porque es lo que permite mostrar un PDF del
 * propio paquete dentro del recorrido (E05). Eso no abre nada a terceros: lo
 * único enmarcable con `'self'` es lo que el autor puso en el paquete.
 */
function contentSecurityPolicy(
  telemetryEndpoint: string | undefined,
  frameOrigins: readonly string[] = [],
): string {
  const connect = ["'self'", telemetryEndpoint].filter((value) => value !== undefined).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    `frame-src ${frameSrcDirective(frameOrigins)}`,
    // `object-src` se queda en `none`: un PDF del paquete se muestra con un
    // `iframe`, que gobierna `frame-src`. Abrir `object-src` admitiría además
    // `<embed>` y los complementos del navegador, que no hacen falta para
    // nada aquí.
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function indexHtml(options: {
  readonly title: string;
  readonly description: string;
  readonly csp: string;
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
  readonly accentColor: string | null;
  readonly faviconPath: string | null;
  readonly language: string;
}): string {
  const {
    title,
    description,
    csp,
    scripts,
    styles,
    accentColor,
    faviconPath,
    language,
  } = options;

  return `<!doctype html>
<html lang="${escapeHtml(language)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="generator" content="INDUSTRIAL TWINS 360" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(title)}</title>
${
      faviconPath === null
        ? // Sin marca propia se declara un icono vacío en lugar de no declarar
          // ninguno. El navegador que no encuentra declaración pide
          // /favicon.ico por su cuenta, y en un paquete que no lo lleva eso
          // deja un 404 en el registro del servidor del cliente por cada
          // visita: un error inventado que alguien tendrá que investigar.
          '    <link rel="icon" href="data:," />\n'
        : `    <link rel="icon" href="${escapeHtml(faviconPath)}" />\n`
    }${accentColor === null ? '' : `    <style>:root { --it-color-accent-default: ${escapeHtml(accentColor)}; }</style>\n`}${styles.map((href) => `    <link rel="stylesheet" href="${escapeHtml(href)}" />`).join('\n')}
  </head>
  <body>
    <div id="recorrido"></div>
    <noscript>
      Este recorrido necesita JavaScript para dibujar las panorámicas en tres dimensiones.
      El contenido documental del proyecto está disponible en el archivo manifiesto.json.
    </noscript>
${scripts.map((src) => `    <script type="module" src="${escapeHtml(src)}"></script>`).join('\n')}
  </body>
</html>
`;
}

/**
 * Construye el sitio estático.
 *
 * No escribe en disco: devuelve los archivos. Quien llama decide si los
 * guarda en una carpeta, los mete en un ZIP o los sube a un servidor, y el
 * exportador se puede probar sin sistema de archivos.
 */
export function buildSite(project: Project, options: SiteOptions): SiteResult {
  const plan = planPublication(project, options);

  /*
   * Orígenes enmarcables.
   *
   * Se calculan aquí y no en cada sitio que publica, para que ninguna vía de
   * publicación pueda olvidarse y salir con `frame-src 'self'` cuando el
   * recorrido sí lleva Webframes: el autor lo descubriría abriendo el
   * recorrido publicado y encontrándose un marco en blanco.
   */
  const frameOrigins = options.frameOrigins ?? collectFrameOrigins(project).origins;
  const warnings: string[] = plan.warnings.map((w) => w.message);

  const branding = project.settings.branding;
  const mediaById = new Map(project.media.map((m) => [m.id, m]));

  const logoPath =
    branding.logoMediaId === null ? null : (mediaById.get(branding.logoMediaId)?.relativePath ?? null);
  const faviconPath =
    branding.faviconMediaId === null
      ? null
      : (mediaById.get(branding.faviconMediaId)?.relativePath ?? null);

  const manifest = toManifest(
    {
      ...project,
      // El manifiesto se construye sobre el proyecto ya filtrado por el plan:
      // si se construyera sobre el original, incluiría las escenas excluidas y
      // las propuestas sin revisar, y el filtrado no habría servido de nada.
      scenes: [...plan.scenes],
      media: [...plan.media],
      settings: { ...project.settings, entrySceneId: plan.entrySceneId as Uuid | null },
    },
    {
      publishedAt: options.publishedAt,
      appVersion: options.appVersion,
      offlineCapable: options.offlineCapable ?? false,
      ...(options.telemetryEndpoint !== undefined
        ? { telemetryEndpoint: options.telemetryEndpoint }
        : {}),
      logoPath,
      faviconPath,
      vrPanoramas: vrPanoramasPresent(options.vrPanoramas ?? {}, options.mediaFiles, plan.media),
    },
  );

  const publishedManifest: Manifest = { ...manifest, frameOrigins: [...frameOrigins] };

  /* --- Comprobación de secretos sobre el resultado, no sobre la intención --- */

  const leaked = auditForSecrets(manifest);
  if (leaked.length > 0) {
    // No se devuelve un paquete con credenciales dentro: se lanza. Un aviso
    // sería ignorable, y aquí el fallo consiste precisamente en publicar algo
    // que no debía salir del equipo.
    throw new Error(
      `El manifiesto contiene claves prohibidas y no se puede publicar: ${leaked.join(', ')}`,
    );
  }

  const files: PackageFile[] = [];

  const scripts: string[] = [];
  const styles: string[] = [];
  for (const [path, bytes] of options.runtime) {
    files.push({ path, bytes });
    if (path.endsWith('.js')) scripts.push(`./${path}`);
    else if (path.endsWith('.css')) styles.push(`./${path}`);
  }

  if (scripts.length === 0) {
    // Sin JavaScript el sitio es una página en blanco. Se avisa en lugar de
    // producir silenciosamente algo que no funciona.
    warnings.push(
      'El tiempo de ejecución del visor no incluye ningún archivo JavaScript: el sitio publicado no mostrará el recorrido.',
    );
  }

  /* --- Medios --- */

  for (const media of plan.media) {
    const bytes = options.mediaFiles.get(media.relativePath);
    if (bytes === undefined) {
      warnings.push(
        `Falta el contenido de «${media.originalName}» (${media.relativePath}); el recorrido publicado lo mostrará como ausente.`,
      );
      continue;
    }
    files.push({ path: media.relativePath, bytes });
  }

  /* --- Manifiesto e índice --- */

  files.push({
    path: 'manifiesto.json',
    bytes: encoder.encode(JSON.stringify(publishedManifest, null, 2)),
  });

  files.push({
    path: 'index.html',
    bytes: encoder.encode(
      indexHtml({
        // Una marca propia vacía no gana al título del proyecto. `??` dejaría
        // pasar la cadena vacía y la pestaña del navegador quedaría sin
        // nombre, que es lo que ocurría antes de esta comprobación.
        title:
          options.title ??
          (branding.title.trim().length > 0 ? branding.title : project.title),
        description: project.description.slice(0, 300),
        csp: contentSecurityPolicy(options.telemetryEndpoint, frameOrigins),
        scripts,
        styles,
        accentColor: branding.accentColor,
        faviconPath: faviconPath === null ? null : `./${faviconPath}`,
        language: project.settings.language,
      }),
    ),
  });

  return {
    files,
    manifest: publishedManifest,
    plan,
    warnings,
    totalBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
  };
}

/**
 * Recorta el mapa de panorámicas de VR a lo que el paquete lleva de verdad
 * (N12).
 *
 * Se filtra por dos cosas: que el archivo esté entre los medios que se
 * escriben, y que su panorama plano siga en el plan. Un medio excluido por el
 * plan —escena no publicable— no debe dejar su variante en el manifiesto, y un
 * archivo que no se escribió no debe anunciarse: el visor lo pediría y
 * recibiría un 404 dentro de la sesión inmersiva, donde no hay forma de
 * contarle el fallo al usuario.
 */
function vrPanoramasPresent(
  map: Readonly<Record<string, Readonly<Record<string, string>>>>,
  mediaFiles: ReadonlyMap<string, Uint8Array>,
  planned: readonly Media[],
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const plannedIds = new Set<string>(planned.map((entry) => entry.id));
  const kept: Record<string, Record<string, string>> = {};

  for (const [mediaId, byProfile] of Object.entries(map)) {
    if (!plannedIds.has(mediaId)) continue;
    for (const [profile, path] of Object.entries(byProfile)) {
      if (!mediaFiles.has(path)) continue;
      const forMedia = kept[mediaId] ?? {};
      forMedia[profile] = path;
      kept[mediaId] = forMedia;
    }
  }

  return kept;
}
