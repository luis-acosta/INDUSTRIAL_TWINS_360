/**
 * Pruebas del ciclo de vida de la sesión inmersiva.
 *
 * No hay visor en el contenedor de integración y no lo habrá: lo que se puede
 * y se debe verificar aquí es la secuencia de llamadas y el tratamiento de los
 * fallos, que es donde están los defectos que dejan el visor en negro. El
 * `XRSystem` y la `XRSession` se sustituyen por dobles que implementan la
 * interfaz del navegador; la especificación de WebXR es la que fija qué tiene
 * que ocurrir y en qué orden, de modo que un doble fiel es una prueba legítima
 * de la integración, no una simulación del resultado.
 */
import { describe, expect, it, vi } from 'vitest';

import { IDLE_XR_STATUS, XrSessionController, type XrRendererBridge } from './xr-session';

/** Puente al gestor XR que registra el orden de las operaciones. */
function fakeBridge(): XrRendererBridge & { readonly log: string[]; loop: ((t: number, f?: XRFrame) => void) | null } {
  const log: string[] = [];
  return {
    log,
    loop: null,
    enabled: false,
    setReferenceSpaceType(type) {
      log.push(`reference:${type}`);
    },
    async setSession(session) {
      log.push(session === null ? 'session:null' : 'session:set');
    },
    setAnimationLoop(callback) {
      log.push(callback === null ? 'loop:null' : 'loop:set');
      this.loop = callback;
    },
  };
}

type EndListener = () => void;

/** Sesión que recuerda sus oyentes para poder disparar `end`. */
function fakeSession(options: { readonly floor?: boolean } = {}): XRSession & { fireEnd: () => void; ended: boolean } {
  const listeners: EndListener[] = [];
  const session = {
    ended: false,
    addEventListener(type: string, listener: EndListener) {
      if (type === 'end') listeners.push(listener);
    },
    removeEventListener(type: string, listener: EndListener) {
      if (type !== 'end') return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    async requestReferenceSpace(type: XRReferenceSpaceType) {
      if (type === 'local-floor' && options.floor === false) {
        throw new DOMException('sin zona de juego', 'NotSupportedError');
      }
      return {} as XRReferenceSpace;
    },
    async end() {
      session.ended = true;
      for (const listener of [...listeners]) listener();
    },
    fireEnd() {
      for (const listener of [...listeners]) listener();
    },
  };
  return session as unknown as XRSession & { fireEnd: () => void; ended: boolean };
}

/**
 * Sistema WebXR de prueba.
 *
 * El rechazo se declara con su nombre en vez de pasando un `DOMException`:
 * jsdom no hace que `DOMException` herede de `Error`, y una prueba que
 * dependiera de ello comprobaría una peculiaridad del entorno y no la
 * conducta del navegador.
 */
function fakeXr(session: XRSession | { readonly rejectAs: string }): XRSystem {
  const rejection = 'rejectAs' in session ? session.rejectAs : null;
  return {
    async requestSession() {
      if (rejection !== null) {
        const error = new Error(`rechazo simulado: ${rejection}`);
        error.name = rejection;
        throw error;
      }
      return session as XRSession;
    },
    async isSessionSupported() {
      return rejection === null;
    },
  } as unknown as XRSystem;
}

describe('XrSessionController', () => {
  it('habilita el gestor, fija el espacio y entrega la sesión en ese orden', async () => {
    // TEST-XRS-001: el orden no es indiferente. Entregar la sesión antes de
    // habilitar el gestor o antes de fijar el espacio de referencia produce un
    // primer fotograma sin pose válida, que en el visor se ve como un tirón.
    const bridge = fakeBridge();
    const controller = new XrSessionController({ xr: fakeXr(fakeSession()), renderer: bridge });

    const result = await controller.enter();

    expect(result.ok).toBe(true);
    expect(bridge.enabled).toBe(true);
    expect(bridge.log).toEqual(['reference:local-floor', 'session:set', 'loop:set']);
    expect(controller.current.phase).toBe('active');
  });

  it('retrocede a «local» cuando el visor no concede el suelo', async () => {
    // TEST-XRS-002: pedir sólo «local-floor» dejaría fuera a los visores en
    // los que el usuario no ha trazado la zona de juego, que no es un caso
    // raro: es el estado en el que sale un visor recién sacado de la caja.
    const bridge = fakeBridge();
    const controller = new XrSessionController({
      xr: fakeXr(fakeSession({ floor: false })),
      renderer: bridge,
    });

    const result = await controller.enter();

    expect(result.ok).toBe(true);
    expect(controller.current.referenceSpace).toBe('local');
    expect(bridge.log[0]).toBe('reference:local');
  });

  it('informa sin WebXR en lugar de fallar', async () => {
    // TEST-XRS-003: la mayoría de los visitantes abren el recorrido en un
    // navegador de escritorio. Ahí no hay nada que arreglar: hay que decirlo y
    // seguir mostrando el recorrido plano.
    const controller = new XrSessionController({ xr: undefined, renderer: fakeBridge() });

    const result = await controller.enter();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('XR_UNAVAILABLE');
    expect(controller.current.phase).toBe('idle');
  });

  it('distingue el permiso denegado del visor ocupado', async () => {
    // TEST-XRS-004: el primero se arregla volviendo a pulsar y el segundo
    // cerrando la otra aplicación. El mismo mensaje para los dos deja al
    // visitante sin saber qué hacer.
    const denied = new XrSessionController({
      xr: fakeXr({ rejectAs: 'NotAllowedError' }),
      renderer: fakeBridge(),
    });
    const busy = new XrSessionController({
      xr: fakeXr({ rejectAs: 'InvalidStateError' }),
      renderer: fakeBridge(),
    });

    const deniedResult = await denied.enter();
    const busyResult = await busy.enter();

    expect(deniedResult.ok).toBe(false);
    expect(busyResult.ok).toBe(false);
    if (!deniedResult.ok) expect(deniedResult.error.message).toContain('permiso');
    if (!busyResult.ok) expect(busyResult.error.message).toContain('Otra aplicación');
  });

  it('termina la sesión si la instalación falla', async () => {
    // TEST-XRS-005: una sesión concedida y no atendida deja el visor en negro
    // hasta que el sistema operativo la mata. Si no se puede usar, se cierra.
    const session = fakeSession();
    const bridge = fakeBridge();
    bridge.setSession = async () => {
      throw new Error('contexto gráfico perdido');
    };
    const controller = new XrSessionController({ xr: fakeXr(session), renderer: bridge });

    const result = await controller.enter();

    expect(result.ok).toBe(false);
    expect(session.ended).toBe(true);
    expect(controller.current.phase).toBe('idle');
  });

  it('recoge el estado cuando el visitante se quita las gafas', async () => {
    // TEST-XRS-006: la sesión puede acabar sin que nadie la cierre desde el
    // programa —al quitarse el visor o al pasar a otra aplicación—. Si no se
    // atiende el evento, el bucle inmersivo sigue instalado y el recorrido
    // plano no vuelve a dibujarse.
    const session = fakeSession();
    const bridge = fakeBridge();
    const statuses: string[] = [];
    const controller = new XrSessionController({
      xr: fakeXr(session),
      renderer: bridge,
      onStatusChange: (status) => statuses.push(status.phase),
    });

    await controller.enter();
    session.fireEnd();

    expect(controller.current).toEqual(IDLE_XR_STATUS);
    expect(bridge.enabled).toBe(false);
    expect(bridge.log).toContain('loop:null');
    expect(statuses).toEqual(['requesting', 'active', 'idle']);
  });

  it('entrega los fotogramas inmersivos al bucle del visor', async () => {
    // TEST-XRS-007: en XR los fotogramas los pide el visor. Dibujar con
    // requestAnimationFrame dentro de una sesión da un bucle desincronizado
    // del panel del visor, y eso se siente en el estómago.
    const bridge = fakeBridge();
    const frames: number[] = [];
    const controller = new XrSessionController({
      xr: fakeXr(fakeSession()),
      renderer: bridge,
      onXrFrame: (time) => frames.push(time),
    });

    await controller.enter();
    bridge.loop?.(16);
    bridge.loop?.(32);

    expect(frames).toEqual([16, 32]);
  });

  it('salir dos veces no es un error', async () => {
    // TEST-XRS-008: el botón de salir, el mando y el evento del visor pueden
    // llegar casi a la vez. La segunda salida tiene que ser inocua.
    const controller = new XrSessionController({
      xr: fakeXr(fakeSession()),
      renderer: fakeBridge(),
    });

    await controller.enter();
    await controller.exit();
    await expect(controller.exit()).resolves.toBeUndefined();
    expect(controller.activeSession).toBeNull();
  });

  it('entrar dos veces devuelve la sesión en curso', async () => {
    // TEST-XRS-009: dos pulsaciones rápidas no deben pedir dos sesiones; el
    // visor rechaza la segunda y el error confundiría al visitante.
    const session = fakeSession();
    const xr = fakeXr(session);
    const request = vi.spyOn(xr, 'requestSession');
    const controller = new XrSessionController({ xr, renderer: fakeBridge() });

    await controller.enter();
    const second = await controller.enter();

    expect(second.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('liberar el visor cierra la sesión abierta', async () => {
    // TEST-XRS-010: cerrar la pestaña con la sesión abierta deja al visor
    // presentando una escena que ya no se dibuja.
    const session = fakeSession();
    const controller = new XrSessionController({ xr: fakeXr(session), renderer: fakeBridge() });

    await controller.enter();
    controller.dispose();
    await Promise.resolve();

    expect(session.ended).toBe(true);
  });
});
