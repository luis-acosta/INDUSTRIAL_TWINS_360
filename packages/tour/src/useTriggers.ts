/**
 * Conexión de los disparadores con el recorrido (J04, J06, J07).
 *
 * `triggers.ts` decide **qué** toca disparar; este gancho se encarga del
 * **cuándo**: lleva el reloj, escucha los gestos del visitante y avisa al
 * ejecutor de acciones. Están separados porque la máquina se prueba sin reloj
 * y sin DOM, y lo que queda aquí es plomería que se comprueba montando el
 * recorrido.
 *
 * Dos decisiones que no son evidentes:
 *
 * - **El reloj corre a 250 ms y no por fotograma.** Un temporizador con
 *   resolución de un cuarto de segundo es indistinguible de uno exacto para
 *   una persona, y evaluarlo sesenta veces por segundo gasta batería en un
 *   equipo de planta sin añadir nada.
 * - **La actividad se escucha en la ventana y en captura.** Si se escuchara en
 *   el contenedor del recorrido, un clic sobre un panel abierto —que está en
 *   otra capa— no contaría como actividad y el aviso de inactividad saltaría
 *   con el visitante leyendo.
 */
import { useCallback, useEffect, useRef } from 'react';

import type { Action, ActionEvent } from '@it360/domain';

import {
  INITIAL_TRIGGERS,
  enterScene,
  focusChanged,
  mediaEnded,
  noteActivity,
  tick,
  tourBoundary,
  type DueAction,
  type TriggerState,
} from './triggers';

/** Periodo de evaluación del reloj, en milisegundos. */
export const TICK_MS = 250;

export interface UseTriggersOptions {
  /** Escena actual, o `null` mientras carga. */
  readonly sceneId: string | null;
  /** Acciones de la escena actual. */
  readonly sceneActions: readonly Action[];
  /** Acciones de la escena anterior, para poder ejecutar su salida. */
  readonly previousActions: readonly Action[];
  /** Ejecutor: recibe las acciones y el evento que las disparó. */
  readonly run: (actions: readonly Action[], event: ActionEvent) => void;
  /** Inactividad configurada por el proyecto. */
  readonly idleMs?: number;
  /** `false` detiene el reloj: recorrido en pausa o pestaña oculta. */
  readonly running?: boolean;
}

export interface TriggersHandle {
  /** Avisa de que un medio ha terminado (J06). */
  notifyMediaEnd(mediaId: string, actions: readonly Action[]): void;
  /** Avisa de un cambio de foco visual (J07). */
  notifyFocus(previousId: string | null, nextId: string | null, actionsOf: (id: string) => readonly Action[]): void;
  /** Avisa del inicio o fin de un recorrido guiado. */
  notifyTour(event: 'tourStart' | 'tourEnd', actions: readonly Action[]): void;
  /** Registra actividad del visitante a mano, si hace falta. */
  notifyActivity(): void;
}

export function useTriggers(options: UseTriggersOptions): TriggersHandle {
  const stateRef = useRef<TriggerState>(INITIAL_TRIGGERS);
  // Las opciones cambian en cada render; el reloj las lee de una referencia
  // para no reinstalarse, que reiniciaría la cuenta de cada temporizador en
  // cada cambio de estado del recorrido.
  const latest = useRef(options);
  latest.current = options;

  const dispatch = useCallback((due: readonly DueAction[]): void => {
    // Se agrupa por evento: el ejecutor filtra por evento, así que pasarle una
    // lista mezclada haría que descartara casi todo. Agrupar aquí mantiene el
    // orden en que la máquina los produjo, que es el orden del autor.
    const byEvent = new Map<ActionEvent, Action[]>();
    for (const { action, event } of due) {
      const list = byEvent.get(event);
      if (list === undefined) byEvent.set(event, [action]);
      else list.push(action);
    }
    for (const [event, actions] of byEvent) {
      latest.current.run(actions, event);
    }
  }, []);

  // --- Entrada y salida de escena ---
  useEffect(() => {
    const { sceneId, sceneActions, previousActions } = latest.current;
    const result = enterScene(stateRef.current, sceneId, Date.now(), previousActions, sceneActions);
    stateRef.current = result.state;
    dispatch(result.due);
  }, [options.sceneId, dispatch]);

  // --- Reloj: temporizadores e inactividad ---
  useEffect(() => {
    if (options.running === false) return undefined;

    const timer = globalThis.setInterval(() => {
      const current = latest.current;
      const result = tick(stateRef.current, {
        nowMs: Date.now(),
        sceneId: current.sceneId,
        sceneActions: current.sceneActions,
        idleMs: current.idleMs,
        running: current.running,
      });
      stateRef.current = result.state;
      dispatch(result.due);
    }, TICK_MS);

    return () => globalThis.clearInterval(timer);
  }, [options.running, dispatch]);

  // --- Actividad del visitante ---
  useEffect(() => {
    const mark = (): void => {
      stateRef.current = noteActivity(stateRef.current, Date.now());
    };

    // En captura y en la ventana: un clic sobre un panel abierto no burbujea
    // hasta el contenedor del recorrido, y sin esto no contaría como
    // actividad.
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) {
      globalThis.addEventListener?.(name, mark, { capture: true, passive: true });
    }
    return () => {
      for (const name of events) {
        globalThis.removeEventListener?.(name, mark, { capture: true });
      }
    };
  }, []);

  return {
    notifyMediaEnd: useCallback(
      (mediaId, actions) => {
        const result = mediaEnded(stateRef.current, mediaId, actions);
        stateRef.current = result.state;
        dispatch(result.due);
      },
      [dispatch],
    ),
    notifyFocus: useCallback(
      (previousId, nextId, actionsOf) => {
        const result = focusChanged(stateRef.current, previousId, nextId, actionsOf);
        stateRef.current = result.state;
        dispatch(result.due);
      },
      [dispatch],
    ),
    notifyTour: useCallback(
      (event, actions) => {
        const result = tourBoundary(stateRef.current, event, actions);
        stateRef.current = result.state;
        dispatch(result.due);
      },
      [dispatch],
    ),
    notifyActivity: useCallback(() => {
      stateRef.current = noteActivity(stateRef.current, Date.now());
    }, []),
  };
}
