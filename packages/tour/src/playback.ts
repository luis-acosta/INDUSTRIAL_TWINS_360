/**
 * Decisiones de reproducción del recorrido automático y de la evaluación.
 *
 * El motor de estados vive en `@it360/domain` (`tourReducer`, `submitAnswer`);
 * aquí está lo que el visor tiene que decidir alrededor y que no es una
 * transición de estado: cuánto dura de verdad una parada, si un recorrido
 * puede empezar, qué opciones se pueden marcar y cuándo se puede responder.
 *
 * Está separado del componente porque es donde se esconden los fallos que
 * dejan al visitante atascado, y eso se prueba mejor sin pintar nada:
 *
 *  - Una parada que espera a un audio que el navegador **no deja sonar** se
 *    quedaría esperando para siempre. Los navegadores bloquean la
 *    reproducción automática con sonido mientras el visitante no haya tocado
 *    la página, así que la espera por audio necesita siempre un plazo
 *    máximo.
 *  - Un recorrido condicionado a una evaluación que no se ha hecho no debe
 *    arrancar en silencio ni arrancar a medias: tiene que decir qué falta.
 */
import {
  orderedWaypoints,
  type Quiz,
  type QuizRuntime,
  type Question,
  type Tour,
  type TourRuntime,
  type Waypoint,
} from '@it360/domain';

/* ------------------------------------------------------------------ *
 * Duración real de una parada
 * ------------------------------------------------------------------ */

/**
 * Plazo máximo esperando a un audio, en ms.
 *
 * Es el seguro contra la reproducción automática bloqueada: si el audio nunca
 * empieza ni termina, la parada sigue adelante en lugar de dejar el recorrido
 * congelado delante del visitante.
 */
export const AUDIO_WAIT_CEILING_MS = 300_000;

/** Permanencia mínima cuando el autor dejó la parada en cero. */
export const MIN_DWELL_MS = 1200;

export interface DwellPlan {
  /** Milisegundos a esperar antes de pasar a la parada siguiente. */
  readonly dwellMs: number;
  /** La parada termina cuando acabe el audio, no al cumplirse `dwellMs`. */
  readonly waitsForAudio: boolean;
}

/**
 * Cuánto dura una parada y qué la termina.
 *
 * `audioAvailable` dice si hay un audio que de verdad se puede reproducir, no
 * si el autor configuró uno: un medio que falta o que el navegador rechaza
 * cuenta como ausente, y entonces manda `dwellMs`.
 */
export function dwellPlan(waypoint: Waypoint, audioAvailable: boolean): DwellPlan {
  const waitsForAudio = waypoint.waitForAudio && audioAvailable;

  if (waitsForAudio) {
    // Incluso esperando al audio hay plazo: el `ended` puede no llegar nunca.
    return { dwellMs: AUDIO_WAIT_CEILING_MS, waitsForAudio: true };
  }

  return { dwellMs: Math.max(waypoint.dwellMs, MIN_DWELL_MS), waitsForAudio: false };
}

/** Parada en curso, o `null` si el recorrido no está reproduciéndose. */
export function currentWaypoint(tour: Tour, runtime: TourRuntime): Waypoint | null {
  if (runtime.state === 'idle') return null;
  return orderedWaypoints(tour)[runtime.waypointIndex] ?? null;
}

/* ------------------------------------------------------------------ *
 * Condición de acceso (J08)
 * ------------------------------------------------------------------ */

export type GateVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly quizId: string | null };

export interface SessionResult {
  readonly quizId: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly finished: boolean;
}

/**
 * Si el recorrido puede empezar.
 *
 * La comprobación es en memoria, de la sesión en curso: el paquete publicado
 * es de sólo lectura y no hay dónde guardar un expediente. Eso se dice al
 * visitante en lugar de insinuar un historial que no existe.
 */
export function tourGate(
  tour: Tour,
  quizzes: readonly Quiz[],
  results: readonly SessionResult[],
): GateVerdict {
  if (tour.requiresQuizId === null) return { allowed: true };

  const quiz = quizzes.find((q) => q.id === tour.requiresQuizId);
  if (quiz === undefined) {
    return {
      allowed: false,
      reason: 'Este recorrido exige una evaluación que no está en el paquete publicado.',
      quizId: null,
    };
  }

  const result = results.find((r) => r.quizId === quiz.id && r.finished);
  if (result === undefined) {
    return {
      allowed: false,
      reason: `Antes de este recorrido hay que completar «${quiz.name}».`,
      quizId: quiz.id,
    };
  }

  if (tour.requiresQuizMinScore === null) return { allowed: true };

  const obtained = totalScore(result.scores);
  if (obtained < tour.requiresQuizMinScore) {
    return {
      allowed: false,
      reason: `«${quiz.name}» requiere al menos ${tour.requiresQuizMinScore} puntos; obtuvo ${obtained}.`,
      quizId: quiz.id,
    };
  }

  return { allowed: true };
}

export const totalScore = (scores: Readonly<Record<string, number>>): number =>
  Object.values(scores).reduce((sum, value) => sum + value, 0);

/* ------------------------------------------------------------------ *
 * Respuesta a una pregunta
 * ------------------------------------------------------------------ */

/** Cómo se marca una pregunta: una opción, varias, o encontrando marcadores. */
export type SelectionMode = 'single' | 'multiple' | 'ordered' | 'hunt';

export function selectionMode(question: Question): SelectionMode {
  switch (question.kind) {
    case 'singleChoice':
    case 'trueFalse':
      return 'single';
    case 'multipleChoice':
      return 'multiple';
    case 'ordering':
      return 'ordered';
    case 'hotspotHunt':
      return 'hunt';
    default: {
      const exhaustive: never = question.kind;
      throw new Error(`Tipo de pregunta no contemplado: ${String(exhaustive)}`);
    }
  }
}

/**
 * Aplica una elección a la selección actual.
 *
 * En respuesta única sustituye; en múltiple alterna; en ordenar añade al final
 * o quita del orden. Devolver siempre la selección completa evita que el
 * componente tenga que saber de qué tipo es la pregunta.
 */
export function toggleSelection(
  question: Question,
  selected: readonly string[],
  choiceId: string,
): string[] {
  const mode = selectionMode(question);

  if (mode === 'single') return [choiceId];

  if (mode === 'ordered') {
    return selected.includes(choiceId)
      ? selected.filter((id) => id !== choiceId)
      : [...selected, choiceId];
  }

  return selected.includes(choiceId)
    ? selected.filter((id) => id !== choiceId)
    : [...selected, choiceId];
}

/**
 * Si se puede enviar la respuesta.
 *
 * Una pregunta obligatoria sin nada marcado no se envía: enviarla vacía
 * contaría como fallo sin que el evaluado haya decidido nada. Una opcional sí,
 * que es lo que significa poder saltarla.
 */
export function canSubmit(question: Question, selected: readonly string[]): boolean {
  if (selected.length > 0) return true;
  return !question.required;
}

/** Intentos restantes; `null` cuando son ilimitados. */
export function attemptsLeft(question: Question, runtime: QuizRuntime): number | null {
  if (question.maxAttempts === 0) return null;
  const used = runtime.attempts[question.id] ?? 0;
  return Math.max(question.maxAttempts - used, 0);
}

export function canRetry(question: Question, runtime: QuizRuntime): boolean {
  const left = attemptsLeft(question, runtime);
  return left === null || left > 0;
}

/* ------------------------------------------------------------------ *
 * Búsqueda de marcadores (O04)
 * ------------------------------------------------------------------ */

export interface HuntProgress {
  readonly found: number;
  readonly total: number;
  /** Identificadores de marcador que todavía no se han encontrado. */
  readonly pending: readonly string[];
  readonly complete: boolean;
}

/**
 * Avance de una búsqueda de marcadores.
 *
 * `selected` son los identificadores de **objetivo** ya encontrados. Se
 * cuentan los objetivos, no los marcadores pulsados: pulsar dos veces el
 * mismo no cuenta dos veces.
 */
export function huntProgress(question: Question, selected: readonly string[]): HuntProgress {
  const unique = new Set(selected);
  const pending = question.huntTargets.filter((t) => !unique.has(t.id)).map((t) => t.id);

  return {
    found: question.huntTargets.length - pending.length,
    total: question.huntTargets.length,
    pending,
    complete: pending.length === 0 && question.huntTargets.length > 0,
  };
}

/** Objetivo que corresponde a un marcador pulsado, si lo hay. */
export function targetForHotspot(question: Question, hotspotId: string): string | null {
  return question.huntTargets.find((t) => t.hotspotId === hotspotId)?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * Fin de sesión (O09)
 * ------------------------------------------------------------------ */

export interface ScoreLine {
  readonly scoreKey: string;
  readonly obtained: number;
  readonly passing: number | null;
  readonly passed: boolean | null;
}

/**
 * Puntuaciones de la evaluación, con el apto por clave.
 *
 * `passed` es `null` cuando la clave no tiene nota mínima: no es un suspenso,
 * es que no se exigía nada, y presentarlo como fallo sería mentir sobre el
 * resultado.
 */
export function scoreLines(quiz: Quiz, runtime: QuizRuntime): ScoreLine[] {
  const keys = new Set<string>([
    ...quiz.questions.map((q) => q.scoreKey),
    ...Object.keys(runtime.scores),
    ...Object.keys(quiz.passingScores),
  ]);

  return [...keys]
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((scoreKey) => {
      const obtained = runtime.scores[scoreKey] ?? 0;
      const passing = quiz.passingScores[scoreKey];

      return {
        scoreKey,
        obtained,
        passing: passing ?? null,
        passed: passing === undefined ? null : obtained >= passing,
      };
    });
}

/** `true` cuando todas las claves con nota mínima la alcanzan. */
export function quizPassed(quiz: Quiz, runtime: QuizRuntime): boolean {
  return scoreLines(quiz, runtime).every((line) => line.passed !== false);
}

/** Duración de la sesión en segundos; `null` si no ha terminado. */
export function quizElapsedS(runtime: QuizRuntime): number | null {
  if (runtime.finishedAtMs === null) return null;
  return Math.max(Math.round((runtime.finishedAtMs - runtime.startedAtMs) / 1000), 0);
}

/** Duración legible: «2 min 15 s», «48 s». */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
