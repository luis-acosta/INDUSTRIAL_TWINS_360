/**
 * Lado del navegador del alta de imágenes: leer, medir y calcular la suma.
 *
 * La decisión de qué se acepta está en `@it360/domain/media-import`, que es
 * puro y se prueba sin navegador. Aquí sólo queda lo que necesita del entorno.
 */

import { importImage, newUuid, type ImageImport, type Media, type DomainError, type Result, domainError, err } from '@it360/domain';
import { sha256 } from '@it360/persistence/hash';

/**
 * Lee el archivo completo.
 *
 * `FileReader` y no `File.arrayBuffer()`, igual que en las demás importaciones
 * de la aplicación: es la única vía disponible en todas las webviews que se
 * soportan, y la que funciona en las pruebas.
 */
function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0));
    };
    reader.onerror = () => reject(new Error('lectura fallida'));
    reader.readAsArrayBuffer(file);
  });
}

/** Plazo para decodificar la imagen y medirla. */
const MEASURE_TIMEOUT_MS = 4_000;

/**
 * Dimensiones en píxeles, o `null` si el entorno no puede decodificar.
 *
 * No se trata como error: el plano se muestra igual con la relación de aspecto
 * natural de la etiqueta `<img>`, y las dimensiones sólo sirven para informar.
 */
async function measure(url: string): Promise<{ width: number; height: number } | null> {
  if (typeof Image === 'undefined') return null;

  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;

    const done = (value: { width: number; height: number } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };

    // Hay entornos donde `Image` existe y no carga nada: ni `onload` ni
    // `onerror` llegan nunca. Sin este plazo la importación se queda colgada
    // y el autor ve un botón deshabilitado para siempre, sin explicación.
    const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);

    image.onload = () =>
      done(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
      );
    image.onerror = () => done(null);
    image.src = url;
  });
}

/**
 * URL con la que mostrar unos bytes recién leídos.
 *
 * Se prefiere la URL de objeto: no duplica los bytes ni los pasa a base64,
 * que en un plano de 40 MB importa. Donde no existe —entornos de prueba y
 * webviews antiguas— se cae en una URL de datos, porque quedarse sin ninguna
 * dejaría el plano recién importado mostrando «falta la imagen».
 */
function displayUrl(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob);

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime === '' ? 'application/octet-stream' : mime};base64,${btoa(binary)}`;
}

export interface ImportedImage extends ImageImport {
  /** URL para mostrarla en el editor. Vacía cuando se reutilizó el medio. */
  readonly url: string;
}

/**
 * Da de alta una imagen del disco en el proyecto.
 *
 * Devuelve también la URL con la que mostrarla, porque el medio recién creado
 * todavía no está en el paquete: sus bytes viven en memoria hasta que se
 * guarda el proyecto.
 */
export async function importImageFile(
  file: File,
  existing: readonly Media[],
  options: { readonly folder?: string } = {},
): Promise<Result<ImportedImage, DomainError>> {
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch {
    return err(
      domainError('IO_FAILED', `No se pudo leer «${file.name}».`, {
        recovery: 'Compruebe que el archivo sigue en su sitio y vuelva a elegirlo.',
      }),
    );
  }

  const digest = await sha256(bytes);
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  // El texto sólo se necesita para revisar el SVG; decodificarlo para un PNG
  // de 40 MB sería gasto puro.
  const svgText = isSvg ? new TextDecoder().decode(bytes) : undefined;

  // Se valida antes de medir: decodificar una imagen grande cuesta, y un
  // archivo que no se va a aceptar no merece ese gasto. Además el rechazo
  // llega de inmediato, que es lo que el autor espera de un archivo erróneo.
  const result = importImage(
    {
      id: newUuid(),
      sha256: digest,
      declaredMime: file.type,
      originalName: file.name,
      byteSize: bytes.byteLength,
      width: null,
      height: null,
      ...(svgText !== undefined ? { svgText } : {}),
      createdAt: new Date().toISOString(),
      ...(options.folder !== undefined ? { folder: options.folder } : {}),
    },
    existing,
  );

  if (!result.ok) return result;

  if (result.value.reused) {
    // El proyecto ya tiene estos bytes y su URL: no hace falta otra.
    return { ok: true, value: { ...result.value, url: '' } };
  }

  const url = displayUrl(bytes, file.type);
  const size = await measure(url);

  return {
    ok: true,
    value: {
      ...result.value,
      media:
        size === null
          ? result.value.media
          : { ...result.value.media, width: size.width, height: size.height },
      url,
    },
  };
}
