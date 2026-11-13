import { describe, expect, it } from 'vitest';
import { degToRad, radToDeg, type CameraView, type Transition } from '@it360/domain';
import {
  effectiveTransition,
  evaluateTransition,
  INSTANT_TRANSITION,
  planTransition,
  resolveEntryView,
  type TransitionTarget,
} from './transition';
import {
  ActionRunner,
  IDLE_DWELL,
  updateFocusDwell,
  type ActionHost,
} from './action-runtime';
import { AdaptiveResolution } from './model-viewer';
import {
  applyVrInput,
  DEFAULT_VR_PANEL,
  IDLE_VR_SESSION,
  isPanelReadable,
  isVrCompatible,
  SNAP_TURN_RAD,
  VR_PROFILES,
  vrCompatibilityWarnings,
} from './webxr';
import { makeHotspot, testUuid } from '@it360/domain/testing';

const view = (yaw = 0, pitch = 0, fov = 75): CameraView => ({ yaw, pitch, fov });

const target = (overrides: Partial<TransitionTarget> = {}): TransitionTarget => ({
  sceneId: testUuid(2),
  entryMode: 'initialView',
  initialView: view(1, 0.2, 70),
  ...overrides,
});

/**
 * TEST-TRN-001 .. TEST-TRN-012 (transiciones, C04, C10, C11)
 * TEST-ACT-001 .. TEST-ACT-012 (motor de acciones, grupo J)
 * TEST-M3D-001 .. (resolución adaptativa, V03)
 * TEST-VR-001 .. (subconjunto compatible, grupo N)
 */
describe('modo de entrada (C11)', () => {
  it('TEST-TRN-001: keepOrientation conserva la dirección de la mirada', () => {
    const result = resolveEntryView(view(1.5, 0.3), target({ entryMode: 'keepOrientation' }));
    expect(result.yaw).toBeCloseTo(1.5, 9);
    expect(result.pitch).toBeCloseTo(0.3, 9);
  });

  it('TEST-TRN-002: initialView usa la vista configurada en la escena', () => {
    const result = resolveEntryView(view(1.5, 0.3), target({ entryMode: 'initialView' }));
    expect(result.yaw).toBeCloseTo(1, 9);
    expect(result.fov).toBe(70);
  });

  it('TEST-TRN-003: la entrada inteligente mira en sentido contrario al hotspot de vuelta', () => {
    // Es lo que hace que un recorrido se sienta como caminar: se llega
    // mirando hacia delante, no hacia el sitio del que se viene.
    const result = resolveEntryView(
      view(0, 0),
      target({ entryMode: 'smart', returnHotspotYaw: degToRad(30) }),
    );
    expect(radToDeg(result.yaw)).toBeCloseTo(210 - 360, 4);
  });

  it('TEST-TRN-004: sin hotspot de vuelta, la entrada inteligente no inventa nada', () => {
    const result = resolveEntryView(view(0.8, 0), target({ entryMode: 'smart', departureYaw: 0.8 }));
    expect(result.yaw).toBeCloseTo(0.8, 9);
  });

  it('TEST-TRN-005: custom usa la vista declarada en la acción', () => {
    const custom = view(2.2, -0.4, 50);
    const result = resolveEntryView(view(0, 0), target({ entryMode: 'custom', customView: custom }));
    expect(result).toEqual(custom);
  });
});

describe('curva de transición', () => {
  const fade: Transition = { kind: 'fade', durationMs: 700, useGeometry: false };
  const through: Transition = { kind: 'zoomThrough', durationMs: 700, useGeometry: false };

  it('TEST-TRN-006: el corte es instantáneo', () => {
    const plan = planTransition(view(), target(), INSTANT_TRANSITION);
    const state = evaluateTransition(plan, 0);
    expect(state.toOpacity).toBe(1);
    expect(state.phase).toBe('done');
  });

  it('TEST-TRN-007: el fundido progresa de 0 a 1', () => {
    const plan = planTransition(view(), target(), fade);
    expect(evaluateTransition(plan, 0).toOpacity).toBeCloseTo(0, 6);
    expect(evaluateTransition(plan, 350).toOpacity).toBeCloseTo(0.5, 2);
    expect(evaluateTransition(plan, 700).toOpacity).toBeCloseTo(1, 6);
    expect(evaluateTransition(plan, 900).phase).toBe('done');
  });

  it('TEST-TRN-008: el avance estrecha el campo de visión de la escena de origen', () => {
    // El zoom hacia el hotspot es lo que el cerebro interpreta como
    // desplazamiento: lo que se mira crece antes de que la imagen cambie.
    const plan = planTransition(view(0, 0, 75), target({ departureYaw: 1 }), through);
    const mid = evaluateTransition(plan, 350);
    const end = evaluateTransition(plan, 700);
    expect(mid.fromView.fov).toBeLessThan(75);
    expect(end.fromView.fov).toBeLessThan(mid.fromView.fov);
    expect(end.fromScale).toBeGreaterThan(mid.fromScale);
  });

  it('TEST-TRN-009: el avance gira la cámara hacia el hotspot pulsado', () => {
    const plan = planTransition(view(0, 0), target({ departureYaw: degToRad(60) }), through);
    const mid = evaluateTransition(plan, 350);
    expect(radToDeg(mid.fromView.yaw)).toBeGreaterThan(30);
  });

  it('TEST-TRN-010: el destino sólo aparece en la segunda mitad', () => {
    // Solapar ambas escenas desde el inicio produce una mezcla en la que no
    // se distingue ninguna de las dos.
    const plan = planTransition(view(), target(), through);
    expect(evaluateTransition(plan, 100).toOpacity).toBe(0);
    expect(evaluateTransition(plan, 349).toOpacity).toBe(0);
    expect(evaluateTransition(plan, 500).toOpacity).toBeGreaterThan(0);
    expect(evaluateTransition(plan, 700).toOpacity).toBeCloseTo(1, 6);
  });

  it('TEST-TRN-011: el progreso queda acotado fuera del intervalo', () => {
    const plan = planTransition(view(), target(), through);
    expect(evaluateTransition(plan, -100).progress).toBe(0);
    expect(evaluateTransition(plan, 99_999).progress).toBe(1);
  });
});

describe('transición efectiva', () => {
  const requested: Transition = { kind: 'zoomThrough', durationMs: 700, useGeometry: true };

  it('TEST-TRN-012: el movimiento reducido del sistema sustituye por un corte', () => {
    // Con esa preferencia activa, un desplazamiento con zoom puede provocar
    // malestar real, no una simple molestia estética.
    const result = effectiveTransition(requested, { reducedMotion: true, hasGeometry: true });
    expect(result).toEqual(INSTANT_TRANSITION);
  });

  it('TEST-TRN-013: sin geometría de fondo degrada a fundido en silencio', () => {
    const result = effectiveTransition(requested, { reducedMotion: false, hasGeometry: false });
    expect(result.kind).toBe('fade');
    expect(result.useGeometry).toBe(false);
    expect(result.durationMs).toBe(700);
  });

  it('TEST-TRN-014: con geometría se conserva la transición solicitada', () => {
    const result = effectiveTransition(requested, { reducedMotion: false, hasGeometry: true });
    expect(result).toEqual(requested);
  });
});

/* ------------------------------------------------------------------ */

function makeHost(): ActionHost & { calls: string[]; scores: Map<string, number> } {
  const calls: string[] = [];
  const scores = new Map<string, number>();
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}:${args.map((a) => JSON.stringify(a)).join(',')}`);
    };

  return {
    calls,
    scores,
    goToScene: record('goToScene'),
    lookAt: record('lookAt'),
    openInfoWindow: record('openInfoWindow'),
    openMedia: record('openMedia'),
    openDocument: record('openDocument'),
    downloadFile: record('downloadFile'),
    openUrl: record('openUrl'),
    openWebframe: record('openWebframe'),
    setElementVisibility: record('setElementVisibility'),
    setVariable: (namespace, key, operation, value) => {
      const current = scores.get(key) ?? 0;
      const next = operation === 'set' ? value : operation === 'add' ? current + value : current - value;
      scores.set(key, next);
      calls.push(`setVariable:${namespace}.${key}=${next}`);
    },
    getVariable: (_namespace, key) => scores.get(key) ?? 0,
    startTour: record('startTour'),
    stopTour: record('stopTour'),
    startQuiz: record('startQuiz'),
    showAsset: record('showAsset'),
    createNote: record('createNote'),
    showPlan: record('showPlan'),
    setVisualEffect: record('setVisualEffect'),
    playMedia: record('playMedia'),
    pauseMedia: record('pauseMedia'),
    enterVr: record('enterVr'),
    exitVr: record('exitVr'),
    modelPlayAnimation: record('modelPlayAnimation'),
    modelSetVisibility: record('modelSetVisibility'),
    runScript: record('runScript'),
    log: record('log'),
  };
}

const action = (config: unknown, overrides: Record<string, unknown> = {}): never =>
  ({
    id: testUuid(900),
    event: 'click',
    config,
    order: 0,
    delayMs: 0,
    focusDwellMs: 1200,
    once: false,
    requiresScore: null,
    enabled: true,
    ...overrides,
  }) as never;

const CONTEXT = { device: 'desktop', online: true, published: false, inVr: false } as const;

describe('motor de acciones', () => {
  it('TEST-ACT-001: ejecuta la acción del evento correspondiente', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const outcomes = await runner.run(
      [action({ type: 'stopTour' }), action({ type: 'startQuiz', quizId: testUuid(5) }, { event: 'sceneEnter', id: testUuid(901) })],
      'click',
      { context: CONTEXT, nowMs: 0 },
    );
    expect(outcomes).toHaveLength(1);
    expect(host.calls.some((c) => c.startsWith('stopTour'))).toBe(true);
    expect(host.calls.some((c) => c.startsWith('startQuiz'))).toBe(false);
  });

  it('TEST-ACT-002: respeta el orden declarado', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    await runner.run(
      [
        action({ type: 'stopTour' }, { id: testUuid(902), order: 2 }),
        action({ type: 'enterVr' }, { id: testUuid(903), order: 1 }),
      ],
      'click',
      { context: CONTEXT, nowMs: 0 },
    );
    expect(host.calls[0]?.startsWith('enterVr')).toBe(true);
    expect(host.calls[1]?.startsWith('stopTour')).toBe(true);
  });

  it('TEST-ACT-003: «una sola vez» no se repite en la misma sesión', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const once = action({ type: 'stopTour' }, { once: true });

    await runner.run([once], 'click', { context: CONTEXT, nowMs: 0 });
    const second = await runner.run([once], 'click', { context: CONTEXT, nowMs: 100 });

    expect(host.calls.filter((c) => c.startsWith('stopTour'))).toHaveLength(1);
    expect(second[0]?.status).toBe('skipped');
    expect(second[0]?.reason).toContain('ya se ejecutó');
  });

  it('TEST-ACT-004: reiniciar la sesión olvida el registro', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const once = action({ type: 'stopTour' }, { once: true });

    await runner.run([once], 'click', { context: CONTEXT, nowMs: 0 });
    runner.resetSession();
    await runner.run([once], 'click', { context: CONTEXT, nowMs: 100 });

    expect(host.calls.filter((c) => c.startsWith('stopTour'))).toHaveLength(2);
  });

  it('TEST-ACT-005: la condición de puntuación bloquea la acción (J08, O08)', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const gated = action(
      { type: 'startTour', tourId: testUuid(7), fromWaypointIndex: 0 },
      { requiresScore: { key: 'seguridad', comparison: 'gte', value: 10 } },
    );

    const blocked = await runner.run([gated], 'click', { context: CONTEXT, nowMs: 0 });
    expect(blocked[0]?.status).toBe('skipped');

    host.scores.set('seguridad', 12);
    const allowed = await runner.run([gated], 'click', { context: CONTEXT, nowMs: 100 });
    expect(allowed[0]?.status).toBe('executed');
  });

  it('TEST-ACT-006: sin conexión, las acciones de red se omiten con motivo', async () => {
    // La arquitectura exige que lo que depende de Internet lo indique en vez
    // de fallar en silencio.
    const host = makeHost();
    const runner = new ActionRunner(host);
    const outcomes = await runner.run(
      [action({ type: 'openUrl', url: 'https://ejemplo.com', external: true })],
      'click',
      { context: { ...CONTEXT, online: false }, nowMs: 0 },
    );
    expect(outcomes[0]?.status).toBe('skipped');
    expect(outcomes[0]?.reason).toContain('sin conexión');
    expect(host.calls).toHaveLength(0);
  });

  it('TEST-ACT-007: el recorrido publicado no permite crear notas', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const outcomes = await runner.run([action({ type: 'createNote' })], 'click', {
      context: { ...CONTEXT, published: true },
      nowMs: 0,
    });
    expect(outcomes[0]?.status).toBe('skipped');
    expect(outcomes[0]?.reason).toContain('solo lectura');
  });

  it('TEST-ACT-008: salir de VR fuera de una sesión se omite', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const outcomes = await runner.run([action({ type: 'exitVr' })], 'click', {
      context: CONTEXT,
      nowMs: 0,
    });
    expect(outcomes[0]?.status).toBe('skipped');
  });

  it('TEST-ACT-009: el retardo programa la acción en lugar de ejecutarla (J04)', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const scheduled: Array<{ fn: () => void; delay: number }> = [];

    await runner.run([action({ type: 'stopTour' }, { delayMs: 3000 })], 'click', {
      context: CONTEXT,
      nowMs: 0,
      schedule: (fn, delay) => scheduled.push({ fn, delay }),
    });

    expect(host.calls).toHaveLength(0);
    expect(scheduled[0]?.delay).toBe(3000);
    scheduled[0]?.fn();
    await Promise.resolve();
    expect(host.calls.some((c) => c.startsWith('stopTour'))).toBe(true);
  });

  it('TEST-ACT-010: una acción que falla no detiene las siguientes', async () => {
    // Un recorrido publicado puede tener una acción rota; detener la cadena
    // dejaría al visitante atrapado.
    const host = makeHost();
    host.openMedia = () => {
      throw new Error('medio inexistente');
    };
    const runner = new ActionRunner(host);

    const outcomes = await runner.run(
      [
        action({ type: 'openMedia', mediaId: testUuid(9), albumMediaIds: [], autoplay: false }, { id: testUuid(910), order: 0 }),
        action({ type: 'stopTour' }, { id: testUuid(911), order: 1 }),
      ],
      'click',
      { context: CONTEXT, nowMs: 0 },
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[1]?.status).toBe('executed');
    expect(host.calls.some((c) => c.startsWith('log'))).toBe(true);
  });

  it('TEST-ACT-011: las acciones desactivadas se ignoran', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    const outcomes = await runner.run([action({ type: 'stopTour' }, { enabled: false })], 'click', {
      context: CONTEXT,
      nowMs: 0,
    });
    expect(outcomes).toHaveLength(0);
  });

  it('TEST-ACT-012: setVariable aplica la operación declarada', async () => {
    const host = makeHost();
    const runner = new ActionRunner(host);
    await runner.run(
      [action({ type: 'setVariable', namespace: 'score', key: 'seguridad', operation: 'add', value: 5 })],
      'click',
      { context: CONTEXT, nowMs: 0 },
    );
    expect(host.scores.get('seguridad')).toBe(5);
  });
});

describe('disparo por mirada sostenida (D13)', () => {
  it('TEST-ACT-013: no dispara antes del tiempo de permanencia', () => {
    let state = updateFocusDwell(IDLE_DWELL, 'h1', 1000, 0);
    state = updateFocusDwell(state, 'h1', 1000, 500);
    expect(state.triggered).toBe(false);
    expect(state.progress).toBeCloseTo(0.5, 6);
  });

  it('TEST-ACT-014: dispara al cumplirse el tiempo', () => {
    let state = updateFocusDwell(IDLE_DWELL, 'h1', 1000, 0);
    state = updateFocusDwell(state, 'h1', 1000, 1100);
    expect(state.triggered).toBe(true);
  });

  it('TEST-ACT-015: apartar la mirada reinicia el contador', () => {
    // Sin esto, cruzar la escena activaría todo lo que quedara en el camino.
    let state = updateFocusDwell(IDLE_DWELL, 'h1', 1000, 0);
    state = updateFocusDwell(state, 'h1', 1000, 800);
    state = updateFocusDwell(state, null, 1000, 850);
    expect(state).toEqual(IDLE_DWELL);

    state = updateFocusDwell(state, 'h1', 1000, 900);
    expect(state.progress).toBe(0);
  });

  it('TEST-ACT-016: cambiar de marcador reinicia el contador', () => {
    let state = updateFocusDwell(IDLE_DWELL, 'h1', 1000, 0);
    state = updateFocusDwell(state, 'h2', 1000, 900);
    expect(state.targetId).toBe('h2');
    expect(state.progress).toBe(0);
  });

  it('TEST-ACT-017: no vuelve a disparar mientras se mantenga la mirada', () => {
    let state = updateFocusDwell(IDLE_DWELL, 'h1', 500, 0);
    state = updateFocusDwell(state, 'h1', 500, 600);
    const triggered = state;
    state = updateFocusDwell(state, 'h1', 500, 1200);
    expect(state).toBe(triggered);
  });
});

describe('resolución adaptativa (V03)', () => {
  it('TEST-M3D-001: baja la resolución cuando no se sostiene la tasa objetivo', () => {
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    let state = adaptive.sample(16, 0);
    expect(state.pixelRatio).toBe(2);

    // 20 fps sostenidos.
    let now = 600;
    for (let i = 0; i < 20; i += 1) {
      state = adaptive.sample(50, now);
      now += 600;
    }
    expect(state.pixelRatio).toBeLessThan(2);
    expect(state.degraded).toBe(true);
  });

  it('TEST-M3D-002: no baja por debajo del mínimo configurado', () => {
    const adaptive = new AdaptiveResolution(60, 0.6, 2);
    let state = adaptive.sample(16, 0);
    let now = 600;
    for (let i = 0; i < 60; i += 1) {
      state = adaptive.sample(200, now);
      now += 600;
    }
    expect(state.pixelRatio).toBeGreaterThanOrEqual(0.6);
  });

  it('TEST-M3D-003: subir exige estabilidad sostenida y no oscila', () => {
    // El parpadeo de resolución es más molesto que la pérdida de nitidez.
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    let now = 0;
    for (let i = 0; i < 20; i += 1) {
      adaptive.sample(50, now);
      now += 600;
    }
    const degraded = adaptive.sample(50, now).pixelRatio;

    // Un segundo a buena tasa no basta.
    now += 1000;
    const afterShortRecovery = adaptive.sample(8, now).pixelRatio;
    expect(afterShortRecovery).toBeCloseTo(degraded, 6);
  });
});

describe('subconjunto compatible con VR', () => {
  it('TEST-VR-001: los componentes densos quedan fuera de VR', () => {
    // Un editor de skins o una tabla densa no se manejan con un mando a tres
    // metros de distancia.
    expect(isVrCompatible('button')).toBe(true);
    expect(isVrCompatible('quizCard')).toBe(true);
    expect(isVrCompatible('webframe')).toBe(false);
    expect(isVrCompatible('notesPanel')).toBe(false);
  });

  it('TEST-VR-002: avisa de marcadores marcados para VR que no lo soportan', () => {
    const webframe = makeHotspot(1, testUuid(40), {
      name: 'Panel SCADA',
      geometry: { shape: 'webframe', url: 'https://interno.local', widthPx: 640, heightPx: 400 },
    });
    const warnings = vrCompatibilityWarnings([webframe], [], VR_PROFILES['standalone']!);
    expect(warnings.some((w) => w.includes('Panel SCADA'))).toBe(true);
  });

  it('TEST-VR-003: avisa cuando hay demasiados marcadores para el perfil', () => {
    const many = Array.from({ length: 40 }, (_, i) => makeHotspot(i, testUuid(40)));
    const warnings = vrCompatibilityWarnings(many, [], VR_PROFILES['standalone']!);
    expect(warnings.some((w) => w.includes('24'))).toBe(true);
  });

  it('TEST-VR-004: una escena compatible no genera avisos', () => {
    const icon = makeHotspot(1, testUuid(40));
    expect(vrCompatibilityWarnings([icon], ['button', 'text'], VR_PROFILES['tethered']!)).toEqual([]);
  });

  it('TEST-VR-005: el giro del mando es por pasos y no continuo', () => {
    // El giro continuo es la causa principal del malestar en VR.
    const turned = applyVrInput(IDLE_VR_SESSION, 'rotateRight');
    expect(turned.yawOffset).toBeCloseTo(SNAP_TURN_RAD, 9);
    expect(radToDeg(SNAP_TURN_RAD)).toBeCloseTo(30, 6);
  });

  it('TEST-VR-006: salir de VR restablece el estado', () => {
    const turned = applyVrInput(IDLE_VR_SESSION, 'rotateLeft');
    expect(applyVrInput(turned, 'exit')).toEqual(IDLE_VR_SESSION);
  });

  it('TEST-VR-007: detecta un panel con texto ilegible a su distancia', () => {
    // Un panel diseñado para pantalla y llevado a VR sin ajustar queda con
    // texto de un par de milímetros a dos metros.
    expect(isPanelReadable(DEFAULT_VR_PANEL, 13, 1200)).toBe(false);
    expect(isPanelReadable(DEFAULT_VR_PANEL, 32, 1200)).toBe(true);
  });
});
