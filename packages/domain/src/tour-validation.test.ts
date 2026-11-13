/**
 * Pruebas de la validación del recorrido automático (J01–J03, J08).
 *
 * El fallo que persiguen es el punto de paso huérfano: una parada que apunta a
 * una escena borrada deja el recorrido detenido a mitad, **delante de alguien a
 * quien se le está enseñando la planta**, y el autor no se entera hasta ese
 * momento. Lo demás son avisos a propósito: son decisiones legítimas que
 * conviene ver escritas antes de publicar, no errores que impedir.
 */
import { describe, expect, it } from 'vitest';
import {
  canPublishTour,
  estimatedTourSeconds,
  tourSchema,
  validateTour,
  type Tour,
  type Waypoint,
} from './tour';
import { newUuid, type Uuid } from './identity';

const NOW = '2026-10-01T09:00:00.000Z';
const SCENE_A = newUuid();
const SCENE_B = newUuid();
const QUIZ = newUuid();
const AUDIO = newUuid();

const options = (over: Partial<Parameters<typeof validateTour>[1]> = {}) => ({
  sceneIds: new Set<string>([SCENE_A, SCENE_B]),
  quizIds: new Set<string>([QUIZ]),
  mediaIds: new Set<string>([AUDIO]),
  ...over,
});

function waypoint(sceneId: Uuid, over: Partial<Waypoint> = {}): Waypoint {
  return {
    id: newUuid(),
    sceneId,
    view: { yaw: 0, pitch: 0, fov: 75 },
    dwellMs: 4000,
    travelMs: 1500,
    actions: [],
    caption: '',
    audioMediaId: null,
    waitForAudio: true,
    order: 0,
    ...over,
  } as Waypoint;
}

function tour(over: Partial<Tour> = {}): Tour {
  return tourSchema.parse({
    id: newUuid(),
    projectId: newUuid(),
    name: 'Visita de planta',
    waypoints: [waypoint(SCENE_A), waypoint(SCENE_B, { order: 1 })],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}

const messages = (problems: readonly { message: string }[]): string =>
  problems.map((p) => p.message).join(' | ');

/* ------------------------------------------------------------------ *
 * Puntos de paso
 * ------------------------------------------------------------------ */

describe('validateTour — puntos de paso', () => {
  it('TEST-TRV-001 un recorrido completo no tiene problemas', () => {
    const problems = validateTour(tour(), options());
    expect(problems).toEqual([]);
    expect(canPublishTour(problems)).toBe(true);
  });

  it('TEST-TRV-002 impide publicar un recorrido sin paradas', () => {
    const problems = validateTour(tour({ waypoints: [] }), options());
    expect(canPublishTour(problems)).toBe(false);
    expect(messages(problems)).toContain('ningún punto de paso');
  });

  it('TEST-TRV-003 avisa, sin bloquear, de un recorrido de una sola parada', () => {
    const problems = validateTour(tour({ waypoints: [waypoint(SCENE_A)] }), options());
    expect(canPublishTour(problems)).toBe(true);
    expect(messages(problems)).toContain('un solo punto');
  });

  it('TEST-TRV-004 impide publicar si una parada apunta a una escena borrada', () => {
    // Es el fallo que se descubre delante de la visita: el recorrido se para
    // en seco y nadie sabe por qué.
    const problems = validateTour(
      tour({ waypoints: [waypoint(SCENE_A), waypoint(newUuid(), { order: 1 })] }),
      options(),
    );

    expect(canPublishTour(problems)).toBe(false);
    expect(messages(problems)).toContain('ya no está en el proyecto');
  });

  it('TEST-TRV-005 señala cuál es la parada rota, no sólo que hay una', () => {
    const rota = waypoint(newUuid(), { order: 1 });
    const problems = validateTour(tour({ waypoints: [waypoint(SCENE_A), rota] }), options());

    const problem = problems.find((p) => p.severity === 'blocking');
    expect(problem?.waypointId).toBe(rota.id);
  });

  it('TEST-TRV-006 impide publicar si la narración ya no está', () => {
    const problems = validateTour(
      tour({ waypoints: [waypoint(SCENE_A, { audioMediaId: newUuid() })] }),
      options(),
    );
    expect(canPublishTour(problems)).toBe(false);
    expect(messages(problems)).toContain('narración');
  });

  it('TEST-TRV-007 una narración que sí está no genera problemas', () => {
    const problems = validateTour(
      tour({
        waypoints: [
          waypoint(SCENE_A, { audioMediaId: AUDIO }),
          waypoint(SCENE_B, { order: 1 }),
        ],
      }),
      options(),
    );
    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Permanencia
 * ------------------------------------------------------------------ */

describe('validateTour — permanencia', () => {
  it('TEST-TRV-008 avisa de una parada que pasará de largo', () => {
    // Sin permanencia y sin esperar al audio, el visitante ve un salto y no
    // una parada: nunca llega a mirar lo que se le quería enseñar.
    const problems = validateTour(
      tour({
        waypoints: [
          waypoint(SCENE_A, { dwellMs: 0, waitForAudio: false }),
          waypoint(SCENE_B, { order: 1 }),
        ],
      }),
      options(),
    );

    expect(canPublishTour(problems)).toBe(true);
    expect(messages(problems)).toContain('pasará de largo');
  });

  it('TEST-TRV-009 impide publicar una parada que espera a un audio que no tiene', () => {
    // Esta sí bloquea: el recorrido se queda esperando algo que nunca llega.
    const problems = validateTour(
      tour({
        waypoints: [
          waypoint(SCENE_A, { dwellMs: 0, waitForAudio: true, audioMediaId: null }),
          waypoint(SCENE_B, { order: 1 }),
        ],
      }),
      options(),
    );

    expect(canPublishTour(problems)).toBe(false);
    expect(messages(problems)).toContain('Espera a un audio que no tiene');
  });

  it('TEST-TRV-010 una parada sin audio pero con permanencia es correcta', () => {
    const problems = validateTour(
      tour({
        waypoints: [
          waypoint(SCENE_A, { dwellMs: 5000, waitForAudio: true, audioMediaId: null }),
          waypoint(SCENE_B, { order: 1 }),
        ],
      }),
      options(),
    );
    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Evaluación previa (J08)
 * ------------------------------------------------------------------ */

describe('validateTour — evaluación previa', () => {
  it('TEST-TRV-011 admite condicionar el recorrido a una evaluación que existe', () => {
    const problems = validateTour(
      tour({ requiresQuizId: QUIZ, requiresQuizMinScore: 70 }),
      options(),
    );
    expect(problems).toEqual([]);
  });

  it('TEST-TRV-012 impide publicar si la evaluación ya no existe', () => {
    const problems = validateTour(tour({ requiresQuizId: newUuid() }), options());
    expect(canPublishTour(problems)).toBe(false);
    expect(messages(problems)).toContain('evaluación que condiciona');
  });

  it('TEST-TRV-013 impide exigir una nota sin decir de qué evaluación', () => {
    // Sin evaluación, la nota mínima no se puede comprobar nunca: o bloquea
    // siempre o no bloquea nunca, y en ninguno de los dos casos el autor
    // obtiene lo que quería.
    const problems = validateTour(
      tour({ requiresQuizId: null, requiresQuizMinScore: 70 }),
      options(),
    );
    expect(canPublishTour(problems)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Interrupción (J03)
 * ------------------------------------------------------------------ */

describe('validateTour — interrupción', () => {
  it('TEST-TRV-014 avisa cuando el visitante no puede detenerlo', () => {
    // Es configurable, pero no es un valor que deba pasarse por alto: quien
    // lo desactiva debe ver escrito lo que implica.
    const problems = validateTour(tour({ allowInterrupt: false }), options());

    expect(canPublishTour(problems)).toBe(true);
    expect(messages(problems)).toContain('quiosco vigilado');
  });

  it('TEST-TRV-015 señala la combinación que se contradice', () => {
    const problems = validateTour(
      tour({ allowInterrupt: false, autoResumeIdleS: 30 }),
      options(),
    );
    expect(messages(problems)).toContain('no puede pausarlo');
  });

  it('TEST-TRV-016 un recorrido interrumpible no genera ningún aviso', () => {
    const problems = validateTour(
      tour({ allowInterrupt: true, autoResumeIdleS: 30 }),
      options(),
    );
    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Duración
 * ------------------------------------------------------------------ */

describe('estimatedTourSeconds', () => {
  it('TEST-TRV-017 suma permanencia y desplazamiento de cada parada', () => {
    const result = estimatedTourSeconds(
      tour({
        waypoints: [
          waypoint(SCENE_A, { dwellMs: 4000, travelMs: 1500 }),
          waypoint(SCENE_B, { dwellMs: 6000, travelMs: 2500, order: 1 }),
        ],
      }),
    );
    expect(result).toBe(14);
  });

  it('TEST-TRV-018 un recorrido sin paradas dura cero', () => {
    expect(estimatedTourSeconds(tour({ waypoints: [] }))).toBe(0);
  });

  it('TEST-TRV-019 no cuenta la narración, cuya duración no está en el proyecto', () => {
    // Por eso la interfaz dice «al menos»: una cifra exacta que luego se queda
    // corta es peor que una declarada como mínimo.
    const conAudio = estimatedTourSeconds(
      tour({ waypoints: [waypoint(SCENE_A, { dwellMs: 1000, travelMs: 0, audioMediaId: AUDIO })] }),
    );
    expect(conAudio).toBe(1);
  });
});
