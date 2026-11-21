/**
 * Panorámica en vivo (B06, mitad de «Live Panorama»).
 *
 * Qué aporta en una planta, que es distinto de lo que aporta en una casa: una
 * fotografía fija de una unidad en operación puede parecer una unidad parada. Un
 * bucle de unos segundos —el vapor moviéndose, la llama parpadeando, las aspas
 * girando— dice que aquello está en marcha, y eso es información y no
 * decoración.
 *
 * Las cuatro condiciones para reproducir, todas comprobadas antes de pedir el
 * archivo, porque pedir veinte megabytes para descubrir que no se puede
 * reproducir es gastar la red de la planta para nada:
 *
 *  1. **La escena declara un vídeo.** Si no, no hay nada que decidir.
 *  2. **El sistema no pide movimiento reducido.** Un entorno que se mueve es
 *     exactamente lo que esa preferencia pide no hacer, y aquí el movimiento
 *     ocupa los 360 grados: quien la tiene activada por mareo no puede
 *     esquivarlo mirando a otro lado.
 *  3. **El visitante no ha pedido ahorrar datos.** El bucle pesa más que la
 *     fotografía y la fotografía ya cuenta la escena.
 *  4. **El dispositivo dice que puede decodificar ese formato.**
 *
 * Y la regla que lo sostiene todo: **la imagen fija es obligatoria y el vídeo
 * es un añadido**. Si falla la reproducción —un códec que el navegador declara
 * y no reproduce, una red que se corta a medias, un autoplay que el navegador
 * rechaza— la escena sigue siendo la fotografía. Una escena cuyo único medio
 * fuera el vídeo quedaría en negro, y el visitante no tendría forma de saber si
 * el problema es el recorrido o su conexión.
 */

import { LinearFilter, SRGBColorSpace, VideoTexture } from 'three';

export type LiveDecision =
  | { readonly play: true }
  | {
      readonly play: false;
      readonly reason: 'noVideo' | 'reducedMotion' | 'saveData' | 'unsupportedCodec';
      /** Para contarlo en la interfaz cuando el autor está probando. */
      readonly message: string;
    };

export interface LiveContext {
  readonly reducedMotion: boolean;
  readonly saveData: boolean;
  /** `canPlayType` del elemento de vídeo; vacío significa «no puedo». */
  readonly canPlay: (mime: string) => string;
}

/**
 * Decide si el bucle se reproduce.
 *
 * El orden de las comprobaciones importa: primero las del visitante y del
 * sistema —movimiento reducido, ahorro de datos—, y sólo después la capacidad
 * técnica. Al revés, un dispositivo que no puede decodificar el formato
 * informaría de un problema de códec a alguien que de todas formas había pedido
 * no ver movimiento, y el mensaje le haría buscar una solución a algo que no es
 * su caso.
 */
export function decideLive(
  videoMime: string | null,
  context: LiveContext,
): LiveDecision {
  if (videoMime === null) {
    return { play: false, reason: 'noVideo', message: 'Esta escena no trae panorámica en vivo.' };
  }

  if (context.reducedMotion) {
    return {
      play: false,
      reason: 'reducedMotion',
      message:
        'El sistema pide movimiento reducido, así que se muestra la imagen fija. Un entorno en movimiento ocupa los 360 grados y no se puede esquivar mirando a otro lado.',
    };
  }

  if (context.saveData) {
    return {
      play: false,
      reason: 'saveData',
      message: 'Con el ahorro de datos activado se muestra la imagen fija, que pesa mucho menos.',
    };
  }

  /* `canPlayType` devuelve «probably», «maybe» o cadena vacía. «maybe» se
     acepta: es lo que contestan muchos navegadores para formatos que luego
     reproducen bien, y rechazarlo dejaría la función sin usar en la mitad de
     los dispositivos. Si al final no reproduce, la reserva a la imagen fija lo
     recoge. */
  if (context.canPlay(videoMime) === '') {
    return {
      play: false,
      reason: 'unsupportedCodec',
      message: `Este dispositivo no puede reproducir «${videoMime}»; se muestra la imagen fija.`,
    };
  }

  return { play: true };
}

/** Lee del navegador lo que hace falta para decidir. */
export function readLiveContext(
  nav: Navigator = globalThis.navigator,
  matchMedia: typeof globalThis.matchMedia | undefined = globalThis.matchMedia,
): LiveContext {
  const connection = (nav as Navigator & { connection?: { saveData?: boolean } }).connection;
  const probe = globalThis.document?.createElement('video');

  return {
    reducedMotion: matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    saveData: connection?.saveData === true,
    canPlay: (mime) => probe?.canPlayType(mime) ?? '',
  };
}

export interface LiveHandle {
  readonly texture: VideoTexture;
  readonly video: HTMLVideoElement;
  dispose(): void;
}

/**
 * Prepara el vídeo y su textura.
 *
 * `muted` no es una preferencia: sin él, el navegador rechaza la reproducción
 * automática y la panorámica en vivo no arranca nunca. Y un entorno de 360
 * grados con sonido propio tampoco es lo que se quiere: el audio de una escena
 * se controla con las acciones del recorrido, no con el fondo.
 */
export function createLivePanorama(url: string): LiveHandle {
  const video = globalThis.document.createElement('video');
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  // Precarga sólo los metadatos: el bucle empieza cuando la escena está
  // visible, y descargarlo entero antes convertiría la mejora en una espera.
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';

  const texture = new VideoTexture(video);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  return {
    texture,
    video,
    dispose() {
      texture.dispose();
      /* Se para y se suelta la fuente: un elemento de vídeo con `src` sigue
         con su búfer en memoria y, en algunos navegadores, sigue
         decodificando aunque esté pausado y fuera del documento. */
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}

/**
 * Intenta reproducir y dice si lo consiguió.
 *
 * El rechazo de la reproducción automática no es un fallo que contar al
 * visitante: es una política del navegador, frecuente y legítima. Lo que
 * corresponde es volver a la imagen fija sin decir nada, que es lo que el
 * visitante esperaría ver de todas formas.
 */
export async function startLive(video: HTMLVideoElement): Promise<boolean> {
  try {
    await video.play();
    return true;
  } catch {
    return false;
  }
}
