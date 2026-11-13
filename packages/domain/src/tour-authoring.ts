/**
 * Operaciones de autoría de recorridos y evaluaciones (etapa 09).
 *
 * El motor de ejecución vive en `tour.ts`; aquí está lo que hace falta para
 * **construir** un recorrido o una evaluación sin romperlos. Está separado de
 * la interfaz a propósito: lo que destruye una evaluación no es un clic, es
 * una rama que apunta a una pregunta borrada, y eso se comprueba mejor aquí
 * que en una pantalla.
 *
 * Dos decisiones que se repiten en todo el archivo:
 *
 *  - **Los valores por defecto se derivan del esquema**, nunca se copian a
 *    mano. Una lista de campos escrita aquí se queda atrás en cuanto el
 *    esquema cambia, y el resultado es un recorrido que no valida sin que
 *    nadie sepa por qué.
 *  - **Borrar algo nunca deja referencias colgando.** Quitar una pregunta
 *    limpia las ramas que la señalaban, y la interfaz puede decir cuántas
 *    antes de hacerlo.
 */
import {
  questionSchema,
  quizSchema,
  tourSchema,
  waypointSchema,
  type Choice,
  type HuntTarget,
  type Question,
  type QuestionKind,
  type Quiz,
  type ScoreGoal,
  type Tour,
  type Waypoint,
} from './tour';
import { DEFAULT_CAMERA_VIEW, type CameraView } from './coordinates';
import { newUuid, type Uuid } from './identity';

/* ------------------------------------------------------------------ *
 * Creación
 * ------------------------------------------------------------------ */

/** Recorrido vacío, con los valores por defecto del esquema. */
export function createTour(projectId: Uuid, name: string, isoNow: string): Tour {
  return tourSchema.parse({
    id: newUuid(),
    projectId,
    name,
    createdAt: isoNow,
    updatedAt: isoNow,
  });
}

/** Punto de paso sobre una escena, con la vista actual de la cámara. */
export function createWaypoint(
  sceneId: Uuid,
  view: CameraView = DEFAULT_CAMERA_VIEW,
  order = 0,
): Waypoint {
  return waypointSchema.parse({ id: newUuid(), sceneId, view, order });
}

/** Evaluación vacía. */
export function createQuiz(projectId: Uuid, name: string, isoNow: string): Quiz {
  return quizSchema.parse({
    id: newUuid(),
    projectId,
    name,
    createdAt: isoNow,
    updatedAt: isoNow,
  });
}

/**
 * Pregunta del tipo pedido.
 *
 * `trueFalse` llega con sus dos opciones puestas porque no tiene otras
 * posibles: dejarlas vacías sólo obliga al autor a escribir «Verdadero» y
 * «Falso» en cada pregunta. Los demás tipos empiezan sin opciones, que es
 * donde el autor tiene algo que decidir.
 */
export function createQuestion(kind: QuestionKind, order = 0): Question {
  const base = { id: shortId(), kind, prompt: 'Nueva pregunta', order };

  if (kind === 'trueFalse') {
    return questionSchema.parse({
      ...base,
      choices: [
        { id: 'v', text: 'Verdadero', correct: true },
        { id: 'f', text: 'Falso' },
      ],
    });
  }

  return questionSchema.parse(base);
}

/** Opción nueva, con un id que no choca con las existentes. */
export function createChoice(existing: readonly Choice[], text = 'Nueva opción'): Choice {
  return { id: freeChoiceId(existing), text, correct: false, feedback: '', points: 0, nextQuestionId: null };
}

/* ------------------------------------------------------------------ *
 * Puntos de paso
 * ------------------------------------------------------------------ */

/**
 * Inserta un punto de paso y renumera el orden.
 *
 * `index` se interpreta sobre la lista ya ordenada. Un índice fuera de rango
 * añade al final en vez de fallar: es lo que quiere decir «al final» cuando
 * la interfaz no sabe cuántos hay.
 */
export function insertWaypoint(tour: Tour, waypoint: Waypoint, index?: number): Tour {
  const ordered = sortByOrder(tour.waypoints);
  const at = index === undefined ? ordered.length : clamp(index, 0, ordered.length);
  const next = [...ordered.slice(0, at), waypoint, ...ordered.slice(at)];
  return { ...tour, waypoints: renumber(next) };
}

/** Mueve un punto de paso a otra posición. */
export function moveWaypoint(tour: Tour, waypointId: string, toIndex: number): Tour {
  const ordered = sortByOrder(tour.waypoints);
  const from = ordered.findIndex((w) => w.id === waypointId);
  if (from < 0) return tour;

  const without = [...ordered.slice(0, from), ...ordered.slice(from + 1)];
  const at = clamp(toIndex, 0, without.length);
  const moved = ordered[from];
  if (moved === undefined) return tour;

  return { ...tour, waypoints: renumber([...without.slice(0, at), moved, ...without.slice(at)]) };
}

/** Quita un punto de paso y renumera el resto. */
export function removeWaypoint(tour: Tour, waypointId: string): Tour {
  const kept = sortByOrder(tour.waypoints).filter((w) => w.id !== waypointId);
  if (kept.length === tour.waypoints.length) return tour;
  return { ...tour, waypoints: renumber(kept) };
}

/** Cambia campos de un punto de paso dejando el resto intactos. */
export function updateWaypoint(
  tour: Tour,
  waypointId: string,
  patch: Partial<Omit<Waypoint, 'id'>>,
): Tour {
  let found = false;
  const waypoints = tour.waypoints.map((w) => {
    if (w.id !== waypointId) return w;
    found = true;
    return { ...w, ...patch, id: w.id };
  });
  return found ? { ...tour, waypoints } : tour;
}

/** Duplica un punto de paso justo detrás del original. */
export function duplicateWaypoint(tour: Tour, waypointId: string): Tour {
  const ordered = sortByOrder(tour.waypoints);
  const index = ordered.findIndex((w) => w.id === waypointId);
  const source = ordered[index];
  if (source === undefined) return tour;

  return insertWaypoint(tour, { ...source, id: newUuid() }, index + 1);
}

/* ------------------------------------------------------------------ *
 * Preguntas
 * ------------------------------------------------------------------ */

export function insertQuestion(quiz: Quiz, question: Question, index?: number): Quiz {
  const ordered = sortByOrder(quiz.questions);
  const at = index === undefined ? ordered.length : clamp(index, 0, ordered.length);
  const next = [...ordered.slice(0, at), question, ...ordered.slice(at)];
  return { ...quiz, questions: renumber(next) };
}

export function moveQuestion(quiz: Quiz, questionId: string, toIndex: number): Quiz {
  const ordered = sortByOrder(quiz.questions);
  const from = ordered.findIndex((q) => q.id === questionId);
  if (from < 0) return quiz;

  const without = [...ordered.slice(0, from), ...ordered.slice(from + 1)];
  const at = clamp(toIndex, 0, without.length);
  const moved = ordered[from];
  if (moved === undefined) return quiz;

  return { ...quiz, questions: renumber([...without.slice(0, at), moved, ...without.slice(at)]) };
}

/** Lo que se rompe al quitar una pregunta, para poder avisar antes. */
export interface QuestionRemovalImpact {
  /** Ramas de opción que apuntaban a ella. */
  readonly choiceBranches: number;
  /** Continuaciones de pregunta que apuntaban a ella. */
  readonly questionBranches: number;
  /** La pregunta era la entrada de la evaluación. */
  readonly wasEntry: boolean;
}

export function questionRemovalImpact(quiz: Quiz, questionId: string): QuestionRemovalImpact {
  let choiceBranches = 0;
  let questionBranches = 0;

  for (const question of quiz.questions) {
    if (question.id === questionId) continue;
    if (question.nextQuestionId === questionId) questionBranches += 1;
    for (const choice of question.choices) {
      if (choice.nextQuestionId === questionId) choiceBranches += 1;
    }
  }

  return { choiceBranches, questionBranches, wasEntry: quiz.entryQuestionId === questionId };
}

/**
 * Quita una pregunta y deja la evaluación coherente.
 *
 * Las ramas que la señalaban vuelven a `null`, que significa «sigue el orden».
 * Dejarlas apuntando a un id que ya no existe produce una evaluación que se
 * corta a mitad en la primera ejecución, y `validateQuiz` la rechazaría
 * después; es mejor arreglarlo aquí que publicar algo roto.
 */
export function removeQuestion(quiz: Quiz, questionId: string): Quiz {
  const kept = sortByOrder(quiz.questions).filter((q) => q.id !== questionId);
  if (kept.length === quiz.questions.length) return quiz;

  const cleaned = kept.map((question) => ({
    ...question,
    nextQuestionId: question.nextQuestionId === questionId ? null : question.nextQuestionId,
    choices: question.choices.map((choice) =>
      choice.nextQuestionId === questionId ? { ...choice, nextQuestionId: null } : choice,
    ),
  }));

  return {
    ...quiz,
    questions: renumber(cleaned),
    entryQuestionId: quiz.entryQuestionId === questionId ? null : quiz.entryQuestionId,
  };
}

export function updateQuestion(
  quiz: Quiz,
  questionId: string,
  patch: Partial<Omit<Question, 'id'>>,
): Quiz {
  let found = false;
  const questions = quiz.questions.map((q) => {
    if (q.id !== questionId) return q;
    found = true;
    return { ...q, ...patch, id: q.id };
  });
  return found ? { ...quiz, questions } : quiz;
}

/** Duplica una pregunta detrás del original, con id nuevo. */
export function duplicateQuestion(quiz: Quiz, questionId: string): Quiz {
  const ordered = sortByOrder(quiz.questions);
  const index = ordered.findIndex((q) => q.id === questionId);
  const source = ordered[index];
  if (source === undefined) return quiz;

  const taken = new Set(quiz.questions.map((q) => q.id));
  return insertQuestion(quiz, { ...source, id: freeId(taken) }, index + 1);
}

/* ------------------------------------------------------------------ *
 * Opciones
 * ------------------------------------------------------------------ */

export function addChoice(quiz: Quiz, questionId: string, text?: string): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  const choice = createChoice(question.choices, text);
  return updateQuestion(quiz, questionId, { choices: [...question.choices, choice] });
}

export function updateChoice(
  quiz: Quiz,
  questionId: string,
  choiceId: string,
  patch: Partial<Omit<Choice, 'id'>>,
): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  return updateQuestion(quiz, questionId, {
    choices: question.choices.map((c) => (c.id === choiceId ? { ...c, ...patch, id: c.id } : c)),
  });
}

/**
 * Quita una opción, y con ella su rastro en el orden correcto.
 *
 * En una pregunta de ordenar, `correctOrder` es una lista de ids de opción:
 * dejar ahí una opción borrada hace que la pregunta no se pueda acertar nunca.
 */
export function removeChoice(quiz: Quiz, questionId: string, choiceId: string): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  return updateQuestion(quiz, questionId, {
    choices: question.choices.filter((c) => c.id !== choiceId),
    correctOrder: question.correctOrder.filter((id) => id !== choiceId),
  });
}

/**
 * Marca una opción como correcta respetando el tipo de pregunta.
 *
 * En las de respuesta única y en verdadero/falso, marcar una desmarca las
 * demás: dos respuestas correctas en una pregunta de respuesta única es un
 * estado que el corrector no sabe puntuar.
 */
export function setChoiceCorrect(
  quiz: Quiz,
  questionId: string,
  choiceId: string,
  correct: boolean,
): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  const exclusive = question.kind === 'singleChoice' || question.kind === 'trueFalse';

  return updateQuestion(quiz, questionId, {
    choices: question.choices.map((c) => {
      if (c.id === choiceId) return { ...c, correct };
      return exclusive && correct ? { ...c, correct: false } : c;
    }),
  });
}

/** Mueve una opción dentro de su pregunta. */
export function moveChoice(
  quiz: Quiz,
  questionId: string,
  choiceId: string,
  toIndex: number,
): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  const from = question.choices.findIndex((c) => c.id === choiceId);
  const moved = question.choices[from];
  if (from < 0 || moved === undefined) return quiz;

  const without = [...question.choices.slice(0, from), ...question.choices.slice(from + 1)];
  const at = clamp(toIndex, 0, without.length);
  return updateQuestion(quiz, questionId, {
    choices: [...without.slice(0, at), moved, ...without.slice(at)],
  });
}

/* ------------------------------------------------------------------ *
 * Búsqueda de marcadores (O04)
 * ------------------------------------------------------------------ */

/**
 * Añade un marcador a buscar.
 *
 * El mismo marcador dos veces en la misma pregunta se puntuaría dos veces por
 * un solo hallazgo, así que se rechaza devolviendo la evaluación intacta.
 */
export function addHuntTarget(
  quiz: Quiz,
  questionId: string,
  target: { readonly sceneId: Uuid; readonly hotspotId: Uuid; readonly label?: string; readonly points?: number },
): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;
  if (question.huntTargets.some((t) => t.hotspotId === target.hotspotId)) return quiz;

  const added: HuntTarget = {
    id: freeId(new Set(question.huntTargets.map((t) => t.id))),
    sceneId: target.sceneId,
    hotspotId: target.hotspotId,
    label: target.label ?? '',
    points: target.points ?? 1,
  };

  return updateQuestion(quiz, questionId, { huntTargets: [...question.huntTargets, added] });
}

export function updateHuntTarget(
  quiz: Quiz,
  questionId: string,
  targetId: string,
  patch: Partial<Omit<HuntTarget, 'id'>>,
): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  return updateQuestion(quiz, questionId, {
    huntTargets: question.huntTargets.map((t) => (t.id === targetId ? { ...t, ...patch, id: t.id } : t)),
  });
}

export function removeHuntTarget(quiz: Quiz, questionId: string, targetId: string): Quiz {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) return quiz;

  return updateQuestion(quiz, questionId, {
    huntTargets: question.huntTargets.filter((t) => t.id !== targetId),
  });
}

/**
 * Marcadores que ya no existen en el proyecto.
 *
 * Un objetivo que apunta a un marcador borrado no se puede encontrar nunca, y
 * la pregunta queda imposible de completar sin que nada lo diga.
 */
export function deadHuntTargets(quiz: Quiz, hotspotIds: ReadonlySet<string>): string[] {
  const dead: string[] = [];

  for (const question of quiz.questions) {
    for (const target of question.huntTargets) {
      if (!hotspotIds.has(target.hotspotId)) dead.push(target.id);
    }
  }

  return dead;
}

/* ------------------------------------------------------------------ *
 * Objetivos de puntuación (O06, O08)
 * ------------------------------------------------------------------ */

/**
 * Añade un objetivo de puntuación.
 *
 * Dos objetivos sobre la misma clave se solaparían al alcanzarse y dispararían
 * dos juegos de acciones; se rechaza.
 */
export function addGoal(
  quiz: Quiz,
  goal: { readonly scoreKey: string; readonly label: string; readonly target: number },
): Quiz {
  if (goal.scoreKey === '' || goal.label === '') return quiz;
  if (quiz.goals.some((g) => g.scoreKey === goal.scoreKey)) return quiz;

  return { ...quiz, goals: [...quiz.goals, { ...goal, onReached: [] }] };
}

export function updateGoal(quiz: Quiz, scoreKey: string, patch: Partial<ScoreGoal>): Quiz {
  let found = false;
  const goals = quiz.goals.map((goal) => {
    if (goal.scoreKey !== scoreKey) return goal;
    found = true;
    return { ...goal, ...patch };
  });
  return found ? { ...quiz, goals } : quiz;
}

export function removeGoal(quiz: Quiz, scoreKey: string): Quiz {
  const goals = quiz.goals.filter((goal) => goal.scoreKey !== scoreKey);
  return goals.length === quiz.goals.length ? quiz : { ...quiz, goals };
}

/**
 * Objetivos imposibles de alcanzar.
 *
 * Un objetivo de 80 sobre un máximo de 60 no se alcanza nunca, y sus acciones
 * tampoco. No impide publicar, pero el autor cree haber configurado algo que
 * no va a pasar.
 */
export function unreachableGoals(quiz: Quiz): string[] {
  const max = maxScoresOf(quiz);
  return quiz.goals.filter((goal) => goal.target > (max[goal.scoreKey] ?? 0)).map((g) => g.scoreKey);
}

/** Claves de puntuación realmente usadas por las preguntas. */
export function scoreKeysOf(quiz: Quiz): string[] {
  const keys = new Set<string>();
  for (const question of quiz.questions) keys.add(question.scoreKey);
  return [...keys].sort((a, b) => a.localeCompare(b, 'es'));
}

/**
 * Objetivos cuya clave no la usa ninguna pregunta.
 *
 * Un objetivo sobre una clave que nadie puntúa nunca se alcanza, y sus
 * acciones nunca se ejecutan. No es un error que impida publicar, pero el
 * autor cree que ha configurado algo que no va a pasar.
 */
export function orphanGoals(quiz: Quiz): string[] {
  const keys = new Set(scoreKeysOf(quiz));
  return quiz.goals.filter((goal) => !keys.has(goal.scoreKey)).map((goal) => goal.scoreKey);
}

/** Puntuación máxima alcanzable por clave, sin contar penalizaciones. */
export function maxScoresOf(quiz: Quiz): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const question of quiz.questions) {
    const best = bestPointsOf(question);
    totals[question.scoreKey] = (totals[question.scoreKey] ?? 0) + best;
  }

  return totals;
}

function bestPointsOf(question: Question): number {
  if (question.kind === 'hotspotHunt') {
    return question.huntTargets.reduce((sum, target) => sum + target.points, 0);
  }

  if (question.kind === 'multipleChoice') {
    // Varias correctas suman; las de puntos negativos no las elegiría quien
    // acierta, así que no entran en el máximo.
    return question.choices
      .filter((c) => c.correct && c.points > 0)
      .reduce((sum, c) => sum + c.points, 0);
  }

  const positives = question.choices.map((c) => c.points).filter((p) => p > 0);
  return positives.length === 0 ? 0 : Math.max(...positives);
}

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const sortByOrder = <T extends { readonly order: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.order - b.order);

const renumber = <T extends { readonly order: number }>(items: readonly T[]): T[] =>
  items.map((item, index) => ({ ...item, order: index }));

/** Identificador corto para preguntas y opciones, que no son UUID. */
function shortId(): string {
  return `p${newUuid().slice(0, 8)}`;
}

function freeId(taken: ReadonlySet<string>): string {
  let candidate = shortId();
  while (taken.has(candidate)) candidate = shortId();
  return candidate;
}

/** Primera letra libre; tras la `z`, identificadores con número. */
function freeChoiceId(existing: readonly Choice[]): string {
  const taken = new Set(existing.map((c) => c.id));

  for (let code = 97; code <= 122; code += 1) {
    const letter = String.fromCharCode(code);
    if (!taken.has(letter)) return letter;
  }

  let index = 1;
  while (taken.has(`o${index}`)) index += 1;
  return `o${index}`;
}
