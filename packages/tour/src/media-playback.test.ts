/**
 * Pruebas de la reproducción de medios del recorrido (F10, J06).
 *
 * La acción «reproducir medio» tenía un anfitrión vacío en el recorrido
 * publicado: pulsar el marcador no sonaba nada, y la barra de reproducción
 * preguntaba por el avance de un medio que nunca empezaba, de modo que quedaba
 * invisible.
 *
 * `Audio` se sustituye por un doble: jsdom no reproduce nada, y lo que hay que
 * comprobar es la conducta —un solo medio a la vez, el fin avisado una vez, el
 * rechazo de la reproducción automática reflejado en el estado— que es
 * exactamente lo que el doble permite provocar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { PROGRESS_TICK_MS, useMediaPlayback } from './useMediaPlayback';

interface FakeAudio {
  src: string;
  loop: boolean;
  volume: number;
  paused: boolean;
  duration: number;
  currentTime: number;
  readonly played: number;
  readonly pauses: number;
  readonly loads: number;
  fire(event: 'ended' | 'error'): void;
  playRejects: boolean;
}

let instances: FakeAudio[] = [];

function installAudio(): void {
  vi.stubGlobal(
    'Audio',
    class {
      src = '';
      loop = false;
      volume = 1;
      paused = true;
      duration = 10;
      currentTime = 0;
      played = 0;
      pauses = 0;
      loads = 0;
      playRejects = false;
      private readonly listeners = new Map<string, (() => void)[]>();

      constructor(url: string) {
        this.src = url;
        instances.push(this as unknown as FakeAudio);
      }

      addEventListener(name: string, listener: () => void): void {
        const list = this.listeners.get(name) ?? [];
        list.push(listener);
        this.listeners.set(name, list);
      }

      removeAttribute(): void {}

      load(): void {
        this.loads += 1;
      }

      play(): Promise<void> {
        this.played += 1;
        if (this.playRejects) return Promise.reject(new Error('autoplay bloqueado'));
        this.paused = false;
        return Promise.resolve();
      }

      pause(): void {
        this.pauses += 1;
        this.paused = true;
      }

      fire(name: 'ended' | 'error'): void {
        for (const listener of this.listeners.get(name) ?? []) listener();
      }
    },
  );
}

const URLS = new Map([
  ['audio-1', 'blob:uno'],
  ['audio-2', 'blob:dos'],
]);

function setup(onEnded?: (mediaId: string) => void) {
  return renderHook(() =>
    useMediaPlayback({
      urlOf: (mediaId) => URLS.get(mediaId) ?? null,
      ...(onEnded === undefined ? {} : { onEnded }),
    }),
  );
}

beforeEach(() => {
  instances = [];
  installAudio();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useMediaPlayback', () => {
  it('reproduce el medio pedido', () => {
    // TEST-MPB-001: la acción existía y su anfitrión era una función vacía.
    const { result } = setup();

    act(() => result.current.play('audio-1', false, 0.8));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.src).toBe('blob:uno');
    expect(instances[0]!.volume).toBe(0.8);
    expect(instances[0]!.played).toBe(1);
    expect(result.current.state).toMatchObject({ mediaId: 'audio-1', playing: true });
  });

  it('detiene el anterior al empezar otro', () => {
    // TEST-MPB-002: dos locuciones simultáneas no se entienden, y en una
    // planta el audio suele ser una instrucción.
    const { result } = setup();

    act(() => result.current.play('audio-1', false, 1));
    act(() => result.current.play('audio-2', false, 1));

    expect(instances[0]!.pauses).toBeGreaterThan(0);
    expect(result.current.state.mediaId).toBe('audio-2');
  });

  it('acota el volumen fuera de rango', () => {
    // TEST-MPB-003: un volumen mayor que uno lanza en algunos navegadores, y
    // la acción puede traerlo de un proyecto editado a mano.
    const { result } = setup();
    act(() => result.current.play('audio-1', false, 4));
    expect(instances[0]!.volume).toBe(1);
  });

  it('avisa del fin una sola vez', () => {
    // TEST-MPB-004: `ended` puede llegar junto a un `pause` final, y
    // encadenar dos veces la acción siguiente abriría dos ventanas.
    const onEnded = vi.fn();
    const { result } = setup(onEnded);

    act(() => result.current.play('audio-1', false, 1));
    act(() => instances[0]!.fire('ended'));
    act(() => instances[0]!.fire('ended'));

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith('audio-1');
  });

  it('no avisa del fin de un medio en bucle', () => {
    // TEST-MPB-005: un ambiente en bucle que encadenara la acción siguiente
    // en cada vuelta dispararía esa acción para siempre.
    const onEnded = vi.fn();
    const { result } = setup(onEnded);

    act(() => result.current.play('audio-1', true, 1));
    act(() => instances[0]!.fire('ended'));

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('deja de decir que suena si el navegador bloquea la reproducción', async () => {
    // TEST-MPB-006: sin gesto del visitante, el navegador rechaza la
    // reproducción automática. No es un error del paquete, pero la barra no
    // puede decir que algo suena cuando no suena.
    const { result } = setup();

    await act(async () => {
      // El doble rechaza el primer `play`.
      const original = globalThis.Audio;
      class Rejecting extends (original as unknown as { new (url: string): FakeAudio }) {
        constructor(url: string) {
          super(url);
          this.playRejects = true;
        }
      }
      vi.stubGlobal('Audio', Rejecting);
      result.current.play('audio-1', false, 1);
      await Promise.resolve();
    });

    expect(result.current.state.playing).toBe(false);
  });

  it('informa de un medio que el paquete no trae', () => {
    // TEST-MPB-007: ocurre en un paquete publicado sin ese archivo; no debe
    // romper el recorrido.
    const { result } = setup();
    act(() => result.current.play('ausente', false, 1));

    expect(instances).toHaveLength(0);
    expect(result.current.state.mediaId).toBeNull();
  });

  it('vuelve a reposo si el medio falla', () => {
    // TEST-MPB-008: un códec que falta deja la barra con un avance congelado
    // si no se limpia el estado.
    const { result } = setup();
    act(() => result.current.play('audio-1', false, 1));
    act(() => instances[0]!.fire('error'));

    expect(result.current.state).toMatchObject({ mediaId: null, playing: false });
  });

  it('pausa sólo el medio indicado', () => {
    // TEST-MPB-009: pausar «el medio X» cuando suena Y silenciaría al
    // equivocado, que en una instrucción de seguridad importa.
    const { result } = setup();
    act(() => result.current.play('audio-1', false, 1));

    act(() => result.current.pause('audio-2'));
    expect(result.current.state.playing).toBe(true);

    act(() => result.current.pause('audio-1'));
    expect(result.current.state.playing).toBe(false);
  });

  it('pausa lo que haya cuando no se indica medio', () => {
    // TEST-MPB-010: es lo que hace el botón de pausa de la interfaz.
    const { result } = setup();
    act(() => result.current.play('audio-1', false, 1));
    act(() => result.current.pause());
    expect(result.current.state.playing).toBe(false);
  });

  it('publica el avance a intervalos', () => {
    // TEST-MPB-011: el navegador dispara «timeupdate» hasta cuatro veces por
    // segundo y cada uno redibujaría el recorrido entero. A 250 ms el
    // movimiento se ve continuo y el coste es constante.
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.play('audio-1', false, 1));
    act(() => {
      instances[0]!.currentTime = 5;
      instances[0]!.duration = 10;
      vi.advanceTimersByTime(PROGRESS_TICK_MS);
    });

    expect(result.current.state.fraction).toBeCloseTo(0.5, 6);
  });

  it('deja la fracción nula si no se conoce la duración', () => {
    // TEST-MPB-012: un flujo sin duración declarada da infinito, y una barra
    // calculada con eso saldría siempre a cero sin decir por qué.
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.play('audio-1', false, 1));
    act(() => {
      instances[0]!.duration = Number.POSITIVE_INFINITY;
      instances[0]!.currentTime = 3;
      vi.advanceTimersByTime(PROGRESS_TICK_MS);
    });

    expect(result.current.state.fraction).toBeNull();
  });

  it('no deja el avance por encima del final', () => {
    // TEST-MPB-013: `currentTime` puede pasar de `duration` por unos
    // milisegundos, y una barra al 103 % se sale de su caja.
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.play('audio-1', false, 1));
    act(() => {
      instances[0]!.currentTime = 11;
      instances[0]!.duration = 10;
      vi.advanceTimersByTime(PROGRESS_TICK_MS);
    });

    expect(result.current.state.fraction).toBe(1);
  });

  it('suelta el medio al desmontar', () => {
    // TEST-MPB-014: cerrar el recorrido durante una locución larga dejaría la
    // descarga viva y el audio sonando.
    const { result, unmount } = setup();
    act(() => result.current.play('audio-1', false, 1));
    unmount();

    expect(instances[0]!.pauses).toBeGreaterThan(0);
    expect(instances[0]!.loads).toBeGreaterThan(0);
  });
});
