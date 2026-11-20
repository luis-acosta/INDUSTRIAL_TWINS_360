/**
 * Reconocimiento de formatos por su contenido (V05).
 *
 * El tipo que declara el sistema operativo no es de fiar: llega vacío para
 * extensiones que no conoce, lo rellena según la extensión —que cualquiera
 * puede cambiar— y en algunos navegadores varía entre versiones. Para un
 * programa que importa archivos de planta de orígenes variados —una cámara,
 * un pendrive, un correo— eso significa dos cosas:
 *
 * 1. Un archivo correcto puede rechazarse porque su extensión no es la
 *    habitual. Un `.jpeg` escrito `.jpe`, un WAV sin extensión.
 * 2. Un archivo que no es lo que dice puede aceptarse. Y el contrato de
 *    seguridad del proyecto es explícito: «validar todos los archivos y
 *    entradas».
 *
 * Así que el formato se decide mirando los primeros bytes, que es lo que de
 * verdad determina si un reproductor va a poder abrirlo. La extensión y el
 * tipo declarado se usan sólo para desempatar entre formatos que comparten
 * contenedor: MP4 y WebM alojan vídeo y audio, y los primeros bytes no dicen
 * cuál de los dos lleva dentro.
 */

/** Tipos reconocibles por contenido. */
export type SniffedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/avif'
  | 'image/svg+xml'
  | 'video/mp4'
  | 'video/webm'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/webm'
  | 'audio/mp4'
  | 'application/pdf';

export interface SniffResult {
  /** Tipo reconocido, o `null` si el contenido no corresponde a ninguno. */
  readonly mime: SniffedMime | null;
  /**
   * Contenedor ambiguo que necesita el tipo declarado para decidirse.
   *
   * MP4 y Matroska/WebM llevan vídeo o sólo audio, y la cabecera del
   * contenedor no lo distingue sin recorrer las pistas. Se expone para que
   * quien importa pueda preguntar al reproductor en lugar de suponer.
   */
  readonly ambiguousContainer: 'mp4' | 'matroska' | null;
}

/** Bytes mínimos que hay que leer para reconocer cualquiera de los formatos. */
export const SNIFF_BYTES = 64;

/**
 * Reconoce el formato por los primeros bytes.
 *
 * `declaredMime` y `fileName` sólo deciden entre audio y vídeo dentro de un
 * mismo contenedor; nunca convierten un contenido no reconocido en uno
 * reconocido, que es lo que haría inútil la comprobación.
 */
export function sniffMedia(
  bytes: Uint8Array,
  declaredMime = '',
  fileName = '',
): SniffResult {
  const none: SniffResult = { mime: null, ambiguousContainer: null };
  if (bytes.length < 4) return none;

  // --- Imágenes ---
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ambiguousContainer: null };
  }
  if (starts(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', ambiguousContainer: null };
  }

  // --- Contenedores RIFF: WebP y WAV ---
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') return { mime: 'image/webp', ambiguousContainer: null };
    if (form === 'WAVE') return { mime: 'audio/wav', ambiguousContainer: null };
    return none;
  }

  // --- Contenedores ISO-BMFF: AVIF y MP4 ---
  //
  // Los dos empiezan por un recuadro `ftyp` cuya marca dice qué hay dentro.
  // Mirar sólo `ftyp` confundiría una imagen AVIF con un vídeo MP4, y el
  // recorrido intentaría reproducir una foto.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') {
      return { mime: 'image/avif', ambiguousContainer: null };
    }
    // `M4A ` declara audio en la propia marca del contenedor: no hay
    // ambigüedad y no hace falta preguntar a nadie.
    if (brand === 'M4A ') return { mime: 'audio/mp4', ambiguousContainer: null };

    const mp4Brands = ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'qt  '];
    if (mp4Brands.includes(brand)) {
      // Estas marcas admiten vídeo y audio, y la cabecera no dice cuál hay.
      return { mime: 'video/mp4', ambiguousContainer: 'mp4' };
    }
    // Una marca desconocida en un contenedor conocido: no se adivina.
    return none;
  }

  // --- Matroska / WebM ---
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // El contenedor es el mismo para vídeo y audio; la cabecera no lo
    // distingue sin recorrer las pistas.
    const isAudio = declaredMime.startsWith('audio/') || /\.weba$/i.test(fileName);
    return {
      mime: isAudio ? 'audio/webm' : 'video/webm',
      ambiguousContainer: 'matroska',
    };
  }

  // --- Ogg ---
  if (ascii(bytes, 0, 4) === 'OggS') {
    return { mime: 'audio/ogg', ambiguousContainer: null };
  }

  // --- MP3 ---
  //
  // Dos formas legítimas: con etiqueta ID3 delante, o empezando directamente
  // por una trama. La segunda es la que traen muchas grabadoras de campo.
  if (ascii(bytes, 0, 3) === 'ID3') {
    return { mime: 'audio/mpeg', ambiguousContainer: null };
  }
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0) {
    return { mime: 'audio/mpeg', ambiguousContainer: null };
  }

  // --- PDF ---
  if (ascii(bytes, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', ambiguousContainer: null };
  }

  // --- SVG ---
  //
  // Es texto, de modo que no hay firma: se busca la etiqueta en el principio
  // del archivo, saltando la declaración XML y los comentarios. El contenido
  // sigue pasando por `svgThreat` antes de aceptarse.
  const head = ascii(bytes, 0, Math.min(bytes.length, SNIFF_BYTES)).toLowerCase();
  if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))) {
    return { mime: 'image/svg+xml', ambiguousContainer: null };
  }

  return none;
}

/** Clase de medio que corresponde a un tipo reconocido. */
export function kindOfMime(mime: SniffedMime): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Resuelve un contenedor ambiguo con el tipo declarado.
 *
 * Se aplica **después** del reconocimiento y sólo entre los dos tipos que
 * comparten ese contenedor: un declarado que no encaje se ignora en lugar de
 * mandar, porque es precisamente el dato del que no nos fiamos.
 */
export function resolveAmbiguous(result: SniffResult, declaredMime: string): SniffedMime | null {
  if (result.mime === null) return null;
  if (result.ambiguousContainer === null) return result.mime;

  // Sólo se admite la lectura declarada si cae dentro de lo que ese
  // contenedor puede llevar. Un declarado que no encaje se ignora en lugar de
  // mandar: es el dato del que no nos fiamos.
  const alternatives: Readonly<Record<'mp4' | 'matroska', readonly [SniffedMime, SniffedMime]>> = {
    mp4: ['video/mp4', 'audio/mp4'],
    matroska: ['video/webm', 'audio/webm'],
  };

  const [asVideo, asAudio] = alternatives[result.ambiguousContainer];
  return declaredMime.startsWith('audio/') ? asAudio : asVideo;
}

/* ------------------------------------------------------------------ *
 * Interno
 * ------------------------------------------------------------------ */

function starts(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let text = '';
  for (let i = offset; i < offset + length; i += 1) {
    text += String.fromCharCode(bytes[i] ?? 0);
  }
  return text;
}
