/**
 * Qué se hace con cada imagen al publicar (V01, V02).
 *
 * Existe porque había una promesa sin cumplir: el editor dejaba elegir
 * formato, calidad, lado máximo y teselado, y la publicación copiaba los
 * archivos originales tal cual. Un recorrido de cuarenta panorámicas a 100 MP
 * salía como cuatro gigabytes aunque el autor hubiera pedido WebP al 80 % con
 * teselas, y nada se lo decía.
 *
 * Este módulo es la parte que se puede decidir sin tocar un píxel: qué
 * formato, qué tamaño, cuántas teselas y con qué nombre. La codificación en sí
 * es trabajo del contenedor —Rust, con la biblioteca de imágenes— porque una
 * panorámica de 100 MP en un lienzo del navegador es lenta y se queda sin
 * memoria antes de acabar.
 *
 * La decisión que más conviene tener escrita: **AVIF se pide y no se produce.**
 * Comprime bastante mejor que WebP, pero codificarlo cuesta minutos por imagen
 * y no está disponible en todas las plataformas donde corre la aplicación. En
 * lugar de aceptar la elección y entregar otra cosa en silencio, el plan dice
 * que se sustituye por WebP y por qué, para que la interfaz lo cuente.
 */

import {
  IMAGE_MIME_TYPES,
  MIME_EXTENSION,
  type Media,
  type MimeType,
  type PublishImageFormat,
  type PublishQuality,
} from './media';

/** Tesela de la pirámide: una porción de la imagen y su sitio en el paquete. */
export interface TilePlan {
  readonly level: number;
  readonly column: number;
  readonly row: number;
  /** Recorte en la imagen ya reescalada, en píxeles. */
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly relativePath: string;
}

export interface ImagePlan {
  readonly mediaId: string;
  /** Lo que se hace: recodificar, reescalar y recodificar, o copiar. */
  readonly action: 'copy' | 'encode';
  readonly format: PublishImageFormat;
  readonly mime: MimeType;
  readonly quality: number;
  /** Tamaño de salida; igual al de entrada si no se reescala. */
  readonly width: number | null;
  readonly height: number | null;
  readonly relativePath: string;
  readonly tiles: readonly TilePlan[];
  /** Copia en JPEG para navegadores sin WebP. */
  readonly fallback: { readonly relativePath: string; readonly quality: number } | null;
  /** Por qué no se hace exactamente lo pedido, si procede. */
  readonly note: string | null;
}

const FORMAT_MIME: Readonly<Record<PublishImageFormat, MimeType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Formatos que el contenedor sabe producir hoy. */
export const ENCODABLE_FORMATS: readonly PublishImageFormat[] = ['jpeg', 'png', 'webp'];

/** Lado mínimo por debajo del cual no se tesela: la pirámide no compensa. */
export const MIN_TILED_EDGE_PX = 2048;

/**
 * Tope de teselas por imagen.
 *
 * Una panorámica de 30.000 px con teselas de 64 daría ciento diez mil archivos
 * en el primer nivel. Eso no es una publicación lenta: es una publicación que
 * no termina, y el valor que lo provoca es un campo mal introducido. Al
 * pasarse del tope se publica sin teselar y se dice, que es un resultado
 * utilizable en lugar de un cuelgue.
 */
export const MAX_TILES_PER_IMAGE = 4096;

/**
 * Plan para una imagen.
 *
 * `copy` cuando no hay nada que mejorar: ni cambio de formato, ni reescalado,
 * ni teselas. Recodificar una imagen para dejarla igual sólo le quita calidad.
 */
export function planImage(media: Media, quality: PublishQuality): ImagePlan {
  const stem = stemOf(media.relativePath);

  if (media.kind !== 'image' || !(IMAGE_MIME_TYPES as readonly string[]).includes(media.mime)) {
    return copyPlan(media, 'no es una imagen');
  }

  /* AVIF: se pide y se entrega WebP, diciéndolo. Codificar AVIF cuesta minutos
     por imagen y no está disponible en todas las plataformas. */
  const requested = quality.format;
  const format = ENCODABLE_FORMATS.includes(requested) ? requested : 'webp';
  const formatNote =
    format === requested
      ? format === 'webp'
        ? 'WebP se publica sin pérdida: la imagen queda exacta y pesa más que su JPEG.'
        : null
      : `Se pidió ${requested.toUpperCase()} y se publica WebP sin pérdida: esta versión no codifica ${requested.toUpperCase()}.`;

  const mime = FORMAT_MIME[format];
  const scaled = scaledSize(media, quality.maxEdgePx);

  /* Sin dimensiones conocidas no se puede ni reescalar ni tesear con cabeza.
     Se recodifica sin más, que es lo único seguro. */
  const width = scaled?.width ?? null;
  const height = scaled?.height ?? null;

  const wanted =
    quality.tiled && scaled !== null && Math.max(scaled.width, scaled.height) >= MIN_TILED_EDGE_PX
      ? planTiles(stem, scaled, quality.tileSizePx, extensionOf(mime))
      : [];

  /* `planTiles` devuelve vacío cuando la pirámide se pasa del tope, así que
     para contarlo hay que preguntarlo aparte: es lo que se le dice al autor. */
  const count =
    quality.tiled && scaled !== null ? totalTileCount(scaled, quality.tileSizePx) : 0;
  const tooMany = quality.tiled && wanted.length === 0 && count > MAX_TILES_PER_IMAGE;
  const tiles = wanted;
  const tileNote = tooMany
    ? `Con teselas de ${quality.tileSizePx} px esta imagen daría ${count} archivos: se publica sin teselar. Use un tamaño de tesela mayor.`
    : null;

  const sameFormat = media.mime === mime;
  const sameSize = scaled === null || (scaled.width === media.width && scaled.height === media.height);

  if (sameFormat && sameSize && tiles.length === 0 && !quality.includeFallback) {
    return copyPlan(media, null);
  }

  return {
    mediaId: media.id,
    action: 'encode',
    format,
    mime,
    quality: format === 'png' ? 100 : quality.quality,
    width,
    height,
    relativePath: `${stem}${extensionOf(mime)}`,
    tiles,
    fallback:
      quality.includeFallback && format !== 'jpeg' && format !== 'png'
        ? { relativePath: `${stem}.jpg`, quality: Math.min(quality.quality, 85) }
        : null,
    note: [formatNote, tileNote].filter((entry) => entry !== null).join(' ') || null,
  };
}

/** Plan de todas las imágenes del proyecto, en el orden en que están. */
export function planImages(
  media: readonly Media[],
  quality: PublishQuality,
): ImagePlan[] {
  return media.map((entry) => planImage(entry, quality));
}

/**
 * Ahorro estimado en bytes, para poder decirlo antes de publicar.
 *
 * Es una estimación declarada como tal, con factores por formato medidos sobre
 * panorámicas industriales típicas. No se presenta como una cifra exacta: un
 * número falso con dos decimales se cree más que una estimación honesta.
 */
export function estimateBytes(media: Media, plan: ImagePlan): number {
  if (plan.action === 'copy') return media.byteSize;

  const pixelRatio =
    media.width !== null && media.height !== null && plan.width !== null && plan.height !== null
      ? (plan.width * plan.height) / Math.max(1, media.width * media.height)
      : 1;

  // Factores respecto al original, a igualdad de píxeles.
  /* Factores respecto al original a igualdad de píxeles. WebP va por encima
     de uno porque el codificador del contenedor es sin pérdida: una fotografía
     exacta pesa más que su JPEG. Poner aquí el 0,62 que se esperaría de un
     WebP con pérdida prometería un paquete más pequeño del que se entrega, y
     el autor descubriría la diferencia al subirlo. */
  const factor =
    plan.format === 'webp'
      ? 1.35
      : plan.format === 'jpeg'
        ? 0.9
        : 2.4;

  // La calidad sólo mueve el peso donde el codificador la atiende.
  const qualityFactor = plan.format === 'jpeg' ? plan.quality / 85 : 1;
  const base = media.byteSize * pixelRatio * factor * qualityFactor;
  // Las teselas añaden cabeceras y solapamiento de bordes.
  const tiled = plan.tiles.length > 0 ? base * 1.08 : base;
  const withFallback = plan.fallback !== null ? tiled + base * 0.9 : tiled;

  return Math.max(1, Math.round(withFallback));
}

/* ------------------------------------------------------------------ *
 * Interno
 * ------------------------------------------------------------------ */

function copyPlan(media: Media, reason: string | null): ImagePlan {
  return {
    mediaId: media.id,
    action: 'copy',
    format: formatOfMime(media.mime),
    mime: media.mime,
    quality: 100,
    width: media.width,
    height: media.height,
    relativePath: media.relativePath,
    tiles: [],
    fallback: null,
    note: reason,
  };
}

const formatOfMime = (mime: string): PublishImageFormat => {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/avif') return 'avif';
  return 'jpeg';
};

const extensionOf = (mime: MimeType): string => MIME_EXTENSION[mime] ?? '.bin';

function stemOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.');
  const slash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  return dot > slash ? relativePath.slice(0, dot) : relativePath;
}

/**
 * Tamaño de salida respetando el lado máximo.
 *
 * `null` si no se conocen las dimensiones. Se conserva la relación de aspecto:
 * una panorámica equirrectangular deformada no se puede proyectar.
 */
export function scaledSize(
  media: Media,
  maxEdgePx: number,
): { readonly width: number; readonly height: number } | null {
  if (media.width === null || media.height === null) return null;
  if (maxEdgePx <= 0) return { width: media.width, height: media.height };

  const longest = Math.max(media.width, media.height);
  if (longest <= maxEdgePx) return { width: media.width, height: media.height };

  const factor = maxEdgePx / longest;
  return {
    width: Math.max(1, Math.round(media.width * factor)),
    height: Math.max(1, Math.round(media.height * factor)),
  };
}

/** Cuántas teselas tendría la pirámide completa, sin construirla. */
export function totalTileCount(
  size: { readonly width: number; readonly height: number },
  tileSizePx: number,
): number {
  const tile = Math.max(64, tileSizePx);
  let total = 0;
  let width = size.width;
  let height = size.height;

  for (let level = 0; level <= 12; level += 1) {
    const columns = Math.ceil(width / tile);
    const rows = Math.ceil(height / tile);
    total += columns * rows;

    if (columns <= 1 && rows <= 1) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }

  return total;
}

/**
 * Pirámide de teselas, del nivel completo hacia abajo.
 *
 * El nivel 0 es la imagen completa y cada nivel siguiente la mitad, hasta que
 * cabe en una sola tesela. Es lo que permite que el visor cargue primero una
 * vista entera de poco peso y vaya pidiendo detalle sólo de lo que se mira.
 */
export function planTiles(
  stem: string,
  size: { readonly width: number; readonly height: number },
  tileSizePx: number,
  extension: string,
): TilePlan[] {
  const tiles: TilePlan[] = [];
  const tile = Math.max(64, tileSizePx);

  /* Se cuenta antes de generar. Contar es aritmética; generar son objetos, y
     con un tamaño de tesela mal introducido el primer nivel ya son cien mil:
     el array se come la memoria antes de que ningún tope posterior se mire. */
  if (totalTileCount(size, tile) > MAX_TILES_PER_IMAGE) return [];

  let level = 0;
  let width = size.width;
  let height = size.height;

  while (true) {
    const columns = Math.ceil(width / tile);
    const rows = Math.ceil(height / tile);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const sourceX = column * tile;
        const sourceY = row * tile;
        tiles.push({
          level,
          column,
          row,
          sourceX,
          sourceY,
          sourceWidth: Math.min(tile, width - sourceX),
          sourceHeight: Math.min(tile, height - sourceY),
          relativePath: `${stem}/l${level}/${row}_${column}${extension}`,
        });
      }
    }

    if (columns <= 1 && rows <= 1) break;
    level += 1;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));

    // Tope de seguridad: una imagen enorme con teselas diminutas podría
    // producir cientos de niveles por un valor mal introducido.
    if (level > 12) break;
  }

  return tiles;
}
