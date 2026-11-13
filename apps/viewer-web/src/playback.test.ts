/**
 * Pruebas de la reproducción (etapa 09, parte del visitante).
 *
 * Lo que persiguen es dejar al visitante atascado: una parada que espera un
 * audio que el navegador no deja sonar, un recorrido condicionado que arranca
 * sin condición, una pregunta obligatoria que se envía vacía y cuenta como
 * fallo sin que nadie haya decidido nada.
 */
import { describe, expect, it } from 'vitest';
import {
  createQuestion,
  createQuiz,
  createTour,
  createWaypoint,
  insertQuestion,
  insertWaypoint,
  newUuid,
  startQuiz,
  submitAnswer,
  updateChoice,
  updateQuestion,
  addChoice,
  INITIAL_TOUR_RUNTIME,
  tourReducer,
  type Quiz,
  type Tour,
  type Uuid,
} from '@it360/domain';
import {
  AUDIO_WAIT_CEILING_MS,
  MIN_DWELL_MS,
  attemptsLeft,
  canRetry,
  canSubmit,
  currentWaypoint,
  dwellPlan,
  formatElapsed,
  huntProgress,
  quizElapsedS,
  quizPassed,
  scoreLines,
  selectionMode,
  targetForHotspot,
  toggleSelection,
  totalScore,
  tourGate,
} from './playback';

const NOW = '2026-10-01T09:00:00.000Z';
const PROJECT = newUuid();
const SCENE_A = newUuid();
const SCENE_B = newUuid();
const AUDIO = newUuid();

/* ------------------------------------------------------------------ *
 * Duración de una parada
 * ------------------------------------------------------------------ */

describe('dwellPlan', () => {
  it('TEST-PBK-001 sin audio manda la permanencia configurada', () => {
    const plan = dwellPlan(createWaypoint(SCENE_A), false);
    expect(plan.waitsForAudio).toBe(false);
    expect(plan.dwellMs).toBe(4000);
  });

  it('TEST-PBK-002 una permanencia de cero recibe un mínimo visible', () => {
    // Sin mínimo, la parada sería un parpadeo: la cámara llega y se va sin
    // que nadie alcance a mirar.
    const waypoint = { ...createWaypoint(SCENE_A), dwellMs: 0, waitForAudio: false };
    expect(dwellPlan(waypoint, false).dwellMs).toBe(MIN_DWELL_MS);
  });

  it('TEST-PBK-003 con audio disponible la parada espera al audio', () => {
    const waypoint = { ...createWaypoint(SCENE_A), audioMediaId: AUDIO, waitForAudio: true };
    const plan = dwellPlan(waypoint, true);
    expect(plan.waitsForAudio).toBe(true);
  });

  it('TEST-PBK-004 esperando al audio sigue habiendo plazo máximo', () => {
    // Es el seguro contra la reproducción automática bloqueada: sin plazo, el
    // recorrido se queda congelado para siempre delante del visitante.
    const waypoint = { ...createWaypoint(SCENE_A), audioMediaId: AUDIO, waitForAudio: true };
    expect(dwellPlan(waypoint, true).dwellMs).toBe(AUDIO_WAIT_CEILING_MS);
  });

  it('TEST-PBK-005 un audio que el navegador no puede reproducir no cambia nada', () => {
    // El autor configuró audio, pero el medio falta o el navegador lo rechaza:
    // entonces manda la permanencia, no una espera sin fin.
    const waypoint = {
      ...createWaypoint(SCENE_A),
      audioMediaId: AUDIO,
      waitForAudio: true,
      dwellMs: 7000,
    };
    const plan = dwellPlan(waypoint, false);
    expect(plan.waitsForAudio).toBe(false);
    expect(plan.dwellMs).toBe(7000);
  });
});

describe('currentWaypoint', () => {
  const twoStops = (): Tour => {
    let tour = createTour(PROJECT, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(SCENE_A));
    tour = insertWaypoint(tour, createWaypoint(SCENE_B));
    return tour;
  };

  it('TEST-PBK-006 en reposo no hay parada en curso', () => {
    expect(currentWaypoint(twoStops(), INITIAL_TOUR_RUNTIME)).toBeNull();
  });

  it('TEST-PBK-007 al arrancar la parada en curso es la primera', () => {
    const tour = twoStops();
    const runtime = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    expect(currentWaypoint(tour, runtime)?.sceneId).toBe(SCENE_A);
  });

  it('TEST-PBK-008 al completar la parada se pasa a la siguiente', () => {
    const tour = twoStops();
    let runtime = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    runtime = tourReducer(runtime, { type: 'arrive' }, tour, 0);
    runtime = tourReducer(runtime, { type: 'dwellComplete' }, tour, 0);
    expect(currentWaypoint(tour, runtime)?.sceneId).toBe(SCENE_B);
  });

  it('TEST-PBK-009 el orden lo decide `order`, no el de inserción', () => {
    const tour = twoStops();
    const reversed: Tour = {
      ...tour,
      waypoints: [
        { ...tour.waypoints[0]!, order: 1 },
        { ...tour.waypoints[1]!, order: 0 },
      ],
    };
    const runtime = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, reversed, 0);
    expect(currentWaypoint(reversed, runtime)?.sceneId).toBe(SCENE_B);
  });
});

/* ------------------------------------------------------------------ *
 * Condición de acceso (J08)
 * ------------------------------------------------------------------ */

describe('tourGate', () => {
  const quiz = createQuiz(PROJECT, 'Seguridad', NOW);
  const plain = createTour(PROJECT, 'Visita', NOW);
  const gated: Tour = { ...plain, requiresQuizId: quiz.id };

  it('TEST-PBK-010 un recorrido sin condición siempre puede empezar', () => {
    expect(tourGate(plain, [quiz], [])).toEqual({ allowed: true });
  });

  it('TEST-PBK-011 sin haber hecho la evaluación no se puede empezar, y se dice cuál', () => {
    const verdict = tourGate(gated, [quiz], []);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('Seguridad');
      expect(verdict.quizId).toBe(quiz.id);
    }
  });

  it('TEST-PBK-012 una evaluación empezada pero no terminada no vale', () => {
    const verdict = tourGate(gated, [quiz], [{ quizId: quiz.id, scores: {}, finished: false }]);
    expect(verdict.allowed).toBe(false);
  });

  it('TEST-PBK-013 completada sin nota mínima, el recorrido se abre', () => {
    const verdict = tourGate(gated, [quiz], [{ quizId: quiz.id, scores: { general: 0 }, finished: true }]);
    expect(verdict).toEqual({ allowed: true });
  });

  it('TEST-PBK-014 con nota mínima se compara la puntuación obtenida', () => {
    const strict: Tour = { ...gated, requiresQuizMinScore: 8 };
    const low = tourGate(strict, [quiz], [{ quizId: quiz.id, scores: { general: 5 }, finished: true }]);
    const high = tourGate(strict, [quiz], [{ quizId: quiz.id, scores: { general: 9 }, finished: true }]);

    expect(low.allowed).toBe(false);
    if (!low.allowed) expect(low.reason).toContain('obtuvo 5');
    expect(high).toEqual({ allowed: true });
  });

  it('TEST-PBK-015 la nota mínima suma todas las claves', () => {
    const strict: Tour = { ...gated, requiresQuizMinScore: 8 };
    const verdict = tourGate(
      strict,
      [quiz],
      [{ quizId: quiz.id, scores: { seguridad: 5, proceso: 4 }, finished: true }],
    );
    expect(verdict).toEqual({ allowed: true });
  });

  it('TEST-PBK-016 si la evaluación exigida no viaja en el paquete, se dice', () => {
    // Publicar el recorrido sin su evaluación es un error del paquete, no del
    // visitante: no se le puede pedir que haga algo que no está.
    const verdict = tourGate(gated, [], []);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.quizId).toBeNull();
      expect(verdict.reason).toContain('no está en el paquete');
    }
  });

  it('TEST-PBK-017 suma de puntuaciones vacía es cero', () => {
    expect(totalScore({})).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Selección y envío
 * ------------------------------------------------------------------ */

describe('selección de respuesta', () => {
  it('TEST-PBK-018 cada tipo de pregunta tiene su forma de marcar', () => {
    expect(selectionMode(createQuestion('singleChoice'))).toBe('single');
    expect(selectionMode(createQuestion('trueFalse'))).toBe('single');
    expect(selectionMode(createQuestion('multipleChoice'))).toBe('multiple');
    expect(selectionMode(createQuestion('ordering'))).toBe('ordered');
    expect(selectionMode(createQuestion('hotspotHunt'))).toBe('hunt');
  });

  it('TEST-PBK-019 en respuesta única marcar otra sustituye la anterior', () => {
    const question = createQuestion('singleChoice');
    expect(toggleSelection(question, ['a'], 'b')).toEqual(['b']);
  });

  it('TEST-PBK-020 en respuesta múltiple se alterna sin perder las demás', () => {
    const question = createQuestion('multipleChoice');
    expect(toggleSelection(question, ['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(question, ['a', 'b'], 'a')).toEqual(['b']);
  });

  it('TEST-PBK-021 en ordenar se añade al final, conservando el orden de pulsación', () => {
    // El orden en que se pulsan ES la respuesta: reordenar la selección la
    // cambiaría.
    const question = createQuestion('ordering');
    let selected = toggleSelection(question, [], 'c');
    selected = toggleSelection(question, selected, 'a');
    selected = toggleSelection(question, selected, 'b');
    expect(selected).toEqual(['c', 'a', 'b']);
  });

  it('TEST-PBK-022 en ordenar volver a pulsar una opción la retira', () => {
    const question = createQuestion('ordering');
    expect(toggleSelection(question, ['c', 'a', 'b'], 'a')).toEqual(['c', 'b']);
  });

  it('TEST-PBK-023 una pregunta obligatoria no se envía vacía', () => {
    // Enviarla vacía contaría como fallo sin que el evaluado haya decidido.
    const question = createQuestion('singleChoice');
    expect(canSubmit(question, [])).toBe(false);
    expect(canSubmit(question, ['a'])).toBe(true);
  });

  it('TEST-PBK-024 una pregunta opcional se puede saltar', () => {
    const question = { ...createQuestion('singleChoice'), required: false };
    expect(canSubmit(question, [])).toBe(true);
  });
});

describe('intentos', () => {
  const quizWith = (maxAttempts: number): { quiz: Quiz; questionId: string } => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'Correcta');
    const choiceId = quiz.questions.find((q) => q.id === question.id)!.choices[0]!.id;
    quiz = updateChoice(quiz, question.id, choiceId, { correct: true, points: 1 });
    quiz = updateQuestion(quiz, question.id, { maxAttempts });
    return { quiz, questionId: question.id };
  };

  it('TEST-PBK-025 cero intentos significa ilimitados', () => {
    const { quiz, questionId } = quizWith(0);
    const runtime = startQuiz(quiz, 0);
    const question = quiz.questions.find((q) => q.id === questionId)!;

    expect(attemptsLeft(question, runtime)).toBeNull();
    expect(canRetry(question, runtime)).toBe(true);
  });

  it('TEST-PBK-026 los intentos se descuentan al responder', () => {
    const { quiz, questionId } = quizWith(2);
    const question = quiz.questions.find((q) => q.id === questionId)!;
    let runtime = startQuiz(quiz, 0);
    expect(attemptsLeft(question, runtime)).toBe(2);

    runtime = submitAnswer(quiz, runtime, questionId, ['a'], 1000, NOW).runtime;
    expect(attemptsLeft(question, runtime)).toBe(1);
  });

  it('TEST-PBK-027 agotados los intentos no se puede reintentar', () => {
    const { quiz, questionId } = quizWith(1);
    const question = quiz.questions.find((q) => q.id === questionId)!;
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, questionId, ['a'], 1000, NOW).runtime;

    expect(attemptsLeft(question, runtime)).toBe(0);
    expect(canRetry(question, runtime)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Búsqueda de marcadores (O04)
 * ------------------------------------------------------------------ */

describe('huntProgress', () => {
  const HOTSPOT_A = newUuid();
  const HOTSPOT_B = newUuid();

  const question = {
    ...createQuestion('hotspotHunt'),
    huntTargets: [
      { id: 't1', sceneId: SCENE_A as Uuid, hotspotId: HOTSPOT_A, label: 'Extintor', points: 1 },
      { id: 't2', sceneId: SCENE_B as Uuid, hotspotId: HOTSPOT_B, label: 'Salida', points: 1 },
    ],
  };

  it('TEST-PBK-028 sin nada encontrado el avance es cero', () => {
    const progress = huntProgress(question, []);
    expect(progress).toMatchObject({ found: 0, total: 2, complete: false });
    expect(progress.pending).toEqual(['t1', 't2']);
  });

  it('TEST-PBK-029 encontrar uno deja el otro pendiente', () => {
    const progress = huntProgress(question, ['t1']);
    expect(progress.found).toBe(1);
    expect(progress.pending).toEqual(['t2']);
    expect(progress.complete).toBe(false);
  });

  it('TEST-PBK-030 encontrarlos todos completa la búsqueda', () => {
    expect(huntProgress(question, ['t1', 't2']).complete).toBe(true);
  });

  it('TEST-PBK-031 pulsar dos veces el mismo marcador no cuenta dos veces', () => {
    const progress = huntProgress(question, ['t1', 't1']);
    expect(progress.found).toBe(1);
  });

  it('TEST-PBK-032 una pregunta sin objetivos no está completa', () => {
    // Si contase como completa, una pregunta mal configurada se aprobaría
    // sola sin que el evaluado hiciese nada.
    const empty = { ...createQuestion('hotspotHunt'), huntTargets: [] };
    expect(huntProgress(empty, []).complete).toBe(false);
  });

  it('TEST-PBK-033 un marcador pulsado se traduce a su objetivo', () => {
    expect(targetForHotspot(question, HOTSPOT_A)).toBe('t1');
    expect(targetForHotspot(question, newUuid())).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Fin de sesión (O09)
 * ------------------------------------------------------------------ */

describe('fin de sesión', () => {
  const scored = (): { quiz: Quiz; questionId: string; choiceId: string } => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'Correcta');
    const choiceId = quiz.questions.find((q) => q.id === question.id)!.choices[0]!.id;
    quiz = updateChoice(quiz, question.id, choiceId, { correct: true, points: 10 });
    return { quiz, questionId: question.id, choiceId };
  };

  it('TEST-PBK-034 las puntuaciones se listan por clave', () => {
    const { quiz, questionId, choiceId } = scored();
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, questionId, [choiceId], 5000, NOW).runtime;

    const lines = scoreLines(quiz, runtime);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ scoreKey: 'general', obtained: 10, passing: null, passed: null });
  });

  it('TEST-PBK-035 una clave sin nota mínima no es un suspenso', () => {
    // Presentarlo como fallo sería mentir sobre el resultado: no se exigía
    // nada en esa clave.
    const { quiz, questionId } = scored();
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, questionId, [], 5000, NOW).runtime;

    expect(scoreLines(quiz, runtime)[0]!.passed).toBeNull();
    expect(quizPassed(quiz, runtime)).toBe(true);
  });

  it('TEST-PBK-036 con nota mínima el apto se calcula por clave', () => {
    const { quiz: base, questionId, choiceId } = scored();
    const quiz: Quiz = { ...base, passingScores: { general: 8 } };

    let failed = startQuiz(quiz, 0);
    failed = submitAnswer(quiz, failed, questionId, [], 5000, NOW).runtime;
    expect(quizPassed(quiz, failed)).toBe(false);

    let passed = startQuiz(quiz, 0);
    passed = submitAnswer(quiz, passed, questionId, [choiceId], 5000, NOW).runtime;
    expect(quizPassed(quiz, passed)).toBe(true);
  });

  it('TEST-PBK-037 una clave exigida en la que no se puntuó aparece como suspenso', () => {
    const { quiz: base } = scored();
    const quiz: Quiz = { ...base, passingScores: { calidad: 5 } };
    const runtime = startQuiz(quiz, 0);

    const line = scoreLines(quiz, runtime).find((l) => l.scoreKey === 'calidad');
    expect(line).toMatchObject({ obtained: 0, passing: 5, passed: false });
  });

  it('TEST-PBK-038 la duración sólo existe cuando la sesión ha terminado', () => {
    const { quiz, questionId, choiceId } = scored();
    const started = startQuiz(quiz, 10_000);
    expect(quizElapsedS(started)).toBeNull();

    const finished = submitAnswer(quiz, started, questionId, [choiceId], 145_000, NOW).runtime;
    expect(quizElapsedS(finished)).toBe(135);
  });

  it('TEST-PBK-039 la duración se presenta en minutos y segundos', () => {
    expect(formatElapsed(48)).toBe('48 s');
    expect(formatElapsed(135)).toBe('2 min 15 s');
    expect(formatElapsed(120)).toBe('2 min');
  });
});
