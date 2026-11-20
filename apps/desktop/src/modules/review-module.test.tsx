/**
 * Pruebas de la pantalla de revisión (X16, X17).
 *
 * El servidor ya tiene probados los controles —máquina de estados, separación
 * de funciones, conflictos—. Lo que se comprueba aquí es lo otro, que es lo
 * que decide si el control se usa o se rodea: que la pantalla ofrezca sólo las
 * acciones posibles, que explique por qué algo no se puede en lugar de mostrar
 * un código, y que nombre las secciones en conflicto por su título.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { domainError, err, ok, type Project, type Result } from '@it360/domain';
import { makeProject, makeScene, testUuid } from '@it360/domain/testing';

import { ReviewModule } from './ReviewModule';
import type { ReviewClient, RevisionAction, RevisionInfo } from '../review/review-client';

const PROJECT_ID = testUuid(1);

function project(): Project {
  return {
    ...makeProject(),
    scenes: [makeScene(10, PROJECT_ID, { title: 'Sala de bombas' })],
  };
}

function revision(over: Partial<RevisionInfo> = {}): RevisionInfo {
  return {
    revisionId: 'rev-1',
    projectId: project().id,
    authorId: 'tecnico',
    state: 'draft',
    summary: 'Rótulos nuevos',
    baseRevisionId: null,
    approvedBy: null,
    comments: [],
    createdAt: '2026-03-01T09:00:00+00:00',
    updatedAt: '2026-03-01T09:30:00+00:00',
    conflicts: [],
    ...over,
  };
}

/** Cliente de prueba que registra las acciones pedidas. */
function stubClient(options: {
  readonly revisions?: readonly RevisionInfo[];
  readonly actResult?: Result<RevisionInfo>;
  readonly createResult?: Result<RevisionInfo>;
}): ReviewClient & { readonly acted: { id: string; action: RevisionAction }[]; readonly created: string[] } {
  const acted: { id: string; action: RevisionAction }[] = [];
  const created: string[] = [];
  return {
    acted,
    created,
    async list() {
      return ok(options.revisions ?? []);
    },
    async act(revisionId, action) {
      acted.push({ id: revisionId, action });
      return options.actResult ?? ok(revision({ state: 'in_review' }));
    },
    async create(_project, summary) {
      created.push(summary);
      return options.createResult ?? ok(revision());
    },
  };
}

function mount(client: ReviewClient | null, userId = 'tecnico'): void {
  render(
    <ToastProvider>
      <ReviewModule project={project()} client={client} currentUserId={userId} />
    </ToastProvider>,
  );
}

describe('ReviewModule', () => {
  it('explica la ausencia de servicio en lugar de mostrar una lista vacía', () => {
    // TEST-RVM-001: una lista vacía se lee como «no hay revisiones», que es
    // una afirmación distinta y falsa. La edición local sigue funcionando y la
    // pantalla lo dice.
    mount(null);
    expect(screen.getByText(/No hay servicio de revisión configurado/)).toBeTruthy();
  });

  it('ofrece sólo las acciones del estado actual', async () => {
    // TEST-RVM-002: un botón que el servicio va a rechazar enseña a
    // desconfiar de la pantalla. En revisión no se publica: se aprueba.
    mount(stubClient({ revisions: [revision({ state: 'in_review', authorId: 'otro' })] }));

    await waitFor(() => expect(screen.getByText('En revisión')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Aprobar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pedir cambios' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publicar' })).toBeNull();
  });

  it('una revisión cerrada no ofrece ninguna acción', async () => {
    // TEST-RVM-003: lo publicado no se edita; se abre una revisión nueva.
    mount(stubClient({ revisions: [revision({ state: 'published', authorId: 'otro' })] }));

    await waitFor(() => expect(screen.getByText('Publicada')).toBeTruthy());
    expect(screen.getByText(/ya está cerrada/)).toBeTruthy();
  });

  it('avisa de la separación de funciones antes de pulsar', async () => {
    // TEST-RVM-004: el servicio la aplica igualmente, pero descubrirla con un
    // rechazo hace pensar que la pantalla está rota.
    mount(stubClient({ revisions: [revision({ state: 'in_review', authorId: 'tecnico' })] }), 'tecnico');

    await waitFor(() => expect(screen.getByText(/tiene que aprobarla y publicarla otra persona/)).toBeTruthy());
  });

  it('nombra las secciones en conflicto por su título', async () => {
    // TEST-RVM-005: es la diferencia entre resolver el conflicto y rehacer el
    // trabajo. «scene:7f3a…» no le dice nada a nadie.
    const scene = project().scenes[0]!;
    mount(
      stubClient({
        revisions: [
          revision({
            state: 'approved',
            authorId: 'otro',
            conflicts: [{ section: `scene:${scene.id}`, base: 'a', incoming: 'b', published: 'c' }],
          }),
        ],
      }),
    );

    const aviso = await screen.findByText('Secciones en conflicto');
    const bloque = aviso.closest('div')!;
    expect(within(bloque).getByText('Escena «Sala de bombas»')).toBeTruthy();
  });

  it('no abre un borrador sin resumen', async () => {
    // TEST-RVM-006: el resumen es lo que lee quien revisa. El servicio también
    // lo exige; comprobarlo aquí evita el viaje y explica mejor.
    const client = stubClient({});
    mount(client);

    await userEvent.click(screen.getByRole('button', { name: 'Abrir borrador' }));

    expect(client.created).toEqual([]);
    expect(screen.getByText(/Escriba un resumen/)).toBeTruthy();
  });

  it('abre el borrador con el resumen escrito', async () => {
    // TEST-RVM-007
    const client = stubClient({});
    mount(client);

    await userEvent.type(screen.getByLabelText('Resumen de los cambios'), 'Rótulos nuevos');
    await userEvent.click(screen.getByRole('button', { name: 'Abrir borrador' }));

    await waitFor(() => expect(client.created).toEqual(['Rótulos nuevos']));
  });

  it('envía la acción pulsada al servicio', async () => {
    // TEST-RVM-008: el estado no se cambia en la pantalla por su cuenta: lo
    // decide el servicio, que es donde están los controles.
    const client = stubClient({ revisions: [revision({ state: 'draft' })] });
    mount(client);

    await waitFor(() => expect(screen.getByText('Borrador')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Enviar a revisión' }));

    await waitFor(() => expect(client.acted).toEqual([{ id: 'rev-1', action: 'submit' }]));
  });

  it('muestra el motivo y la salida cuando el servicio rechaza', async () => {
    // TEST-RVM-009: «403» no es una respuesta. A quien le falta permiso hay
    // que decirle a quién pedirlo.
    const client = stubClient({
      revisions: [revision({ state: 'in_review', authorId: 'otro' })],
      actResult: err(
        domainError('PERMISSION_DENIED', 'Esta acción exige el permiso «project.publish»', {
          recovery: 'Pida el permiso al administrador de la instalación.',
        }),
      ),
    });
    mount(client);

    await waitFor(() => expect(screen.getByText('En revisión')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));

    await waitFor(() => expect(screen.getByText(/Pida el permiso al administrador/)).toBeTruthy());
  });

  it('recarga la lista tras un rechazo por estado', async () => {
    // TEST-RVM-010: un rechazo por transición inválida significa que lo que
    // muestra la pantalla ya no es el estado real; insistir sobre un estado
    // viejo produce otro rechazo.
    const client = stubClient({
      revisions: [revision({ state: 'draft' })],
      actResult: err(domainError('CONFLICT', 'Estado cambiado', { recovery: 'Vuelva a cargar la lista.' })),
    });
    const spy = vi.spyOn(client, 'list');
    mount(client);

    await waitFor(() => expect(screen.getByText('Borrador')).toBeTruthy());
    const before = spy.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Enviar a revisión' }));

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
  });

  it('informa cuando el servicio no responde', async () => {
    // TEST-RVM-011: el servicio es opcional y puede estar apagado. Una lista
    // vacía mentiría sobre el estado del proyecto.
    const client: ReviewClient = {
      async list() {
        return err(
          domainError('NETWORK_UNAVAILABLE', 'No se pudo contactar con el servicio', {
            recovery: 'Compruebe la dirección del servicio.',
          }),
        );
      },
      async act() {
        return err(domainError('NETWORK_UNAVAILABLE', 'sin servicio'));
      },
      async create() {
        return err(domainError('NETWORK_UNAVAILABLE', 'sin servicio'));
      },
    };
    mount(client);

    await waitFor(() => expect(screen.getByText(/No se pudo contactar con el servicio/)).toBeTruthy());
  });

  it('distingue las revisiones propias', async () => {
    // TEST-RVM-012: en una cola con varias revisiones, saber cuál es la suya
    // es lo primero que busca quien entra.
    mount(stubClient({ revisions: [revision({ authorId: 'tecnico' })] }), 'tecnico');
    await waitFor(() => expect(screen.getByText(/\(usted\)/)).toBeTruthy());
  });
});
