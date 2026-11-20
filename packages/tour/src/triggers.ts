/**
 * Disparadores del recorrido: temporizadores, inactividad, fin de medio y foco
 * (J04, J06, J07).
 *
 * El vocabulario de eventos del dominio tiene diecisiete entradas y el editor
 * las ofrece todas. El visor publicado disparaba cuatro: `click`, `hover`,
 * `hoverOut` y `windowClose`. Las demás —`timer`, `idle`, `mediaEnd`,
 * `sceneEnter`, `sceneExit`, `focusEnter`, `focusExit`, `tourStart`,
 * `tourEnd`, `projectStart`— se podían configurar y no ocurrían nunca: el
 * autor programaba un aviso a los treinta segundos de inactividad, lo probaba,
 * no pasaba nada y concluía que la plataforma no funcionaba.
 *
 * Este módulo es la máquina que los dispara, y es pura: recibe el tiempo y los
 * sucesos, y devuelve qué eventos toca lanzar. Lo que la hace así es que los
 * dos defectos que importan sólo existen en el tiempo y se prueban mal con un
 * reloj de verdad:
 *
 * 1. **Repetición.** Un temporizador de escena que se rearma al redibujar
 *    dispara cada fotograma. Hay que llevar cuenta de lo ya disparado.
 * 2. **Fugas entre escenas.** Un temporizador armado en la escena A que
 *    dispara cuando el visitante ya está en la B ejecuta la acción en el sitio
 *    equivocado, y eso es peor que no ejecutarla.
 */
import type { Action, ActionEvent } from '@it360/domain';

/**
 * Inactividad por omisión antes de considerar que el visitante se fue.
 *
 * Treinta segundos es lo que distingue «está leyendo un panel» de «se levantó
 * de la mesa». Menos interrumpe la lectura, y el `idle` se usa precisamente
 * para recuperar la atención.
 */
export const DEFAULT_IDLE_MS = 30_000;

/**
 * Eventos que ocurren **una vez por visita a la escena**.
 *
 * Un temporizador «a los diez segundos» no significa «cada diez segundos»: el
 * esquema no tiene campo de repetición, de modo que repetirlo sería inventar
 * una conducta que el autor no pidió. Y como el visor evalúa el tiempo en cada
 * fotograma, sin esta lista un temporizador cumplido dispararía sesenta veces
 * por segundo durante el resto de la visita.
 *
 * Los que NO están aquí pueden repetirse dentro de la misma escena y debe ser
 * así: un medio en bucle termina muchas veces, y la mirada entra y sale de un
 * marcador tantas veces como el visitante quiera.
 *
 * `idle` tampoco está, y no por descuido: no es una cuenta atrás sino el flanco
 * de un estado que va y viene. Su repetición la gobierna `idleFired`, que
 * `noteActivity` rebaja en cuanto el visitante toca algo. Tratarlo como
 * disparo único por visita lo dejaría sirviendo una sola vez por escena, y
 * entonces no sirve para lo que existe: recuperar la atención de alguien que se
 * ha distraído, tantas veces como se distraiga.
 */
const ONCE_PER_VISIT: ReadonlySet<ActionEvent> = new Set<ActionEvent>([
  'timer',
  'sceneEnter',
  'sceneExit',
  'projectStart',
  'tourStart',
  'tourEnd',
]);

/** Qué hay armado en este momento. */
export interface TriggerState {
  /** Escena a la que pertenece lo armado. */
  readonly sceneId: string | null;
  /** Momento en que se entró en la escena. */
  readonly enteredAtMs: number;
  /** Última actividad del visitante. */
  readonly lastActivityMs: number;
  /**
   * Acciones ya disparadas en esta visita a la escena.
   *
   * Se vacía al cambiar de escena: volver a una escena tiene que volver a
   * disparar su temporizador, o la segunda visita sería muda.
   */
  readonly firedInScene: ReadonlySet<string>;
  /**
   * Acciones marcadas «una sola vez» ya disparadas en la sesión.
   *
   * Va aparte de la anterior y no se vacía nunca. Al principio se guardaban
   * juntas y se filtraban por las acciones de la escena de destino, y eso
   * perdía la marca al pasar por una escena que no contenía la acción: el
   * aviso «una sola vez» volvía a salir en la siguiente vuelta.
   */
  readonly firedOnce: ReadonlySet<string>;
  /** `true` cuando ya se disparó el arranque del proyecto. */
  readonly projectStarted: boolean;
  /** `true` mientras el `idle` actual siga vigente. */
  readonly idleFired: boolean;
}

export const INITIAL_TRIGGERS: TriggerState = {
  sceneId: null,
  enteredAtMs: 0,
  lastActivityMs: 0,
  firedInScene: new Set(),
  firedOnce: new Set(),
  projectStarted: false,
  idleFired: false,
};

/** Una acción que toca ejecutar, con el evento que la disparó. */
export interface DueAction {
  readonly action: Action;
  readonly event: ActionEvent;
}

export interface TickInput {
  readonly nowMs: number;
  readonly sceneId: string | null;
  /** Acciones de la escena actual. */
  readonly sceneActions: readonly Action[];
  /** Milisegundos de inactividad que configura el proyecto. */
  readonly idleMs?: number;
  /** `false` cuando el recorrido está en pausa: no se arman temporizadores. */
  readonly running?: boolean;
}

export interface TickResult {
  readonly state: TriggerState;
  readonly due: readonly DueAction[];
}

/**
 * Entra en una escena.
 *
 * Devuelve el estado nuevo y las acciones de salida de la escena anterior:
 * `sceneExit` tiene que ejecutarse con la escena vieja todavía como contexto,
 * y por eso se devuelven juntas en lugar de dejarlo a quien llame.
 */
export function enterScene(
  state: TriggerState,
  sceneId: string | null,
  nowMs: number,
  previousActions: readonly Action[],
  nextActions: readonly Action[],
): TickResult {
  const due: DueAction[] = [];

  if (state.sceneId !== null && state.sceneId !== sceneId) {
    for (const action of applicable(previousActions, 'sceneExit', state)) {
      due.push({ action, event: 'sceneExit' });
    }
  }

  // Los temporizadores de la escena anterior se olvidan al salir: uno armado
  // en la escena A que dispara cuando el visitante ya está en la B ejecuta la
  // acción en el sitio equivocado. Lo marcado «una sola vez» no se olvida.
  const next: TriggerState = {
    sceneId,
    enteredAtMs: nowMs,
    lastActivityMs: nowMs,
    firedInScene: new Set(),
    firedOnce: state.firedOnce,
    projectStarted: state.projectStarted,
    idleFired: false,
  };

  if (!next.projectStarted) {
    // `projectStart` se dispara una sola vez en toda la sesión, al entrar en
    // la primera escena: es el gancho para una presentación o un aviso de
    // seguridad que no debe repetirse en cada escena.
    for (const action of applicable(nextActions, 'projectStart', next)) {
      due.push({ action, event: 'projectStart' });
    }
  }

  if (sceneId !== null) {
    for (const action of applicable(nextActions, 'sceneEnter', next)) {
      due.push({ action, event: 'sceneEnter' });
    }
  }

  return { state: { ...markFired(next, due), projectStarted: true }, due };
}

/**
 * Avanza el reloj.
 *
 * Es la única función que mira el tiempo, y lo recibe en lugar de leerlo: con
 * `Date.now()` dentro, probar un temporizador de treinta segundos exigiría
 * esperar treinta segundos o falsear el reloj global, y lo segundo rompe todo
 * lo demás que mida tiempo en la misma prueba.
 */
export function tick(state: TriggerState, input: TickInput): TickResult {
  if (input.running === false || input.sceneId === null) {
    return { state, due: [] };
  }

  const due: DueAction[] = [];
  const elapsed = input.nowMs - state.enteredAtMs;

  // --- Temporizadores (J04) ---
  //
  // El retardo se cuenta desde la entrada en la escena, que es lo que el autor
  // espera al configurar «a los diez segundos»: desde que se ve la escena, no
  // desde que arrancó el programa.
  for (const action of applicable(input.sceneActions, 'timer', state)) {
    if (elapsed >= action.delayMs) due.push({ action, event: 'timer' });
  }

  // --- Inactividad (J04) ---
  const idleLimit = input.idleMs ?? DEFAULT_IDLE_MS;
  const idleFor = input.nowMs - state.lastActivityMs;
  let idleFired = state.idleFired;

  if (!idleFired && idleFor >= idleLimit) {
    for (const action of applicable(input.sceneActions, 'idle', state)) {
      due.push({ action, event: 'idle' });
    }
    // Se marca aunque no hubiera acciones: así el estado refleja que el
    // visitante está inactivo, que es lo que impide repetirlo cada fotograma.
    idleFired = true;
  }

  return { state: { ...markFired(state, due), idleFired }, due };
}

/**
 * Registra actividad del visitante.
 *
 * Cualquier gesto cuenta: girar la cámara, pulsar, mover el ratón. Rearma el
 * `idle`, que si no se rearmase se dispararía una sola vez por escena y
 * dejaría de servir para recuperar la atención.
 */
export function noteActivity(state: TriggerState, nowMs: number): TriggerState {
  if (!state.idleFired && nowMs - state.lastActivityMs < 250) {
    // Los gestos llegan a decenas por segundo; sin este filtro, cada
    // movimiento del ratón crearía un estado nuevo y el componente se
    // redibujaría continuamente.
    return state;
  }
  return { ...state, lastActivityMs: nowMs, idleFired: false };
}

/**
 * Fin de un medio (J06).
 *
 * Es el evento que permite encadenar: una locución que al terminar abre la
 * ventana siguiente, o que avanza el recorrido. Sin él, el autor tiene que
 * calcular a mano cuánto dura el audio y poner un temporizador, que se
 * descuadra en cuanto cambia la grabación.
 */
export function mediaEnded(
  state: TriggerState,
  mediaId: string,
  actions: readonly Action[],
): TickResult {
  const due: DueAction[] = [];
  for (const action of applicable(actions, 'mediaEnd', state)) {
    // Una acción de `mediaEnd` sin medio declarado responde a cualquiera; con
    // medio declarado, sólo al suyo. Lo primero es lo que quiere quien tiene
    // una locución por escena; lo segundo, quien tiene varias.
    const target = mediaOf(action);
    if (target !== null && target !== mediaId) continue;
    due.push({ action, event: 'mediaEnd' });
  }
  return { state: markFired(state, due), due };
}

/**
 * Entrada y salida del foco visual (J07).
 *
 * El foco es «el visitante está mirando esto», que en una pantalla significa
 * que el marcador está centrado y en VR, que la mirada se sostiene. Devuelve
 * los dos eventos porque siempre van juntos: salir de uno es entrar en otro, y
 * tratarlos por separado deja acciones de salida sin ejecutar cuando la mirada
 * salta directamente de un marcador al siguiente.
 */
export function focusChanged(
  state: TriggerState,
  previousId: string | null,
  nextId: string | null,
  actionsById: (id: string) => readonly Action[],
): TickResult {
  if (previousId === nextId) return { state, due: [] };

  const due: DueAction[] = [];

  if (previousId !== null) {
    for (const action of applicable(actionsById(previousId), 'focusExit', state)) {
      due.push({ action, event: 'focusExit' });
    }
  }
  if (nextId !== null) {
    for (const action of applicable(actionsById(nextId), 'focusEnter', state)) {
      due.push({ action, event: 'focusEnter' });
    }
  }

  return { state: markFired(state, due), due };
}

/** Inicio y fin de un recorrido guiado (J06). */
export function tourBoundary(
  state: TriggerState,
  event: 'tourStart' | 'tourEnd',
  actions: readonly Action[],
): TickResult {
  const due = applicable(actions, event, state).map((action) => ({ action, event }));
  return { state: markFired(state, due), due };
}

/* ------------------------------------------------------------------ *
 * Interno
 * ------------------------------------------------------------------ */

/**
 * Acciones que corresponden a un evento y todavía pueden ejecutarse.
 *
 * El filtro de `once` va aquí y no en el ejecutor: el ejecutor no sabe si una
 * acción ya corrió en esta escena, y duplicar la cuenta en los dos sitios es
 * la forma de que acaben discrepando.
 */
function applicable(
  actions: readonly Action[],
  event: ActionEvent,
  state: TriggerState,
): readonly Action[] {
  return actions.filter((action) => {
    if (!action.enabled || action.event !== event) return false;
    if (action.once && state.firedOnce.has(action.id)) return false;
    if (ONCE_PER_VISIT.has(event) && state.firedInScene.has(action.id)) return false;
    return true;
  });
}

/**
 * Anota lo disparado en los dos registros.
 *
 * Son dos porque caducan de forma distinta: lo de la visita se olvida al
 * cambiar de escena y lo de «una sola vez» no se olvida nunca. Llevarlos
 * juntos obligaba a decidir al vaciar cuál conservar, y la decisión se tomaba
 * mirando las acciones de la escena de destino, que es información que no
 * tiene nada que ver.
 */
function markFired(state: TriggerState, due: readonly DueAction[]): TriggerState {
  if (due.length === 0) return state;

  const inScene = new Set(state.firedInScene);
  const once = new Set(state.firedOnce);

  for (const { action, event } of due) {
    if (ONCE_PER_VISIT.has(event)) inScene.add(action.id);
    if (action.once) once.add(action.id);
  }

  return { ...state, firedInScene: inScene, firedOnce: once };
}

/** Medio al que apunta una acción de `mediaEnd`, si declara uno. */
function mediaOf(action: Action): string | null {
  const config = action.config as { readonly mediaId?: string | null };
  return typeof config.mediaId === 'string' ? config.mediaId : null;
}
