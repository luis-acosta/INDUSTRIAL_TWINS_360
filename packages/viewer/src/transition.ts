/**
 * Transiciones entre escenas (etapa 02, C04 y C10).
 *
 * El requisito pide «sensación de movimiento 3D». Se consigue combinando dos
 * cosas durante el cambio de escena: un avance de la cámara hacia el hotspot
 * que se ha pulsado (el zoom atraviesa el marcador) y un fundido entre las
 * dos panorámicas. El efecto no reconstruye la geometría real del espacio
 * —para eso está `useGeometry`, que sólo actúa cuando hay un modelo 3D de
 * fondo—, pero sí reproduce la señal que el cerebro interpreta como
 * desplazamiento: lo que se mira crece antes de que la imagen cambie.
 *
 * La máquina es pura y sin temporizadores propios: recibe el tiempo y
 * devuelve el estado visual. Así la transición se puede probar fotograma a
 * fotograma sin esperar setecientos milisegundos reales por caso.
 */
import {
  clamp,
  slerpSpherical,
  wrapYaw,
  type CameraView,
  type EntryMode,
  type Transition,
} from '@it360/domain';

export interface TransitionTarget {
  readonly sceneId: string;
  readonly entryMode: EntryMode;
  /** Vista explícita, para `custom`. */
  readonly customView?: CameraView;
  /** Vista inicial declarada en la escena destino. */
  readonly initialView: CameraView;
  /**
   * Orientación del hotspot de vuelta en la escena destino, si existe.
   * Es lo que permite la «entrada inteligente»: al llegar, el visitante mira
   * hacia donde seguiría avanzando y no hacia el punto del que viene.
   */
  readonly returnHotspotYaw?: number;
  /** Orientación del hotspot pulsado en la escena de origen. */
  readonly departureYaw?: number;
  readonly departurePitch?: number;
}

export interface TransitionState {
  readonly phase: 'idle' | 'departing' | 'arriving' | 'done';
  /** Progreso global 0-1. */
  readonly progress: number;
  /** Vista que debe aplicarse al renderizador de origen. */
  readonly fromView: CameraView;
  /** Vista que debe aplicarse al renderizador de destino. */
  readonly toView: CameraView;
  /** Opacidad de la escena de destino, 0-1. */
  readonly toOpacity: number;
  /** Escala aplicada a la escena de origen: produce el avance. */
  readonly fromScale: number;
}

/**
 * Calcula la vista de llegada según el modo de entrada (C11).
 *
 *  - `keepOrientation` conserva el yaw: da continuidad cuando dos escenas
 *    miran al mismo pasillo.
 *  - `initialView` usa la vista configurada en la escena.
 *  - `smart` mira en sentido contrario al hotspot de vuelta: el visitante
 *    llega mirando hacia delante y no hacia el sitio del que viene, que es lo
 *    que hace que un recorrido se sienta como caminar.
 *  - `custom` usa la vista declarada en la propia acción.
 */
export function resolveEntryView(
  current: CameraView,
  target: TransitionTarget,
): CameraView {
  switch (target.entryMode) {
    case 'keepOrientation':
      return { ...target.initialView, yaw: current.yaw, pitch: current.pitch };

    case 'custom':
      return target.customView ?? target.initialView;

    case 'smart': {
      if (target.returnHotspotYaw !== undefined) {
        return { ...target.initialView, yaw: wrapYaw(target.returnHotspotYaw + Math.PI) };
      }
      // Sin hotspot de vuelta no hay nada inteligente que deducir: se conserva
      // la orientación, que es mejor que un salto arbitrario.
      if (target.departureYaw !== undefined) {
        return { ...target.initialView, yaw: target.departureYaw };
      }
      return target.initialView;
    }

    case 'initialView':
    default:
      return target.initialView;
  }
}

/** Suavizado con entrada y salida amortiguadas. */
export function easeInOutCubic(t: number): number {
  const k = clamp(t, 0, 1);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  const k = clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 3);
}

export interface TransitionPlan {
  readonly transition: Transition;
  readonly fromView: CameraView;
  readonly toView: CameraView;
  /** Dirección del hotspot pulsado: hacia dónde avanza la cámara. */
  readonly travelYaw: number;
  readonly travelPitch: number;
}

/**
 * Prepara una transición.
 *
 * El plan se calcula una vez al iniciar y no en cada fotograma: así la
 * trayectoria no cambia si el usuario mueve el ratón a mitad del
 * desplazamiento.
 */
export function planTransition(
  current: CameraView,
  target: TransitionTarget,
  transition: Transition,
): TransitionPlan {
  return {
    transition,
    fromView: current,
    toView: resolveEntryView(current, target),
    travelYaw: target.departureYaw ?? current.yaw,
    travelPitch: target.departurePitch ?? current.pitch,
  };
}

/**
 * FOV mínimo al que llega el avance.
 *
 * Es la intensidad del «atravesar»: el FOV se estrecha hasta el 55 % del
 * inicial. Más que eso marea; menos no se percibe.
 */
const TRAVEL_FOV_FACTOR = 0.55;

/** Escala máxima de la escena de origen durante el avance. */
const TRAVEL_SCALE = 1.35;

/**
 * Evalúa el estado visual de la transición en un instante dado.
 *
 * `elapsedMs` es tiempo transcurrido desde el inicio; la función no guarda
 * estado. Devolver todo el estado visual —y no mutar objetos— es lo que
 * permite probar la curva completa con una tabla de instantes.
 */
export function evaluateTransition(plan: TransitionPlan, elapsedMs: number): TransitionState {
  const duration = Math.max(plan.transition.durationMs, 1);
  const t = clamp(elapsedMs / duration, 0, 1);

  if (plan.transition.kind === 'cut' || plan.transition.durationMs === 0) {
    // Un corte no tiene estado intermedio: ya en el instante cero la escena
    // de destino está completa. Devolver «en llegada» obligaría al visor a
    // esperar un fotograma para considerar terminada una transición que no
    // dura nada, y esa espera se notaría al encadenar escenas con el teclado.
    return {
      phase: 'done',
      progress: 1,
      fromView: plan.fromView,
      toView: plan.toView,
      toOpacity: 1,
      fromScale: 1,
    };
  }

  if (plan.transition.kind === 'fade') {
    return {
      phase: t >= 1 ? 'done' : 'arriving',
      progress: t,
      fromView: plan.fromView,
      toView: plan.toView,
      toOpacity: easeInOutCubic(t),
      fromScale: 1,
    };
  }

  // `zoomThrough` y `dolly3d`: la cámara de origen gira hacia el hotspot,
  // avanza estrechando el FOV, y la escena de destino aparece por encima.
  const departing = t < 0.5;
  const localT = departing ? t / 0.5 : (t - 0.5) / 0.5;

  const lookAt = slerpSpherical(
    { yaw: plan.fromView.yaw, pitch: plan.fromView.pitch },
    { yaw: plan.travelYaw, pitch: plan.travelPitch },
    easeInOutCubic(Math.min(t * 2, 1)),
  );

  const travelProgress = easeInOutCubic(t);
  const fromFov = plan.fromView.fov * (1 - (1 - TRAVEL_FOV_FACTOR) * travelProgress);

  return {
    phase: t >= 1 ? 'done' : departing ? 'departing' : 'arriving',
    progress: t,
    fromView: { yaw: lookAt.yaw, pitch: lookAt.pitch, fov: fromFov },
    toView: plan.toView,
    // El destino entra en la segunda mitad: primero se percibe el avance y
    // luego el cambio de lugar. Solapar ambos desde el inicio produce una
    // mezcla confusa en la que no se distingue ninguna de las dos escenas.
    toOpacity: departing ? 0 : easeOutCubic(localT),
    fromScale: 1 + (TRAVEL_SCALE - 1) * travelProgress,
  };
}

/** Transición instantánea, para cortes o cuando el movimiento está reducido. */
export const INSTANT_TRANSITION: Transition = {
  kind: 'cut',
  durationMs: 0,
  useGeometry: false,
};

/**
 * Elige la transición efectiva.
 *
 * Respeta `prefers-reduced-motion`: con esa preferencia activa, un
 * desplazamiento de 700 ms con zoom puede provocar malestar real, no una
 * simple molestia estética. El cambio de escena sigue ocurriendo; lo que se
 * elimina es el movimiento.
 */
export function effectiveTransition(
  requested: Transition,
  options: { reducedMotion: boolean; hasGeometry: boolean },
): Transition {
  if (options.reducedMotion) return INSTANT_TRANSITION;
  if (requested.useGeometry && !options.hasGeometry) {
    // Degradar a fundido sin avisar al visitante: es una mejora visual, no
    // una función que deba poder fallar de forma visible.
    return { ...requested, kind: 'fade', useGeometry: false };
  }
  return requested;
}
