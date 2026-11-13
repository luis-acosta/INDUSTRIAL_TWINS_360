/**
 * Deshacer y rehacer (etapa 00, Y04).
 *
 * El historial guarda **comandos invertibles**, no instantáneas del proyecto.
 * Un proyecto con doscientas escenas y sus marcadores ocupa decenas de MB en
 * memoria; cincuenta instantáneas serían un gigabyte y el editor empezaría a
 * paginar justo cuando el usuario trabaja rápido. Un comando pesa lo que
 * pesa el cambio.
 *
 * El otro motivo es la agrupación: arrastrar un marcador produce un evento de
 * puntero por fotograma, y el usuario espera que una pulsación de deshacer
 * devuelva el marcador a donde estaba, no que retroceda un píxel. Los
 * comandos con la misma `coalesceKey` dentro de la ventana de fusión se
 * combinan en uno.
 */

/**
 * Un cambio invertible sobre el estado del proyecto.
 *
 * `apply` e `invert` reciben el estado y devuelven el estado resultante, sin
 * mutarlo. La inmutabilidad es lo que permite que rehacer sea simplemente
 * volver a aplicar, sin recalcular nada.
 */
export interface Command<S> {
  /** Identificador del tipo de operación: `scene.move`, `hotspot.create`. */
  readonly kind: string;
  /** Descripción en español para el menú: «Mover marcador». */
  readonly label: string;
  readonly apply: (state: S) => S;
  readonly invert: (state: S) => S;
  /**
   * Comandos consecutivos con la misma clave se fusionan. `null` desactiva
   * la fusión para ese comando.
   */
  readonly coalesceKey?: string | null;
  /** Momento de creación, en ms. Decide la ventana de fusión. */
  readonly timestampMs: number;
}

export interface HistoryEntry<S> {
  readonly command: Command<S>;
  /** Número de comandos fusionados en esta entrada. */
  readonly mergeCount: number;
}

export interface HistoryState<S> {
  readonly past: readonly HistoryEntry<S>[];
  readonly future: readonly HistoryEntry<S>[];
  /**
   * Índice del último comando que estaba aplicado al guardar. Permite saber
   * si hay cambios sin guardar incluso después de deshacer hasta el punto de
   * guardado, en lugar de marcar el proyecto como sucio para siempre.
   */
  readonly savedDepth: number;
}

/** Límite del historial. */
export const MAX_HISTORY = 200;

/** Ventana de fusión de comandos contiguos, en ms. */
export const COALESCE_WINDOW_MS = 600;

export function createHistory<S>(): HistoryState<S> {
  return { past: [], future: [], savedDepth: 0 };
}

export interface PushResult<S> {
  readonly state: S;
  readonly history: HistoryState<S>;
}

/**
 * Aplica un comando y lo registra.
 *
 * Registrar un comando descarta el futuro: tras deshacer tres pasos y hacer
 * algo nuevo, los tres pasos rehacibles ya no son alcanzables. Conservarlos
 * daría un árbol de historial, que es más potente y que nadie usa bien.
 */
export function pushCommand<S>(
  state: S,
  history: HistoryState<S>,
  command: Command<S>,
): PushResult<S> {
  const nextState = command.apply(state);

  const last = history.past[history.past.length - 1];
  const canCoalesce =
    last !== undefined &&
    command.coalesceKey != null &&
    last.command.coalesceKey === command.coalesceKey &&
    command.timestampMs - last.command.timestampMs <= COALESCE_WINDOW_MS;

  if (canCoalesce && last !== undefined) {
    // La entrada fusionada aplica lo nuevo y deshace hasta el estado anterior
    // al PRIMER comando del grupo, que es lo que el usuario considera un paso.
    const merged: HistoryEntry<S> = {
      command: {
        kind: command.kind,
        label: command.label,
        apply: command.apply,
        invert: last.command.invert,
        coalesceKey: command.coalesceKey,
        timestampMs: command.timestampMs,
      },
      mergeCount: last.mergeCount + 1,
    };
    return {
      state: nextState,
      history: {
        past: [...history.past.slice(0, -1), merged],
        future: [],
        savedDepth: history.savedDepth,
      },
    };
  }

  const past = [...history.past, { command, mergeCount: 1 }];
  const overflow = Math.max(past.length - MAX_HISTORY, 0);

  return {
    state: nextState,
    history: {
      past: overflow > 0 ? past.slice(overflow) : past,
      future: [],
      // Al descartar entradas antiguas, la referencia del guardado se mueve
      // con ellas; si queda por detrás del inicio, el proyecto se considera
      // modificado, que es la suposición conservadora.
      savedDepth: Math.max(history.savedDepth - overflow, -1),
    },
  };
}

export function canUndo<S>(history: HistoryState<S>): boolean {
  return history.past.length > 0;
}

export function canRedo<S>(history: HistoryState<S>): boolean {
  return history.future.length > 0;
}

export function undo<S>(state: S, history: HistoryState<S>): PushResult<S> {
  const entry = history.past[history.past.length - 1];
  if (entry === undefined) return { state, history };
  return {
    state: entry.command.invert(state),
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
      savedDepth: history.savedDepth,
    },
  };
}

export function redo<S>(state: S, history: HistoryState<S>): PushResult<S> {
  const entry = history.future[0];
  if (entry === undefined) return { state, history };
  return {
    state: entry.command.apply(state),
    history: {
      past: [...history.past, entry],
      future: history.future.slice(1),
      savedDepth: history.savedDepth,
    },
  };
}

/** Marca el punto actual como guardado. */
export function markSaved<S>(history: HistoryState<S>): HistoryState<S> {
  return { ...history, savedDepth: history.past.length };
}

/** `true` si hay cambios no guardados. */
export function isDirty<S>(history: HistoryState<S>): boolean {
  return history.past.length !== history.savedDepth;
}

/** Etiqueta de la siguiente operación a deshacer: «Deshacer mover marcador». */
export function undoLabel<S>(history: HistoryState<S>): string | null {
  const entry = history.past[history.past.length - 1];
  return entry === undefined ? null : entry.command.label;
}

export function redoLabel<S>(history: HistoryState<S>): string | null {
  const entry = history.future[0];
  return entry === undefined ? null : entry.command.label;
}

/** Limpia el historial conservando el estado. Se usa al abrir un proyecto. */
export function resetHistory<S>(): HistoryState<S> {
  return createHistory<S>();
}

/* ------------------------------------------------------------------ *
 * Constructores de comando
 * ------------------------------------------------------------------ */

/**
 * Comando a partir del valor anterior y el nuevo de una ruta del estado.
 *
 * Cubre la mayoría de las ediciones del inspector: cambiar un número, un
 * texto, una casilla. El llamante aporta las funciones de lectura y
 * escritura, de modo que el historial no necesita conocer la forma del
 * estado.
 */
export function fieldCommand<S, V>(options: {
  readonly kind: string;
  readonly label: string;
  readonly previous: V;
  readonly next: V;
  readonly write: (state: S, value: V) => S;
  readonly coalesceKey?: string | null;
  readonly timestampMs: number;
}): Command<S> {
  return {
    kind: options.kind,
    label: options.label,
    apply: (state) => options.write(state, options.next),
    invert: (state) => options.write(state, options.previous),
    coalesceKey: options.coalesceKey ?? null,
    timestampMs: options.timestampMs,
  };
}

/**
 * Agrupa varios comandos en uno, para que se deshagan juntos.
 *
 * Lo necesita cualquier operación compuesta: pegar ocho marcadores (Y05)
 * son ocho inserciones y un solo paso de deshacer. La inversión recorre los
 * comandos en orden inverso, que es la única forma de que el estado
 * intermedio sea coherente en cada paso.
 */
export function compositeCommand<S>(
  kind: string,
  label: string,
  commands: readonly Command<S>[],
  timestampMs: number,
): Command<S> {
  return {
    kind,
    label,
    apply: (state) => commands.reduce((acc, c) => c.apply(acc), state),
    invert: (state) => [...commands].reverse().reduce((acc, c) => c.invert(acc), state),
    coalesceKey: null,
    timestampMs,
  };
}
