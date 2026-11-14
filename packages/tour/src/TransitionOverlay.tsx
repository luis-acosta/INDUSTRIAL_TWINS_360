/**
 * Capa que dibuja la transición entre escenas (C04).
 *
 * Es la fotografía de la escena de la que se sale, superpuesta sobre la que
 * ya está cargando debajo. Se agranda y se desvanece: lo que el visitante
 * percibe es que ha avanzado hacia donde pulsó, en lugar de que una imagen se
 * ha sustituido por otra.
 *
 * La capa no recibe pulsaciones (`pointer-events: none`) ni la anuncia el
 * lector de pantalla (`aria-hidden`): es decoración sobre un cambio de escena
 * que ya ha ocurrido, y el visitante debe poder pulsar un marcador de la
 * escena nueva sin esperar a que termine.
 */
import type { TransitionState } from '@it360/viewer';

export interface TransitionOverlayProps {
  readonly snapshot: string;
  readonly state: TransitionState;
}

export function TransitionOverlay({ snapshot, state }: TransitionOverlayProps): JSX.Element {
  /*
   * El giro de la cámara hacia el punto de destino ya está en `fromView`, pero
   * la fotografía es plana y no se puede reproyectar. Lo que sí traslada la
   * sensación es el avance: la escala crece y la imagen se desvanece. Fingir
   * el giro desplazando la imagen produciría un deslizamiento que no coincide
   * con ninguna geometría y se percibe como un defecto.
   */
  const opacity = 1 - state.toOpacity;

  return (
    <div
      className="transition-overlay"
      aria-hidden
      style={{
        opacity,
        transform: `scale(${state.fromScale.toFixed(4)})`,
        backgroundImage: `url(${snapshot})`,
      }}
      data-phase={state.phase}
    />
  );
}
