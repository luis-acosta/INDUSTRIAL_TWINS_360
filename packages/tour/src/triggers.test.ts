/**
 * Pruebas de los disparadores del recorrido.
 *
 * El editor ofrecía diecisiete eventos y el visor disparaba cuatro: un autor
 * podía programar un aviso a los treinta segundos de inactividad, probarlo, no
 * ver nada y concluir que la plataforma no funciona. Estas pruebas fijan
 * cuándo ocurre cada uno, y sobre todo cuándo **no**: la repetición por
 * fotograma y las fugas entre escenas son los dos defectos que hacen inútil un
 * sistema de disparadores.
 *
 * El reloj se pasa como argumento. Con `Date.now()` dentro, probar un
 * temporizador de treinta segundos exigiría esperar treinta segundos o falsear
 * el reloj global, y lo segundo rompe todo lo demás que mida tiempo.
 */
import { describe, expect, it } from 'vitest';

import { actionSchema, type Action, type ActionEvent } from '@it360/domain';
import { testUuid } from '@it360/domain/testing';

import {
  DEFAULT_IDLE_MS,
  INITIAL_TRIGGERS,
  enterScene,
  focusChanged,
  mediaEnded,
  noteActivity,
  tick,
  tourBoundary,
} from './triggers';

let counter = 0;

/** Acción del vocabulario real: el esquema rellena lo que no se declara. */
function action(event: ActionEvent, over: Record<string, unknown> = {}): Action {
  counter += 1;
  return actionSchema.parse({
    id: testUuid(200 + counter),
    event,
    // `setVariable` como acción de relleno: es la más simple del vocabulario
    // real y no abre nada, de modo que estas pruebas miran los disparadores y
    // no los efectos.
    config: { type: 'setVariable', namespace: 'score', key: 'avisos', operation: 'add', value: 1 },
    ...over,
  });
}

const SCENE_A = testUuid(10);
const SCENE_B = testUuid(11);

describe('enterScene', () => {
  it('dispara la entrada de escena', () => {
    // TEST-TRG-001: es el gancho más usado —un rótulo al llegar— y no se
    // disparaba nunca.
    const enter = action('sceneEnter');
    const result = enterScene(INITIAL_TRIGGERS, SCENE_A, 1000, [], [enter]);

    expect(result.due.map((d) => d.event)).toContain('sceneEnter');
  });

  it('dispara la salida con las acciones de la escena que se abandona', () => {
    // TEST-TRG-002: `sceneExit` tiene que ejecutarse con la escena vieja como
    // contexto. Si se ejecutara con la nueva, una acción que oculta un panel
    // ocultaría el de la escena a la que se acaba de llegar.
    const exit = action('sceneExit');
    const first = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [exit]);
    const second = enterScene(first.state, SCENE_B, 1000, [exit], []);

    expect(second.due.map((d) => d.action.id)).toEqual([exit.id]);
    expect(second.due[0]!.event).toBe('sceneExit');
  });

  it('el arranque del proyecto ocurre una sola vez', () => {
    // TEST-TRG-003: es el gancho de un aviso de seguridad o una presentación.
    // Repetirlo en cada escena lo convertiría en un estorbo.
    const start = action('projectStart');
    const first = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [start]);
    expect(first.due.map((d) => d.event)).toContain('projectStart');

    const second = enterScene(first.state, SCENE_B, 1000, [], [start]);
    expect(second.due.map((d) => d.event)).not.toContain('projectStart');
  });

  it('olvida lo disparado de la escena anterior', () => {
    // TEST-TRG-004: volver a una escena tiene que volver a disparar su
    // temporizador; si no, la segunda visita sería muda.
    const timer = action('timer', { delayMs: 500 });
    const entered = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [timer]);
    const fired = tick(entered.state, { nowMs: 600, sceneId: SCENE_A, sceneActions: [timer] });
    expect(fired.due).toHaveLength(1);

    const left = enterScene(fired.state, SCENE_B, 1000, [timer], []);
    const back = enterScene(left.state, SCENE_A, 2000, [], [timer]);
    const again = tick(back.state, { nowMs: 2600, sceneId: SCENE_A, sceneActions: [timer] });

    expect(again.due).toHaveLength(1);
  });

  it('conserva lo disparado de una acción marcada «una sola vez»', () => {
    // TEST-TRG-005: «una vez» significa una vez por sesión, no una por
    // visita; si no, un aviso marcado así saldría en cada vuelta.
    const once = action('sceneEnter', { once: true });
    const first = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [once]);
    expect(first.due).toHaveLength(1);

    const away = enterScene(first.state, SCENE_B, 1000, [once], []);
    const back = enterScene(away.state, SCENE_A, 2000, [], [once]);
    expect(back.due).toHaveLength(0);
  });
});

describe('tick: temporizadores (J04)', () => {
  it('dispara al cumplirse el retardo y no antes', () => {
    // TEST-TRG-006: el retardo se cuenta desde la entrada en la escena, que
    // es lo que el autor espera al configurar «a los diez segundos».
    const timer = action('timer', { delayMs: 10_000 });
    const entered = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [timer]);

    const antes = tick(entered.state, { nowMs: 9_999, sceneId: SCENE_A, sceneActions: [timer] });
    expect(antes.due).toHaveLength(0);

    const despues = tick(antes.state, { nowMs: 10_000, sceneId: SCENE_A, sceneActions: [timer] });
    expect(despues.due.map((d) => d.event)).toEqual(['timer']);
  });

  it('no repite el temporizador en cada fotograma', () => {
    // TEST-TRG-007: el defecto que haría inservible el sistema. A 60 fps, un
    // temporizador que se rearma dispara sesenta veces por segundo.
    const timer = action('timer', { delayMs: 100 });
    let state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [timer]).state;

    let total = 0;
    for (let now = 0; now <= 2000; now += 16) {
      const result = tick(state, { nowMs: now, sceneId: SCENE_A, sceneActions: [timer] });
      state = result.state;
      total += result.due.length;
    }

    expect(total).toBe(1);
  });

  it('varios temporizadores disparan cada uno a su hora', () => {
    // TEST-TRG-008: una secuencia —aviso a los 5 s, panel a los 20 s— es el
    // uso normal, y no puede depender del orden en que se declararon.
    const pronto = action('timer', { delayMs: 5_000 });
    const tarde = action('timer', { delayMs: 20_000 });
    const actions = [tarde, pronto];
    let state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], actions).state;

    const a = tick(state, { nowMs: 6_000, sceneId: SCENE_A, sceneActions: actions });
    state = a.state;
    expect(a.due.map((d) => d.action.id)).toEqual([pronto.id]);

    const b = tick(state, { nowMs: 21_000, sceneId: SCENE_A, sceneActions: actions });
    expect(b.due.map((d) => d.action.id)).toEqual([tarde.id]);
  });

  it('en pausa no se dispara nada', () => {
    // TEST-TRG-009: pausar un recorrido guiado y que los temporizadores sigan
    // corriendo haría que al reanudar saltaran todos de golpe.
    const timer = action('timer', { delayMs: 100 });
    const state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [timer]).state;

    const result = tick(state, {
      nowMs: 5_000,
      sceneId: SCENE_A,
      sceneActions: [timer],
      running: false,
    });
    expect(result.due).toHaveLength(0);
  });

  it('sin escena no se dispara nada', () => {
    // TEST-TRG-010: ocurre mientras carga el paquete; disparar entonces
    // ejecutaría acciones sobre una escena que todavía no existe.
    const timer = action('timer', { delayMs: 0 });
    const result = tick(INITIAL_TRIGGERS, { nowMs: 1000, sceneId: null, sceneActions: [timer] });
    expect(result.due).toHaveLength(0);
  });
});

describe('tick: inactividad (J04)', () => {
  it('dispara tras el tiempo configurado', () => {
    // TEST-TRG-011: treinta segundos distingue «está leyendo un panel» de «se
    // levantó de la mesa».
    const idle = action('idle');
    let state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [idle]).state;

    const antes = tick(state, {
      nowMs: DEFAULT_IDLE_MS - 1,
      sceneId: SCENE_A,
      sceneActions: [idle],
    });
    expect(antes.due).toHaveLength(0);
    state = antes.state;

    const despues = tick(state, { nowMs: DEFAULT_IDLE_MS, sceneId: SCENE_A, sceneActions: [idle] });
    expect(despues.due.map((d) => d.event)).toEqual(['idle']);
  });

  it('respeta el tiempo que configura el proyecto', () => {
    // TEST-TRG-012: una sala de control y una visita guiada tienen ritmos
    // distintos.
    const idle = action('idle');
    const state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [idle]).state;

    const result = tick(state, {
      nowMs: 5_000,
      sceneId: SCENE_A,
      sceneActions: [idle],
      idleMs: 4_000,
    });
    expect(result.due).toHaveLength(1);
  });

  it('no se repite mientras el visitante siga inactivo', () => {
    // TEST-TRG-013: si se repitiera, el aviso saldría cada fotograma desde el
    // segundo treinta hasta que alguien tocara algo.
    const idle = action('idle');
    let state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [idle]).state;

    let total = 0;
    for (let now = 0; now <= DEFAULT_IDLE_MS * 2; now += 500) {
      const result = tick(state, { nowMs: now, sceneId: SCENE_A, sceneActions: [idle] });
      state = result.state;
      total += result.due.length;
    }
    expect(total).toBe(1);
  });

  it('un gesto del visitante rearma la inactividad', () => {
    // TEST-TRG-014: el `idle` existe para recuperar la atención; sin rearmar,
    // se dispararía una sola vez por escena y dejaría de servir.
    const idle = action('idle');
    let state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [idle]).state;

    const primera = tick(state, { nowMs: DEFAULT_IDLE_MS, sceneId: SCENE_A, sceneActions: [idle] });
    expect(primera.due).toHaveLength(1);

    state = noteActivity(primera.state, DEFAULT_IDLE_MS + 1_000);
    const segunda = tick(state, {
      nowMs: DEFAULT_IDLE_MS * 2 + 1_000,
      sceneId: SCENE_A,
      sceneActions: [idle],
    });
    expect(segunda.due).toHaveLength(1);
  });

  it('los gestos seguidos no crean estado nuevo', () => {
    // TEST-TRG-015: los gestos llegan a decenas por segundo. Sin filtro, cada
    // movimiento del ratón redibujaría el componente.
    const base = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], []).state;
    const primero = noteActivity(base, 100);
    const segundo = noteActivity(primero, 200);
    expect(segundo).toBe(primero);
  });
});

describe('mediaEnded (J06)', () => {
  it('dispara el fin de medio', () => {
    // TEST-TRG-016: sin este evento, el autor tiene que medir a mano cuánto
    // dura la locución y poner un temporizador, que se descuadra en cuanto
    // cambia la grabación.
    const end = action('mediaEnd');
    const result = mediaEnded(INITIAL_TRIGGERS, testUuid(50), [end]);
    expect(result.due.map((d) => d.event)).toEqual(['mediaEnd']);
  });

  it('una acción con medio declarado sólo responde al suyo', () => {
    // TEST-TRG-017: una escena con locución y vídeo necesita distinguirlos; si
    // no, el final del vídeo dispararía también lo que seguía a la locución.
    const propio = testUuid(50);
    const ajeno = testUuid(51);
    const end = action('mediaEnd', {
      config: { type: 'playMedia', mediaId: propio, loop: false, volume: 1 },
    });

    expect(mediaEnded(INITIAL_TRIGGERS, propio, [end]).due).toHaveLength(1);
    expect(mediaEnded(INITIAL_TRIGGERS, ajeno, [end]).due).toHaveLength(0);
  });
});

describe('focusChanged (J07)', () => {
  const marcadorA = testUuid(60);
  const marcadorB = testUuid(61);
  const entrar = action('focusEnter');
  const salir = action('focusExit');
  const byId = (id: string): readonly Action[] => (id === marcadorA ? [salir] : [entrar]);

  it('dispara entrada y salida en el mismo salto', () => {
    // TEST-TRG-018: la mirada salta de un marcador al siguiente sin pasar por
    // el vacío. Tratando los eventos por separado, la acción de salida del
    // primero no se ejecutaría nunca.
    const result = focusChanged(INITIAL_TRIGGERS, marcadorA, marcadorB, byId);
    expect(result.due.map((d) => d.event)).toEqual(['focusExit', 'focusEnter']);
  });

  it('no dispara si el foco no cambió', () => {
    // TEST-TRG-019: el foco se evalúa cada fotograma; sin esta comprobación,
    // mirar fijamente un marcador dispararía su entrada sin parar.
    expect(focusChanged(INITIAL_TRIGGERS, marcadorA, marcadorA, byId).due).toHaveLength(0);
  });

  it('salir al vacío dispara sólo la salida', () => {
    // TEST-TRG-020
    const result = focusChanged(INITIAL_TRIGGERS, marcadorA, null, byId);
    expect(result.due.map((d) => d.event)).toEqual(['focusExit']);
  });
});

describe('tourBoundary (J06)', () => {
  it('dispara el inicio y el fin del recorrido', () => {
    // TEST-TRG-021: son los ganchos de la introducción y del informe final de
    // una formación.
    const start = action('tourStart');
    const end = action('tourEnd');

    expect(tourBoundary(INITIAL_TRIGGERS, 'tourStart', [start, end]).due.map((d) => d.action.id)).toEqual([
      start.id,
    ]);
    expect(tourBoundary(INITIAL_TRIGGERS, 'tourEnd', [start, end]).due.map((d) => d.action.id)).toEqual([
      end.id,
    ]);
  });
});

describe('acciones deshabilitadas', () => {
  it('no se disparan', () => {
    // TEST-TRG-022: deshabilitar es la forma de probar un recorrido sin
    // borrar lo que el autor lleva configurado.
    const timer = action('timer', { delayMs: 0, enabled: false });
    const state = enterScene(INITIAL_TRIGGERS, SCENE_A, 0, [], [timer]).state;
    const result = tick(state, { nowMs: 1_000, sceneId: SCENE_A, sceneActions: [timer] });
    expect(result.due).toHaveLength(0);
  });
});
