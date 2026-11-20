/**
 * Importación de audio y vídeo desde el editor (V05).
 *
 * El dominio decide **qué se acepta**; aquí se hace lo que sólo puede hacer el
 * entorno: leer el archivo, calcular su suma y preguntar al reproductor del
 * navegador cuánto dura y qué tamaño tiene la imagen.
 *
 * La medida de la duración tiene dos trampas que ya costaron caro en la
 * importación de imágenes y que aquí se evitan desde el principio:
 *
 * 1. **Puede no llegar nunca.** Un archivo con cabecera dañada deja al
 *    elemento `<audio>` sin disparar `loadedmetadata` ni `error`. Sin plazo, el
 *    importador se queda colgado y el autor no sabe si sigue trabajando.
 * 2. **Puede llegar como infinito.** Es lo que devuelven los flujos sin
 *    duración declarada —un MP3 grabado por tramos, un WebM en directo—. Hay
 *    que tratarlo como «no se pudo medir» en lugar de guardarlo, porque un
 *    infinito en el proyecto rompe cualquier cálculo que lo use.
 */
import {
  SNIFF_BYTES,
  domainError,
  err,
  importAudioVideo,
  newUuid,
  ok,
  type DomainError,
  type ImageImport,
  type Media,
  type Result,
} from '@it360/domain';

/** Plazo para que el reproductor informe de los metadatos. */
export const MEASURE_TIMEOUT_MS = 6000;

/** Lo que el reproductor consigue averiguar del archivo. */
export interface MediaMetadata {
  readonly durationS: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * Mide duración y dimensiones con el reproductor del navegador.
 *
 * Es la única forma de saberlo sin incorporar un analizador de contenedores:
 * el navegador ya trae uno y es el mismo que va a reproducir el archivo en el
 * recorrido, de modo que si él no puede con el archivo, el visitante tampoco.
 */
export async function measureMedia(url: string, kind: 'audio' | 'video'): Promise<MediaMetadata> {
  const empty: MediaMetadata = { durationS: null, width: null, height: null };
  if (typeof document === 'undefined') return empty;

  const element = document.createElement(kind === 'video' ? 'video' : 'audio');
  element.preload = 'metadata';
  element.muted = true;

  return new Promise<MediaMetadata>((resolve) => {
    let settled = false;
    const finish = (value: MediaMetadata): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute('src');
      // `load()` tras quitar la fuente aborta la descarga en curso: sin esto,
      // importar veinte archivos seguidos deja veinte descargas vivas.
      element.load();
      resolve(value);
    };

    const timer = setTimeout(() => finish(empty), MEASURE_TIMEOUT_MS);

    element.addEventListener('loadedmetadata', () => {
      const duration = element.duration;
      const usable = Number.isFinite(duration) && duration > 0 ? duration : null;
      const video = element as HTMLVideoElement;
      finish({
        durationS: usable,
        width: kind === 'video' && video.videoWidth > 0 ? video.videoWidth : null,
        height: kind === 'video' && video.videoHeight > 0 ? video.videoHeight : null,
      });
    });

    element.addEventListener('error', () => finish(empty));

    element.src = url;
  });
}

export interface ImportedMedia extends ImageImport {
  /** URL para previsualizar el medio en el editor. */
  readonly displayUrl: string;
  /** Contenido, para escribirlo en el paquete al publicar. */
  readonly bytes: Uint8Array;
  /** Advertencia sin gravedad: se importó, pero conviene saberlo. */
  readonly warning: string | null;
}

/**
 * Importa un archivo de audio o vídeo elegido por el autor.
 *
 * El orden es deliberado: primero se reconoce el formato por contenido —que es
 * barato y descarta lo que no sirve—, y sólo después se mide con el
 * reproductor, que es lo lento. Al revés, arrastrar una carpeta con veinte
 * archivos equivocados haría esperar veinte plazos.
 */
export async function importMediaFile(
  file: File,
  existing: readonly Media[],
  options: { readonly folder?: string } = {},
): Promise<Result<ImportedMedia, DomainError>> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return err(
      domainError('IO_FAILED', `No se pudo leer «${file.name}».`, {
        recovery: 'Compruebe que el archivo sigue disponible y vuelva a elegirlo.',
      }),
    );
  }

  const sha256 = await sha256Hex(bytes);
  const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));

  // Primera pasada sin medir: si el contenido no es audio ni vídeo, no hay
  // nada que medir y el error llega de inmediato.
  const probe = importAudioVideo(
    {
      id: newUuid(),
      sha256,
      declaredMime: file.type,
      originalName: file.name,
      byteSize: bytes.byteLength,
      head,
      durationS: null,
      width: null,
      height: null,
      createdAt: new Date().toISOString(),
      ...(options.folder === undefined ? {} : { folder: options.folder }),
    },
    existing,
  );
  if (!probe.ok) return probe;

  const url = objectUrlFor(bytes, probe.value.media.mime);

  // Un medio reutilizado no se vuelve a medir: ya tiene sus metadatos y
  // medirlo otra vez sólo gastaría el plazo.
  if (probe.value.reused) {
    return ok({ ...probe.value, displayUrl: url, bytes, warning: null });
  }

  const kind = probe.value.media.kind === 'video' ? 'video' : 'audio';
  const measured = await measureMedia(url, kind);

  const result = importAudioVideo(
    {
      id: probe.value.media.id,
      sha256,
      declaredMime: file.type,
      originalName: file.name,
      byteSize: bytes.byteLength,
      head,
      durationS: measured.durationS,
      width: measured.width,
      height: measured.height,
      createdAt: probe.value.media.createdAt,
      ...(options.folder === undefined ? {} : { folder: options.folder }),
    },
    existing,
  );
  if (!result.ok) return result;

  /*
   * Si el reproductor no pudo con el archivo, se importa igualmente pero se
   * dice. Negarse sería peor: puede ser el único original que tiene el autor,
   * y el códec puede faltar en este equipo y estar en el del visitante. Lo que
   * no se puede hacer es callarlo, porque una parada que espera a un audio sin
   * duración conocida no sabe cuánto esperar.
   */
  const warning =
    measured.durationS === null
      ? 'El reproductor de este equipo no pudo leer la duración del archivo. Se importa, pero una parada de recorrido no podrá esperar a que termine.'
      : kind === 'video' && measured.width === null
        ? 'No se pudieron leer las dimensiones del vídeo. Se importa, pero el visor no podrá encuadrarlo con exactitud.'
        : null;

  return ok({ ...result.value, displayUrl: url, bytes, warning });
}

/* ------------------------------------------------------------------ *
 * Interno
 * ------------------------------------------------------------------ */

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    // No debería ocurrir en el editor —Tauri trae un contexto seguro— pero si
    // ocurre, es mejor un identificador que no deduplica que una excepción
    // en medio de una importación.
    return Array.from(bytes.subarray(0, 32))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(64, '0');
  }
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function objectUrlFor(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob);
  // En entornos sin `createObjectURL` —algunas pruebas— no hay URL que dar; el
  // medio queda importado y sin previsualización, que es recuperable.
  return '';
}
