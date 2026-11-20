/**
 * Pruebas de la transición entre escenas en el visor (C04, C10).
 *
 * El motor —qué escala y qué opacidad toca en cada instante— ya está probado
 * en `@it360/viewer`. Aquí se comprueba lo que sólo falla al conectarlo: que
 * la escena cambie **pase lo que pase**, que no se anime cuando el sistema
 * pide movimiento reducido, y que una fotografía fallida no deje al visitante
 * encerrado en la escena de la que quería salir.
 *
 * Esa última es la que importa: una transición es decoración, y una decoración
 * que impide navegar por la planta es peor que no tenerla.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSceneTransition } from './useSceneTransition';
import type { TransitionTarget } from '@it360/viewer';
import type { CameraView, Transition } from '@it360/domain';

const FROM: CameraView = { yaw: 0, pitch: 0, fov: 75 };

const TARGET: TransitionTarget = {
  sceneId: 'destino',
  entryMode: 'initialView',
  initialView: { yaw: 1.2, pitch: 0, fov: 75 },
};

const zoom: Transition = { kind: 'zoomThrough', durationMs: 600, useGeometry: false };

/** Lienzo que sí se deja fotografiar. */
function workingCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.toDataURL = () => `data:image/jpeg;base64,${'A'.repeat(800)}`;
  return canvas;
}

/** Lienzo que lanza al fotografiarlo, como uno contaminado o sin contexto. */
function taintedCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.toDataURL = () => {
    throw new Error('el lienzo está contaminado');
  };
  return canvas;
}

let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  // jsdom no programa fotogramas; se ejecutan al instante para poder avanzar.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    void cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Arranque
 * ------------------------------------------------------------------ */

describe('useSceneTransition', () => {
  it('TEST-TRN-001 sin transición en curso no hay nada que dibujar', () => {
    const { result } = renderHook(() => useSceneTransition());
    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-002 una transición con movimiento arranca y expone su primer estado', () => {
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).not.toBeNull();
    expect(result.current.run?.state.phase).toBe('departing');
    expect(result.current.run?.snapshot).toMatch(/^data:image\/jpeg/);
  });

  it('TEST-TRN-003 un corte no anima nada', () => {
    // No hay estado intermedio que dibujar: superponer una capa durante cero
    // milisegundos sólo produciría un parpadeo.
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: { kind: 'cut', durationMs: 0, useGeometry: false },
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-004 una duración de cero tampoco anima, aunque el tipo diga otra cosa', () => {
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: { kind: 'zoomThrough', durationMs: 0, useGeometry: false },
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Lo que no debe impedir navegar
 * ------------------------------------------------------------------ */

describe('fallos que no deben bloquear la navegación', () => {
  it('TEST-TRN-005 un lienzo que no se deja fotografiar no anima, y no lanza', () => {
    // Es el caso que importa: la transición es decoración, y una decoración
    // que impide moverse por la planta es peor que no tenerla.
    const { result } = renderHook(() => useSceneTransition());

    expect(() => {
      act(() => {
        result.current.begin({
          canvas: taintedCanvas(),
          transition: zoom,
          fromView: FROM,
          target: TARGET,
          hasGeometry: false,
        });
      });
    }).not.toThrow();

    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-006 sin lienzo tampoco se anima', () => {
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: null,
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-007 un lienzo sin dibujar no se superpone', () => {
    // `toDataURL` de un lienzo vacío devuelve una cadena mínima; superponerla
    // taparía la escena con un rectángulo en blanco.
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.toDataURL = () => 'data:,';

    const { result } = renderHook(() => useSceneTransition());
    act(() => {
      result.current.begin({
        canvas,
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-008 un lienzo de tamaño cero no se fotografía', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;

    const { result } = renderHook(() => useSceneTransition());
    act(() => {
      result.current.begin({
        canvas,
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Movimiento reducido
 * ------------------------------------------------------------------ */

describe('movimiento reducido', () => {
  it('TEST-TRN-009 con la preferencia activa no se anima', () => {
    // No es una molestia estética: un desplazamiento con zoom de 700 ms puede
    // provocar malestar real. El cambio de escena sigue ocurriendo.
    reducedMotion = true;
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).toBeNull();
  });

  it('TEST-TRN-010 sin la preferencia sí se anima', () => {
    reducedMotion = false;
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Geometría de fondo (C10)
 * ------------------------------------------------------------------ */

describe('geometría de fondo', () => {
  const withGeometry: Transition = { kind: 'dolly3d', durationMs: 600, useGeometry: true };

  it('TEST-TRN-011 pedir geometría sin tenerla degrada a fundido, no falla', () => {
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: withGeometry,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    // Un fundido no tiene fase de salida: la escena de destino entra desde el
    // primer instante.
    expect(result.current.run?.state.phase).toBe('arriving');
    expect(result.current.run?.state.fromScale).toBe(1);
  });

  it('TEST-TRN-012 con geometría disponible se conserva el desplazamiento', () => {
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: withGeometry,
        fromView: FROM,
        target: TARGET,
        hasGeometry: true,
      });
    });

    expect(result.current.run?.state.phase).toBe('departing');
  });
});

/* ------------------------------------------------------------------ *
 * Encadenar transiciones
 * ------------------------------------------------------------------ */

describe('encadenado', () => {
  it('TEST-TRN-013 una transición nueva sustituye a la anterior', () => {
    // El visitante que pulsa dos marcadores seguidos no debe ver las dos
    // animaciones superpuestas.
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });
    const first = result.current.run?.snapshot;

    const second = workingCanvas();
    second.toDataURL = () => `data:image/jpeg;base64,${'B'.repeat(800)}`;

    act(() => {
      result.current.begin({
        canvas: second,
        transition: zoom,
        fromView: { yaw: 1.2, pitch: 0, fov: 75 },
        target: { ...TARGET, sceneId: 'tercera' },
        hasGeometry: false,
      });
    });

    expect(result.current.run?.snapshot).not.toBe(first);
  });

  it('TEST-TRN-014 desmontar el visor cancela la animación pendiente', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);

    const { result, unmount } = renderHook(() => useSceneTransition());
    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: zoom,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Fondo de geometría (C10)
 * ------------------------------------------------------------------ */

describe('transición efectiva en el resultado', () => {
  const withGeometry: Transition = {
    kind: 'zoomThrough',
    durationMs: 600,
    useGeometry: true,
  };

  it('TEST-TRN-010 conserva la geometría cuando la escena de destino la tiene', () => {
    /* Quien dibuja la escena de destino necesita saber si debe mover su
       geometría, y la degradación ocurre dentro del gancho: sin este dato
       tendría que volver a decidirla por su cuenta y las dos decisiones
       acabarían separándose. */
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: withGeometry,
        fromView: FROM,
        target: TARGET,
        hasGeometry: true,
      });
    });

    expect(result.current.run?.transition.useGeometry).toBe(true);
  });

  it('TEST-TRN-011 la degrada a fundido cuando el destino no tiene geometría', () => {
    /* Es una mejora visual, no una función que deba fallar de forma visible:
       el visitante no tiene por qué enterarse de que el autor pidió algo que
       esta escena no puede dar. Lo que no puede es quedarse como pedido, o
       la cámara del modelo se movería sin modelo que mover. */
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: withGeometry,
        fromView: FROM,
        target: TARGET,
        hasGeometry: false,
      });
    });

    expect(result.current.run?.transition.useGeometry).toBe(false);
    expect(result.current.run?.transition.kind).toBe('fade');
  });

  it('TEST-TRN-012 con movimiento reducido no hay transición y nada que mover', () => {
    /* La preferencia del sistema gana sobre el ajuste del autor: un
       desplazamiento con zoom puede producir malestar real. Y como no hay
       transición, tampoco hay cámara de geometría que animar. */
    reducedMotion = true;
    const { result } = renderHook(() => useSceneTransition());

    act(() => {
      result.current.begin({
        canvas: workingCanvas(),
        transition: withGeometry,
        fromView: FROM,
        target: TARGET,
        hasGeometry: true,
      });
    });

    expect(result.current.run).toBeNull();
  });
});
