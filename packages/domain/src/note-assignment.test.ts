/**
 * Pruebas de la asignación de tareas (P05).
 *
 * Antes de esto el editor guardaba el nombre del responsable como texto libre
 * y, junto a él, el identificador fijo `'local'`. Las dos consecuencias se
 * fijan aquí al contrario: el identificador guardado tiene que ser el mismo que
 * usa el servicio para los permisos —si no, «asignadas a mí» no puede
 * funcionar, porque todos los responsables comparten identificador— y dos
 * formas de escribir un nombre no pueden ser dos responsables distintos.
 *
 * El orden de `tasksAssignedTo` también se fija aquí: en una planta lo vencido
 * va primero porque ya está tarde, no porque sea más importante.
 */
import { describe, expect, it } from 'vitest';

import { assignNote, assignableUsers, tasksAssignedTo } from './note';
import { makeNote, makeUser, testUuid } from './testing';

const PROJECT = testUuid(1);
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ISO = '2026-06-15T12:00:00.000Z';

describe('assignNote', () => {
  it('guarda el identificador del equipo, no el nombre escrito', () => {
    // TEST-NAS-001: lo que rompía el filtro «asignadas a mí» era el
    // identificador: con texto libre siempre valía `'local'`. El nombre se
    // guarda además para poder mostrarlo sin consultar el equipo.
    const ana = makeUser('u-ana', { displayName: 'Ana Restrepo' });
    const assigned = assignNote(makeNote(90, PROJECT), ana, ISO);

    expect(assigned.assigneeId).toBe('u-ana');
    expect(assigned.assigneeName).toBe('Ana Restrepo');
  });

  it('quitar el responsable borra nombre e identificador a la vez', () => {
    // TEST-NAS-002: dejar el nombre sin identificador —o al revés— produce una
    // nota que se ve asignada y no sale en ninguna lista de tareas, o que sale
    // en una lista sin poder mostrar a quién.
    const assigned = assignNote(
      makeNote(91, PROJECT, { assigneeId: 'u-ana', assigneeName: 'Ana Restrepo' }),
      null,
      ISO,
    );

    expect(assigned.assigneeId).toBeNull();
    expect(assigned.assigneeName).toBeNull();
  });

  it('marca la nota como modificada y no toca el resto', () => {
    // TEST-NAS-003: la asignación es un cambio del proyecto y tiene que
    // quedar fechada; el cuerpo, los comentarios y el estado no cambian.
    const note = makeNote(92, PROJECT, {
      title: 'Fuga en la brida',
      status: 'inProgress',
      priority: 'urgent',
    });
    const assigned = assignNote(note, makeUser('u-luis'), ISO);

    expect(assigned.updatedAt).toBe(ISO);
    expect(assigned.title).toBe('Fuga en la brida');
    expect(assigned.status).toBe('inProgress');
    expect(assigned.priority).toBe('urgent');
    // El original no se modifica: el almacén compara la versión anterior.
    expect(note.assigneeId).toBeNull();
  });
});

describe('assignableUsers', () => {
  const ana = makeUser('u-ana', { displayName: 'Ana' });
  const luis = makeUser('u-luis', { displayName: 'Luis' });
  const pedro = makeUser('u-pedro', { displayName: 'Pedro', active: false });

  it('deja fuera a quien ya no está en el equipo', () => {
    // TEST-NAS-004: en un desplegable largo los nombres no dicen quién sigue;
    // asignar a alguien inactivo crea una tarea que nadie va a mirar.
    const list = assignableUsers([ana, luis, pedro], null);

    expect(list.map((u) => u.id)).toEqual(['u-ana', 'u-luis']);
  });

  it('conserva al responsable actual aunque esté inactivo', () => {
    // TEST-NAS-005: este es el caso que importa. Si se excluyera, abrir una
    // nota asignada a alguien que ya se fue cambiaría el responsable al primero
    // de la lista —el desplegable no encontraría su valor— y el histórico de la
    // tarea se perdería por el simple hecho de abrirla.
    const note = makeNote(93, PROJECT, { assigneeId: 'u-pedro', assigneeName: 'Pedro' });
    const list = assignableUsers([ana, luis, pedro], note);

    expect(list.map((u) => u.id)).toEqual(['u-ana', 'u-luis', 'u-pedro']);
  });

  it('no inventa personas cuando el responsable ya no figura en el equipo', () => {
    // TEST-NAS-006: si al responsable lo borraron del equipo en vez de
    // desactivarlo, la lista no puede ofrecerlo: no hay identificador que
    // ofrecer. La interfaz muestra el nombre guardado en la nota.
    const note = makeNote(94, PROJECT, { assigneeId: 'u-fuera', assigneeName: 'Quien se fue' });
    const list = assignableUsers([ana, luis], note);

    expect(list.map((u) => u.id)).toEqual(['u-ana', 'u-luis']);
  });
});

describe('tasksAssignedTo', () => {
  it('solo las de esa persona y solo las abiertas', () => {
    // TEST-NAS-007: una tarea resuelta o archivada no es pendiente. Sin este
    // recorte la lista crece con el proyecto y deja de usarse.
    const notes = [
      makeNote(100, PROJECT, { assigneeId: 'u-ana' }),
      makeNote(101, PROJECT, { assigneeId: 'u-luis' }),
      makeNote(102, PROJECT, { assigneeId: 'u-ana', status: 'resolved' }),
      makeNote(103, PROJECT, { assigneeId: 'u-ana', status: 'archived' }),
      makeNote(104, PROJECT, { assigneeId: null }),
    ];

    expect(tasksAssignedTo(notes, 'u-ana', NOW).map((n) => n.id)).toEqual([testUuid(100)]);
  });

  it('lo vencido va primero aunque su prioridad sea menor', () => {
    // TEST-NAS-008: el orden no es por prioridad. Una tarea normal cuya fecha
    // ya pasó va antes que una urgente que todavía tiene plazo: la primera ya
    // incumplió, la segunda no.
    const notes = [
      makeNote(110, PROJECT, {
        assigneeId: 'u-ana',
        priority: 'urgent',
        dueDate: '2026-06-20T12:00:00.000Z',
      }),
      makeNote(111, PROJECT, {
        assigneeId: 'u-ana',
        priority: 'normal',
        dueDate: '2026-06-10T12:00:00.000Z',
      }),
    ];

    expect(tasksAssignedTo(notes, 'u-ana', NOW).map((n) => n.id)).toEqual([
      testUuid(111),
      testUuid(110),
    ]);
  });

  it('a igual urgencia manda la prioridad y después la fecha más próxima', () => {
    // TEST-NAS-009: entre tareas en plazo, primero la prioridad; a igualdad de
    // prioridad, la que vence antes. Las que no tienen fecha van al final, no
    // al principio: sin fecha no hay compromiso que incumplir.
    const notes = [
      makeNote(120, PROJECT, { assigneeId: 'u-ana', priority: 'normal', dueDate: null }),
      makeNote(121, PROJECT, {
        assigneeId: 'u-ana',
        priority: 'normal',
        dueDate: '2026-06-30T12:00:00.000Z',
      }),
      makeNote(122, PROJECT, {
        assigneeId: 'u-ana',
        priority: 'normal',
        dueDate: '2026-06-18T12:00:00.000Z',
      }),
      makeNote(123, PROJECT, { assigneeId: 'u-ana', priority: 'high', dueDate: null }),
    ];

    expect(tasksAssignedTo(notes, 'u-ana', NOW).map((n) => n.id)).toEqual([
      testUuid(123),
      testUuid(122),
      testUuid(121),
      testUuid(120),
    ]);
  });

  it('no reordena el listado recibido', () => {
    // TEST-NAS-010: el listado viene del proyecto y se usa en otras pantallas;
    // ordenarlo en el sitio cambiaría el orden de las notas en todas ellas.
    const notes = [
      makeNote(130, PROJECT, {
        assigneeId: 'u-ana',
        priority: 'low',
        dueDate: '2026-06-01T12:00:00.000Z',
      }),
      makeNote(131, PROJECT, { assigneeId: 'u-ana', priority: 'urgent' }),
    ];
    const original = notes.map((n) => n.id);

    tasksAssignedTo(notes, 'u-ana', NOW);

    expect(notes.map((n) => n.id)).toEqual(original);
  });
});
