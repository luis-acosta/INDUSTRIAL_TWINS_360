import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  COALESCE_WINDOW_MS,
  compositeCommand,
  createHistory,
  fieldCommand,
  isDirty,
  markSaved,
  MAX_HISTORY,
  pushCommand,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type Command,
} from './history';

interface TestState {
  readonly yaw: number;
  readonly title: string;
  readonly hotspots: readonly string[];
}

const initial: TestState = { yaw: 0, title: 'Escena', hotspots: [] };

const moveCommand = (from: number, to: number, timestampMs: number): Command<TestState> =>
  fieldCommand<TestState, number>({
    kind: 'hotspot.move',
    label: 'Mover marcador',
    previous: from,
    next: to,
    write: (state, value) => ({ ...state, yaw: value }),
    coalesceKey: 'hotspot.move:h1',
    timestampMs,
  });

const addHotspot = (id: string, timestampMs: number): Command<TestState> => ({
  kind: 'hotspot.create',
  label: 'Crear marcador',
  apply: (state) => ({ ...state, hotspots: [...state.hotspots, id] }),
  invert: (state) => ({ ...state, hotspots: state.hotspots.filter((h) => h !== id) }),
  coalesceKey: null,
  timestampMs,
});

/**
 * TEST-HIST-001 .. TEST-HIST-016
 * Requisito: Y04 (deshacer y rehacer), etapa 00.
 */
describe('deshacer y rehacer', () => {
  it('TEST-HIST-001: un historial nuevo no permite deshacer ni rehacer', () => {
    const history = createHistory<TestState>();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undoLabel(history)).toBeNull();
    expect(redoLabel(history)).toBeNull();
  });

  it('TEST-HIST-002: aplicar un comando cambia el estado y habilita deshacer', () => {
    const result = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    expect(result.state.hotspots).toEqual(['h1']);
    expect(canUndo(result.history)).toBe(true);
    expect(undoLabel(result.history)).toBe('Crear marcador');
  });

  it('TEST-HIST-003: deshacer devuelve el estado anterior exacto', () => {
    const pushed = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    const undone = undo(pushed.state, pushed.history);
    expect(undone.state).toEqual(initial);
    expect(canRedo(undone.history)).toBe(true);
  });

  it('TEST-HIST-004: rehacer vuelve a aplicar el comando', () => {
    const pushed = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    const undone = undo(pushed.state, pushed.history);
    const redone = redo(undone.state, undone.history);
    expect(redone.state.hotspots).toEqual(['h1']);
    expect(canRedo(redone.history)).toBe(false);
  });

  it('TEST-HIST-005: una secuencia larga se deshace y rehace íntegra', () => {
    let state = initial;
    let history = createHistory<TestState>();
    for (let i = 0; i < 10; i += 1) {
      const result = pushCommand(state, history, addHotspot(`h${i}`, i * 5000));
      state = result.state;
      history = result.history;
    }
    expect(state.hotspots).toHaveLength(10);

    for (let i = 0; i < 10; i += 1) {
      const result = undo(state, history);
      state = result.state;
      history = result.history;
    }
    expect(state).toEqual(initial);

    for (let i = 0; i < 10; i += 1) {
      const result = redo(state, history);
      state = result.state;
      history = result.history;
    }
    expect(state.hotspots).toHaveLength(10);
  });

  it('TEST-HIST-006: deshacer con el historial vacío no cambia nada', () => {
    const history = createHistory<TestState>();
    const result = undo(initial, history);
    expect(result.state).toBe(initial);
    expect(result.history).toBe(history);
  });

  it('TEST-HIST-007: un comando nuevo descarta el futuro rehacible', () => {
    // Tras deshacer tres pasos y hacer algo nuevo, los pasos rehacibles ya no
    // son alcanzables. Conservarlos daría un árbol de historial, que es más
    // potente y que nadie usa bien.
    let { state, history } = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    ({ state, history } = pushCommand(state, history, addHotspot('h2', 2000)));
    ({ state, history } = undo(state, history));
    expect(canRedo(history)).toBe(true);
    ({ state, history } = pushCommand(state, history, addHotspot('h3', 3000)));
    expect(canRedo(history)).toBe(false);
    expect(state.hotspots).toEqual(['h1', 'h3']);
  });
});

describe('fusión de comandos contiguos', () => {
  it('TEST-HIST-008: un arrastre se deshace en un solo paso', () => {
    // Arrastrar produce un evento por fotograma. El usuario espera que una
    // pulsación de deshacer devuelva el marcador a donde estaba, no que
    // retroceda un píxel.
    let state = initial;
    let history = createHistory<TestState>();
    let previous = 0;
    for (let i = 1; i <= 20; i += 1) {
      const next = i * 0.01;
      const result = pushCommand(state, history, moveCommand(previous, next, 1000 + i * 10));
      state = result.state;
      history = result.history;
      previous = next;
    }

    expect(state.yaw).toBeCloseTo(0.2, 10);
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.mergeCount).toBe(20);

    const undone = undo(state, history);
    expect(undone.state.yaw).toBe(0);
  });

  it('TEST-HIST-009: pasada la ventana de fusión se crean pasos distintos', () => {
    let { state, history } = pushCommand(initial, createHistory<TestState>(), moveCommand(0, 0.1, 1000));
    ({ state, history } = pushCommand(
      state,
      history,
      moveCommand(0.1, 0.2, 1000 + COALESCE_WINDOW_MS + 1),
    ));
    expect(history.past).toHaveLength(2);

    const undone = undo(state, history);
    expect(undone.state.yaw).toBeCloseTo(0.1, 10);
  });

  it('TEST-HIST-010: comandos con claves distintas no se fusionan', () => {
    const moveOther = (from: number, to: number, ts: number): Command<TestState> =>
      fieldCommand<TestState, number>({
        kind: 'hotspot.move',
        label: 'Mover marcador',
        previous: from,
        next: to,
        write: (s, v) => ({ ...s, yaw: v }),
        coalesceKey: 'hotspot.move:h2',
        timestampMs: ts,
      });

    let { state, history } = pushCommand(initial, createHistory<TestState>(), moveCommand(0, 0.1, 1000));
    ({ state, history } = pushCommand(state, history, moveOther(0.1, 0.2, 1050)));
    expect(history.past).toHaveLength(2);
  });

  it('TEST-HIST-011: un comando sin clave nunca se fusiona', () => {
    let { state, history } = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    ({ state, history } = pushCommand(state, history, addHotspot('h2', 1010)));
    expect(history.past).toHaveLength(2);
  });
});

describe('comandos compuestos', () => {
  it('TEST-HIST-012: pegar varios marcadores es un solo paso de deshacer', () => {
    // Y05: copiar y pegar varios hotspots. Ocho inserciones, un paso.
    const commands = ['a', 'b', 'c', 'd'].map((id) => addHotspot(id, 1000));
    const composite = compositeCommand('hotspot.paste', 'Pegar 4 marcadores', commands, 1000);

    const pushed = pushCommand(initial, createHistory<TestState>(), composite);
    expect(pushed.state.hotspots).toEqual(['a', 'b', 'c', 'd']);
    expect(pushed.history.past).toHaveLength(1);
    expect(undoLabel(pushed.history)).toBe('Pegar 4 marcadores');

    const undone = undo(pushed.state, pushed.history);
    expect(undone.state.hotspots).toEqual([]);
  });

  it('TEST-HIST-013: la inversión recorre los comandos en orden inverso', () => {
    // Es la única forma de que el estado intermedio sea coherente en cada paso.
    const order: string[] = [];
    const tracked = (id: string): Command<TestState> => ({
      kind: 'test',
      label: 'test',
      apply: (s) => ({ ...s, hotspots: [...s.hotspots, id] }),
      invert: (s) => {
        order.push(id);
        return { ...s, hotspots: s.hotspots.filter((h) => h !== id) };
      },
      coalesceKey: null,
      timestampMs: 0,
    });

    const composite = compositeCommand('t', 't', [tracked('1'), tracked('2'), tracked('3')], 0);
    const pushed = pushCommand(initial, createHistory<TestState>(), composite);
    undo(pushed.state, pushed.history);
    expect(order).toEqual(['3', '2', '1']);
  });
});

describe('límite del historial', () => {
  it('TEST-HIST-014: el historial no crece sin tope', () => {
    let state = initial;
    let history = createHistory<TestState>();
    for (let i = 0; i < MAX_HISTORY + 50; i += 1) {
      const result = pushCommand(state, history, addHotspot(`h${i}`, i * 5000));
      state = result.state;
      history = result.history;
    }
    expect(history.past).toHaveLength(MAX_HISTORY);
  });
});

describe('seguimiento de cambios sin guardar', () => {
  it('TEST-HIST-015: tras guardar el proyecto no está modificado', () => {
    const pushed = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    expect(isDirty(pushed.history)).toBe(true);
    const saved = markSaved(pushed.history);
    expect(isDirty(saved)).toBe(false);
  });

  it('TEST-HIST-016: deshacer hasta el punto de guardado deja de marcar cambios', () => {
    // Sin esto el proyecto quedaría marcado como sucio para siempre, y el
    // usuario aprendería a ignorar el aviso de cambios sin guardar.
    let { state, history } = pushCommand(initial, createHistory<TestState>(), addHotspot('h1', 1000));
    history = markSaved(history);
    ({ state, history } = pushCommand(state, history, addHotspot('h2', 10_000)));
    expect(isDirty(history)).toBe(true);
    ({ history } = undo(state, history));
    expect(isDirty(history)).toBe(false);
  });
});
