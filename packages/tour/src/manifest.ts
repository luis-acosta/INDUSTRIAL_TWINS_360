/**
 * Carga del manifiesto publicado.
 *
 * El visor publicado valida el manifiesto con el mismo esquema que lo generó.
 * Puede parecer redundante —lo escribió esta misma aplicación— pero no lo es:
 * el archivo viaja. Pasa por un servidor web del cliente, por un USB, por un
 * LMS que a veces reescribe archivos de texto, y por la mano de alguien que
 * quiso «editar un título rápido». Validar al cargar convierte un recorrido
 * con un campo roto en un mensaje de error concreto, en lugar de una pantalla
 * negra o un marcador que desaparece sin explicación.
 *
 * La otra razón es de versiones: un paquete publicado con una versión del
 * formato más nueva que el visor no se puede mostrar correctamente, y es mejor
 * decirlo que dibujar la mitad de las cosas.
 */
import {
  CURRENT_SCHEMA_VERSION,
  MINIMUM_SCHEMA_VERSION,
  domainError,
  err,
  manifestSchema,
  ok,
  type Manifest,
  type Result,
} from '@it360/domain';

export interface LoadedTour {
  readonly manifest: Manifest;
  /** Base para resolver rutas relativas de medios. */
  readonly baseUrl: string;
}

/** Ruta del manifiesto dentro del paquete publicado. */
export const MANIFEST_PATH = 'manifiesto.json';

/**
 * Descarga y valida el manifiesto.
 *
 * `baseUrl` se deduce de la propia ubicación del documento para que el
 * paquete funcione igual en la raíz de un dominio, en una subcarpeta de la
 * intranet o abierto con `file://` desde una memoria USB.
 */
export async function loadTour(
  fetchImpl: typeof fetch = fetch,
  location: { readonly href: string } = globalThis.location,
): Promise<Result<LoadedTour>> {
  const baseUrl = location.href.replace(/[^/]*$/, '');

  /* Manifiesto incrustado en la página (S04/S08).
     El exportador lo escribe dentro del HTML además de dejar el archivo
     suelto. Dos motivos: una petición menos en cada carga —la del manifiesto
     bloquea todo lo demás, porque hasta que no llega no se sabe ni qué imagen
     pedir—, y que un paquete abierto directamente desde el disco o desde un
     USB llegue más lejos, porque muchos navegadores bloquean la lectura de
     archivos vecinos pero no el contenido de la propia página.

     El archivo suelto se sigue escribiendo: es lo que leen las integraciones y
     lo que permite revisar un paquete sin abrirlo en un navegador. */
  const inline = readInlineManifest();
  if (inline !== null) {
    const parsed = manifestSchema.safeParse(inline);
    if (parsed.success) return ok({ manifest: parsed.data, baseUrl });
    /* Un manifiesto incrustado ilegible no se traga: se sigue por el archivo
       suelto, que puede estar bien, y así un paquete reescrito a mano sigue
       abriéndose. */
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${MANIFEST_PATH}`, { cache: 'no-cache' });
  } catch (cause) {
    return err(
      domainError('NETWORK_UNAVAILABLE', 'No se pudo leer el manifiesto del recorrido', {
        detail: { cause: String(cause) },
        recovery:
          'Si abrió el archivo directamente desde el disco, algunos navegadores bloquean la lectura de archivos vecinos. Use el visor desde un servidor web o el paquete sin conexión.',
      }),
    );
  }

  if (!response.ok) {
    return err(
      domainError('NOT_FOUND', `El manifiesto del recorrido respondió ${response.status}`, {
        recovery: 'Compruebe que manifiesto.json está junto a index.html en el servidor.',
      }),
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    return err(
      domainError('VALIDATION_FAILED', 'El manifiesto del recorrido no es un JSON válido', {
        detail: { cause: String(cause) },
        recovery: 'El archivo puede haberse modificado o truncado. Vuelva a publicar el recorrido.',
      }),
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return err(
      domainError('VALIDATION_FAILED', 'El manifiesto del recorrido no tiene el formato esperado', {
        ...(first !== undefined ? { path: first.path.join('.') } : {}),
        detail: {
          problemas: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        recovery: 'Vuelva a publicar el recorrido desde la aplicación de escritorio.',
      }),
    );
  }

  const manifest = parsed.data;

  if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return err(
      domainError('SCHEMA_TOO_NEW', 'El recorrido se publicó con una versión más reciente', {
        detail: { paquete: manifest.schemaVersion, visor: CURRENT_SCHEMA_VERSION },
        recovery:
          'Actualice el visor. Mostrar el recorrido con un visor antiguo omitiría contenido sin avisar.',
      }),
    );
  }

  if (manifest.schemaVersion < MINIMUM_SCHEMA_VERSION) {
    return err(
      domainError('MIGRATION_FAILED', 'El recorrido usa una versión del formato ya no admitida', {
        detail: { paquete: manifest.schemaVersion, minimo: MINIMUM_SCHEMA_VERSION },
        recovery: 'Abra el proyecto con la aplicación de escritorio y vuelva a publicarlo.',
      }),
    );
  }

  return ok({ manifest, baseUrl });
}

/**
 * URL de un medio dentro del paquete.
 *
 * Se resuelve contra la base del documento y se codifica cada segmento: los
 * nombres de archivo del cliente llevan espacios y acentos con normalidad, y
 * sin codificar el navegador pide una ruta que el servidor no reconoce.
 */
export function mediaUrl(baseUrl: string, relativePath: string): string {
  const safe = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl}${safe}`;
}

/** Índice de medios por identificador, para resolver una escena sin buscar. */
export function mediaUrlIndex(tour: LoadedTour): ReadonlyMap<string, string> {
  return new Map(
    tour.manifest.media.map((media) => [media.id, mediaUrl(tour.baseUrl, media.relativePath)]),
  );
}

/** Identificador del elemento que lleva el manifiesto incrustado. */
export const INLINE_MANIFEST_ID = 'it360-manifiesto';

/**
 * Lee el manifiesto incrustado en la página, si lo hay.
 *
 * Devuelve `null` cuando no está, cuando no es JSON válido o cuando no hay
 * documento —el visor también se usa desde pruebas y desde el editor, donde no
 * hay página publicada—. Cualquiera de esos casos sigue por el archivo suelto,
 * que es la vía que siempre ha funcionado.
 */
export function readInlineManifest(doc: Document | undefined = globalThis.document): unknown | null {
  try {
    const element = doc?.getElementById(INLINE_MANIFEST_ID);
    if (element === null || element === undefined) return null;
    const text = element.textContent;
    if (text === null || text.trim().length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
