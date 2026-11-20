/**
 * Mandos del visor (N11).
 *
 * `webxr.ts` ya reducía una acción a estado (`applyVrInput`). Lo que falta es
 * el paso anterior: convertir lo que informa el navegador —botones y ejes de
 * cada `XRInputSource`, muestreados una vez por fotograma— en acciones
 * discretas.
 *
 * Ese paso tiene dos trampas, y las dos producen fallos que sólo se notan con
 * las gafas puestas:
 *
 * 1. **Un botón pulsado está pulsado en muchos fotogramas.** Leer el estado
 *    sin detectar el flanco convierte una pulsación de un cuarto de segundo
 *    en veinte acciones: el visitante pulsa «girar» una vez y la escena da
 *    media vuelta.
 * 2. **Los ejes no vuelven exactamente a cero.** Una palanca en reposo marca
 *    décimas, y sin zona muerta la escena gira sola.
 *
 * El módulo es puro: recibe una instantánea de las fuentes de entrada y el
 * estado anterior, y devuelve las acciones y el estado nuevo. Así el
 * comportamiento se prueba fotograma a fotograma sin hardware.
 */
import type { VrInputAction } from './webxr';

/**
 * Lo que se necesita de un `XRInputSource`.
 *
 * Se declara en lugar de usar el tipo del navegador porque el `Gamepad` de
 * WebXR trae decenas de campos irrelevantes y porque una instantánea de datos
 * planos es lo que permite escribir las pruebas como una secuencia de
 * fotogramas.
 */
export interface XrInputSnapshot {
  readonly handedness: 'left' | 'right' | 'none';
  /** Botones en el orden del perfil estándar de WebXR. */
  readonly buttons: readonly boolean[];
  /** Ejes: [x, y] de la palanca principal en las posiciones 2 y 3. */
  readonly axes: readonly number[];
}

/**
 * Índices del perfil «xr-standard».
 *
 * Son los que publica la especificación para los mandos con palanca, y los
 * respetan Quest, Index, WMR y Pico. Un mando exótico puede ordenarlos de otra
 * forma; para esos queda la mirada y el gatillo, que sí es universal.
 */
export const XR_BUTTON = {
  /** Gatillo: seleccionar. Presente en todos los perfiles. */
  trigger: 0,
  /** Agarre lateral: arrastrar paneles. */
  squeeze: 1,
  /** Pulsación de la palanca. */
  thumbstick: 3,
  /** Botón primario (A / X): menú. */
  primary: 4,
  /** Botón secundario (B / Y): volver o salir. */
  secondary: 5,
} as const;

/** Posición de la palanca principal dentro de `axes`. */
export const THUMBSTICK_AXES = { x: 2, y: 3 } as const;

/**
 * Zona muerta de la palanca.
 *
 * 0,55 es alto a propósito para el giro por pasos: el umbral tiene que estar
 * lejos del reposo para que un roce no gire la escena, y el giro por pasos no
 * necesita precisión analógica.
 */
export const TURN_DEADZONE = 0.55;

/** Estado que hay que recordar entre fotogramas para detectar flancos. */
export interface XrInputMemory {
  /** Botones pulsados en el fotograma anterior, por mano. */
  readonly pressed: Readonly<Record<string, readonly boolean[]>>;
  /** Si la palanca estaba fuera de la zona muerta, por mano. */
  readonly turning: Readonly<Record<string, boolean>>;
}

export const EMPTY_INPUT_MEMORY: XrInputMemory = { pressed: {}, turning: {} };

export interface XrInputReading {
  readonly actions: readonly VrInputAction[];
  readonly memory: XrInputMemory;
  /** Mano cuyo gatillo se ha usado más recientemente. */
  readonly activeHand: 'left' | 'right' | null;
}

/**
 * Traduce un fotograma de entrada a acciones.
 *
 * Sólo se emiten acciones en el flanco de subida. El giro, además, se emite
 * una vez por cruce de la zona muerta: mantener la palanca no gira en
 * continuo, que es la decisión de comodidad que ya tomaba `SNAP_TURN_RAD`.
 */
export function readXrInput(
  sources: readonly XrInputSnapshot[],
  memory: XrInputMemory = EMPTY_INPUT_MEMORY,
  previousHand: 'left' | 'right' | null = null,
): XrInputReading {
  const actions: VrInputAction[] = [];
  const pressed: Record<string, readonly boolean[]> = {};
  const turning: Record<string, boolean> = {};
  let activeHand = previousHand;

  for (const source of sources) {
    const key = source.handedness;
    const before = memory.pressed[key] ?? [];
    const rising = (index: number): boolean =>
      (source.buttons[index] ?? false) && !(before[index] ?? false);

    if (rising(XR_BUTTON.trigger)) {
      actions.push('select');
      if (key === 'left' || key === 'right') activeHand = key;
    }
    if (rising(XR_BUTTON.primary)) actions.push('menu');
    if (rising(XR_BUTTON.secondary)) actions.push('exit');
    if (rising(XR_BUTTON.thumbstick)) actions.push('teleport');

    const x = source.axes[THUMBSTICK_AXES.x] ?? 0;
    const beyond = Math.abs(x) >= TURN_DEADZONE;
    const wasBeyond = memory.turning[key] ?? false;
    if (beyond && !wasBeyond) {
      actions.push(x < 0 ? 'rotateLeft' : 'rotateRight');
    }

    pressed[key] = [...source.buttons];
    turning[key] = beyond;
  }

  return { actions, memory: { pressed, turning }, activeHand };
}

/**
 * Rayo del mando en coordenadas del espacio de referencia.
 *
 * La pose la da el navegador como matriz; aquí sólo se extrae el origen y la
 * dirección −Z, que es la convención de WebXR para «hacia donde apunta el
 * mando». Se separa del cálculo de intersección para poder probar cada mitad.
 */
export interface XrRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * Extrae el rayo de una matriz de pose en orden de columnas (16 números),
 * que es como la entrega `XRRigidTransform.matrix`.
 */
export function rayFromPoseMatrix(matrix: readonly number[] | Float32Array): XrRay {
  const origin: [number, number, number] = [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0];
  // Tercera columna negada: la dirección de apuntado en WebXR y en Three es
  // −Z del sistema local.
  // El `+ 0` convierte el cero negativo que produce la negación en cero
  // positivo: −0 es matemáticamente inofensivo pero se propaga a la
  // serialización y a las comparaciones estrictas como un valor distinto.
  const raw: [number, number, number] = [
    -(matrix[8] ?? 0) + 0,
    -(matrix[9] ?? 0) + 0,
    -(matrix[10] ?? 1) + 0,
  ];
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  const direction: [number, number, number] =
    length > 1e-6 ? [raw[0] / length + 0, raw[1] / length + 0, raw[2] / length + 0] : [0, 0, -1];
  return { origin, direction };
}
