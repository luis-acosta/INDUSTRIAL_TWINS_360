/**
 * Pruebas de la publicación de notas en el servicio (P09).
 *
 * Sin esto, la pantalla de notas del recorrido existiría y estaría siempre
 * vacía: el servicio no lee archivos de proyecto, así que la copia que sirve a
 * los teléfonos de la planta es la que le entrega el editor.
 *
 * Lo que se fija: que no viaje más de lo necesario, que un fallo no se traduzca
 * en un número, y que la huella no cambie por algo que el servicio no sirve
 * —porque el proyecto se guarda en cada tecla, y un envío por tecla convierte
 * el servicio en el cuello de botella del editor—.
 */
import { describe, expect, it } from 'vitest';
import { makeNote, testUuid } from '@it360/domain/testing';

import { notesFingerprint, requestNotification, syncNotes } from './notes-sync';

const PROJECT = testUuid(1);
const IDENTITY = { userId: 'jefa.planta', role: 'administrator' };

function fakeFetch(status = 200, body: unknown = { loaded: 2 }): {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('syncNotes', () => {
  it('manda las notas al servicio con la identidad del editor', async () => {
    // TEST-NSY-001
    const { impl, calls } = fakeFetch();
    const notes = [makeNote(80, PROJECT), makeNote(81, PROJECT)];

    const result = await syncNotes('https://planta.local/api/v1', IDENTITY, PROJECT, notes, impl);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://planta.local/api/v1/notes');
    expect(calls[0]?.init.method).toBe('PUT');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-usuario']).toBe('jefa.planta');
  });

  it('no manda adjuntos, comentarios ni resolución', async () => {
    // TEST-NSY-002: en una pantalla de teléfono y con la red de una planta, una
    // lista que arrastra fotografías no acaba de cargar. Y la resolución es
    // trabajo interno del proyecto: no hace falta para listar ni para abrir.
    const { impl, calls } = fakeFetch();
    const note = makeNote(80, PROJECT, {
      resolution: 'Se cambió la junta',
      comments: [
        {
          id: testUuid(90),
          noteId: testUuid(80),
          body: 'interno',
          authorId: 'u',
          authorName: 'U',
          attachments: [],
          editedAt: null,
          createdAt: '2026-03-01T09:00:00Z',
        },
      ],
    });

    await syncNotes('https://planta.local/api/v1', IDENTITY, PROJECT, [note], impl);

    const sent = JSON.parse(String(calls[0]?.init.body)) as {
      notes: Record<string, unknown>[];
    };
    expect(Object.keys(sent.notes[0] ?? {})).not.toContain('comments');
    expect(Object.keys(sent.notes[0] ?? {})).not.toContain('resolution');
    expect(Object.keys(sent.notes[0] ?? {})).not.toContain('attachments');
  });

  it('un 403 se explica con lo que falta y por qué', async () => {
    // TEST-NSY-003: publicar sustituye lo que el servicio sirve. Con permiso de
    // lectura bastando, cualquiera que pueda leer podría vaciar la lista de los
    // demás, y eso merece explicarse en lugar de devolver «prohibido».
    const { impl } = fakeFetch(403);

    const result = await syncNotes('https://planta.local/api/v1', IDENTITY, PROJECT, [], impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.recovery).toMatch(/actualizar el proyecto/);
  });

  it('un servicio inalcanzable no es un error del editor', async () => {
    // TEST-NSY-004: que la planta no pueda consultar las notas desde el móvil
    // es un problema; que el editor se quede esperando a un servicio caído es
    // peor, porque entonces no se puede ni editar.
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await syncNotes('https://planta.local/api/v1', IDENTITY, PROJECT, [], failing);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error.recovery).toMatch(/sigue funcionando/);
  });

  it('respeta el plazo y no deja la promesa colgada', async () => {
    // TEST-NSY-005: un servicio que acepta la conexión y no responde dejaría el
    // envío vivo para siempre, y con él el aviso que nunca llega.
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('abortado')));
      })) as unknown as typeof fetch;

    const result = await syncNotes(
      'https://planta.local/api/v1',
      IDENTITY,
      PROJECT,
      [],
      hanging,
      10,
    );

    expect(result.ok).toBe(false);
  });
});

describe('notesFingerprint', () => {
  it('cambia cuando cambia algo que el servicio sirve', () => {
    // TEST-NSY-006
    const before = notesFingerprint([makeNote(80, PROJECT, { status: 'open' })]);
    const after = notesFingerprint([makeNote(80, PROJECT, { status: 'blocked' })]);

    expect(before).not.toBe(after);
  });

  it('no cambia por algo que no viaja', () => {
    // TEST-NSY-007: es la razón de que la huella exista. El proyecto se guarda
    // en cada tecla; si la huella mirase todo el proyecto, mover un marcador
    // provocaría un envío de notas.
    const before = notesFingerprint([makeNote(80, PROJECT, { resolution: '' })]);
    const after = notesFingerprint([
      makeNote(80, PROJECT, { resolution: 'Se cambió la junta' }),
    ]);

    expect(before).toBe(after);
  });

  it('no depende del orden de la lista', () => {
    // TEST-NSY-008: reordenar la lista en el editor no cambia lo que el
    // servicio va a servir, y provocar un envío por ello gastaría la red de la
    // planta sin motivo.
    const a = makeNote(80, PROJECT);
    const b = makeNote(81, PROJECT);

    expect(notesFingerprint([a, b])).toBe(notesFingerprint([b, a]));
  });

  it('una nota más cambia la huella', () => {
    // TEST-NSY-009: y una menos también, que es el caso que importa: una nota
    // borrada tiene que desaparecer del teléfono de la planta.
    expect(notesFingerprint([makeNote(80, PROJECT)])).not.toBe(
      notesFingerprint([makeNote(80, PROJECT), makeNote(81, PROJECT)]),
    );
  });
});

describe('requestNotification', () => {
  it('manda el aviso con la identidad y el motivo', async () => {
    // TEST-NSY-010
    const { impl, calls } = fakeFetch(200, { delivered: 1, pending: 0 });

    const result = await requestNotification(
      'https://planta.local/api/v1',
      IDENTITY,
      {
        reason: 'note.assigned',
        noteId: 'n1',
        recipientId: 'tecnico.ruiz',
        recipientAddress: 'ruiz@planta.local',
        recipientName: 'Ruiz',
        projectTitle: 'Planta Norte',
        priority: 'urgent',
        noteTitle: 'Fuga de ácido en la brida',
      },
      impl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.delivered).toBe(1);
    expect(calls[0]?.url).toBe('https://planta.local/api/v1/notifications');
  });

  it('cero entregados no es un fallo, y quien llama tiene que poder verlo', async () => {
    // TEST-NSY-011: es la distinción que da valor a todo esto. Un servicio sin
    // servidor de correo acepta el aviso y no lo manda; traducirlo a «hecho»
    // dejaría al autor creyendo avisado a alguien que no lo está.
    const { impl } = fakeFetch(200, { delivered: 0, pending: 1 });

    const result = await requestNotification(
      'https://planta.local/api/v1',
      IDENTITY,
      {
        reason: 'note.assigned',
        noteId: 'n1',
        recipientId: 'tecnico.ruiz',
        recipientAddress: 'ruiz@planta.local',
        recipientName: 'Ruiz',
        projectTitle: 'Planta Norte',
        priority: 'normal',
        noteTitle: 'x',
      },
      impl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ delivered: 0, pending: 1 });
  });

  it('un 400 se explica apuntando al equipo del proyecto', async () => {
    // TEST-NSY-012: el fallo más probable es una persona sin dirección de
    // correo, y eso se arregla en Ajustes. «Petición incorrecta» no lo dice.
    const { impl } = fakeFetch(400);

    const result = await requestNotification(
      'https://planta.local/api/v1',
      IDENTITY,
      {
        reason: 'note.assigned',
        noteId: 'n1',
        recipientId: 'x',
        recipientAddress: 'roto',
        recipientName: 'X',
        projectTitle: 'P',
        priority: 'normal',
        noteTitle: 'x',
      },
      impl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toMatch(/equipo del proyecto/);
  });

  it('un servicio caído deja claro que la nota sí quedó asignada', async () => {
    // TEST-NSY-013: lo contrario haría pensar que la asignación se perdió, y
    // el autor la repetiría.
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await requestNotification(
      'https://planta.local/api/v1',
      IDENTITY,
      {
        reason: 'note.assigned',
        noteId: 'n1',
        recipientId: 'x',
        recipientAddress: 'x@y.es',
        recipientName: 'X',
        projectTitle: 'P',
        priority: 'normal',
        noteTitle: 'x',
      },
      failing,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toMatch(/queda asignada/);
  });
});
