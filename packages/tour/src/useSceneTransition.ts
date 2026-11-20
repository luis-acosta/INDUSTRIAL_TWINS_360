/**
 * Transiciones visuales entre escenas (C04, C10).
 *
 * El motor —`planTransition` y `evaluateTransition`— ya existía y estaba
 * probado, pero nadie lo llamaba: el cambio de escena era instantáneo. Esto es
 * lo que lo conecta al visor.
 *
 * El recurso que lo hace posible sin un segundo contexto WebGL es que el
 * renderizador ya conserva su búfer de dibujo (se puso para exportar
 * fotogramas). Eso permite fotografiar el lienzo justo antes de cambiar de
 * escena y superponer esa imagen mientras la nueva carga debajo: la imagen se
 * agranda y se desvanece, y lo que el visitante percibe es que ha avanzado
 * hacia donde pulsó. Dos contextos WebGL en la misma página costarían memoria
 * de vídeo y, en equipos modestos, el segundo ni siquiera se crearía.
 *
 * Tres decisiones que no son de estilo:
 *
 *  - **La escena cambia de inmediato, no al terminar la animación.** La
 *    transición es decoración sobre un cambio que ya ocurrió; si el visitante
 *    pulsa otra vez a mitad, no hay nada que cancelar ni ningún estado que
 *    revertir.
 *  - **Si la fotografía falla, el cambio ocurre igual.** Un lienzo que no se
 *    deja fotografiar —porque el contexto se perdió, o porque el navegador lo
 *    considera contaminado— no puede impedir navegar por la planta.
 *  - **`prefers-reduced-motion` se respeta de verdad.** No es una molestia
 *    estética: un desplazamiento con zoom de 700 ms puede provocar malestar
 *    real. `effectiveTransition` lo convierte en corte, y entonces este gancho
 *    no llega a animar nada.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  INSTANT_TRANSITION,
  effectiveTransition,
  evaluateTransition,
  planTransition,
  type TransitionPlan,
  type TransitionState,
  type TransitionTarget,
} from '@it360/viewer';
import type { CameraView, Transition } from '@it360/domain';

export interface SceneTransitionRun {
  /** Imagen de la escena de la que se sale. */
  readonly snapshot: string;
  readonly state: TransitionState;
}

export interface SceneTransition {
  /** Transición en curso, o `null` cuando no hay ninguna. */
  readonly run: SceneTransitionRun | null;
  /**
   * Empieza una transición desde el lienzo dado.
   *
   * Devuelve la vista que el visor debe aplicar al llegar. Quien llama cambia
   * de escena a continuación, siempre: esta función no navega.
   */
  readonly begin: (input: BeginInput) => void;
}

export interface BeginInput {
  readonly canvas: HTMLCanvasElement | null;
  readonly transition: Transition;
  readonly fromView: CameraView;
  /**
   * Destino, en el tipo del propio motor.
   *
   * Se pasa el destino y no la vista ya resuelta para que sea `planTransition`
   * quien aplique el modo de entrada: qué significa «entrada inteligente» es
   * una regla del producto y debe decidirse en un solo sitio.
   */
  readonly target: TransitionTarget;
  /** La escena de destino tiene geometría 3D disponible (C10). */
  readonly hasGeometry: boolean;
}

/**
 * Consulta la preferencia del sistema sobre el movimiento.
 *
 * Se exporta porque la usan dos cosas distintas por el mismo motivo: las
 * transiciones entre escenas y los efectos ambientales. Dos consultas
 * separadas acabarían respondiendo distinto en cuanto una de ellas cambiara.
 */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Fotografía el lienzo.
 *
 * Devuelve `null` ante cualquier fallo en lugar de propagarlo: no poder
 * fotografiar es un motivo para no animar, nunca para no navegar.
 */
function snapshotOf(canvas: HTMLCanvasElement | null): string | null {
  if (canvas === null || canvas.width === 0 || canvas.height === 0) return null;

  try {
    const data = canvas.toDataURL('image/jpeg', 0.82);
    // Un lienzo sin dibujar devuelve una cadena mínima; superponerla taparía
    // la escena con un rectángulo en blanco.
    return data.length > 512 ? data : null;
  } catch {
    return null;
  }
}

export function useSceneTransition(): SceneTransition {
  const [run, setRun] = useState<SceneTransitionRun | null>(null);
  const frameRef = useRef<number | null>(null);
  const planRef = useRef<TransitionPlan | null>(null);
  const startedRef = useRef(0);
  const snapshotRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    planRef.current = null;
    snapshotRef.current = null;
    setRun(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const tick = useCallback(() => {
    const plan = planRef.current;
    const snapshot = snapshotRef.current;
    if (plan === null || snapshot === null) return;

    const state = evaluateTransition(plan, performance.now() - startedRef.current);

    if (state.phase === 'done') {
      stop();
      return;
    }

    setRun({ snapshot, state });
    frameRef.current = requestAnimationFrame(tick);
  }, [stop]);

  const begin = useCallback(
    ({ canvas, transition, fromView, target, hasGeometry }: BeginInput) => {
      stop();

      const effective = effectiveTransition(transition, {
        reducedMotion: prefersReducedMotion(),
        hasGeometry,
      });

      if (effective.kind === 'cut' || effective.durationMs === 0) return;

      const snapshot = snapshotOf(canvas);
      if (snapshot === null) return;

      const plan = planTransition(fromView, target, effective);

      planRef.current = plan;
      snapshotRef.current = snapshot;
      startedRef.current = performance.now();

      setRun({ snapshot, state: evaluateTransition(plan, 0) });
      frameRef.current = requestAnimationFrame(tick);
    },
    [stop, tick],
  );

  return { run, begin };
}

export { INSTANT_TRANSITION };
