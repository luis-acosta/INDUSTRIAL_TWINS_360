/**
 * Recorridos automáticos y formación (etapa 09, grupos J01-J03, J08 y O).
 *
 * Dos máquinas de estado conviven aquí:
 *
 *  - El **autopilot**, que recorre puntos de paso y puede ser interrumpido
 *    por el visitante en cualquier momento (J03). La interrupción no es un
 *    detalle de implementación: un recorrido que no se puede parar convierte
 *    al visitante en espectador, y el requisito pide lo contrario.
 *  - La **evaluación**, con preguntas, puntuaciones múltiples y ramas (O01-O10).
 *
 * Están en el mismo módulo porque se condicionan: un recorrido puede
 * depender del resultado de una evaluación (J08) y una evaluación puede
 * desbloquear acciones al alcanzar un objetivo (O08).
 */
import { z } from 'zod';
import { actionSchema } from './action';
import { cameraViewSchema } from './coordinates';
import { uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Autopilot (J01, J02)
 * ------------------------------------------------------------------ */

export const waypointSchema = z.object({
  id: uuidSchema,
  sceneId: uuidSchema,
  /** Vista a la que se lleva la cámara al llegar. */
  view: cameraViewSchema,
  /** Tiempo de permanencia en el punto, en ms. */
  dwellMs: z.number().int().min(0).max(600_000).default(4000),
  /** Duración del desplazamiento hasta este punto, en ms. */
  travelMs: z.number().int().min(0).max(60_000).default(1500),
  /** Acciones que se ejecutan al llegar (J02). */
  actions: z.array(actionSchema).default([]),
  /** Rótulo mostrado durante la parada. */
  caption: z.string().max(1000).default(''),
  /** Narración o audio reproducido en la parada. */
  audioMediaId: uuidSchema.nullable().default(null),
  /**
   * Esperar a que termine el audio antes de continuar, ignorando `dwellMs`.
   * Sin esto, una narración de 30 s en una parada de 4 s se corta a mitad.
   */
  waitForAudio: z.boolean().default(true),
  order: z.number().int().nonnegative().default(0),
});

export type Waypoint = z.infer<typeof waypointSchema>;

export const tourSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  waypoints: z.array(waypointSchema).default([]),
  loop: z.boolean().default(false),
  /**
   * Permitir al visitante interrumpir el recorrido (J03).
   *
   * Es configurable pero su valor por defecto es `true` y la interfaz
   * advierte al desactivarlo: un recorrido no interrumpible sólo tiene
   * sentido en un modo quiosco vigilado.
   */
  allowInterrupt: z.boolean().default(true),
  /** Reanudar donde se quedó, o volver al principio tras interrumpir. */
  resumeAfterInterrupt: z.boolean().default(true),
  /** Segundos de inactividad tras los que se reanuda solo. 0 = nunca. */
  autoResumeIdleS: z.number().int().min(0).max(3600).default(0),
  /** Evaluación que debe superarse para habilitar el recorrido (J08). */
  requiresQuizId: uuidSchema.nullable().default(null),
  requiresQuizMinScore: z.number().min(0).nullable().default(null),
  /** Acciones al iniciar y al terminar. */
  onStart: z.array(actionSchema).default([]),
  onEnd: z.array(actionSchema).default([]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Tour = z.infer<typeof tourSchema>;

export const tourStateSchema = z.enum(['idle', 'traveling', 'dwelling', 'interrupted', 'finished']);
export type TourState = z.infer<typeof tourStateSchema>;

export interface TourRuntime {
  readonly state: TourState;
  readonly tourId: string | null;
  readonly waypointIndex: number;
  /** Progreso dentro del tramo actual, 0-1. */
  readonly segmentProgress: number;
  /** Momento en que se interrumpió, para el reanudado automático. */
  readonly interruptedAtMs: number | null;
  /** Punto en el que se interrumpió, para reanudar ahí. */
  readonly resumeIndex: number;
}

export const INITIAL_TOUR_RUNTIME: TourRuntime = {
  state: 'idle',
  tourId: null,
  waypointIndex: 0,
  segmentProgress: 0,
  interruptedAtMs: null,
  resumeIndex: 0,
};

export type TourEvent =
  | { readonly type: 'start'; readonly tourId: string; readonly fromIndex?: number }
  | { readonly type: 'arrive' }
  | { readonly type: 'dwellComplete' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'resume' }
  | { readonly type: 'stop' }
  | { readonly type: 'tick'; readonly progress: number }
  | { readonly type: 'jumpTo'; readonly index: number };

/**
 * Transición de la máquina de estados del autopilot.
 *
 * Es una función pura sobre `(estado, evento) -> estado`: el motor del visor
 * sólo aporta los temporizadores. Esto permite probar el ciclo completo
 * —arrancar, viajar, parar, interrumpir, reanudar, terminar— sin renderizar
 * nada y sin esperar en tiempo real.
 */
export function tourReducer(
  runtime: TourRuntime,
  event: TourEvent,
  tour: Tour | null,
  nowMs: number,
): TourRuntime {
  switch (event.type) {
    case 'start': {
      const from = event.fromIndex ?? 0;
      return {
        state: 'traveling',
        tourId: event.tourId,
        waypointIndex: from,
        segmentProgress: 0,
        interruptedAtMs: null,
        resumeIndex: from,
      };
    }

    case 'tick':
      if (runtime.state !== 'traveling') return runtime;
      return { ...runtime, segmentProgress: Math.min(Math.max(event.progress, 0), 1) };

    case 'arrive':
      if (runtime.state !== 'traveling') return runtime;
      return { ...runtime, state: 'dwelling', segmentProgress: 1 };

    case 'dwellComplete': {
      if (runtime.state !== 'dwelling' || tour === null) return runtime;
      const next = runtime.waypointIndex + 1;
      if (next < tour.waypoints.length) {
        return { ...runtime, state: 'traveling', waypointIndex: next, segmentProgress: 0 };
      }
      if (tour.loop) {
        return { ...runtime, state: 'traveling', waypointIndex: 0, segmentProgress: 0 };
      }
      return { ...runtime, state: 'finished', segmentProgress: 1 };
    }

    case 'interrupt': {
      // Un recorrido no interrumpible ignora el evento; uno ya terminado o
      // inactivo tampoco tiene nada que interrumpir.
      if (tour !== null && !tour.allowInterrupt) return runtime;
      if (runtime.state === 'idle' || runtime.state === 'finished') return runtime;
      return {
        ...runtime,
        state: 'interrupted',
        interruptedAtMs: nowMs,
        resumeIndex: runtime.waypointIndex,
      };
    }

    case 'resume': {
      if (runtime.state !== 'interrupted' || tour === null) return runtime;
      const index = tour.resumeAfterInterrupt ? runtime.resumeIndex : 0;
      return {
        ...runtime,
        state: 'traveling',
        waypointIndex: index,
        segmentProgress: 0,
        interruptedAtMs: null,
      };
    }

    case 'jumpTo': {
      if (tour === null) return runtime;
      const index = Math.min(Math.max(event.index, 0), Math.max(tour.waypoints.length - 1, 0));
      return { ...runtime, state: 'traveling', waypointIndex: index, segmentProgress: 0 };
    }

    case 'stop':
      return { ...INITIAL_TOUR_RUNTIME, tourId: runtime.tourId };

    default: {
      const exhaustive: never = event;
      throw new Error(`Evento de recorrido no contemplado: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** `true` si procede reanudar solo por inactividad. */
export function shouldAutoResume(runtime: TourRuntime, tour: Tour, nowMs: number): boolean {
  if (runtime.state !== 'interrupted' || tour.autoResumeIdleS <= 0) return false;
  if (runtime.interruptedAtMs === null) return false;
  return nowMs - runtime.interruptedAtMs >= tour.autoResumeIdleS * 1000;
}

/** Progreso global del recorrido, 0-1. */
export function tourProgress(runtime: TourRuntime, tour: Tour): number {
  const total = tour.waypoints.length;
  if (total === 0) return 0;
  if (runtime.state === 'finished') return 1;
  const completed = runtime.waypointIndex + (runtime.state === 'dwelling' ? 1 : runtime.segmentProgress);
  return Math.min(Math.max(completed / total, 0), 1);
}

export function orderedWaypoints(tour: Tour): Waypoint[] {
  return [...tour.waypoints].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id),
  );
}

/* ------------------------------------------------------------------ *
 * Evaluaciones (O01-O09)
 * ------------------------------------------------------------------ */

/**
 * Tipos de pregunta.
 *
 * `hotspotHunt` es la «búsqueda de riesgos u objetos» de O04: el visitante
 * debe localizar puntos en la escena en lugar de elegir una opción. Es el
 * formato que de verdad evalúa observación sobre una panorámica, y la razón
 * por la que una evaluación dentro de un recorrido aporta algo que un
 * cuestionario en papel no.
 */
export const questionKindSchema = z.enum([
  'singleChoice',
  'multipleChoice',
  'trueFalse',
  'hotspotHunt',
  'ordering',
]);

export type QuestionKind = z.infer<typeof questionKindSchema>;

export const choiceSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  correct: z.boolean().default(false),
  /** Explicación mostrada tras responder. */
  feedback: z.string().max(2000).default(''),
  /** Puntos de esta opción; permite respuestas parcialmente acertadas (O05). */
  points: z.number().finite().default(0),
  /** Rama: pregunta a la que se salta si se elige esta opción (O07). */
  nextQuestionId: z.string().max(64).nullable().default(null),
});

export type Choice = z.infer<typeof choiceSchema>;

export const huntTargetSchema = z.object({
  id: z.string().min(1).max(64),
  sceneId: uuidSchema,
  /** Marcador que hay que encontrar. */
  hotspotId: uuidSchema,
  label: z.string().max(300).default(''),
  points: z.number().finite().default(1),
});

export type HuntTarget = z.infer<typeof huntTargetSchema>;

export const questionSchema = z.object({
  id: z.string().min(1).max(64),
  kind: questionKindSchema,
  prompt: z.string().min(1).max(5000),
  /** Multimedia dentro de la pregunta (O03). */
  mediaId: uuidSchema.nullable().default(null),
  /** Escena en la que se plantea; `null` = en la actual. */
  sceneId: uuidSchema.nullable().default(null),
  choices: z.array(choiceSchema).default([]),
  huntTargets: z.array(huntTargetSchema).default([]),
  /** Orden correcto para `ordering`, como lista de ids de opción. */
  correctOrder: z.array(z.string().max(64)).default([]),
  /** Clave de puntuación a la que suma esta pregunta (O06). */
  scoreKey: z.string().min(1).max(64).default('general'),
  /** Penalización por respuesta incorrecta (O05). */
  penalty: z.number().min(0).default(0),
  /** Tiempo límite en segundos; 0 = sin límite. */
  timeLimitS: z.number().int().min(0).max(3600).default(0),
  /** Intentos permitidos; 0 = ilimitados. */
  maxAttempts: z.number().int().min(0).max(20).default(1),
  /** Pregunta a la que se continúa si no hay rama en la opción elegida. */
  nextQuestionId: z.string().max(64).nullable().default(null),
  required: z.boolean().default(true),
  order: z.number().int().nonnegative().default(0),
});

export type Question = z.infer<typeof questionSchema>;

/** Objetivo de puntuación que desbloquea acciones (O08). */
export const scoreGoalSchema = z.object({
  scoreKey: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  /** Puntuación mínima para considerarlo alcanzado. */
  target: z.number().finite(),
  onReached: z.array(actionSchema).default([]),
});

export type ScoreGoal = z.infer<typeof scoreGoalSchema>;

export const quizSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  questions: z.array(questionSchema).default([]),
  /** Primera pregunta; `null` = la de menor `order`. */
  entryQuestionId: z.string().max(64).nullable().default(null),
  goals: z.array(scoreGoalSchema).default([]),
  /** Puntuación mínima para aprobar, por clave. */
  passingScores: z.record(z.string().max(64), z.number().finite()).default({}),
  /** Mostrar explicación de cada respuesta inmediatamente. */
  immediateFeedback: z.boolean().default(true),
  /** Presentar las preguntas en orden aleatorio. */
  shuffleQuestions: z.boolean().default(false),
  shuffleChoices: z.boolean().default(false),
  /** Mostrar informe final con tiempos (O09). */
  showReport: z.boolean().default(true),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Quiz = z.infer<typeof quizSchema>;

/* ------------------------------------------------------------------ *
 * Ejecución de la evaluación
 * ------------------------------------------------------------------ */

export const answerSchema = z.object({
  questionId: z.string().min(1).max(64),
  /** Opciones elegidas, o ids de objetivo encontrados, o el orden propuesto. */
  selectedIds: z.array(z.string().max(64)).default([]),
  correct: z.boolean(),
  pointsAwarded: z.number().finite(),
  scoreKey: z.string().min(1).max(64),
  attempt: z.number().int().positive().default(1),
  /** Milisegundos empleados en responder. */
  elapsedMs: z.number().int().nonnegative().default(0),
  answeredAt: z.string().datetime({ offset: true }),
});

export type Answer = z.infer<typeof answerSchema>;

export interface QuizRuntime {
  readonly quizId: string;
  readonly currentQuestionId: string | null;
  readonly answers: readonly Answer[];
  /** Puntuaciones acumuladas por clave (O06). */
  readonly scores: Readonly<Record<string, number>>;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  /** Objetivos ya alcanzados: evita volver a disparar sus acciones. */
  readonly reachedGoals: readonly string[];
  readonly attempts: Readonly<Record<string, number>>;
}

export function startQuiz(quiz: Quiz, nowMs: number): QuizRuntime {
  const first =
    quiz.entryQuestionId ??
    [...quiz.questions].sort((a, b) => a.order - b.order)[0]?.id ??
    null;
  return {
    quizId: quiz.id,
    currentQuestionId: first,
    answers: [],
    scores: {},
    startedAtMs: nowMs,
    finishedAtMs: null,
    reachedGoals: [],
    attempts: {},
  };
}

/**
 * Corrige una respuesta y calcula los puntos.
 *
 * Reglas, en este orden:
 *  1. Si la pregunta define puntos por opción, se suman los de las elegidas.
 *  2. Si no, acertar vale 1 punto y fallar aplica la penalización declarada.
 *  3. La puntuación nunca se corrige retroactivamente: un segundo intento
 *     suma sobre lo ya obtenido, no lo reemplaza. Reemplazarlo permitiría
 *     mejorar la nota repitiendo hasta acertar sin coste.
 */
export function gradeAnswer(
  question: Question,
  selectedIds: readonly string[],
): { correct: boolean; points: number } {
  // Sin penalización declarada el fallo vale cero, no «menos cero»: el valor
  // -0 de JavaScript se serializaría como «-0» en el CSV del informe.
  const failPoints = question.penalty > 0 ? -question.penalty : 0;

  switch (question.kind) {
    case 'singleChoice':
    case 'trueFalse': {
      const chosen = question.choices.find((c) => c.id === selectedIds[0]);
      if (chosen === undefined) return { correct: false, points: failPoints };
      const explicitPoints = question.choices.some((c) => c.points !== 0);
      if (explicitPoints) return { correct: chosen.correct, points: chosen.points };
      return chosen.correct ? { correct: true, points: 1 } : { correct: false, points: failPoints };
    }

    case 'multipleChoice': {
      const correctIds = new Set(question.choices.filter((c) => c.correct).map((c) => c.id));
      const selected = new Set(selectedIds);
      const allCorrectChosen = [...correctIds].every((id) => selected.has(id));
      const noWrongChosen = [...selected].every((id) => correctIds.has(id));
      const fullyCorrect = allCorrectChosen && noWrongChosen && selected.size > 0;

      const explicitPoints = question.choices.some((c) => c.points !== 0);
      if (explicitPoints) {
        const points = question.choices
          .filter((c) => selected.has(c.id))
          .reduce((sum, c) => sum + c.points, 0);
        return { correct: fullyCorrect, points };
      }
      return fullyCorrect ? { correct: true, points: 1 } : { correct: false, points: failPoints };
    }

    case 'hotspotHunt': {
      const targetIds = new Set(question.huntTargets.map((t) => t.id));
      const found = selectedIds.filter((id) => targetIds.has(id));
      const points = question.huntTargets
        .filter((t) => found.includes(t.id))
        .reduce((sum, t) => sum + t.points, 0);
      const complete = found.length === targetIds.size && targetIds.size > 0;
      // Encontrar parte de los riesgos puntúa parcialmente: en una búsqueda
      // de riesgos, localizar tres de cuatro no equivale a no ver ninguno.
      return { correct: complete, points: complete ? points : points + failPoints };
    }

    case 'ordering': {
      const expected = question.correctOrder;
      const correct =
        expected.length === selectedIds.length &&
        expected.every((id, index) => selectedIds[index] === id);
      return correct ? { correct: true, points: 1 } : { correct: false, points: failPoints };
    }

    default: {
      const exhaustive: never = question.kind;
      throw new Error(`Tipo de pregunta no contemplado: ${String(exhaustive)}`);
    }
  }
}

/** Siguiente pregunta según las ramas declaradas (O07). */
export function nextQuestionId(
  quiz: Quiz,
  question: Question,
  selectedIds: readonly string[],
): string | null {
  // La rama de la opción elegida tiene prioridad sobre la de la pregunta.
  for (const id of selectedIds) {
    const choice = question.choices.find((c) => c.id === id);
    if (choice?.nextQuestionId != null) return choice.nextQuestionId;
  }
  if (question.nextQuestionId !== null) return question.nextQuestionId;

  const ordered = [...quiz.questions].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((q) => q.id === question.id);
  return index >= 0 && index + 1 < ordered.length ? (ordered[index + 1]?.id ?? null) : null;
}

export interface SubmitResult {
  readonly runtime: QuizRuntime;
  readonly answer: Answer;
  /** Objetivos alcanzados con esta respuesta; sus acciones deben ejecutarse. */
  readonly newlyReachedGoals: readonly ScoreGoal[];
}

/** Registra una respuesta y avanza la evaluación. */
export function submitAnswer(
  quiz: Quiz,
  runtime: QuizRuntime,
  questionId: string,
  selectedIds: readonly string[],
  nowMs: number,
  isoNow: string,
): SubmitResult {
  const question = quiz.questions.find((q) => q.id === questionId);
  if (question === undefined) {
    throw new Error(`La evaluación no contiene la pregunta ${questionId}`);
  }

  const attempt = (runtime.attempts[questionId] ?? 0) + 1;
  const { correct, points } = gradeAnswer(question, selectedIds);

  const lastAnswerMs =
    runtime.answers.length > 0 ? runtime.startedAtMs : runtime.startedAtMs;

  const answer: Answer = {
    questionId,
    selectedIds: [...selectedIds],
    correct,
    pointsAwarded: points,
    scoreKey: question.scoreKey,
    attempt,
    elapsedMs: Math.max(nowMs - lastAnswerMs, 0),
    answeredAt: isoNow,
  };

  const scores = {
    ...runtime.scores,
    [question.scoreKey]: (runtime.scores[question.scoreKey] ?? 0) + points,
  };

  const newlyReachedGoals = quiz.goals.filter(
    (goal) =>
      !runtime.reachedGoals.includes(goal.scoreKey) &&
      (scores[goal.scoreKey] ?? 0) >= goal.target,
  );

  const next = nextQuestionId(quiz, question, selectedIds);

  return {
    runtime: {
      ...runtime,
      answers: [...runtime.answers, answer],
      scores,
      attempts: { ...runtime.attempts, [questionId]: attempt },
      currentQuestionId: next,
      finishedAtMs: next === null ? nowMs : null,
      reachedGoals: [...runtime.reachedGoals, ...newlyReachedGoals.map((g) => g.scoreKey)],
    },
    answer,
    newlyReachedGoals,
  };
}

/* ------------------------------------------------------------------ *
 * Informe (O09, O10)
 * ------------------------------------------------------------------ */

export interface QuizReport {
  readonly quizId: string;
  readonly quizName: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly totalMs: number;
  readonly questionCount: number;
  readonly answeredCount: number;
  readonly correctCount: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly passed: boolean;
  readonly perScore: ReadonlyArray<{
    readonly key: string;
    readonly score: number;
    readonly required: number | null;
    readonly passed: boolean;
  }>;
  readonly answers: readonly Answer[];
}

/**
 * Compone el informe final.
 *
 * Aprueba quien cumple TODAS las puntuaciones mínimas declaradas. Con varias
 * puntuaciones independientes (O06), aprobar por la media permitiría superar
 * una formación de seguridad compensando con la de proceso, que es
 * exactamente lo que no debe pasar.
 */
export function buildReport(quiz: Quiz, runtime: QuizRuntime, isoNow: string): QuizReport {
  const perScore: Array<{
    key: string;
    score: number;
    required: number | null;
    passed: boolean;
  }> = Object.entries(quiz.passingScores).map(([key, required]) => ({
    key,
    score: runtime.scores[key] ?? 0,
    required,
    passed: (runtime.scores[key] ?? 0) >= required,
  }));

  const extraKeys = Object.keys(runtime.scores).filter((k) => !(k in quiz.passingScores));
  for (const key of extraKeys) {
    perScore.push({ key, score: runtime.scores[key] ?? 0, required: null, passed: true });
  }

  const finishedAtMs = runtime.finishedAtMs;

  return {
    quizId: quiz.id,
    quizName: quiz.name,
    startedAt: new Date(runtime.startedAtMs).toISOString(),
    finishedAt: finishedAtMs === null ? null : new Date(finishedAtMs).toISOString(),
    totalMs: Math.max((finishedAtMs ?? Date.parse(isoNow)) - runtime.startedAtMs, 0),
    questionCount: quiz.questions.length,
    answeredCount: new Set(runtime.answers.map((a) => a.questionId)).size,
    correctCount: runtime.answers.filter((a) => a.correct).length,
    scores: runtime.scores,
    passed: perScore.every((s) => s.passed),
    perScore,
    answers: runtime.answers,
  };
}

/** Informe a CSV para exportación (O10). */
export function reportToCsv(report: QuizReport): string {
  const escape = (value: string): string =>
    /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const header = [
    'evaluacion',
    'pregunta',
    'intento',
    'respuestas',
    'correcta',
    'puntos',
    'clave_puntuacion',
    'ms_empleados',
    'respondida_en',
  ].join(';');

  const rows = report.answers.map((a) =>
    [
      escape(report.quizName),
      escape(a.questionId),
      String(a.attempt),
      escape(a.selectedIds.join('|')),
      a.correct ? 'si' : 'no',
      String(a.pointsAwarded),
      escape(a.scoreKey),
      String(a.elapsedMs),
      a.answeredAt,
    ].join(';'),
  );

  const summary = [
    '',
    escape('RESUMEN'),
    '',
    '',
    report.passed ? 'aprobado' : 'no aprobado',
    String(Object.values(report.scores).reduce((s, v) => s + v, 0)),
    escape(report.perScore.map((s) => `${s.key}=${s.score}`).join('|')),
    String(report.totalMs),
    report.finishedAt ?? '',
  ].join(';');

  return [header, ...rows, summary].join('\n');
}

export interface QuizProblem {
  readonly questionId: string;
  readonly message: string;
}

/**
 * Valida una evaluación.
 *
 * El fallo que esta función existe para impedir es la rama rota: una opción
 * que salta a una pregunta borrada deja la evaluación muerta a mitad, y el
 * autor no lo descubre hasta que alguien la hace. También detecta ciclos,
 * que dejarían al visitante dando vueltas sin poder terminar.
 */
export function validateQuiz(quiz: Quiz): QuizProblem[] {
  const problems: QuizProblem[] = [];
  const ids = new Set(quiz.questions.map((q) => q.id));

  if (quiz.entryQuestionId !== null && !ids.has(quiz.entryQuestionId)) {
    problems.push({ questionId: quiz.entryQuestionId, message: 'La pregunta inicial no existe' });
  }

  for (const question of quiz.questions) {
    if (question.nextQuestionId !== null && !ids.has(question.nextQuestionId)) {
      problems.push({
        questionId: question.id,
        message: `Continúa hacia una pregunta inexistente: ${question.nextQuestionId}`,
      });
    }

    for (const choice of question.choices) {
      if (choice.nextQuestionId !== null && !ids.has(choice.nextQuestionId)) {
        problems.push({
          questionId: question.id,
          message: `La opción «${choice.text}» salta a una pregunta inexistente`,
        });
      }
    }

    switch (question.kind) {
      case 'singleChoice':
      case 'trueFalse':
        if (question.choices.length < 2) {
          problems.push({ questionId: question.id, message: 'Necesita al menos dos opciones' });
        }
        if (!question.choices.some((c) => c.correct) && !question.choices.some((c) => c.points !== 0)) {
          problems.push({
            questionId: question.id,
            message: 'No tiene ninguna opción correcta ni puntos por opción',
          });
        }
        break;
      case 'multipleChoice':
        if (question.choices.length < 2) {
          problems.push({ questionId: question.id, message: 'Necesita al menos dos opciones' });
        }
        break;
      case 'hotspotHunt':
        if (question.huntTargets.length === 0) {
          problems.push({
            questionId: question.id,
            message: 'Una búsqueda necesita al menos un objetivo',
          });
        }
        break;
      case 'ordering':
        if (question.correctOrder.length !== question.choices.length) {
          problems.push({
            questionId: question.id,
            message: 'El orden correcto debe incluir todas las opciones',
          });
        }
        break;
      default:
        break;
    }
  }

  // Ciclos: se recorre el grafo desde la entrada siguiendo la rama por defecto.
  const start = quiz.entryQuestionId ?? [...quiz.questions].sort((a, b) => a.order - b.order)[0]?.id;
  if (start !== undefined) {
    const visited = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        problems.push({ questionId: cursor, message: 'La secuencia de preguntas forma un ciclo' });
        break;
      }
      visited.add(cursor);
      const question = quiz.questions.find((q) => q.id === cursor);
      if (question === undefined) break;
      cursor = question.nextQuestionId;
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Validación del recorrido automático (J01–J03, J08)
 * ------------------------------------------------------------------ */

export interface TourProblem {
  /** Punto de paso afectado, o `null` si el problema es del recorrido entero. */
  readonly waypointId: string | null;
  readonly message: string;
  /** `blocking` impide publicar el recorrido; `advisory` sólo avisa. */
  readonly severity: 'blocking' | 'advisory';
}

export interface ValidateTourOptions {
  readonly sceneIds: ReadonlySet<string>;
  readonly quizIds: ReadonlySet<string>;
  readonly mediaIds: ReadonlySet<string>;
}

/**
 * Valida un recorrido automático.
 *
 * El fallo que esta función existe para impedir es el punto de paso huérfano:
 * una parada que apunta a una escena borrada deja el recorrido detenido a
 * mitad, delante de alguien a quien se le está enseñando la planta, y el autor
 * no se entera hasta ese momento.
 *
 * Lo demás son avisos y no bloqueos, porque son decisiones legítimas que
 * conviene ver escritas: un recorrido de un solo punto, una parada sin tiempo
 * de permanencia o uno que el visitante no puede interrumpir.
 */
export function validateTour(tour: Tour, options: ValidateTourOptions): TourProblem[] {
  const problems: TourProblem[] = [];

  if (tour.waypoints.length === 0) {
    problems.push({
      waypointId: null,
      message: 'El recorrido no tiene ningún punto de paso',
      severity: 'blocking',
    });
  }

  if (tour.waypoints.length === 1) {
    problems.push({
      waypointId: null,
      message: 'Un recorrido de un solo punto no recorre nada; añada al menos otra parada',
      severity: 'advisory',
    });
  }

  for (const waypoint of tour.waypoints) {
    if (!options.sceneIds.has(waypoint.sceneId)) {
      problems.push({
        waypointId: waypoint.id,
        message: 'La escena de esta parada ya no está en el proyecto',
        severity: 'blocking',
      });
    }

    if (waypoint.audioMediaId !== null && !options.mediaIds.has(waypoint.audioMediaId)) {
      problems.push({
        waypointId: waypoint.id,
        message: 'La narración de esta parada ya no está en la biblioteca',
        severity: 'blocking',
      });
    }

    // Una parada sin permanencia y sin esperar al audio pasa de largo: el
    // visitante ve un salto, no una parada.
    if (waypoint.dwellMs === 0 && !waypoint.waitForAudio) {
      problems.push({
        waypointId: waypoint.id,
        message: 'Sin tiempo de permanencia ni espera de audio, esta parada pasará de largo',
        severity: 'advisory',
      });
    }

    if (waypoint.audioMediaId === null && waypoint.waitForAudio && waypoint.dwellMs === 0) {
      problems.push({
        waypointId: waypoint.id,
        message: 'Espera a un audio que no tiene y no declara permanencia',
        severity: 'blocking',
      });
    }
  }

  /* --- Requisito de evaluación (J08) --- */

  if (tour.requiresQuizId !== null && !options.quizIds.has(tour.requiresQuizId)) {
    problems.push({
      waypointId: null,
      message: 'La evaluación que condiciona este recorrido ya no existe',
      severity: 'blocking',
    });
  }

  if (tour.requiresQuizId === null && tour.requiresQuizMinScore !== null) {
    problems.push({
      waypointId: null,
      message: 'Se exige una puntuación mínima sin decir de qué evaluación',
      severity: 'blocking',
    });
  }

  /* --- Interrupción (J03) --- */

  if (!tour.allowInterrupt) {
    problems.push({
      waypointId: null,
      message:
        'El visitante no podrá detener el recorrido. Sólo tiene sentido en un modo quiosco vigilado.',
      severity: 'advisory',
    });
  }

  if (!tour.allowInterrupt && tour.autoResumeIdleS > 0) {
    problems.push({
      waypointId: null,
      message: 'Se reanuda solo tras una pausa, pero el visitante no puede pausarlo',
      severity: 'advisory',
    });
  }

  return problems;
}

/** `true` si el recorrido se puede publicar. */
export const canPublishTour = (problems: readonly TourProblem[]): boolean =>
  !problems.some((problem) => problem.severity === 'blocking');

/**
 * Duración estimada del recorrido, en segundos.
 *
 * No cuenta la narración, porque su duración depende del archivo y no del
 * proyecto. Se dice «al menos» en la interfaz por eso mismo: una cifra exacta
 * que luego se queda corta es peor que una declarada como mínimo.
 */
export function estimatedTourSeconds(tour: Tour): number {
  const total = tour.waypoints.reduce(
    (sum, waypoint) => sum + waypoint.dwellMs + waypoint.travelMs,
    0,
  );
  return Math.round(total / 1000);
}
