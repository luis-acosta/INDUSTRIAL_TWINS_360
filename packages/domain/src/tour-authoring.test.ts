/**
 * Pruebas de la autoría de recorridos y evaluaciones (etapa 09).
 *
 * El eje de casi todas: **borrar no deja referencias colgando**. Una rama que
 * apunta a una pregunta borrada no falla al borrarla, falla la primera vez que
 * alguien hace la evaluación, que es cuando ya hay un operario delante.
 */
import { describe, expect, it } from 'vitest';
import {
  addChoice,
  addGoal,
  addHuntTarget,
  createChoice,
  createQuestion,
  createQuiz,
  createTour,
  deadHuntTargets,
  createWaypoint,
  duplicateQuestion,
  duplicateWaypoint,
  insertQuestion,
  insertWaypoint,
  maxScoresOf,
  moveChoice,
  moveQuestion,
  moveWaypoint,
  orphanGoals,
  questionRemovalImpact,
  removeChoice,
  removeGoal,
  removeHuntTarget,
  removeQuestion,
  removeWaypoint,
  scoreKeysOf,
  setChoiceCorrect,
  unreachableGoals,
  updateGoal,
  updateHuntTarget,
  updateChoice,
  updateQuestion,
  updateWaypoint,
} from './tour-authoring';
import { quizSchema, tourSchema, validateQuiz, type Quiz, type Tour } from './tour';
import { newUuid, type Uuid } from './identity';

const NOW = '2026-10-01T09:00:00.000Z';
const PROJECT = newUuid();
const SCENE_A = newUuid();
const SCENE_B = newUuid();

const ids = (tour: Tour): string[] =>
  [...tour.waypoints].sort((a, b) => a.order - b.order).map((w) => w.id);

const questionIds = (quiz: Quiz): string[] =>
  [...quiz.questions].sort((a, b) => a.order - b.order).map((q) => q.id);

/** Recorrido con tres paradas, para probar el orden. */
function tourOfThree(): { tour: Tour; a: string; b: string; c: string } {
  let tour = createTour(PROJECT, 'Visita', NOW);
  const wa = createWaypoint(SCENE_A);
  const wb = createWaypoint(SCENE_B);
  const wc = createWaypoint(SCENE_A);
  tour = insertWaypoint(tour, wa);
  tour = insertWaypoint(tour, wb);
  tour = insertWaypoint(tour, wc);
  return { tour, a: wa.id, b: wb.id, c: wc.id };
}

/* ------------------------------------------------------------------ *
 * Creación
 * ------------------------------------------------------------------ */

describe('creación', () => {
  it('TEST-TRA-001 el recorrido nuevo cumple su propio esquema', () => {
    // Si los valores por defecto se copiasen a mano, esto es lo que se
    // rompería en silencio al cambiar el esquema.
    const tour = createTour(PROJECT, 'Visita', NOW);
    expect(() => tourSchema.parse(tour)).not.toThrow();
    expect(tour.waypoints).toEqual([]);
    expect(tour.allowInterrupt).toBe(true);
  });

  it('TEST-TRA-002 la evaluación nueva cumple su propio esquema', () => {
    const quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    expect(() => quizSchema.parse(quiz)).not.toThrow();
    expect(quiz.questions).toEqual([]);
  });

  it('TEST-TRA-003 verdadero/falso llega con sus dos opciones', () => {
    const question = createQuestion('trueFalse');
    expect(question.choices.map((c) => c.text)).toEqual(['Verdadero', 'Falso']);
    expect(question.choices.filter((c) => c.correct)).toHaveLength(1);
  });

  it('TEST-TRA-004 los demás tipos empiezan sin opciones', () => {
    expect(createQuestion('singleChoice').choices).toEqual([]);
    expect(createQuestion('ordering').choices).toEqual([]);
  });

  it('TEST-TRA-005 cada opción nueva recibe una letra libre', () => {
    const first = createChoice([]);
    const second = createChoice([first]);
    const third = createChoice([first, second]);
    expect([first.id, second.id, third.id]).toEqual(['a', 'b', 'c']);
  });

  it('TEST-TRA-006 agotadas las letras, los identificadores siguen sin chocar', () => {
    const existing = Array.from({ length: 26 }, (_, i) => ({
      ...createChoice([]),
      id: String.fromCharCode(97 + i),
    }));
    const extra = createChoice(existing);
    expect(existing.map((c) => c.id)).not.toContain(extra.id);
  });

  it('TEST-TRA-007 el punto de paso toma la vista que se le da', () => {
    const waypoint = createWaypoint(SCENE_A, { yaw: 1.2, pitch: -0.3, fov: 60 });
    expect(waypoint.view).toEqual({ yaw: 1.2, pitch: -0.3, fov: 60 });
    expect(waypoint.sceneId).toBe(SCENE_A);
  });
});

/* ------------------------------------------------------------------ *
 * Puntos de paso
 * ------------------------------------------------------------------ */

describe('puntos de paso', () => {
  it('TEST-TRA-008 insertar numera el orden desde cero', () => {
    const { tour } = tourOfThree();
    expect(tour.waypoints.map((w) => w.order).sort()).toEqual([0, 1, 2]);
  });

  it('TEST-TRA-009 inserta en la posición pedida', () => {
    const { tour, a, b } = tourOfThree();
    const nuevo = createWaypoint(SCENE_B);
    const result = insertWaypoint(tour, nuevo, 1);
    expect(ids(result)[0]).toBe(a);
    expect(ids(result)[1]).toBe(nuevo.id);
    expect(ids(result)[2]).toBe(b);
  });

  it('TEST-TRA-010 un índice fuera de rango añade al final', () => {
    const { tour } = tourOfThree();
    const nuevo = createWaypoint(SCENE_B);
    expect(ids(insertWaypoint(tour, nuevo, 99)).at(-1)).toBe(nuevo.id);
  });

  it('TEST-TRA-011 mover reordena y renumera', () => {
    const { tour, a, b, c } = tourOfThree();
    const result = moveWaypoint(tour, c, 0);
    expect(ids(result)).toEqual([c, a, b]);
    expect(result.waypoints.map((w) => w.order).sort()).toEqual([0, 1, 2]);
  });

  it('TEST-TRA-012 el índice de destino se aplica a la lista sin el elemento movido', () => {
    // Es el error clásico: contar la posición incluyendo el elemento que se
    // está sacando deja el movimiento una casilla corta.
    const { tour, a, b, c } = tourOfThree();
    expect(ids(moveWaypoint(tour, a, 2))).toEqual([b, c, a]);
  });

  it('TEST-TRA-013 mover algo que no está no cambia nada', () => {
    const { tour } = tourOfThree();
    expect(moveWaypoint(tour, newUuid(), 0)).toBe(tour);
  });

  it('TEST-TRA-014 quitar renumera el resto', () => {
    const { tour, a, b, c } = tourOfThree();
    const result = removeWaypoint(tour, b);
    expect(ids(result)).toEqual([a, c]);
    expect(result.waypoints.map((w) => w.order).sort()).toEqual([0, 1]);
  });

  it('TEST-TRA-015 quitar algo que no está devuelve el mismo recorrido', () => {
    const { tour } = tourOfThree();
    expect(removeWaypoint(tour, newUuid())).toBe(tour);
  });

  it('TEST-TRA-016 actualizar cambia sólo los campos dados', () => {
    const { tour, b } = tourOfThree();
    const result = updateWaypoint(tour, b, { dwellMs: 9000, caption: 'Bomba principal' });
    const waypoint = result.waypoints.find((w) => w.id === b);
    expect(waypoint?.dwellMs).toBe(9000);
    expect(waypoint?.caption).toBe('Bomba principal');
    expect(waypoint?.travelMs).toBe(1500);
  });

  it('TEST-TRA-017 actualizar no permite cambiar el identificador', () => {
    const { tour, b } = tourOfThree();
    const result = updateWaypoint(tour, b, { id: newUuid() } as never);
    expect(ids(result)).toContain(b);
  });

  it('TEST-TRA-018 duplicar deja la copia justo detrás', () => {
    const { tour, a, b, c } = tourOfThree();
    const result = duplicateWaypoint(tour, a);
    const order = ids(result);
    expect(order).toHaveLength(4);
    expect(order[0]).toBe(a);
    expect(order[1]).not.toBe(a);
    expect(order.slice(2)).toEqual([b, c]);
  });

  it('TEST-TRA-019 la copia conserva la configuración del original', () => {
    const { tour, a } = tourOfThree();
    const withCaption = updateWaypoint(tour, a, { caption: 'Entrada', dwellMs: 7000 });
    const result = duplicateWaypoint(withCaption, a);
    const copy = ids(result)[1];
    const waypoint = result.waypoints.find((w) => w.id === copy);
    expect(waypoint?.caption).toBe('Entrada');
    expect(waypoint?.dwellMs).toBe(7000);
  });

  it('TEST-TRA-020 el recorrido editado sigue cumpliendo el esquema', () => {
    const { tour, a } = tourOfThree();
    const result = duplicateWaypoint(moveWaypoint(removeWaypoint(tour, a), ids(tour)[2]!, 0), ids(tour)[1]!);
    expect(() => tourSchema.parse(result)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Preguntas
 * ------------------------------------------------------------------ */

describe('preguntas', () => {
  const quizOfThree = (): { quiz: Quiz; a: string; b: string; c: string } => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const qa = createQuestion('singleChoice');
    const qb = createQuestion('trueFalse');
    const qc = createQuestion('ordering');
    quiz = insertQuestion(quiz, qa);
    quiz = insertQuestion(quiz, qb);
    quiz = insertQuestion(quiz, qc);
    return { quiz, a: qa.id, b: qb.id, c: qc.id };
  };

  it('TEST-TRA-021 insertar y mover mantiene el orden consecutivo', () => {
    const { quiz, a, b, c } = quizOfThree();
    const result = moveQuestion(quiz, c, 0);
    expect(questionIds(result)).toEqual([c, a, b]);
    expect(result.questions.map((q) => q.order).sort()).toEqual([0, 1, 2]);
  });

  it('TEST-TRA-022 avisa de cuántas ramas señalan la pregunta que se va a borrar', () => {
    const { quiz, a, b, c } = quizOfThree();
    let withBranches = addChoice(quiz, a, 'Sí');
    const choiceId = withBranches.questions.find((q) => q.id === a)!.choices[0]!.id;
    withBranches = updateChoice(withBranches, a, choiceId, { nextQuestionId: c });
    withBranches = updateQuestion(withBranches, b, { nextQuestionId: c });

    const impact = questionRemovalImpact(withBranches, c);
    expect(impact.choiceBranches).toBe(1);
    expect(impact.questionBranches).toBe(1);
    expect(impact.wasEntry).toBe(false);
  });

  it('TEST-TRA-023 avisa si la pregunta era la entrada de la evaluación', () => {
    const { quiz, a } = quizOfThree();
    const withEntry = { ...quiz, entryQuestionId: a };
    expect(questionRemovalImpact(withEntry, a).wasEntry).toBe(true);
  });

  it('TEST-TRA-024 borrar una pregunta no deja ramas apuntando a ella', () => {
    // Este es el fallo que se descubre a mitad de la evaluación: la rama
    // apunta a algo que ya no está y el motor no sabe adónde ir.
    const { quiz, a, b, c } = quizOfThree();
    let withBranches = addChoice(quiz, a, 'Sí');
    const choiceId = withBranches.questions.find((q) => q.id === a)!.choices[0]!.id;
    withBranches = updateChoice(withBranches, a, choiceId, { nextQuestionId: c });
    withBranches = updateQuestion(withBranches, b, { nextQuestionId: c });

    const result = removeQuestion(withBranches, c);

    expect(result.questions.find((q) => q.id === a)!.choices[0]!.nextQuestionId).toBeNull();
    expect(result.questions.find((q) => q.id === b)!.nextQuestionId).toBeNull();
    // Lo que no debe quedar es una rama hacia la pregunta borrada. Las demás
    // quejas de `validateQuiz` (opciones insuficientes) son de estas preguntas
    // de prueba y no tienen que ver con el borrado.
    expect(validateQuiz(result).filter((p) => /inexistente/.test(p.message))).toEqual([]);
  });

  it('TEST-TRA-025 borrar la pregunta de entrada deja la entrada en automático', () => {
    const { quiz, a } = quizOfThree();
    const result = removeQuestion({ ...quiz, entryQuestionId: a }, a);
    expect(result.entryQuestionId).toBeNull();
  });

  it('TEST-TRA-026 borrar algo que no está devuelve la misma evaluación', () => {
    const { quiz } = quizOfThree();
    expect(removeQuestion(quiz, 'inexistente')).toBe(quiz);
  });

  it('TEST-TRA-027 duplicar una pregunta le da un identificador nuevo', () => {
    const { quiz, a } = quizOfThree();
    const result = duplicateQuestion(quiz, a);
    const order = questionIds(result);
    expect(order).toHaveLength(4);
    expect(order[1]).not.toBe(a);
    expect(new Set(order).size).toBe(4);
  });

  it('TEST-TRA-028 la pregunta duplicada conserva sus opciones', () => {
    const { quiz, b } = quizOfThree();
    const result = duplicateQuestion(quiz, b);
    const copyId = questionIds(result)[2]!;
    expect(result.questions.find((q) => q.id === copyId)!.choices).toHaveLength(2);
  });

  it('TEST-TRA-029 la evaluación editada sigue cumpliendo el esquema', () => {
    const { quiz, a, c } = quizOfThree();
    const result = duplicateQuestion(removeQuestion(moveQuestion(quiz, c, 0), a), c);
    expect(() => quizSchema.parse(result)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Opciones
 * ------------------------------------------------------------------ */

describe('opciones', () => {
  const withQuestion = (): { quiz: Quiz; q: string } => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'Primera');
    quiz = addChoice(quiz, question.id, 'Segunda');
    quiz = addChoice(quiz, question.id, 'Tercera');
    return { quiz, q: question.id };
  };

  const choiceIds = (quiz: Quiz, q: string): string[] =>
    quiz.questions.find((x) => x.id === q)!.choices.map((c) => c.id);

  it('TEST-TRA-030 añadir opciones conserva el texto y el orden', () => {
    const { quiz, q } = withQuestion();
    const texts = quiz.questions.find((x) => x.id === q)!.choices.map((c) => c.text);
    expect(texts).toEqual(['Primera', 'Segunda', 'Tercera']);
  });

  it('TEST-TRA-031 en respuesta única marcar una desmarca las demás', () => {
    // Dos correctas en una pregunta de respuesta única es un estado que el
    // corrector no sabe puntuar: la interfaz no debe poder producirlo.
    const { quiz, q } = withQuestion();
    const [a, b] = choiceIds(quiz, q);
    let result = setChoiceCorrect(quiz, q, a!, true);
    result = setChoiceCorrect(result, q, b!, true);

    const correct = result.questions.find((x) => x.id === q)!.choices.filter((c) => c.correct);
    expect(correct.map((c) => c.id)).toEqual([b]);
  });

  it('TEST-TRA-032 en respuesta múltiple pueden convivir varias correctas', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('multipleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'A');
    quiz = addChoice(quiz, question.id, 'B');
    const [a, b] = choiceIds(quiz, question.id);

    let result = setChoiceCorrect(quiz, question.id, a!, true);
    result = setChoiceCorrect(result, question.id, b!, true);

    expect(
      result.questions.find((x) => x.id === question.id)!.choices.filter((c) => c.correct),
    ).toHaveLength(2);
  });

  it('TEST-TRA-033 verdadero/falso también es exclusiva', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('trueFalse');
    quiz = insertQuestion(quiz, question);

    const result = setChoiceCorrect(quiz, question.id, 'f', true);
    const choices = result.questions.find((x) => x.id === question.id)!.choices;
    expect(choices.filter((c) => c.correct).map((c) => c.id)).toEqual(['f']);
  });

  it('TEST-TRA-034 desmarcar no toca las demás opciones', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('multipleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'A');
    quiz = addChoice(quiz, question.id, 'B');
    const [a, b] = choiceIds(quiz, question.id);
    let result = setChoiceCorrect(quiz, question.id, a!, true);
    result = setChoiceCorrect(result, question.id, b!, true);

    result = setChoiceCorrect(result, question.id, a!, false);
    const choices = result.questions.find((x) => x.id === question.id)!.choices;
    expect(choices.find((c) => c.id === b)!.correct).toBe(true);
  });

  it('TEST-TRA-035 borrar una opción la quita también del orden correcto', () => {
    // En una pregunta de ordenar, dejar un id borrado en `correctOrder` hace
    // que la pregunta no se pueda acertar nunca.
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('ordering');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'Uno');
    quiz = addChoice(quiz, question.id, 'Dos');
    const [a, b] = choiceIds(quiz, question.id);
    quiz = updateQuestion(quiz, question.id, { correctOrder: [a!, b!] });

    const result = removeChoice(quiz, question.id, a!);
    const final = result.questions.find((x) => x.id === question.id)!;
    expect(final.correctOrder).toEqual([b]);
    expect(final.choices).toHaveLength(1);
  });

  it('TEST-TRA-036 mover una opción cambia su posición', () => {
    const { quiz, q } = withQuestion();
    const [a, b, c] = choiceIds(quiz, q);
    expect(choiceIds(moveChoice(quiz, q, c!, 0), q)).toEqual([c, a, b]);
  });

  it('TEST-TRA-037 actualizar una opción no permite cambiar su identificador', () => {
    const { quiz, q } = withQuestion();
    const [a] = choiceIds(quiz, q);
    const result = updateChoice(quiz, q, a!, { id: 'z' } as never);
    expect(choiceIds(result, q)).toContain(a);
  });

  it('TEST-TRA-038 operar sobre una pregunta inexistente no cambia nada', () => {
    const { quiz } = withQuestion();
    expect(addChoice(quiz, 'nada', 'X')).toBe(quiz);
    expect(removeChoice(quiz, 'nada', 'a')).toBe(quiz);
    expect(setChoiceCorrect(quiz, 'nada', 'a', true)).toBe(quiz);
    expect(moveChoice(quiz, 'nada', 'a', 0)).toBe(quiz);
  });
});

/* ------------------------------------------------------------------ *
 * Puntuaciones (O05, O06, O08)
 * ------------------------------------------------------------------ */

describe('puntuaciones', () => {
  const quizWithKeys = (): Quiz => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const seguridad = createQuestion('singleChoice');
    const proceso = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, seguridad);
    quiz = insertQuestion(quiz, proceso);
    quiz = updateQuestion(quiz, seguridad.id, { scoreKey: 'seguridad' });
    quiz = updateQuestion(quiz, proceso.id, { scoreKey: 'proceso' });
    quiz = addChoice(quiz, seguridad.id, 'Correcta');
    quiz = addChoice(quiz, seguridad.id, 'Incorrecta');
    quiz = addChoice(quiz, proceso.id, 'Correcta');
    const sKey = quiz.questions.find((q) => q.id === seguridad.id)!;
    const pKey = quiz.questions.find((q) => q.id === proceso.id)!;
    quiz = updateChoice(quiz, seguridad.id, sKey.choices[0]!.id, { correct: true, points: 10 });
    quiz = updateChoice(quiz, proceso.id, pKey.choices[0]!.id, { correct: true, points: 5 });
    return quiz;
  };

  it('TEST-TRA-039 enumera las claves de puntuación realmente usadas', () => {
    expect(scoreKeysOf(quizWithKeys())).toEqual(['proceso', 'seguridad']);
  });

  it('TEST-TRA-040 una evaluación sin preguntas no tiene claves', () => {
    expect(scoreKeysOf(createQuiz(PROJECT, 'Vacía', NOW))).toEqual([]);
  });

  it('TEST-TRA-041 calcula la puntuación máxima por clave', () => {
    expect(maxScoresOf(quizWithKeys())).toEqual({ seguridad: 10, proceso: 5 });
  });

  it('TEST-TRA-042 en respuesta única sólo cuenta la mejor opción', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'A');
    quiz = addChoice(quiz, question.id, 'B');
    const choices = quiz.questions.find((q) => q.id === question.id)!.choices;
    quiz = updateChoice(quiz, question.id, choices[0]!.id, { points: 10 });
    quiz = updateChoice(quiz, question.id, choices[1]!.id, { points: 4 });

    // No se pueden elegir las dos: el máximo es 10, no 14.
    expect(maxScoresOf(quiz)).toEqual({ general: 10 });
  });

  it('TEST-TRA-043 en respuesta múltiple suman las correctas', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('multipleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'A');
    quiz = addChoice(quiz, question.id, 'B');
    quiz = addChoice(quiz, question.id, 'C');
    const choices = quiz.questions.find((q) => q.id === question.id)!.choices;
    quiz = updateChoice(quiz, question.id, choices[0]!.id, { correct: true, points: 3 });
    quiz = updateChoice(quiz, question.id, choices[1]!.id, { correct: true, points: 2 });
    quiz = updateChoice(quiz, question.id, choices[2]!.id, { correct: false, points: 7 });

    expect(maxScoresOf(quiz)).toEqual({ general: 5 });
  });

  it('TEST-TRA-044 en búsqueda de marcadores suman los objetivos', () => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('hotspotHunt');
    quiz = insertQuestion(quiz, question);
    quiz = updateQuestion(quiz, question.id, {
      huntTargets: [
        { id: 't1', sceneId: SCENE_A as Uuid, hotspotId: newUuid(), label: 'Extintor', points: 2 },
        { id: 't2', sceneId: SCENE_B as Uuid, hotspotId: newUuid(), label: 'Salida', points: 3 },
      ],
    });

    expect(maxScoresOf(quiz)).toEqual({ general: 5 });
  });

  it('TEST-TRA-045 señala los objetivos cuya clave nadie puntúa', () => {
    // Un objetivo sobre una clave que ninguna pregunta usa nunca se alcanza:
    // el autor cree que ha configurado algo que no va a pasar.
    const quiz = quizWithKeys();
    const withGoals: Quiz = {
      ...quiz,
      goals: [
        { scoreKey: 'seguridad', label: 'Apto en seguridad', target: 10, onReached: [] },
        { scoreKey: 'calidad', label: 'Apto en calidad', target: 5, onReached: [] },
      ],
    };

    expect(orphanGoals(withGoals)).toEqual(['calidad']);
  });

  it('TEST-TRA-046 sin objetivos huérfanos la lista está vacía', () => {
    const quiz = quizWithKeys();
    const withGoals: Quiz = {
      ...quiz,
      goals: [{ scoreKey: 'proceso', label: 'Apto', target: 5, onReached: [] }],
    };
    expect(orphanGoals(withGoals)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Búsqueda de marcadores (O04)
 * ------------------------------------------------------------------ */

describe('búsqueda de marcadores', () => {
  const HOTSPOT_A = newUuid();
  const HOTSPOT_B = newUuid();

  const withHunt = (): { quiz: Quiz; q: string } => {
    let quiz = createQuiz(PROJECT, 'Riesgos', NOW);
    const question = createQuestion('hotspotHunt');
    quiz = insertQuestion(quiz, question);
    return { quiz, q: question.id };
  };

  it('TEST-TRA-047 añade un marcador a buscar con su puntuación', () => {
    const { quiz, q } = withHunt();
    const result = addHuntTarget(quiz, q, {
      sceneId: SCENE_A,
      hotspotId: HOTSPOT_A,
      label: 'Extintor',
      points: 3,
    });

    const targets = result.questions.find((x) => x.id === q)!.huntTargets;
    expect(targets).toHaveLength(1);
    expect(targets[0]!.label).toBe('Extintor');
    expect(targets[0]!.points).toBe(3);
  });

  it('TEST-TRA-048 el mismo marcador dos veces se rechaza', () => {
    // Puntuaría dos veces por un solo hallazgo.
    const { quiz, q } = withHunt();
    const once = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A });
    expect(addHuntTarget(once, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A })).toBe(once);
  });

  it('TEST-TRA-049 cada marcador recibe un identificador propio', () => {
    const { quiz, q } = withHunt();
    let result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A });
    result = addHuntTarget(result, q, { sceneId: SCENE_B, hotspotId: HOTSPOT_B });

    const ids = result.questions.find((x) => x.id === q)!.huntTargets.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('TEST-TRA-050 la puntuación máxima suma todos los marcadores', () => {
    const { quiz, q } = withHunt();
    let result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A, points: 2 });
    result = addHuntTarget(result, q, { sceneId: SCENE_B, hotspotId: HOTSPOT_B, points: 4 });
    expect(maxScoresOf(result)).toEqual({ general: 6 });
  });

  it('TEST-TRA-051 cambiar la puntuación de un marcador no toca los demás', () => {
    const { quiz, q } = withHunt();
    let result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A, points: 2 });
    result = addHuntTarget(result, q, { sceneId: SCENE_B, hotspotId: HOTSPOT_B, points: 4 });
    const first = result.questions.find((x) => x.id === q)!.huntTargets[0]!.id;

    result = updateHuntTarget(result, q, first, { points: 10 });
    const targets = result.questions.find((x) => x.id === q)!.huntTargets;
    expect(targets[0]!.points).toBe(10);
    expect(targets[1]!.points).toBe(4);
  });

  it('TEST-TRA-052 quitar un marcador lo saca de la pregunta', () => {
    const { quiz, q } = withHunt();
    let result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A });
    const id = result.questions.find((x) => x.id === q)!.huntTargets[0]!.id;

    result = removeHuntTarget(result, q, id);
    expect(result.questions.find((x) => x.id === q)!.huntTargets).toEqual([]);
  });

  it('TEST-TRA-053 señala los marcadores que ya no existen en el proyecto', () => {
    // Un objetivo que apunta a un marcador borrado no se puede encontrar
    // nunca: la pregunta queda imposible y nada más lo diría.
    const { quiz, q } = withHunt();
    let result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A });
    result = addHuntTarget(result, q, { sceneId: SCENE_B, hotspotId: HOTSPOT_B });

    const dead = deadHuntTargets(result, new Set([HOTSPOT_A]));
    expect(dead).toHaveLength(1);
  });

  it('TEST-TRA-054 con todos los marcadores vivos no hay nada que señalar', () => {
    const { quiz, q } = withHunt();
    const result = addHuntTarget(quiz, q, { sceneId: SCENE_A, hotspotId: HOTSPOT_A });
    expect(deadHuntTargets(result, new Set([HOTSPOT_A]))).toEqual([]);
  });

  it('TEST-TRA-055 operar sobre una pregunta inexistente no cambia nada', () => {
    const { quiz } = withHunt();
    expect(addHuntTarget(quiz, 'nada', { sceneId: SCENE_A, hotspotId: HOTSPOT_A })).toBe(quiz);
    expect(removeHuntTarget(quiz, 'nada', 'x')).toBe(quiz);
    expect(updateHuntTarget(quiz, 'nada', 'x', { points: 1 })).toBe(quiz);
  });
});

/* ------------------------------------------------------------------ *
 * Objetivos (O08)
 * ------------------------------------------------------------------ */

describe('objetivos de puntuación', () => {
  const scored = (): Quiz => {
    let quiz = createQuiz(PROJECT, 'Seguridad', NOW);
    const question = createQuestion('singleChoice');
    quiz = insertQuestion(quiz, question);
    quiz = addChoice(quiz, question.id, 'Correcta');
    const choiceId = quiz.questions.find((q) => q.id === question.id)!.choices[0]!.id;
    quiz = updateChoice(quiz, question.id, choiceId, { correct: true, points: 10 });
    return quiz;
  };

  it('TEST-TRA-056 añadir un objetivo lo deja sin acciones todavía', () => {
    const result = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 8 });
    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]!.onReached).toEqual([]);
  });

  it('TEST-TRA-057 dos objetivos sobre la misma clave se rechazan', () => {
    // Se alcanzarían a la vez y dispararían dos juegos de acciones.
    const once = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 8 });
    expect(addGoal(once, { scoreKey: 'general', label: 'Otro', target: 9 })).toBe(once);
  });

  it('TEST-TRA-058 un objetivo sin clave o sin nombre se rechaza', () => {
    const quiz = scored();
    expect(addGoal(quiz, { scoreKey: '', label: 'Apto', target: 8 })).toBe(quiz);
    expect(addGoal(quiz, { scoreKey: 'general', label: '', target: 8 })).toBe(quiz);
  });

  it('TEST-TRA-059 cambiar un objetivo conserva sus acciones', () => {
    const quiz = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 8 });
    const result = updateGoal(quiz, 'general', { target: 10 });
    expect(result.goals[0]!.target).toBe(10);
    expect(result.goals[0]!.label).toBe('Apto');
  });

  it('TEST-TRA-060 cambiar un objetivo que no existe no altera la evaluación', () => {
    const quiz = scored();
    expect(updateGoal(quiz, 'calidad', { target: 1 })).toBe(quiz);
  });

  it('TEST-TRA-061 quitar un objetivo lo elimina de la lista', () => {
    const quiz = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 8 });
    expect(removeGoal(quiz, 'general').goals).toEqual([]);
    expect(removeGoal(quiz, 'calidad')).toBe(quiz);
  });

  it('TEST-TRA-062 señala el objetivo que pide más puntos de los alcanzables', () => {
    // 80 sobre un máximo de 10: ni el objetivo ni sus acciones ocurren nunca.
    const quiz = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 80 });
    expect(unreachableGoals(quiz)).toEqual(['general']);
  });

  it('TEST-TRA-063 un objetivo dentro del máximo no se señala', () => {
    const quiz = addGoal(scored(), { scoreKey: 'general', label: 'Apto', target: 10 });
    expect(unreachableGoals(quiz)).toEqual([]);
  });
});
