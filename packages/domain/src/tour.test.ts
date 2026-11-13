import { describe, expect, it } from 'vitest';
import {
  buildReport,
  gradeAnswer,
  INITIAL_TOUR_RUNTIME,
  nextQuestionId,
  reportToCsv,
  shouldAutoResume,
  startQuiz,
  submitAnswer,
  tourProgress,
  tourReducer,
  validateQuiz,
  type Question,
  type Quiz,
  type Tour,
} from './tour';

import { testUuid as uuid } from './testing';
const ISO = '2026-11-12T19:00:00.000Z';

const makeTour = (overrides: Partial<Tour> = {}): Tour =>
  ({
    id: uuid(1),
    projectId: uuid(2),
    name: 'Recorrido de seguridad',
    description: '',
    waypoints: [0, 1, 2].map((i) => ({
      id: uuid(100 + i),
      sceneId: uuid(200 + i),
      view: { yaw: 0, pitch: 0, fov: 75 },
      dwellMs: 4000,
      travelMs: 1500,
      actions: [],
      caption: '',
      audioMediaId: null,
      waitForAudio: true,
      order: i,
    })),
    loop: false,
    allowInterrupt: true,
    resumeAfterInterrupt: true,
    autoResumeIdleS: 0,
    requiresQuizId: null,
    requiresQuizMinScore: null,
    onStart: [],
    onEnd: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }) as Tour;

const question = (overrides: Partial<Question> = {}): Question =>
  ({
    id: 'q1',
    kind: 'singleChoice',
    prompt: '¿Cuál es el EPP obligatorio en esta zona?',
    mediaId: null,
    sceneId: null,
    choices: [
      { id: 'a', text: 'Casco y gafas', correct: true, feedback: '', points: 0, nextQuestionId: null },
      { id: 'b', text: 'Ninguno', correct: false, feedback: '', points: 0, nextQuestionId: null },
    ],
    huntTargets: [],
    correctOrder: [],
    scoreKey: 'seguridad',
    penalty: 0,
    timeLimitS: 0,
    maxAttempts: 1,
    nextQuestionId: null,
    required: true,
    order: 0,
    ...overrides,
  }) as Question;

const makeQuiz = (questions: Question[], overrides: Partial<Quiz> = {}): Quiz =>
  ({
    id: uuid(10),
    projectId: uuid(2),
    name: 'Inducción de seguridad',
    description: '',
    questions,
    entryQuestionId: null,
    goals: [],
    passingScores: {},
    immediateFeedback: true,
    shuffleQuestions: false,
    shuffleChoices: false,
    showReport: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }) as Quiz;

/**
 * TEST-TOUR-001 .. TEST-TOUR-014 (autopilot, J01-J03)
 * TEST-QUIZ-001 .. TEST-QUIZ-018 (formación, O01-O10, J08)
 */
describe('máquina de estados del autopilot', () => {
  const tour = makeTour();

  it('TEST-TOUR-001: arranca viajando al primer punto', () => {
    const state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    expect(state.state).toBe('traveling');
    expect(state.waypointIndex).toBe(0);
  });

  it('TEST-TOUR-002: al llegar pasa a permanecer en el punto', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'arrive' }, tour, 100);
    expect(state.state).toBe('dwelling');
    expect(state.segmentProgress).toBe(1);
  });

  it('TEST-TOUR-003: completada la parada avanza al punto siguiente', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'arrive' }, tour, 100);
    state = tourReducer(state, { type: 'dwellComplete' }, tour, 4100);
    expect(state.state).toBe('traveling');
    expect(state.waypointIndex).toBe(1);
  });

  it('TEST-TOUR-004: tras el último punto termina', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id, fromIndex: 2 }, tour, 0);
    state = tourReducer(state, { type: 'arrive' }, tour, 100);
    state = tourReducer(state, { type: 'dwellComplete' }, tour, 4100);
    expect(state.state).toBe('finished');
  });

  it('TEST-TOUR-005: con bucle vuelve al primer punto', () => {
    const looping = makeTour({ loop: true });
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: looping.id, fromIndex: 2 }, looping, 0);
    state = tourReducer(state, { type: 'arrive' }, looping, 100);
    state = tourReducer(state, { type: 'dwellComplete' }, looping, 4100);
    expect(state.state).toBe('traveling');
    expect(state.waypointIndex).toBe(0);
  });

  it('TEST-TOUR-006: el visitante puede interrumpir en cualquier momento (J03)', () => {
    // Un recorrido que no se puede parar convierte al visitante en
    // espectador, y el requisito pide lo contrario.
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'interrupt' }, tour, 500);
    expect(state.state).toBe('interrupted');
    expect(state.interruptedAtMs).toBe(500);
    expect(state.resumeIndex).toBe(0);
  });

  it('TEST-TOUR-007: también se puede interrumpir durante una parada', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'arrive' }, tour, 100);
    state = tourReducer(state, { type: 'interrupt' }, tour, 200);
    expect(state.state).toBe('interrupted');
  });

  it('TEST-TOUR-008: un recorrido no interrumpible ignora la interrupción', () => {
    const kiosk = makeTour({ allowInterrupt: false });
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: kiosk.id }, kiosk, 0);
    state = tourReducer(state, { type: 'interrupt' }, kiosk, 500);
    expect(state.state).toBe('traveling');
  });

  it('TEST-TOUR-009: reanudar continúa donde se quedó', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id, fromIndex: 1 }, tour, 0);
    state = tourReducer(state, { type: 'interrupt' }, tour, 500);
    state = tourReducer(state, { type: 'resume' }, tour, 900);
    expect(state.state).toBe('traveling');
    expect(state.waypointIndex).toBe(1);
  });

  it('TEST-TOUR-010: con resumeAfterInterrupt desactivado vuelve al principio', () => {
    const restart = makeTour({ resumeAfterInterrupt: false });
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: restart.id, fromIndex: 2 }, restart, 0);
    state = tourReducer(state, { type: 'interrupt' }, restart, 500);
    state = tourReducer(state, { type: 'resume' }, restart, 900);
    expect(state.waypointIndex).toBe(0);
  });

  it('TEST-TOUR-011: detener devuelve al estado inicial', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'stop' }, tour, 100);
    expect(state.state).toBe('idle');
    expect(state.waypointIndex).toBe(0);
  });

  it('TEST-TOUR-012: el salto directo acota el índice al rango válido', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    state = tourReducer(state, { type: 'jumpTo', index: 99 }, tour, 100);
    expect(state.waypointIndex).toBe(2);
    state = tourReducer(state, { type: 'jumpTo', index: -5 }, tour, 200);
    expect(state.waypointIndex).toBe(0);
  });

  it('TEST-TOUR-013: el reanudado automático respeta el tiempo configurado', () => {
    const auto = makeTour({ autoResumeIdleS: 30 });
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: auto.id }, auto, 0);
    state = tourReducer(state, { type: 'interrupt' }, auto, 1000);
    expect(shouldAutoResume(state, auto, 20_000)).toBe(false);
    expect(shouldAutoResume(state, auto, 31_001)).toBe(true);
    expect(shouldAutoResume(state, makeTour({ autoResumeIdleS: 0 }), 99_999)).toBe(false);
  });

  it('TEST-TOUR-014: el progreso global crece de 0 a 1', () => {
    let state = tourReducer(INITIAL_TOUR_RUNTIME, { type: 'start', tourId: tour.id }, tour, 0);
    expect(tourProgress(state, tour)).toBe(0);
    state = tourReducer(state, { type: 'tick', progress: 0.5 }, tour, 50);
    expect(tourProgress(state, tour)).toBeCloseTo(0.5 / 3, 6);
    state = tourReducer(state, { type: 'arrive' }, tour, 100);
    expect(tourProgress(state, tour)).toBeCloseTo(1 / 3, 6);
    state = { ...state, state: 'finished' };
    expect(tourProgress(state, tour)).toBe(1);
  });
});

describe('corrección de respuestas', () => {
  it('TEST-QUIZ-001: opción única acertada vale un punto', () => {
    expect(gradeAnswer(question(), ['a'])).toEqual({ correct: true, points: 1 });
  });

  it('TEST-QUIZ-002: opción única fallada aplica la penalización declarada', () => {
    expect(gradeAnswer(question({ penalty: 2 }), ['b'])).toEqual({ correct: false, points: -2 });
    expect(gradeAnswer(question(), ['b'])).toEqual({ correct: false, points: 0 });
  });

  it('TEST-QUIZ-003: no responder se corrige como fallo, no lanza', () => {
    expect(gradeAnswer(question({ penalty: 1 }), [])).toEqual({ correct: false, points: -1 });
  });

  it('TEST-QUIZ-004: los puntos por opción tienen prioridad sobre el acierto binario', () => {
    const q = question({
      choices: [
        { id: 'a', text: 'Correcta', correct: true, feedback: '', points: 5, nextQuestionId: null },
        { id: 'b', text: 'Parcial', correct: false, feedback: '', points: 2, nextQuestionId: null },
      ],
    });
    expect(gradeAnswer(q, ['a'])).toEqual({ correct: true, points: 5 });
    expect(gradeAnswer(q, ['b'])).toEqual({ correct: false, points: 2 });
  });

  it('TEST-QUIZ-005: la opción múltiple exige todas las correctas y ninguna incorrecta', () => {
    const q = question({
      kind: 'multipleChoice',
      choices: [
        { id: 'a', text: 'A', correct: true, feedback: '', points: 0, nextQuestionId: null },
        { id: 'b', text: 'B', correct: true, feedback: '', points: 0, nextQuestionId: null },
        { id: 'c', text: 'C', correct: false, feedback: '', points: 0, nextQuestionId: null },
      ],
    });
    expect(gradeAnswer(q, ['a', 'b']).correct).toBe(true);
    expect(gradeAnswer(q, ['a']).correct).toBe(false);
    expect(gradeAnswer(q, ['a', 'b', 'c']).correct).toBe(false);
    expect(gradeAnswer(q, []).correct).toBe(false);
  });

  it('TEST-QUIZ-006: la búsqueda de riesgos puntúa parcialmente (O04)', () => {
    // Localizar tres de cuatro riesgos no equivale a no ver ninguno.
    const q = question({
      kind: 'hotspotHunt',
      huntTargets: [
        { id: 't1', sceneId: uuid(201), hotspotId: uuid(301), label: 'Fuga', points: 2 },
        { id: 't2', sceneId: uuid(201), hotspotId: uuid(302), label: 'Cable', points: 3 },
      ],
    });
    expect(gradeAnswer(q, ['t1', 't2'])).toEqual({ correct: true, points: 5 });
    const partial = gradeAnswer(q, ['t1']);
    expect(partial.correct).toBe(false);
    expect(partial.points).toBe(2);
  });

  it('TEST-QUIZ-007: la búsqueda ignora objetivos inexistentes', () => {
    const q = question({
      kind: 'hotspotHunt',
      huntTargets: [{ id: 't1', sceneId: uuid(201), hotspotId: uuid(301), label: '', points: 1 }],
    });
    expect(gradeAnswer(q, ['no-existe']).points).toBe(0);
  });

  it('TEST-QUIZ-008: la ordenación exige la secuencia exacta', () => {
    const q = question({
      kind: 'ordering',
      choices: [
        { id: 'a', text: '1', correct: false, feedback: '', points: 0, nextQuestionId: null },
        { id: 'b', text: '2', correct: false, feedback: '', points: 0, nextQuestionId: null },
        { id: 'c', text: '3', correct: false, feedback: '', points: 0, nextQuestionId: null },
      ],
      correctOrder: ['a', 'b', 'c'],
    });
    expect(gradeAnswer(q, ['a', 'b', 'c']).correct).toBe(true);
    expect(gradeAnswer(q, ['a', 'c', 'b']).correct).toBe(false);
    expect(gradeAnswer(q, ['a', 'b']).correct).toBe(false);
  });
});

describe('ramificación (O07)', () => {
  const q1 = question({
    id: 'q1',
    choices: [
      { id: 'a', text: 'Sí', correct: true, feedback: '', points: 0, nextQuestionId: 'q3' },
      { id: 'b', text: 'No', correct: false, feedback: '', points: 0, nextQuestionId: null },
    ],
    order: 0,
  });
  const q2 = question({ id: 'q2', order: 1 });
  const q3 = question({ id: 'q3', order: 2 });
  const quiz = makeQuiz([q1, q2, q3]);

  it('TEST-QUIZ-009: la rama de la opción tiene prioridad', () => {
    expect(nextQuestionId(quiz, q1, ['a'])).toBe('q3');
  });

  it('TEST-QUIZ-010: sin rama en la opción se sigue el orden', () => {
    expect(nextQuestionId(quiz, q1, ['b'])).toBe('q2');
  });

  it('TEST-QUIZ-011: la rama de la pregunta se aplica si la opción no tiene', () => {
    const forced = question({ id: 'q1', nextQuestionId: 'q3', order: 0 });
    expect(nextQuestionId(makeQuiz([forced, q2, q3]), forced, ['b'])).toBe('q3');
  });

  it('TEST-QUIZ-012: la última pregunta no tiene siguiente', () => {
    expect(nextQuestionId(quiz, q3, ['a'])).toBeNull();
  });
});

describe('ejecución y puntuaciones múltiples (O06)', () => {
  const safety = question({ id: 'q1', scoreKey: 'seguridad', order: 0, nextQuestionId: 'q2' });
  const process = question({ id: 'q2', scoreKey: 'proceso', order: 1 });
  const quiz = makeQuiz([safety, process], {
    passingScores: { seguridad: 1, proceso: 1 },
  });

  it('TEST-QUIZ-013: las puntuaciones se mantienen independientes', () => {
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, 'q1', ['a'], 1000, ISO).runtime;
    runtime = submitAnswer(quiz, runtime, 'q2', ['b'], 2000, ISO).runtime;
    expect(runtime.scores['seguridad']).toBe(1);
    expect(runtime.scores['proceso']).toBe(0);
  });

  it('TEST-QUIZ-014: aprueba quien cumple TODAS las mínimas, no la media', () => {
    // Con varias puntuaciones independientes, aprobar por la media permitiría
    // superar una formación de seguridad compensando con la de proceso.
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, 'q1', ['a'], 1000, ISO).runtime;
    runtime = submitAnswer(quiz, runtime, 'q2', ['b'], 2000, ISO).runtime;
    const report = buildReport(quiz, runtime, ISO);
    expect(report.passed).toBe(false);
    expect(report.perScore.find((s) => s.key === 'seguridad')?.passed).toBe(true);
    expect(report.perScore.find((s) => s.key === 'proceso')?.passed).toBe(false);
  });

  it('TEST-QUIZ-015: aprueba cuando todas las claves alcanzan su mínimo', () => {
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, 'q1', ['a'], 1000, ISO).runtime;
    runtime = submitAnswer(quiz, runtime, 'q2', ['a'], 2000, ISO).runtime;
    expect(buildReport(quiz, runtime, ISO).passed).toBe(true);
  });

  it('TEST-QUIZ-016: los objetivos se disparan una sola vez (O08)', () => {
    const withGoal = makeQuiz([safety, process], {
      goals: [{ scoreKey: 'seguridad', label: 'Nivel básico', target: 1, onReached: [] }],
    });
    let runtime = startQuiz(withGoal, 0);
    const first = submitAnswer(withGoal, runtime, 'q1', ['a'], 1000, ISO);
    expect(first.newlyReachedGoals).toHaveLength(1);
    runtime = first.runtime;
    const second = submitAnswer(withGoal, runtime, 'q1', ['a'], 2000, ISO);
    expect(second.newlyReachedGoals).toHaveLength(0);
  });

  it('TEST-QUIZ-017: un segundo intento suma sobre lo ya obtenido', () => {
    // Reemplazar la nota permitiría repetir hasta acertar sin coste.
    const penalized = makeQuiz([question({ id: 'q1', penalty: 1, maxAttempts: 0 })]);
    let runtime = startQuiz(penalized, 0);
    runtime = submitAnswer(penalized, runtime, 'q1', ['b'], 1000, ISO).runtime;
    expect(runtime.scores['seguridad']).toBe(-1);
    runtime = submitAnswer(penalized, runtime, 'q1', ['a'], 2000, ISO).runtime;
    expect(runtime.scores['seguridad']).toBe(0);
    expect(runtime.attempts['q1']).toBe(2);
  });

  it('TEST-QUIZ-018: responder una pregunta inexistente es un error de programación', () => {
    const runtime = startQuiz(quiz, 0);
    expect(() => submitAnswer(quiz, runtime, 'inexistente', ['a'], 1000, ISO)).toThrow();
  });

  it('TEST-QUIZ-019: el informe cuenta respuestas y aciertos', () => {
    let runtime = startQuiz(quiz, 0);
    runtime = submitAnswer(quiz, runtime, 'q1', ['a'], 1000, ISO).runtime;
    runtime = submitAnswer(quiz, runtime, 'q2', ['b'], 2000, ISO).runtime;
    const report = buildReport(quiz, runtime, ISO);
    expect(report.questionCount).toBe(2);
    expect(report.answeredCount).toBe(2);
    expect(report.correctCount).toBe(1);
    expect(report.finishedAt).not.toBeNull();
  });

  it('TEST-QUIZ-020: el CSV exportado escapa separadores y comillas', () => {
    const tricky = makeQuiz([question({ id: 'q;1' })], { name: 'Curso "A";B' });
    let runtime = startQuiz(tricky, 0);
    runtime = submitAnswer(tricky, runtime, 'q;1', ['a'], 1000, ISO).runtime;
    const csv = reportToCsv(buildReport(tricky, runtime, ISO));
    expect(csv.split('\n')[0]).toContain('evaluacion;pregunta');
    expect(csv).toContain('"Curso ""A"";B"');
    expect(csv).toContain('"q;1"');
  });
});

describe('validación de evaluaciones', () => {
  it('TEST-QUIZ-021: detecta la rama que apunta a una pregunta borrada', () => {
    // Es el fallo que deja la evaluación muerta a mitad y que el autor no
    // descubre hasta que alguien la hace.
    const broken = makeQuiz([
      question({
        id: 'q1',
        choices: [
          { id: 'a', text: 'A', correct: true, feedback: '', points: 0, nextQuestionId: 'borrada' },
          { id: 'b', text: 'B', correct: false, feedback: '', points: 0, nextQuestionId: null },
        ],
      }),
    ]);
    const problems = validateQuiz(broken);
    expect(problems.some((p) => p.message.includes('inexistente'))).toBe(true);
  });

  it('TEST-QUIZ-022: detecta un ciclo en la secuencia', () => {
    const cyclic = makeQuiz([
      question({ id: 'q1', nextQuestionId: 'q2', order: 0 }),
      question({ id: 'q2', nextQuestionId: 'q1', order: 1 }),
    ]);
    expect(validateQuiz(cyclic).some((p) => p.message.includes('ciclo'))).toBe(true);
  });

  it('TEST-QUIZ-023: exige al menos dos opciones y una correcta', () => {
    const thin = makeQuiz([
      question({
        id: 'q1',
        choices: [{ id: 'a', text: 'Única', correct: false, feedback: '', points: 0, nextQuestionId: null }],
      }),
    ]);
    const problems = validateQuiz(thin);
    expect(problems.some((p) => p.message.includes('dos opciones'))).toBe(true);
    expect(problems.some((p) => p.message.includes('correcta'))).toBe(true);
  });

  it('TEST-QUIZ-024: una búsqueda sin objetivos es inválida', () => {
    const empty = makeQuiz([question({ id: 'q1', kind: 'hotspotHunt', choices: [] })]);
    expect(validateQuiz(empty).some((p) => p.message.includes('objetivo'))).toBe(true);
  });

  it('TEST-QUIZ-025: una evaluación coherente no reporta problemas', () => {
    const good = makeQuiz([
      question({ id: 'q1', order: 0, nextQuestionId: 'q2' }),
      question({ id: 'q2', order: 1 }),
    ]);
    expect(validateQuiz(good)).toEqual([]);
  });
});
