/**
 * Clase de dispositivo del visitante (D14).
 *
 * El autor decide en qué dispositivos aparece cada componente de la interfaz,
 * y hasta ahora el visor declaraba «escritorio» siempre: las reglas de móvil y
 * tableta no se aplicaban nunca, de modo que una barra que el autor había
 * excluido del móvil salía igual y tapaba media pantalla.
 *
 * Se clasifica por el ancho de la ventana y por la finura del puntero, no por
 * la cadena de agente de usuario. La cadena miente —los navegadores la
 * falsean a propósito desde hace años— y lo que de verdad importa para decidir
 * si un panel cabe y si se puede pulsar con precisión es el espacio y el dedo.
 */
import type { DeviceKind } from '@it360/domain';

/** Ancho a partir del cual se considera escritorio. */
export const DESKTOP_MIN_WIDTH = 1024;

/** Ancho a partir del cual se considera tableta. */
export const TABLET_MIN_WIDTH = 640;

export interface DeviceSignals {
  readonly width: number;
  /** `true` si el puntero es grueso (dedo). */
  readonly coarsePointer: boolean;
  /** `true` si el visitante está en una sesión inmersiva. */
  readonly inVr?: boolean;
}

/**
 * Clasifica el dispositivo.
 *
 * Una ventana estrecha con puntero fino —un navegador a media pantalla en un
 * portátil— es escritorio: el autor que oculta algo en el móvil lo hace porque
 * no se puede pulsar con el dedo, no porque la ventana sea angosta. Con dedo,
 * el ancho decide entre móvil y tableta.
 */
export function classifyDevice(signals: DeviceSignals): DeviceKind {
  if (signals.inVr === true) return 'vr';

  if (!signals.coarsePointer) {
    // Con ratón, sólo una ventana muy angosta deja de ser escritorio: por
    // debajo de ese ancho ni la interfaz de escritorio cabe.
    return signals.width < TABLET_MIN_WIDTH ? 'tablet' : 'desktop';
  }

  if (signals.width >= DESKTOP_MIN_WIDTH) return 'tablet';
  return signals.width >= TABLET_MIN_WIDTH ? 'tablet' : 'mobile';
}

/** Señales del entorno actual, con valores prudentes si no se pueden leer. */
export function currentDeviceSignals(inVr = false): DeviceSignals {
  const width = globalThis.innerWidth ?? DESKTOP_MIN_WIDTH;
  const coarsePointer =
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(pointer: coarse)').matches
      : false;

  return { width, coarsePointer, inVr };
}
