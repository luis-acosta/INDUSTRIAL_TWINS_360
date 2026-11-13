/**
 * Empaquetado del sitio publicado.
 *
 * Tres destinos, un solo plan de publicación detrás: carpeta web, ZIP sin
 * conexión y paquete SCORM. Comparten el sitio generado y se diferencian en
 * el envoltorio, que es exactamente como debe ser: si cada destino
 * reconstruyera el recorrido por su cuenta, tres recorridos distintos saldrían
 * del mismo proyecto.
 */
import { zipSync, type Zippable } from 'fflate';
import { sha256, canonicalJson } from '@it360/persistence/hash';
import type { Project } from '@it360/domain';
import { buildSite, type PackageFile, type SiteOptions, type SiteResult } from './site';

const encoder = new TextEncoder();

export interface PackageResult extends SiteResult {
  /** Contenido del archivo único, cuando el destino lo produce. */
  readonly archive: Uint8Array | null;
  /** Sumas de los archivos del paquete, para verificar la entrega. */
  readonly checksums: ReadonlyMap<string, string>;
}

/**
 * Calcula las sumas de verificación del paquete.
 *
 * Se entregan junto al paquete para que el cliente pueda comprobar que lo que
 * recibió es lo que se generó. Un recorrido que viaja por correo o por USB
 * pasa por varias manos, y sin sumas no hay forma de distinguir una copia
 * incompleta de un fallo del visor.
 */
async function checksumsOf(files: readonly PackageFile[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const file of files) {
    result.set(file.path, await sha256(file.bytes));
  }
  return result;
}

/** Formatea las sumas como archivo de texto, una por línea. */
export function formatChecksumFile(checksums: ReadonlyMap<string, string>): string {
  return (
    [...checksums]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, hash]) => `${hash}  ${path}`)
      .join('\n') + '\n'
  );
}

/* ------------------------------------------------------------------ *
 * Sitio web estático (S01-S03)
 * ------------------------------------------------------------------ */

export async function exportWebSite(
  project: Project,
  options: SiteOptions,
): Promise<PackageResult> {
  const site = buildSite(project, options);
  const checksums = await checksumsOf(site.files);

  const files: PackageFile[] = [
    ...site.files,
    {
      path: 'SUMAS.txt',
      bytes: encoder.encode(formatChecksumFile(checksums)),
    },
  ];

  return { ...site, files, archive: null, checksums };
}

/* ------------------------------------------------------------------ *
 * Paquete sin conexión (S05)
 * ------------------------------------------------------------------ */

export interface OfflineOptions extends SiteOptions {
  /** Nombre de la carpeta raíz dentro del ZIP. */
  readonly rootFolder?: string;
}

/**
 * ZIP autocontenido para memoria USB.
 *
 * Lleva las rutas bajo una carpeta raíz y no en la raíz del ZIP. Descomprimir
 * un ZIP que escupe cuarenta archivos en el escritorio es una molestia que el
 * cliente recuerda más que el recorrido.
 *
 * El archivo se marca como capaz de funcionar sin conexión en el manifiesto,
 * lo que el visor usa para no intentar consultas de telemetría: los datos que
 * vayan dentro son un histórico congelado, y presentarlos como lectura actual
 * sería mentir sobre el estado de la planta.
 */
export async function exportOfflinePackage(
  project: Project,
  options: OfflineOptions,
): Promise<PackageResult> {
  const site = buildSite(project, { ...options, offlineCapable: true });
  const checksums = await checksumsOf(site.files);
  const root = options.rootFolder ?? 'recorrido';

  const entries: Zippable = {};
  for (const file of site.files) {
    entries[`${root}/${file.path}`] = file.bytes;
  }
  entries[`${root}/SUMAS.txt`] = encoder.encode(formatChecksumFile(checksums));
  entries[`${root}/LEEME.txt`] = encoder.encode(readmeText(project, site));

  // Nivel 6: por encima, el tiempo de compresión crece mucho y el ahorro en
  // imágenes ya comprimidas es casi nulo.
  const archive = zipSync(entries, { level: 6 });

  return {
    ...site,
    files: [...site.files, { path: 'SUMAS.txt', bytes: encoder.encode(formatChecksumFile(checksums)) }],
    archive,
    checksums,
  };
}

function readmeText(project: Project, site: SiteResult): string {
  return [
    project.title,
    '='.repeat(project.title.length),
    '',
    `Recorrido virtual generado con INDUSTRIAL TWINS 360 el ${site.manifest.publishedAt.slice(0, 10)}.`,
    '',
    'Cómo abrirlo',
    '------------',
    'Abra el archivo index.html con un navegador reciente (Chrome, Edge o Firefox).',
    'No hace falta instalar nada ni tener conexión a Internet.',
    '',
    'Contenido',
    '---------',
    `Escenas: ${site.plan.counts.scenes}`,
    `Marcadores: ${site.plan.counts.hotspots}`,
    `Activos referenciados: ${site.plan.counts.assets}`,
    `Archivos de medios: ${site.plan.counts.media}`,
    '',
    'Sobre los datos de proceso',
    '--------------------------',
    'Este paquete no se conecta al historiador de la planta. Los valores de',
    'proceso que aparezcan corresponden al momento de la publicación y están',
    'marcados como tales: no son lecturas actuales y no deben usarse para tomar',
    'decisiones de operación.',
    '',
    'Verificación',
    '------------',
    'El archivo SUMAS.txt contiene la suma SHA-256 de cada archivo del paquete.',
    'Sirve para comprobar que la copia que recibió está completa.',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Paquete SCORM 1.2 (O10)
 * ------------------------------------------------------------------ */

export interface ScormOptions extends SiteOptions {
  /** Identificador del curso en el LMS. */
  readonly courseId: string;
  readonly courseTitle?: string;
  /** Puntuación mínima para aprobar, de 0 a 100. */
  readonly masteryScore?: number;
}

/**
 * Empaqueta el recorrido como curso SCORM 1.2.
 *
 * Se eligió 1.2 y no 2004 porque es lo que aceptan sin discusión los LMS
 * corporativos que siguen en servicio, que son el caso real del cliente. La
 * diferencia que importa aquí —informar de la puntuación de una evaluación—
 * existe en las dos versiones.
 *
 * El manifiesto IMS se escribe a mano y no con una plantilla cargada de
 * opciones: el formato es estable desde 2001 y una plantilla configurable
 * añadiría formas de generar un manifiesto que el LMS rechaza.
 */
export async function exportScormPackage(
  project: Project,
  options: ScormOptions,
): Promise<PackageResult> {
  const site = buildSite(project, { ...options, offlineCapable: true });
  const checksums = await checksumsOf(site.files);

  const title = options.courseTitle ?? project.title;
  const mastery = options.masteryScore ?? 80;

  const imsmanifest = scormManifest({
    courseId: options.courseId,
    title,
    masteryScore: mastery,
    files: site.files.map((file) => file.path),
  });

  const entries: Zippable = {};
  for (const file of site.files) entries[file.path] = file.bytes;
  entries['imsmanifest.xml'] = encoder.encode(imsmanifest);
  entries['SUMAS.txt'] = encoder.encode(formatChecksumFile(checksums));

  const archive = zipSync(entries, { level: 6 });

  return {
    ...site,
    files: [
      ...site.files,
      { path: 'imsmanifest.xml', bytes: encoder.encode(imsmanifest) },
      { path: 'SUMAS.txt', bytes: encoder.encode(formatChecksumFile(checksums)) },
    ],
    archive,
    checksums,
  };
}

/** Escapa texto para XML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function scormManifest(input: {
  readonly courseId: string;
  readonly title: string;
  readonly masteryScore: number;
  readonly files: readonly string[];
}): string {
  const { courseId, title, masteryScore, files } = input;
  const resources = files
    .map((path) => `      <file href="${escapeXml(path)}" />`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(courseId)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org-1">
    <organization identifier="org-1">
      <title>${escapeXml(title)}</title>
      <item identifier="item-1" identifierref="res-1" isvisible="true">
        <title>${escapeXml(title)}</title>
        <adlcp:masteryscore>${masteryScore}</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
${resources}
    </resource>
  </resources>
</manifest>
`;
}

/* ------------------------------------------------------------------ *
 * Informe de publicación
 * ------------------------------------------------------------------ */

/**
 * Informe en texto de lo que se publicó y lo que no.
 *
 * Acompaña a cada paquete. El motivo es de trazabilidad: cuando el cliente
 * pregunta por qué falta una escena, la respuesta tiene que estar escrita en
 * algún sitio que no sea la memoria de quien publicó.
 */
export function publicationReport(result: PackageResult, project: Project): string {
  const counts = result.plan.counts;
  const lines = [
    `Informe de publicación — ${project.title}`,
    `Generado: ${result.manifest.publishedAt}`,
    `Versión de la aplicación: ${result.manifest.publishedByVersion}`,
    '',
    'Contenido publicado',
    '-------------------',
    `Escenas: ${counts.scenes} (excluidas: ${counts.scenesExcluded})`,
    `Marcadores: ${counts.hotspots} (no publicados: ${counts.hotspotsExcluded})`,
    `Acciones retiradas: ${counts.actionsNeutralized}`,
    `Medios: ${counts.media}`,
    `Activos referenciados: ${counts.assets}`,
    `Documentos: ${counts.documents}`,
    `Tamaño del paquete: ${(result.totalBytes / 1_000_000).toFixed(1)} MB`,
    '',
  ];

  if (result.warnings.length === 0) {
    lines.push('Sin advertencias.', '');
  } else {
    lines.push('Advertencias', '------------');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push(
    'Garantías de este paquete',
    '-------------------------',
    'No contiene tokens, referencias a secretos ni conexiones al historiador.',
    'No contiene usuarios, permisos ni registro de auditoría.',
    'La telemetría, si está configurada, se consulta a través del servicio',
    'declarado en el manifiesto y sólo en lectura.',
    '',
    `Huella del manifiesto: ${result.checksums.get('manifiesto.json') ?? 'no calculada'}`,
    '',
  );

  return lines.join('\n');
}

/** Huella estable del contenido del plan, para detectar republicaciones. */
export async function planFingerprint(result: SiteResult): Promise<string> {
  return sha256(
    encoder.encode(
      canonicalJson({
        scenes: result.plan.scenes.map((s) => s.id),
        media: result.plan.media.map((m) => m.sha256),
        entry: result.plan.entrySceneId,
      }),
    ),
  );
}
