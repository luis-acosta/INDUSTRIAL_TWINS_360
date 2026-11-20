/**
 * Grabación del recorrido en vídeo (S07).
 *
 * El caso: una visita guiada que ya existe en el proyecto hay que mandarla a
 * quien no va a abrir el recorrido —una inducción de seguridad para contratas,
 * una reunión de arranque, un anexo de un informe—. Hasta ahora había que
 * grabar la pantalla con otro programa.
 *
 * Se graba con lo que trae el navegador: `captureStream` del lienzo y
 * `MediaRecorder`. No hay transcodificador en el producto —ni aquí ni en V04— y
 * esto no lo necesita, porque el navegador codifica mientras reproduce.
 *
 * **Lo que la grabación contiene, dicho antes de empezar.** Se graba el lienzo:
 * la panorámica o el modelo con sus marcadores. La interfaz del recorrido
 * —paneles, ventanas de información, botones— es HTML encima del lienzo y no
 * entra en el flujo de vídeo; tampoco el audio de las narraciones, que no pasa
 * por el lienzo. Quien espere un vídeo de la pantalla completa recibiría otra
 * cosa, así que esto se dice en la interfaz antes de grabar y no después.
 */

/** Tipos que se intentan, del que mejor comprime al más compatible. */
const CANDIDATE_TYPES: readonly string[] = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export interface CaptureSupport {
  readonly supported: boolean;
  /** Tipo MIME que se va a producir, o `null` si no se puede grabar. */
  readonly mimeType: string | null;
  /** Motivo legible cuando no se puede, para contárselo al autor. */
  readonly reason: string | null;
}

/**
 * Qué puede grabar este navegador.
 *
 * Se consulta antes de ofrecer el botón, no al pulsarlo: un botón que falla al
 * pulsarlo después de que el autor haya preparado la escena desperdicia su
 * trabajo, y el motivo real —«este navegador no graba vídeo»— no se adivina.
 */
export function captureSupport(
  recorder: typeof MediaRecorder | undefined = globalThis.MediaRecorder,
): CaptureSupport {
  if (recorder === undefined) {
    return {
      supported: false,
      mimeType: null,
      reason: 'Este navegador no puede grabar vídeo (no tiene MediaRecorder).',
    };
  }

  const mimeType = CANDIDATE_TYPES.find((type) => {
    try {
      return recorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });

  if (mimeType === undefined) {
    return {
      supported: false,
      mimeType: null,
      reason: 'Este navegador no admite ninguno de los formatos de vídeo que se pueden grabar.',
    };
  }

  return { supported: true, mimeType, reason: null };
}

/** Extensión que corresponde al tipo grabado. */
export const extensionForCapture = (mimeType: string): string =>
  mimeType.startsWith('video/mp4') ? '.mp4' : '.webm';

/**
 * Tasa de bits por tamaño de lienzo.
 *
 * Una panorámica en movimiento es contenido difícil: paneo continuo y detalle
 * fino por todas partes. Con la tasa por omisión del navegador —que apunta a
 * videollamada— los rótulos de los equipos se deshacen en bloques, que es justo
 * lo que alguien va a mirar en el vídeo. Se pide una tasa proporcional a los
 * píxeles y se acota, porque pedir demasiado en un portátil hace que el
 * codificador pierda fotogramas y el paneo salga a tirones.
 */
export const MIN_BITRATE = 2_000_000;
export const MAX_BITRATE = 24_000_000;

export function bitrateFor(width: number, height: number, fps: number): number {
  // 0,12 bits por píxel y fotograma: medido sobre paneos de panorámicas
  // industriales, es donde los rótulos dejan de romperse.
  const raw = Math.round(width * height * fps * 0.12);
  return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw));
}

export interface CaptureOptions {
  readonly fps?: number;
  /** Tasa de bits; si falta, se calcula a partir del lienzo. */
  readonly bitsPerSecond?: number;
  readonly mimeType?: string;
}

export interface CaptureHandle {
  stop(): Promise<Blob>;
  /** Milisegundos grabados hasta ahora. */
  elapsedMs(): number;
}

/** Fotogramas por segundo por omisión: suficiente para un paneo suave. */
export const DEFAULT_CAPTURE_FPS = 30;

/**
 * Empieza a grabar el lienzo.
 *
 * Devuelve el control para pararla, que entrega el archivo. Los trozos se
 * acumulan en memoria: un recorrido guiado dura minutos, no horas, y escribir a
 * disco mientras se graba obligaría a pedir la carpeta antes de empezar, que es
 * una pregunta más entre el autor y lo que quiere hacer.
 */
export function startCapture(
  canvas: HTMLCanvasElement,
  options: CaptureOptions = {},
  now: () => number = () => Date.now(),
): CaptureHandle {
  const fps = options.fps ?? DEFAULT_CAPTURE_FPS;
  const support = captureSupport();
  const mimeType = options.mimeType ?? support.mimeType ?? 'video/webm';

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    bitsPerSecond:
      options.bitsPerSecond ?? bitrateFor(canvas.width || 1280, canvas.height || 720, fps),
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    // Un trozo vacío llega al parar en algunos navegadores; guardarlo deja un
    // archivo con un bloque de cero bytes que algunos reproductores rechazan.
    if (event.data.size > 0) chunks.push(event.data);
  };

  const startedAt = now();
  /* Con un intervalo, el grabador entrega trozos periódicos en lugar de uno
     solo al final. Importa para una grabación larga: sin él, un fallo a los
     cuatro minutos se lleva los cuatro minutos. */
  recorder.start(1000);

  return {
    elapsedMs: () => now() - startedAt,
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
          // Las pistas se paran explícitamente: el lienzo sigue produciendo
          // fotogramas para un flujo que ya nadie lee y el ventilador del
          // portátil lo nota.
          for (const track of stream.getTracks()) track.stop();
        };
        if (recorder.state === 'inactive') {
          recorder.onstop?.(new Event('stop'));
          return;
        }
        recorder.stop();
      }),
  };
}

/**
 * Nombre de archivo propuesto.
 *
 * Lleva el nombre del recorrido y la fecha, porque quien exporta tres veces en
 * una tarde acaba con tres archivos y necesita distinguirlos sin abrirlos. Los
 * caracteres que no valen en un nombre de archivo se sustituyen: el nombre del
 * recorrido lo escribe el autor y puede llevar barras o dos puntos.
 */
export function captureFileName(tourName: string, mimeType: string, at: Date): string {
  const safe =
    tourName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'recorrido';

  const stamp = at.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `${safe}-${stamp}${extensionForCapture(mimeType)}`;
}
