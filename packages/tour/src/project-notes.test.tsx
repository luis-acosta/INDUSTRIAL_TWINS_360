/**
 * Pruebas de las notas del proyecto en el recorrido (P09).
 *
 * El control de acceso vive en el servidor y está probado allí. Lo que se
 * comprueba aquí es el cliente y la pantalla, y en concreto lo que convertiría
 * una buena API en una mala experiencia en una planta:
 *
 *  - que un fallo de red se cuente como algo que se puede reintentar, y no
 *    como un número;
 *  - que los estados que se ofrecen vengan del servicio y no de esta pantalla,
 *    porque si no acabaría ofreciendo uno que el servicio rechaza;
 *  - que una lista vacía diga por qué está vacía, que no es lo mismo según el
 *    filtro;
 *  - y que el cliente no filtre por categoría, porque hacerlo aquí significaría
 *    pedir al servidor notas que no se deben ver.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NotesClient, mostUrgent, type ServedNote } from './notes-client';
import { ProjectNotesPanel } from './ProjectNotesPanel';

const IDENTITY = { userId: 'tecnico.ruiz', role: 'editor', displayName: 'Ruiz' };

function note(overrides: Partial<ServedNote> = {}): ServedNote {
  return {
    id: 'n1',
    title: 'Fuga en la brida',
    body: 'Gotea por la junta inferior.',
    categoryId: 'safety',
    status: 'open',
    priority: 'urgent',
    sceneId: 'escena-1',
    assetId: null,
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    updatedAt: '2026-03-01T09:00:00Z',
    comments: [],
    ...overrides,
  };
}

/** `fetch` de prueba que registra la petición y responde lo indicado. */
function fakeFetch(
  response: { status?: number; body?: unknown } = {},
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
      text: async () => JSON.stringify(response.body ?? {}),
    };
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe('NotesClient', () => {
  it('manda la identidad en cabeceras y el proyecto en la consulta', async () => {
    // TEST-PNC-001: la identidad viaja como en el resto del servicio. Que esto
    // no autentica está dicho en el módulo y en el servidor; lo que aquí se
    // fija es que llegue, porque sin ella el servicio no sabe qué recortar.
    const { impl, calls } = fakeFetch({ body: { notes: [], fieldStatuses: [] } });
    const client = new NotesClient('https://planta.local/api/v1', IDENTITY, impl);

    await client.list({ projectId: 'planta-norte', mine: true });

    expect(calls[0]?.url).toContain('projectId=planta-norte');
    expect(calls[0]?.url).toContain('mine=true');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-usuario']).toBe('tecnico.ruiz');
    expect(headers['x-rol']).toBe('editor');
  });

  it('firma el comentario con el nombre y no con el identificador', async () => {
    // TEST-PNC-002: una nota firmada «tecnico.ruiz» no sirve para preguntarle
    // nada a nadie tres semanas después.
    const { impl, calls } = fakeFetch({ body: { note: note() } });
    const client = new NotesClient('https://planta.local/api/v1', IDENTITY, impl);

    await client.comment('n1', 'Sigue goteando');

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      body: 'Sigue goteando',
      authorName: 'Ruiz',
    });
  });

  it('traduce el 403 a «su acceso no alcanza»', async () => {
    // TEST-PNC-003: con lo que se puede hacer al respecto.
    const { impl } = fakeFetch({ status: 403 });
    const client = new NotesClient('https://planta.local/api/v1', IDENTITY, impl);

    const result = await client.list({ projectId: 'planta-norte' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.recovery).toMatch(/responsable del proyecto/);
  });

  it('distingue el plazo agotado del fallo de red', async () => {
    // TEST-PNC-004: en una planta con red compartida, «tardó demasiado» se
    // resuelve reintentando y «no hay red» no. Decir lo segundo cuando pasa lo
    // primero manda a alguien a buscar cobertura que ya tiene.
    const aborted = (async () => {
      const error = new Error('abortado');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    const client = new NotesClient('https://planta.local/api/v1', IDENTITY, aborted);

    const result = await client.list({ projectId: 'planta-norte' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/tardó demasiado/);
  });

  it('un fallo de red se cuenta como tal', async () => {
    // TEST-PNC-005
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = new NotesClient('https://planta.local/api/v1', IDENTITY, failing);

    const result = await client.list({ projectId: 'planta-norte' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error.message).toMatch(/no se pudo contactar/i);
  });

  it('la lista vacía no tiene nota más urgente', () => {
    // TEST-PNC-006: «no tiene nada pendiente» es una respuesta; una nota en
    // blanco no lo es.
    expect(mostUrgent([])).toBeNull();
    expect(mostUrgent([note()])?.id).toBe('n1');
  });
});

describe('ProjectNotesPanel', () => {
  function clientWith(
    page: { notes: readonly ServedNote[]; fieldStatuses: readonly string[] },
    onComment?: (body: string) => ServedNote,
  ): NotesClient {
    return {
      list: vi.fn(async () => ({ ok: true as const, value: page })),
      comment: vi.fn(async (_id: string, body: string) => ({
        ok: true as const,
        value: onComment?.(body) ?? note({ comments: [
          { id: 'c1', authorId: 'tecnico.ruiz', authorName: 'Ruiz', body, createdAt: '2026-03-01T10:00:00Z' },
        ] }),
      })),
      setStatus: vi.fn(async (_id: string, status: string) => ({
        ok: true as const,
        value: note({ status }),
      })),
    } as unknown as NotesClient;
  }

  /** Deja una identidad recordada, como la de un dispositivo ya usado. */
  function identified(): void {
    globalThis.localStorage.setItem(
      'it360.notes.identity',
      JSON.stringify({ userId: 'tecnico.ruiz', role: 'editor', displayName: 'Ruiz' }),
    );
  }

  function mount(client: NotesClient): void {
    identified();
    render(
      <ProjectNotesPanel
        open
        onClose={() => undefined}
        makeClient={() => client}
        projectId="planta-norte"
        sceneId="escena-1"
        sceneTitle="Sala de bombas"
      />,
    );
  }

  it('lista las notas que el servicio devuelve', async () => {
    // TEST-PNP-001
    mount(clientWith({ notes: [note()], fieldStatuses: ['open', 'inProgress', 'blocked'] }));

    expect(await screen.findByText('Fuga en la brida')).toBeTruthy();
  });

  it('ofrece los estados que dice el servicio y no los suyos', async () => {
    // TEST-PNP-002: si la pantalla llevara la lista escrita, ofrecería un
    // estado que el servicio rechaza en cuanto cambie una de las dos. Y
    // «resuelta» no está: resolver exige escribir cómo se resolvió.
    mount(clientWith({ notes: [note()], fieldStatuses: ['open', 'blocked'] }));

    await userEvent.click(await screen.findByText('Fuga en la brida'));

    const select = screen.getByLabelText('Estado de la nota');
    const options = [...select.querySelectorAll('option')].map((option) => option.value);
    expect(options).toEqual(['open', 'blocked']);
  });

  it('añade el comentario a la nota sin recargar la lista', async () => {
    // TEST-PNP-003: recargar sobre la red de una planta tarda, y durante ese
    // tiempo el comentario que se acaba de escribir no aparece: el usuario
    // vuelve a escribirlo y queda dos veces.
    const client = clientWith({ notes: [note()], fieldStatuses: ['open'] });
    mount(client);

    await userEvent.click(await screen.findByText('Fuga en la brida'));
    await userEvent.type(screen.getByLabelText('Comentario'), 'Sigue goteando');
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));

    await waitFor(() => expect(screen.getByText(/Sigue goteando/)).toBeTruthy());
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('no manda un comentario vacío', async () => {
    // TEST-PNP-004: en un teclado de teléfono, el envío accidental es normal;
    // el servicio también lo rechaza, pero gastar una petición y un plazo para
    // enterarse es mala educación con una red de planta.
    const client = clientWith({ notes: [note()], fieldStatuses: ['open'] });
    mount(client);

    await userEvent.click(await screen.findByText('Fuga en la brida'));

    expect(screen.getByRole('button', { name: 'Comentar' })).toBeDisabled();
  });

  it('la lista vacía dice por qué está vacía', async () => {
    // TEST-PNP-005: no es lo mismo «no hay notas en esta escena» que «no tiene
    // notas asignadas». Un mensaje único haría buscar en el sitio equivocado.
    mount(clientWith({ notes: [], fieldStatuses: ['open'] }));

    expect(await screen.findByText(/no tiene notas que usted pueda ver/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Mías' }));

    expect(await screen.findByText(/no tiene notas asignadas/i)).toBeTruthy();
  });

  it('cuenta el fallo con lo que se puede hacer', async () => {
    // TEST-PNP-006: «no se pudo contactar, compruebe la cobertura» es
    // accionable de pie en una planta; «error 503» no.
    const client = {
      list: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: 'NETWORK_UNAVAILABLE',
          message: 'No se pudo contactar con el servicio de notas.',
          recovery: 'Compruebe la cobertura y vuelva a intentarlo.',
        },
      })),
    } as unknown as NotesClient;
    mount(client);

    expect(await screen.findByText(/no se pudo contactar/i)).toBeTruthy();
    expect(screen.getByText(/compruebe la cobertura/i)).toBeTruthy();
  });

  it('el filtro de escena se desactiva si no hay escena', () => {
    // TEST-PNP-007: un filtro que devuelve siempre vacío parece una lista sin
    // notas y no un filtro inaplicable.
    identified();
    render(
      <ProjectNotesPanel
        open
        onClose={() => undefined}
        makeClient={() => clientWith({ notes: [], fieldStatuses: [] })}
        projectId="planta-norte"
        sceneId={null}
        sceneTitle="esta escena"
      />,
    );

    expect(screen.getByRole('button', { name: 'De esta escena' })).toBeDisabled();
  });
});

describe('identificación en el dispositivo (P09)', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('pide el identificador la primera vez y dice que no autentica', async () => {
    // TEST-PNP-008: el servicio acepta la identidad por cabeceras y así lo
    // documenta. Escribir «inicie sesión» haría creer que algo comprueba quién
    // es quién, y alguien expondría el servicio fuera de la planta.
    const client = { list: vi.fn() } as unknown as NotesClient;
    render(
      <ProjectNotesPanel
        open
        onClose={() => undefined}
        makeClient={() => client}
        projectId="planta-norte"
        sceneId={null}
        sceneTitle="esta escena"
      />,
    );

    expect(screen.getByText(/identifica, no autentica/i)).toBeTruthy();
    // Sin identidad no se consulta nada: pedir con una identidad vacía haría
    // que el servicio recortara por una concesión que no existe.
    expect(client.list).not.toHaveBeenCalled();
  });

  it('recuerda la identidad y entonces consulta', async () => {
    // TEST-PNP-009: pedirla en cada consulta, en un teléfono y con guantes, es
    // la forma de que nadie use la función.
    const client = {
      list: vi.fn(async () => ({ ok: true as const, value: { notes: [], fieldStatuses: [] } })),
    } as unknown as NotesClient;

    render(
      <ProjectNotesPanel
        open
        onClose={() => undefined}
        makeClient={() => client}
        projectId="planta-norte"
        sceneId={null}
        sceneTitle="esta escena"
      />,
    );

    await userEvent.type(screen.getByLabelText('Su identificador de usuario'), 'tecnico.ruiz');
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(1));
    expect(globalThis.localStorage.getItem('it360.notes.identity')).toContain('tecnico.ruiz');
  });

  it('no continúa con el identificador en blanco', () => {
    // TEST-PNP-010: una identidad vacía llegaría al servicio como una cabecera
    // sin valor y la petición se rechazaría con un error que no explica nada.
    render(
      <ProjectNotesPanel
        open
        onClose={() => undefined}
        makeClient={() => ({} as unknown as NotesClient)}
        projectId="planta-norte"
        sceneId={null}
        sceneTitle="esta escena"
      />,
    );

    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });
});
