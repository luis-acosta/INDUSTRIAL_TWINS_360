/**
 * Multimedia emergente dentro de la sesión inmersiva (N10).
 *
 * Esta es la pieza que faltaba de la etapa 13 y el motivo por el que faltaba
 * merece quedar escrito: **un vídeo en DOM no se compone sobre la imagen del
 * visor**. Mientras la sesión presenta, el navegador dibuja lo que entrega el
 * bucle de WebXR y nada más; una ventana de HTML sobre el lienzo sigue ahí
 * para quien mire la pantalla del PC, pero quien lleva las gafas no la ve. El
 * resultado era el peor posible: el visitante pulsaba un punto de interés, el
 * vídeo empezaba a sonar y en el visor no pasaba nada.
 *
 * Lo que hace este módulo es llevar el vídeo a una textura y el audio a un
 * panel que diga que está sonando. Son dos casos distintos y conviene no
 * mezclarlos:
 *
 *  - **El vídeo necesita textura.** Es imagen, y la imagen tiene que entrar en
 *    la escena que se dibuja.
 *  - **El audio no.** Suena igual desde el elemento del DOM, porque el audio
 *    del navegador no pasa por el bucle de fotogramas. Lo que sí hace falta es
 *    decir en el visor que algo está sonando y dejar pararlo, porque un sonido
 *    sin origen visible dentro de unas gafas desconcierta.
 *
 * Y el tercer caso, el que no se finge: un PDF o una página enmarcada no se
 * pueden mostrar aquí. Se dice en un panel en lugar de dejar la acción muda.
 */

import {
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  VideoTexture,
} from 'three';

/** Qué se puede mostrar dentro de la sesión, y qué no. */
export type XrMediaSupport = 'video' | 'audio' | 'image' | 'unsupported';

/**
 * Clasifica un medio por lo que la sesión inmersiva puede hacer con él.
 *
 * Se decide por el tipo del medio y no por su extensión: el nombre del archivo
 * lo escribe quien hace el proyecto y puede no corresponder con el contenido.
 */
export function xrMediaSupport(kind: string): XrMediaSupport {
  switch (kind) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'image':
      return 'image';
    default:
      // Documentos, páginas enmarcadas, modelos: no en un panel de VR.
      return 'unsupported';
  }
}

/** Texto para el panel cuando el medio no se puede mostrar en la sesión. */
export function unsupportedMediaMessage(kind: string): string {
  switch (kind) {
    case 'document':
      return 'Este documento no se puede leer dentro del visor. Quítese las gafas para abrirlo en la pantalla.';
    case 'model':
      return 'Este modelo se abre como escena propia, no como ventana.';
    default:
      return 'Este contenido no se puede mostrar dentro del visor.';
  }
}

/**
 * Proporción del panel de vídeo.
 *
 * Se calcula con las dimensiones reales del vídeo cuando el elemento ya las
 * conoce, y con 16:9 cuando todavía no: estirar la imagen de un vídeo vertical
 * para llenar un panel apaisado es más molesto dentro del visor que en una
 * pantalla, porque no hay nada alrededor con lo que comparar.
 */
export function videoAspect(video: {
  readonly videoWidth: number;
  readonly videoHeight: number;
}): number {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return video.videoWidth / video.videoHeight;
  }
  return 16 / 9;
}

/**
 * Superficie de vídeo.
 *
 * No extiende `PanelSurface` a propósito: un panel de interfaz se pinta en un
 * lienzo propio y éste no tiene ninguno —la imagen la pone el elemento del
 * vídeo—. Declararlo como panel obligaría a inventar un lienzo que nadie usa, y
 * el primer código que lo diera por bueno pintaría sobre él sin que se viera
 * nada.
 */
export interface XrVideoSurface {
  readonly texture: VideoTexture;
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** Pone al día la proporción del panel con el tamaño real del vídeo. */
  resize(widthM: number): void;
  dispose(): void;
}

/**
 * Panel con la imagen de un vídeo.
 *
 * El elemento del vídeo lo trae quien ya lo está reproduciendo —el mismo que
 * usa la versión plana— en lugar de crear otro aquí: con dos elementos, el
 * sonido se oiría dos veces y la barra de progreso de la pantalla no diría la
 * verdad sobre lo que se ve en el visor.
 */
export function createVideoSurface(
  video: HTMLVideoElement,
  widthM = 1.2,
): XrVideoSurface {
  const texture = new VideoTexture(video);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const material = new MeshBasicMaterial({ map: texture, transparent: false, depthTest: true });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.renderOrder = 11;
  mesh.name = 'it360-xr-video';

  /* `VideoTexture` se sube sola en cada fotograma mientras el vídeo avanza, de
     modo que aquí no hay nada que invalidar a mano. */
  const surface: XrVideoSurface = {
    texture,
    mesh,
    resize(width: number) {
      const aspect = videoAspect(video);
      mesh.scale.set(width, width / aspect, 1);
    },
    dispose() {
      texture.dispose();
      material.dispose();
      mesh.geometry.dispose();
      mesh.removeFromParent();
    },
  };

  surface.resize(widthM);
  return surface;
}

/**
 * Estado de la multimedia dentro de la sesión, para pintarlo en un panel.
 *
 * Es lo mínimo que hace falta saber desde el visor: qué está sonando o
 * mostrándose, cuánto lleva y si el contenido no se puede mostrar. La fracción
 * se recorta a uno porque un vídeo puede informar de una duración ligeramente
 * menor que su último instante y una barra que se pasa del final parece
 * averiada.
 */
export interface XrMediaPanelState {
  readonly title: string;
  readonly support: XrMediaSupport;
  readonly playing: boolean;
  readonly fraction: number;
  readonly message: string | null;
}

export function xrMediaPanelState(options: {
  readonly title: string;
  readonly kind: string;
  readonly playing: boolean;
  readonly positionS: number;
  readonly durationS: number | null;
}): XrMediaPanelState {
  const support = xrMediaSupport(options.kind);
  const fraction =
    options.durationS === null || options.durationS <= 0
      ? 0
      : Math.min(1, Math.max(0, options.positionS / options.durationS));

  return {
    title: options.title,
    support,
    playing: options.playing,
    fraction,
    message: support === 'unsupported' ? unsupportedMediaMessage(options.kind) : null,
  };
}
