/**
 * Paneles dentro de la sesión inmersiva (N03, N04, N05, N08, N09, N10).
 *
 * En pantalla, un panel de información es HTML encima del lienzo. Dentro de
 * una sesión inmersiva no hay «encima del lienzo»: el navegador no compone DOM
 * sobre la imagen que llega al visor. Un panel en VR es geometría —un
 * rectángulo colocado en el espacio— y pulsar un botón es un rayo del mando
 * que corta ese rectángulo.
 *
 * Este módulo es esa aritmética, aislada de Three y del DOM: colocación según
 * el modo (N05), orientación y tamaño (N04), y del rayo a la celda pulsada
 * (N03). Lo que se dibuje dentro del rectángulo —texto, botones, una tarjeta
 * de evaluación, la puntuación— es una textura que pinta `xr-panel-paint.ts`;
 * la separación permite probar la interacción sin un lienzo y el dibujado sin
 * un visor.
 */
import type { VrPanelMode, VrPanelPlacement } from './webxr';

export type Vec3 = readonly [number, number, number];

/** Pose de la cabeza en el espacio de referencia de la sesión. */
export interface HeadPose {
  readonly position: Vec3;
  /** Giro alrededor del eje vertical, en radianes. */
  readonly yaw: number;
}

export const ORIGIN_HEAD: HeadPose = { position: [0, 1.6, 0], yaw: 0 };

/**
 * Rectángulo colocado en el espacio.
 *
 * Se guardan los tres vectores en vez de una matriz porque son exactamente lo
 * que necesita el corte del rayo y lo que hace legible la prueba: un fallo en
 * `right` o en `up` se lee aquí, no en los dieciséis números de una matriz.
 */
export interface PanelFrame {
  readonly center: Vec3;
  /** Normal, hacia el observador. */
  readonly normal: Vec3;
  /** Semieje horizontal: su módulo es la mitad de la anchura. */
  readonly right: Vec3;
  /** Semieje vertical: su módulo es la mitad de la altura. */
  readonly up: Vec3;
}

/** Ancla persistente de un panel: lo que distingue un modo de otro. */
export interface PanelAnchor {
  readonly mode: VrPanelMode;
  /** Giro al que está anclado el panel. */
  readonly yaw: number;
  /** Posición del observador cuando se ancló, para los modos fijos. */
  readonly headPosition: Vec3;
  /** Desplazamiento adicional aplicado por arrastre, en radianes y metros. */
  readonly dragYaw: number;
  readonly dragPitch: number;
}

/**
 * Umbral de recentrado.
 *
 * Un panel «recentering» no persigue la mirada: eso marea y hace imposible
 * mirar la escena. Se queda quieto mientras el visitante gira la cabeza hasta
 * 40°, y sólo cuando la mirada sale de ese cono vuelve a colocarse delante.
 * El valor es el límite habitual del giro cómodo de cuello.
 */
export const RECENTER_THRESHOLD_RAD = (40 * Math.PI) / 180;

/** Ancla inicial de un panel que se abre con la cabeza en `head`. */
export function anchorFor(placement: VrPanelPlacement, head: HeadPose): PanelAnchor {
  return {
    mode: placement.mode,
    yaw: head.yaw,
    headPosition: head.position,
    dragYaw: 0,
    dragPitch: 0,
  };
}

/**
 * Actualiza el ancla para el fotograma actual.
 *
 * Es donde vive la diferencia entre los cuatro modos, y por eso está en una
 * función propia y probada: en VR, un panel que se mueve cuando no debía o que
 * se queda detrás del visitante cuando debía seguirle son los dos defectos que
 * hacen abandonar un recorrido.
 */
export function updateAnchor(anchor: PanelAnchor, head: HeadPose): PanelAnchor {
  switch (anchor.mode) {
    case 'worldFixed':
    case 'draggable':
      // Se queda donde se abrió o donde lo dejó el visitante. Que el
      // observador se aleje es información útil: el panel pertenece al sitio.
      return anchor;
    case 'modal':
      // Un modal bloquea el recorrido: tiene que estar siempre delante, sin
      // retardo, o el visitante no encontraría el botón de cerrar.
      return { ...anchor, yaw: head.yaw, headPosition: head.position };
    case 'recentering': {
      const delta = normalizeAngle(head.yaw - anchor.yaw);
      if (Math.abs(delta) <= RECENTER_THRESHOLD_RAD) {
        // Dentro del cono cómodo el panel no se mueve, pero sí acompaña al
        // visitante si camina: si no, al dar dos pasos se queda a su espalda.
        return { ...anchor, headPosition: head.position };
      }
      return { ...anchor, yaw: head.yaw, headPosition: head.position };
    }
  }
}

/**
 * Coloca el panel en el espacio.
 *
 * El panel siempre mira al observador —un rectángulo con texto visto de canto
 * es ilegible— de modo que la normal se deriva del ancla y no se configura.
 * Lo que sí es configurable es dónde se pone: distancia, desplazamiento
 * horizontal y vertical, y tamaño (N04).
 */
export function panelFrame(placement: VrPanelPlacement, anchor: PanelAnchor): PanelFrame {
  const yaw = anchor.yaw + placement.yawOffset + anchor.dragYaw;
  const pitch = clamp(placement.pitchOffset + anchor.dragPitch, -1.2, 1.2);

  const cosPitch = Math.cos(pitch);
  // Hacia delante en la convención de Three: yaw 0 mira a −Z.
  const forward: Vec3 = [-Math.sin(yaw) * cosPitch, Math.sin(pitch), -Math.cos(yaw) * cosPitch];

  const center: Vec3 = [
    anchor.headPosition[0] + forward[0] * placement.distanceM,
    anchor.headPosition[1] + forward[1] * placement.distanceM,
    anchor.headPosition[2] + forward[2] * placement.distanceM,
  ];

  // La normal apunta al observador, que es lo contrario de «hacia delante».
  const normal: Vec3 = [-forward[0], -forward[1], -forward[2]];

  // El eje horizontal se mantiene a nivel aunque el panel esté inclinado: un
  // panel con el texto escorado se lee torcido incluso si mira de frente.
  const right: Vec3 = scale([Math.cos(yaw), 0, -Math.sin(yaw)], placement.widthM / 2);
  const up = scale(cross(normal, normalize(right)), placement.heightM / 2);

  return { center, normal, right, up };
}

export interface PanelHit {
  /** Distancia desde el origen del rayo, en metros. */
  readonly distanceM: number;
  /** Coordenada horizontal dentro del panel, 0 a la izquierda, 1 a la derecha. */
  readonly u: number;
  /** Coordenada vertical, 0 arriba, 1 abajo: el orden del lienzo. */
  readonly v: number;
}

/**
 * Corta un rayo con el panel.
 *
 * Devuelve `null` cuando el rayo va paralelo al panel, cuando lo corta por
 * detrás —apuntar a la espalda de un panel no debe activar sus botones— o
 * cuando el corte cae fuera del rectángulo.
 */
export function intersectPanel(
  origin: Vec3,
  direction: Vec3,
  frame: PanelFrame,
): PanelHit | null {
  const denominator = dot(direction, frame.normal);
  // Mayor que cero significaría que el rayo viaja en el sentido de la normal,
  // es decir, que llega desde detrás del panel.
  if (denominator > -1e-6) return null;

  const toCenter = sub(frame.center, origin);
  const distanceM = dot(toCenter, frame.normal) / denominator;
  if (distanceM <= 0) return null;

  const point = add(origin, scale(direction, distanceM));
  const offset = sub(point, frame.center);

  // Proyección sobre los semiejes: ±1 son los bordes.
  const halfWidth = length(frame.right);
  const halfHeight = length(frame.up);
  if (halfWidth < 1e-6 || halfHeight < 1e-6) return null;
  const x = dot(offset, scale(frame.right, 1 / (halfWidth * halfWidth)));
  const y = dot(offset, scale(frame.up, 1 / (halfHeight * halfHeight)));
  if (Math.abs(x) > 1 || Math.abs(y) > 1) return null;

  return { distanceM, u: (x + 1) / 2, v: (1 - y) / 2 };
}

/** Zona pulsable dentro del panel, en coordenadas normalizadas. */
export interface PanelTarget {
  readonly id: string;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** `false` para una zona visible pero no pulsable. */
  readonly enabled?: boolean;
}

/**
 * Zona pulsada, si alguna.
 *
 * Se recorre al revés para que la última declarada gane, igual que en una
 * pila de elementos superpuestos: un diálogo declarado después de un botón lo
 * tapa, y pulsando donde coinciden responde el diálogo.
 */
export function targetAt(hit: PanelHit, targets: readonly PanelTarget[]): PanelTarget | null {
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i]!;
    if (target.enabled === false) continue;
    if (hit.u >= target.u0 && hit.u <= target.u1 && hit.v >= target.v0 && hit.v <= target.v1) {
      return target;
    }
  }
  return null;
}

/**
 * Ordena los paneles abiertos por prioridad de interacción.
 *
 * Con un modal abierto, el rayo no debe poder pulsar nada detrás: un «modal»
 * que no bloquea es peor que no tenerlo, porque el visitante responde a una
 * pregunta y a la vez cambia de escena sin darse cuenta. Devuelve la lista de
 * paneles que admiten entrada en este fotograma.
 */
export function interactivePanels<T extends { readonly placement: VrPanelPlacement }>(
  panels: readonly T[],
): readonly T[] {
  const modal = panels.filter((panel) => panel.placement.mode === 'modal');
  return modal.length > 0 ? [modal[modal.length - 1]!] : panels;
}

/**
 * Arrastre de un panel (modo `draggable`).
 *
 * El arrastre se expresa en ángulos y no en metros porque el panel se mueve
 * sobre la esfera de radio `distanceM`: así conserva la distancia de lectura
 * y el tamaño aparente mientras el visitante lo coloca donde quiera.
 */
export function dragAnchor(anchor: PanelAnchor, deltaYaw: number, deltaPitch: number): PanelAnchor {
  if (anchor.mode !== 'draggable') return anchor;
  return {
    ...anchor,
    dragYaw: normalizeAngle(anchor.dragYaw + deltaYaw),
    dragPitch: clamp(anchor.dragPitch + deltaPitch, -0.9, 0.9),
  };
}

/* ------------------------------------------------------------------ *
 * Aritmética vectorial local
 *
 * Sin dependencias: estas seis funciones son el precio de que el módulo se
 * pueda probar sin cargar Three en un entorno sin WebGL.
 * ------------------------------------------------------------------ */

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-6 ? scale(a, 1 / l) : [1, 0, 0];
}

/**
 * Ángulo equivalente en [−π, π).
 *
 * El extremo cerrado es el negativo: media vuelta se expresa como −π. Da lo
 * mismo para lo que se usa —comparaciones de valor absoluto— pero el intervalo
 * se declara tal como es y no como sería más bonito.
 */
export function normalizeAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return wrapped - Math.PI;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;
