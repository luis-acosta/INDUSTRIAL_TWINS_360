/**
 * Biblioteca de medios (etapa 01).
 *
 * Toda imagen, documento, modelo o archivo adjunto entra al proyecto como un
 * `Media` identificado por su SHA-256. Direccionar por contenido tiene dos
 * consecuencias prácticas: importar dos veces el mismo panorama no duplica
 * 40 MB en el paquete, y el manifiesto puede verificar al abrir que ningún
 * archivo se ha alterado desde que se guardó.
 */
import { z } from 'zod';
import { uuidSchema } from './identity';
import { panoramaCoverageSchema } from './coordinates';

/**
 * Tipos MIME admitidos, agrupados por uso.
 *
 * La lista es cerrada a propósito. Aceptar cualquier MIME significaría
 * aceptar archivos que el visor no sabe mostrar, y el usuario lo descubriría
 * en la publicación. V05 pide «formatos habituales», no «todos».
 */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/svg+xml',
] as const;

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

export const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'] as const;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/zip',
  'application/octet-stream',
] as const;

export const MODEL_MIME_TYPES = ['model/gltf-binary', 'model/gltf+json'] as const;

export const FONT_MIME_TYPES = ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'] as const;

export const ALL_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  ...VIDEO_MIME_TYPES,
  ...AUDIO_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
  ...MODEL_MIME_TYPES,
  ...FONT_MIME_TYPES,
] as const;

export const mimeTypeSchema = z.enum(ALL_MIME_TYPES);
export type MimeType = z.infer<typeof mimeTypeSchema>;

export const mediaKindSchema = z.enum(['image', 'video', 'audio', 'document', 'model', 'font']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** Clasifica un MIME en su grupo de uso. */
export function mediaKindOf(mime: string): MediaKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return 'image';
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(mime)) return 'video';
  if ((AUDIO_MIME_TYPES as readonly string[]).includes(mime)) return 'audio';
  if ((MODEL_MIME_TYPES as readonly string[]).includes(mime)) return 'model';
  if ((FONT_MIME_TYPES as readonly string[]).includes(mime)) return 'font';
  if ((DOCUMENT_MIME_TYPES as readonly string[]).includes(mime)) return 'document';
  return null;
}

/** Extensión canónica por MIME, para nombrar archivos en la exportación. */
export const MIME_EXTENSION: Readonly<Record<MimeType, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/apng': '.apng',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.weba',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
};

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Debe ser un SHA-256 en hexadecimal minúsculo');

/**
 * Límites de tamaño por tipo, en bytes.
 *
 * Existen para que un archivo equivocado se rechace al importar y no al
 * guardar, cuando el usuario ya ha hecho trabajo encima. Los valores son
 * generosos: una equirectangular 16K en PNG ronda los 300 MB.
 */
export const MEDIA_SIZE_LIMITS: Readonly<Record<MediaKind, number>> = {
  image: 512 * 1024 * 1024,
  video: 4 * 1024 * 1024 * 1024,
  audio: 512 * 1024 * 1024,
  document: 512 * 1024 * 1024,
  model: 2 * 1024 * 1024 * 1024,
  font: 16 * 1024 * 1024,
};

/** Metadatos propios de una imagen panorámica. */
export const panoramaMetadataSchema = z.object({
  coverage: panoramaCoverageSchema,
  /** `true` si la relación de aspecto es exactamente 2:1 (±2 %). */
  equirectangular: z.boolean(),
  /**
   * Rumbo registrado por la cámara al capturar, en radianes, si el EXIF lo
   * trae. Se conserva para la conexión automática (C07) y nunca se usa sin
   * revisión humana, porque el magnetómetro de una cámara dentro de una
   * planta con acero y motores es poco fiable.
   */
  capturedHeadingRad: z.number().finite().nullable().default(null),
  /** Altura de captura declarada por el usuario, en metros. */
  captureHeightM: z.number().positive().max(100).nullable().default(null),
  /** Coordenadas GPS del EXIF, cuando existen (C07). */
  gps: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      altitudeM: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
});

export type PanoramaMetadata = z.infer<typeof panoramaMetadataSchema>;

/** Nivel de una pirámide de teselas, para panorámicas grandes. */
export const tileLevelSchema = z.object({
  level: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tileSize: z.number().int().positive(),
  /** Patrón de ruta relativa con `{x}` y `{y}`. */
  pathPattern: z.string().min(1),
});

export type TileLevel = z.infer<typeof tileLevelSchema>;

export const mediaSchema = z.object({
  id: uuidSchema,
  /** SHA-256 del contenido: identidad real del archivo. */
  sha256: sha256Schema,
  mime: mimeTypeSchema,
  kind: mediaKindSchema,
  /** Ruta relativa dentro del paquete, siempre con `/`. */
  relativePath: z.string().min(1),
  /** Nombre original, conservado para mostrarlo al usuario. */
  originalName: z.string().min(1).max(255),
  byteSize: z.number().int().nonnegative(),
  /** Dimensiones en píxeles; nulas para audio y documentos. */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /** Duración en segundos para audio y vídeo. */
  durationS: z.number().positive().nullable().default(null),
  /** Ruta relativa de la miniatura generada al importar. */
  thumbnailPath: z.string().nullable().default(null),
  panorama: panoramaMetadataSchema.nullable().default(null),
  tiles: z.array(tileLevelSchema).default([]),
  /**
   * Medio en cuarentena: se importó, se detectó un problema y se conserva
   * sin usarlo. No se borra, porque puede ser el único original que tiene el
   * usuario; tampoco se publica, porque rompería el recorrido.
   */
  quarantined: z.boolean().default(false),
  quarantineReason: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
});

export type Media = z.infer<typeof mediaSchema>;

/** Relación de aspecto considerada equirectangular completa. */
export const EQUIRECTANGULAR_RATIO = 2;
export const EQUIRECTANGULAR_TOLERANCE = 0.02;

export function isEquirectangular(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height - EQUIRECTANGULAR_RATIO) <= EQUIRECTANGULAR_TOLERANCE;
}

/* ------------------------------------------------------------------ *
 * Calidad de publicación (V01, V02)
 * ------------------------------------------------------------------ */

export const publishImageFormatSchema = z.enum(['jpeg', 'png', 'webp', 'avif']);
export type PublishImageFormat = z.infer<typeof publishImageFormatSchema>;

export const publishQualitySchema = z.object({
  /**
   * Formato de salida.
   *
   * Por omisión JPEG y no WebP, aunque WebP comprima mejor en general: el
   * codificador WebP del contenedor es **sin pérdida**, así que una fotografía
   * sale más grande que su JPEG, no más pequeña. WebP aquí significa «exacto»,
   * no «ligero», y sirve para inspección; para publicar un recorrido grande, el
   * formato pequeño es JPEG.
   */
  format: publishImageFormatSchema.default('jpeg'),
  /** Calidad 1-100. Se ignora en PNG, que es sin pérdida. */
  quality: z.number().int().min(1).max(100).default(82),
  /** Lado mayor máximo en píxeles; 0 = sin reescalar. */
  maxEdgePx: z.number().int().min(0).max(32768).default(8192),
  /** Generar pirámide de teselas en lugar de una sola imagen. */
  tiled: z.boolean().default(true),
  tileSizePx: z.number().int().min(256).max(2048).default(512),
  /** Incluir un respaldo JPEG para navegadores sin AVIF/WebP. */
  includeFallback: z.boolean().default(true),
});

export type PublishQuality = z.infer<typeof publishQualitySchema>;

/**
 * Perfiles de publicación.
 *
 * Son los tres puntos de la curva que un usuario distingue sin medir: archivo
 * pequeño, equilibrio, y máxima fidelidad para inspección técnica.
 *
 * Los formatos son los que el contenedor produce de verdad, y eso cambió los
 * perfiles. Antes decían WebP con calidad 72 y AVIF con calidad 92; el
 * codificador WebP es sin pérdida —ignora la calidad y pesa más que un JPEG—
 * y AVIF no se produce. El perfil «compacto» habría publicado paquetes más
 * grandes que el original: exactamente lo contrario de lo que promete.
 *
 * Así que lo pequeño es JPEG, y lo exacto es WebP sin pérdida, que es lo que
 * de verdad sirve para mirar de cerca un rótulo o la aguja de un manómetro.
 * Los valores son editables (V01); los perfiles sólo evitan una mala decisión
 * por omisión.
 */
export const PUBLISH_PROFILES = {
  compact: {
    format: 'jpeg',
    quality: 72,
    maxEdgePx: 4096,
    tiled: true,
    tileSizePx: 512,
    includeFallback: false,
  },
  balanced: {
    format: 'jpeg',
    quality: 85,
    maxEdgePx: 8192,
    tiled: true,
    tileSizePx: 512,
    includeFallback: false,
  },
  fidelity: {
    format: 'webp',
    quality: 100,
    maxEdgePx: 0,
    tiled: true,
    tileSizePx: 1024,
    includeFallback: true,
  },
} as const satisfies Record<string, PublishQuality>;

export type PublishProfileName = keyof typeof PUBLISH_PROFILES;
