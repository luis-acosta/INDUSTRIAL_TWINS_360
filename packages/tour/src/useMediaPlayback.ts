/**
 * Reproducción de medios desde una acción del recorrido (F10, J06).
 *
 * La acción «reproducir medio» existía en el vocabulario y su anfitrión en el
 * recorrido publicado era una función vacía: pulsar el marcador no sonaba
 * nada. Y la barra de reproducción de la interfaz preguntaba por el avance de
 * un medio que nunca empezaba, de modo que quedaba invisible.
 *
 * Decisiones que gobiernan el módulo:
 *
 * - **Un solo medio a la vez.** Dos locuciones simultáneas no se entienden, y
 *   en una planta el audio suele ser una instrucción. Al empezar uno nuevo se
 *   detiene el anterior.
 * - **El progreso se publica a intervalos, no en cada `timeupdate`.** El
 *   navegador dispara ese evento hasta cuatro veces por segundo y cada uno
 *   redibujaría el recorrido entero; cuatro por segundo es más de lo que una
 *   barra necesita, y a 250 ms el movimiento se ve continuo.
 * - **El fin se avisa una vez.** `ended` puede llegar junto a un `pause`
 *   final, y encadenar dos veces la acción siguiente abriría dos ventanas.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Periodo de publicación del avance. */
export const PROGRESS_TICK_MS = 250;

export interface MediaPlaybackState {
  /** Medio en curso, o `null` si no hay ninguno. */
  readonly mediaId: string | null;
  /** Fracción reproducida, 0..1, o `null` si no se conoce la duración. */
  readonly fraction: number | null;
  readonly playing: boolean;
}

export const IDLE_PLAYBACK: MediaPlaybackState = {
  mediaId: null,
  fraction: null,
  playing: false,
};

export interface UseMediaPlaybackOptions {
  /** URL del medio dentro del paquete, o `null` si no está. */
  readonly urlOf: (mediaId: string) => string | null;
  /** Se invoca cuando un medio termina (J06). */
  readonly onEnded?: (mediaId: string) => void;
}

export interface MediaPlaybackHandle {
  readonly state: MediaPlaybackState;
  play(mediaId: string, loop: boolean, volume: number): void;
  pause(mediaId?: string): void;
}

export function useMediaPlayback(options: UseMediaPlaybackOptions): MediaPlaybackHandle {
  const [state, setState] = useState<MediaPlaybackState>(IDLE_PLAYBACK);
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef<string | null>(null);
  const endedRef = useRef(false);

  const latest = useRef(options);
  latest.current = options;

  /** Suelta el elemento en curso sin avisar del fin. */
  const release = useCallback((): void => {
    const element = elementRef.current;
    if (element !== null) {
      element.pause();
      element.removeAttribute('src');
      // `load()` tras quitar la fuente aborta la descarga: sin esto, cambiar
      // de escena durante una locución larga deja la descarga viva.
      element.load();
    }
    elementRef.current = null;
    currentRef.current = null;
  }, []);

  const play = useCallback(
    (mediaId: string, loop: boolean, volume: number): void => {
      const url = latest.current.urlOf(mediaId);
      if (url === null) {
        // Un medio que el paquete no trae: puede ser un recorrido publicado
        // sin ese archivo. Se dice en la consola y no se rompe nada.
        console.warn(`[it360] el paquete no trae el medio ${mediaId}`);
        return;
      }

      release();
      endedRef.current = false;

      const element = new Audio(url);
      element.loop = loop;
      element.volume = Math.min(Math.max(volume, 0), 1);
      elementRef.current = element;
      currentRef.current = mediaId;

      element.addEventListener('ended', () => {
        if (loop) return;
        // Una sola vez: `ended` puede llegar junto a un `pause` final, y
        // encadenar dos veces la acción siguiente abriría dos ventanas.
        if (endedRef.current) return;
        endedRef.current = true;
        setState({ mediaId, fraction: 1, playing: false });
        latest.current.onEnded?.(mediaId);
      });

      element.addEventListener('error', () => {
        console.warn(`[it360] no se pudo reproducir el medio ${mediaId}`);
        setState(IDLE_PLAYBACK);
        release();
      });

      setState({ mediaId, fraction: 0, playing: true });

      const started = element.play();
      // El navegador rechaza la reproducción automática sin gesto del
      // visitante. No es un error del paquete: el medio queda listo y el
      // estado dice que no suena, para que la barra no mienta.
      if (started !== undefined) {
        started.catch(() => {
          setState((current) => ({ ...current, playing: false }));
        });
      }
    },
    [release],
  );

  const pause = useCallback(
    (mediaId?: string): void => {
      // Sin medio indicado se pausa lo que haya; con uno, sólo si es el que
      // suena. Pausar «el medio X» cuando suena Y silenciaría al equivocado.
      if (mediaId !== undefined && currentRef.current !== mediaId) return;
      elementRef.current?.pause();
      setState((current) => ({ ...current, playing: false }));
    },
    [],
  );

  /* Publicación del avance. */
  useEffect(() => {
    if (!state.playing) return undefined;

    const timer = globalThis.setInterval(() => {
      const element = elementRef.current;
      const mediaId = currentRef.current;
      if (element === null || mediaId === null) return;

      const duration = element.duration;
      const fraction =
        Number.isFinite(duration) && duration > 0
          ? Math.min(element.currentTime / duration, 1)
          : null;

      setState((current) =>
        current.fraction === fraction && current.playing === !element.paused
          ? current
          : { mediaId, fraction, playing: !element.paused },
      );
    }, PROGRESS_TICK_MS);

    return () => globalThis.clearInterval(timer);
  }, [state.playing]);

  useEffect(() => release, [release]);

  return { state, play, pause };
}
