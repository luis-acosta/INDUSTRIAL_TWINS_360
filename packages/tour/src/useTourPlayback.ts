/**
 * Reproducción del recorrido automático en el visor publicado (J01–J03).
 *
 * El motor de estados es `tourReducer`, una función pura del dominio; este
 * gancho aporta lo único que esa función no puede tener: los temporizadores,
 * el audio y la cámara. La separación es la que permite probar el ciclo
 * completo sin esperar en tiempo real.
 *
 * Tres cosas que aquí no son detalles:
 *
 *  - **La interrupción manda sobre el temporizador.** Al interrumpir se
 *    cancela el temporizador pendiente y se para el audio. Sin eso, el
 *    recorrido «pausado» saltaría de escena unos segundos después y el
 *    visitante vería que el botón de pausa no sirve.
 *  - **La espera por audio tiene plazo.** El navegador bloquea la
 *    reproducción automática con sonido mientras nadie haya tocado la página;
 *    si la parada esperase el final de un audio que nunca suena, el recorrido
 *    se quedaría congelado. `dwellPlan` pone el techo y el gancho lo respeta.
 *  - **Al desmontar se limpia todo.** Un temporizador o un audio que
 *    sobreviven al cierre del recorrido mueven la cámara o suenan sobre la
 *    escena siguiente.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INITIAL_TOUR_RUNTIME,
  orderedWaypoints,
  shouldAutoResume,
  tourProgress,
  tourReducer,
  type Action,
  type Tour,
  type TourEvent,
  type TourRuntime,
} from '@it360/domain';
import { currentWaypoint, dwellPlan } from './playback';

export interface TourPlaybackHost {
  /** Lleva al visitante a la escena y la vista de la parada. */
  readonly goTo: (sceneId: string, view: { yaw: number; pitch: number; fov: number }) => void;
  /** Ejecuta las acciones configuradas al llegar a la parada (J02). */
  readonly runActions: (actions: readonly Action[]) => void;
  /** URL del audio de narración, o `null` si no hay o no está en el paquete. */
  readonly audioUrl: (mediaId: string | null) => string | null;
  /**
   * Avisa de que un medio terminó de reproducirse (J06).
   *
   * Opcional porque la reproducción de un recorrido guiado funciona sin
   * encadenar nada; quien quiera los disparadores de fin de medio lo
   * proporciona.
   */
  readonly mediaEnded?: (mediaId: string) => void;
}

export interface TourPlayback {
  readonly tour: Tour | null;
  readonly runtime: TourRuntime;
  readonly progress: number;
  readonly caption: string;
  readonly stopIndex: number;
  readonly stopCount: number;
  /** El audio de la parada está sonando ahora. */
  readonly narrating: boolean;
  readonly start: (tour: Tour, fromIndex?: number) => void;
  readonly stop: () => void;
  readonly interrupt: () => void;
  readonly resume: () => void;
  readonly skipNext: () => void;
  readonly skipPrevious: () => void;
}

/** Cada cuánto se comprueba la reanudación automática por inactividad. */
const IDLE_CHECK_MS = 1000;

export function useTourPlayback(host: TourPlaybackHost): TourPlayback {
  const [tour, setTour] = useState<Tour | null>(null);
  const [runtime, setRuntime] = useState<TourRuntime>(INITIAL_TOUR_RUNTIME);
  const [narrating, setNarrating] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** El anfitrión cambia en cada render del visor; se lee por referencia. */
  const hostRef = useRef(host);
  hostRef.current = host;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio !== null) {
      audio.onended = null;
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    }
    setNarrating(false);
  }, []);

  const dispatch = useCallback(
    (event: TourEvent) => {
      setRuntime((current) => tourReducer(current, event, tour, Date.now()));
    },
    [tour],
  );

  /* ---------------------------------------------------------------- *
   * Llegada a una parada
   * ---------------------------------------------------------------- */

  const waypoint = tour === null ? null : currentWaypoint(tour, runtime);

  /**
   * Al entrar en `traveling` se mueve la cámara y, en cuanto llega, se marca
   * la llegada. El desplazamiento no se interpola aquí: la cámara del visor
   * ya anima hacia la vista pedida, y duplicar la animación produciría dos
   * movimientos encadenados.
   */
  useEffect(() => {
    if (runtime.state !== 'traveling' || waypoint === null) return;

    hostRef.current.goTo(waypoint.sceneId, waypoint.view);

    const travel = setTimeout(() => dispatch({ type: 'arrive' }), Math.max(waypoint.travelMs, 0));
    return () => clearTimeout(travel);
  }, [runtime.state, runtime.waypointIndex, waypoint, dispatch]);

  /**
   * Al entrar en `dwelling` se ejecutan las acciones de la parada, suena la
   * narración y se arma el temporizador que la termina.
   */
  useEffect(() => {
    if (runtime.state !== 'dwelling' || waypoint === null) return;

    if (waypoint.actions.length > 0) hostRef.current.runActions(waypoint.actions);

    const url = hostRef.current.audioUrl(waypoint.audioMediaId);

    if (url !== null) {
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setNarrating(false);
        // El fin del medio es un evento del recorrido (J06): es lo que permite
        // encadenar «al acabar la locución, abre la ficha» sin que el autor
        // tenga que medir a mano cuánto dura la grabación.
        if (waypoint.audioMediaId !== null) {
          hostRef.current.mediaEnded?.(waypoint.audioMediaId);
        }
        if (waypoint.waitForAudio) dispatch({ type: 'dwellComplete' });
      };

      const played = audio.play();
      // `play()` devuelve una promesa que se rechaza si el navegador bloquea
      // la reproducción automática. Ese rechazo no es un error del paquete:
      // significa que la parada tiene que regirse por su permanencia.
      if (played !== undefined) {
        played.then(() => setNarrating(true)).catch(() => setNarrating(false));
      } else {
        setNarrating(true);
      }
    }

    const plan = dwellPlan(waypoint, url !== null);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      dispatch({ type: 'dwellComplete' });
    }, plan.dwellMs);

    return () => {
      clearTimer();
      stopAudio();
    };
  }, [runtime.state, runtime.waypointIndex, waypoint, dispatch, clearTimer, stopAudio]);

  /** Reanudación automática tras inactividad. */
  useEffect(() => {
    if (tour === null || runtime.state !== 'interrupted' || tour.autoResumeIdleS <= 0) return;

    const check = setInterval(() => {
      if (shouldAutoResume(runtime, tour, Date.now())) dispatch({ type: 'resume' });
    }, IDLE_CHECK_MS);

    return () => clearInterval(check);
  }, [tour, runtime, dispatch]);

  /** Al terminar no queda nada sonando ni pendiente. */
  useEffect(() => {
    if (runtime.state === 'finished' || runtime.state === 'idle') {
      clearTimer();
      stopAudio();
    }
  }, [runtime.state, clearTimer, stopAudio]);

  useEffect(
    () => () => {
      clearTimer();
      stopAudio();
    },
    [clearTimer, stopAudio],
  );

  /* ---------------------------------------------------------------- *
   * Mandos
   * ---------------------------------------------------------------- */

  const start = useCallback(
    (next: Tour, fromIndex = 0) => {
      clearTimer();
      stopAudio();
      setTour(next);
      setRuntime(
        tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: next.id, fromIndex }, next, Date.now()),
      );
    },
    [clearTimer, stopAudio],
  );

  const stop = useCallback(() => {
    clearTimer();
    stopAudio();
    setRuntime(INITIAL_TOUR_RUNTIME);
    setTour(null);
  }, [clearTimer, stopAudio]);

  /**
   * Interrumpir para de verdad: sin cancelar el temporizador, el recorrido
   * «pausado» saltaría de escena unos segundos después.
   */
  const interrupt = useCallback(() => {
    if (tour !== null && !tour.allowInterrupt) return;
    clearTimer();
    stopAudio();
    dispatch({ type: 'interrupt' });
  }, [tour, clearTimer, stopAudio, dispatch]);

  const resume = useCallback(() => dispatch({ type: 'resume' }), [dispatch]);

  const skipNext = useCallback(() => {
    if (tour === null) return;
    clearTimer();
    stopAudio();
    const last = tour.waypoints.length - 1;
    if (runtime.waypointIndex >= last) {
      dispatch(tour.loop ? { type: 'jumpTo', index: 0 } : { type: 'dwellComplete' });
      return;
    }
    dispatch({ type: 'jumpTo', index: runtime.waypointIndex + 1 });
  }, [tour, runtime.waypointIndex, clearTimer, stopAudio, dispatch]);

  const skipPrevious = useCallback(() => {
    if (tour === null) return;
    clearTimer();
    stopAudio();
    dispatch({ type: 'jumpTo', index: Math.max(runtime.waypointIndex - 1, 0) });
  }, [tour, runtime.waypointIndex, clearTimer, stopAudio, dispatch]);

  const ordered = useMemo(() => (tour === null ? [] : orderedWaypoints(tour)), [tour]);

  return {
    tour,
    runtime,
    progress: tour === null ? 0 : tourProgress(runtime, tour),
    caption: waypoint?.caption ?? '',
    stopIndex: runtime.waypointIndex,
    stopCount: ordered.length,
    narrating,
    start,
    stop,
    interrupt,
    resume,
    skipNext,
    skipPrevious,
  };
}
