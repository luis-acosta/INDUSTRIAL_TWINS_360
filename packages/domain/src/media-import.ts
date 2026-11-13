/**
 * Alta de una imagen en el proyecto (planos, iconos, imágenes de ficha).
 *
 * Esta parte es pura a propósito: la lectura del archivo y el cálculo de la
 * suma son del entorno, pero **qué se acepta** es una decisión del dominio y
 * se prueba sin navegador.
 *
 * Dos decisiones merecen explicación.
 *
 * La primera es la deduplicación por SHA-256. Un plano de planta se importa
 * varias veces durante la edición —el autor prueba, borra el plano, lo vuelve
 * a añadir— y cada importación añadiría otros pocos megabytes al paquete. Si
 * el contenido ya está, se reutiliza el medio existente y no se crea otro.
 *
 * La segunda es el SVG. Un SVG puede llevar `<script>`, manejadores `onload` y
 * referencias externas. Cargado en un `<img>` el navegador no ejecuta nada,
 * así que el visor y el editor están a salvo; pero el archivo viaja dentro del
 * paquete publicado, y a un paquete se le abre un archivo a mano. En lugar de
 * sanear el SVG —reescribir XML ajeno y afirmar que ya es inocuo es una
 * promesa que no se puede sostener— se rechaza el archivo y se dice por qué.
 * Exportar el plano a PNG es un paso que el autor hace una vez.
 */

import {
  IMAGE_MIME_TYPES,
  MEDIA_SIZE_LIMITS,
  mediaSchema,
  type Media,
  type MimeType,
} from './media';
import { domainError, err, ok, type DomainError, type Result } from './result';

/** Extensiones aceptadas, por si el navegador no declara el tipo. */
const EXTENSION_MIME: Readonly<Record<string, MimeType>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.svg': 'image/svg+xml',
};

/**
 * Tipo de imagen de un archivo, por su tipo declarado o por su extensión.
 *
 * El tipo declarado manda, pero no siempre llega: al arrastrar desde algunos
 * gestores de archivos `File.type` viene vacío, y rechazar por eso un PNG
 * correcto sería incomprensible para el autor.
 */
export function imageMimeOf(declaredMime: string, fileName: string): MimeType | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(declaredMime)) {
    return declaredMime as MimeType;
  }

  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_MIME[fileName.slice(dot).toLowerCase()] ?? null;
}

/**
 * Motivo por el que un SVG no se acepta, o `null` si no se ha encontrado
 * ninguno.
 *
 * La comprobación es deliberadamente conservadora: busca las construcciones
 * ejecutables y las referencias externas sobre el texto del archivo. Un SVG
 * limpio de un programa de CAD no las lleva.
 */
export function svgThreat(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes('<script')) return 'contiene código JavaScript (<script>)';
  if (/<foreignobject[\s>]/.test(lower)) return 'contiene HTML incrustado (<foreignObject>)';
  if (/\son[a-z]+\s*=/.test(lower)) return 'contiene manejadores de eventos (onload, onclick…)';
  if (lower.includes('javascript:')) return 'contiene enlaces «javascript:»';
  if (/<(iframe|embed|object)[\s>]/.test(lower)) return 'incrusta contenido externo';
  if (/(href|xlink:href|src)\s*=\s*["']?https?:/.test(lower)) {
    return 'carga recursos de internet, que no estarán disponibles sin conexión';
  }
  return null;
}

/** Nombre de archivo seguro dentro del paquete, a partir del original. */
export function safeMediaFileName(originalName: string, extension: string): string {
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const cleaned = stem
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  return `${cleaned === '' ? 'imagen' : cleaned}${extension}`;
}

/** Ruta relativa libre dentro del paquete, añadiendo sufijo si hace falta. */
export function freeRelativePath(
  taken: readonly string[],
  folder: string,
  fileName: string,
): string {
  const used = new Set(taken);
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';

  let candidate = `${folder}/${fileName}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${folder}/${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

export interface ImageImportInput {
  /** Identificador a usar si hay que crear el medio. */
  readonly id: string;
  readonly sha256: string;
  readonly declaredMime: string;
  readonly originalName: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Texto del archivo, sólo para SVG. */
  readonly svgText?: string;
  readonly createdAt: string;
  /** Carpeta del paquete donde colocarlo: `media`, `media/planos`… */
  readonly folder?: string;
}

export interface ImageImport {
  readonly media: Media;
  /** `true` cuando se ha reutilizado un medio que ya estaba en el proyecto. */
  readonly reused: boolean;
}

/**
 * Da de alta una imagen, o devuelve la que ya estaba con el mismo contenido.
 *
 * `existing` son los medios del proyecto: se consultan para deduplicar y para
 * no pisar rutas dentro del paquete.
 */
export function importImage(
  input: ImageImportInput,
  existing: readonly Media[],
): Result<ImageImport, DomainError> {
  const mime = imageMimeOf(input.declaredMime, input.originalName);
  if (mime === null) {
    return err(
      domainError('UNSUPPORTED_FORMAT', `«${input.originalName}» no es una imagen reconocida.`, {
        recovery: 'Use PNG, JPEG, WebP o AVIF. Los planos en PDF hay que exportarlos a imagen.',
      }),
    );
  }

  if (input.byteSize <= 0) {
    return err(
      domainError('VALIDATION_FAILED', `«${input.originalName}» está vacío.`, {
        recovery: 'Compruebe que el archivo se copió completo.',
      }),
    );
  }

  if (input.byteSize > MEDIA_SIZE_LIMITS.image) {
    const mb = Math.round(MEDIA_SIZE_LIMITS.image / (1024 * 1024));
    return err(
      domainError('FILE_TOO_LARGE', `«${input.originalName}» supera el límite de ${mb} MB.`, {
        recovery: 'Reduzca la resolución de la imagen antes de importarla.',
      }),
    );
  }

  if (mime === 'image/svg+xml') {
    if (input.svgText === undefined) {
      return err(
        domainError('VALIDATION_FAILED', 'No se pudo leer el contenido del SVG para revisarlo.', {
          recovery: 'Vuelva a intentarlo, o exporte el plano a PNG.',
        }),
      );
    }
    const threat = svgThreat(input.svgText);
    if (threat !== null) {
      return err(
        domainError('UNSUPPORTED_FORMAT', `El SVG no se acepta porque ${threat}.`, {
          recovery: 'Exporte el plano a PNG desde su herramienta de dibujo.',
        }),
      );
    }
  }

  const reusable = existing.find((m) => m.sha256 === input.sha256 && m.kind === 'image');
  if (reusable !== undefined) return ok({ media: reusable, reused: true });

  const extension = mime === 'image/jpeg' ? '.jpg' : `.${mime.split('/')[1]?.replace('+xml', '') ?? 'png'}`;
  const relativePath = freeRelativePath(
    existing.map((m) => m.relativePath),
    input.folder ?? 'media',
    safeMediaFileName(input.originalName, extension),
  );

  // Se derivan los valores por omisión del esquema en lugar de escribirlos
  // aquí: un campo nuevo en `mediaSchema` no debe exigir tocar este módulo.
  const parsed = mediaSchema.safeParse({
    id: input.id,
    sha256: input.sha256,
    mime,
    kind: 'image',
    relativePath,
    originalName: input.originalName.slice(0, 255),
    byteSize: input.byteSize,
    width: input.width,
    height: input.height,
    createdAt: input.createdAt,
  });

  if (!parsed.success) {
    return err(
      domainError('VALIDATION_FAILED', `«${input.originalName}» no se pudo registrar.`, {
        detail: { issues: parsed.error.issues.map((i) => i.message) },
      }),
    );
  }

  return ok({ media: parsed.data, reused: false });
}
