/**
 * Pruebas de la asignación de tareas en el editor (P05).
 *
 * Las reglas están probadas en el dominio; aquí se comprueba lo único que sólo
 * falla en la interfaz, y que es justamente lo que estaba mal: el responsable
 * se escribía a mano y el identificador guardado era siempre `'local'`. Con
 * eso, «asignadas a mí» no podía funcionar —todas las notas asignadas
 * compartían identificador— y dos formas de escribir un nombre eran dos
 * responsables al buscar y uno solo al identificar.
 *
 * Lo que se fija: que el desplegable ofrezca el equipo del proyecto, que lo
 * guardado sea el identificador del servicio, que el filtro de «mías» siga al
 * mismo identificador, y que sin identidad el interruptor no aparezca en lugar
 * de aparecer devolviendo siempre una lista vacía.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import type { Project } from '@it360/domain';
import { makeNote, makeProject, makeUser, testUuid } from '@it360/domain/testing';
import { NotesModule } from './NotesModule';
import { useProjectStore } from '../state/project-store';

const PROJECT_ID = testUuid(1);

const ANA = makeUser('u-ana', { displayName: 'Ana Restrepo' });
const LUIS = makeUser('u-luis', { displayName: 'Luis Pardo' });
const PEDRO = makeUser('u-pedro', { displayName: 'Pedro Gómez', active: false });

function baseProject(extra: Partial<Project> = {}): Project {
  return {
    ...makeProject(),
    users: [ANA, LUIS, PEDRO],
    notes: [makeNote(90, PROJECT_ID, { title: 'Fuga en la brida' })],
    ...extra,
  };
}

function Harness({
  project,
  currentUserId = 'u-ana',
  onProject,
}: {
  readonly project: Project;
  readonly currentUserId?: string | null;
  readonly onProject?: (project: Project) => void;
}): JSX.Element {
  const store = useProjectStore(project);
  onProject?.(store.project);

  return (
    <NotesModule store={store} onGoToScene={() => undefined} currentUserId={currentUserId} />
  );
}

function mount(options: {
  project: Project;
  currentUserId?: string | null;
}): { latest: () => Project } {
  let latest = options.project;
  render(
    <ToastProvider>
      <Harness
        project={options.project}
        currentUserId={options.currentUserId}
        onProject={(next) => {
          latest = next;
        }}
      />
    </ToastProvider>,
  );
  return { latest: () => latest };
}

/** Abre la nota del listado para que aparezca el inspector. */
async function openNote(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(screen.getByText(title));
}

describe('responsable de una nota', () => {
  it('ofrece el equipo del proyecto y guarda su identificador', async () => {
    // TEST-NAE-001: el identificador guardado tiene que ser el del servicio.
    // Con texto libre valía siempre `'local'`, y ése era el defecto: el
    // nombre se veía bien y nada de lo que depende del identificador servía.
    const user = userEvent.setup();
    const { latest } = mount({ project: baseProject() });
    await openNote(user, 'Fuga en la brida');

    const select = screen.getByLabelText('Responsable');
    await user.selectOptions(select, 'u-luis');

    const note = latest().notes[0];
    expect(note?.assigneeId).toBe('u-luis');
    expect(note?.assigneeName).toBe('Luis Pardo');
  });

  it('no ofrece a quien ya no está en el equipo', async () => {
    // TEST-NAE-002: Pedro está inactivo. Asignarle una tarea produce una que
    // nadie va a mirar, y en un desplegable largo el nombre no dice quién
    // sigue en el equipo.
    const user = userEvent.setup();
    mount({ project: baseProject() });
    await openNote(user, 'Fuga en la brida');

    const select = screen.getByLabelText('Responsable');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Ana Restrepo');
    expect(options).toContain('Luis Pardo');
    expect(options.some((label) => label?.includes('Pedro'))).toBe(false);
  });

  it('conserva al responsable inactivo de una nota ya asignada', async () => {
    // TEST-NAE-003: si se excluyera, abrir la nota dejaría el desplegable sin
    // su valor y el primer cambio de cualquier otro campo se llevaría por
    // delante el responsable. El histórico no se puede perder por abrirla.
    const user = userEvent.setup();
    const { latest } = mount({
      project: baseProject({
        notes: [
          makeNote(91, PROJECT_ID, {
            title: 'Rodamiento con ruido',
            assigneeId: 'u-pedro',
            assigneeName: 'Pedro Gómez',
          }),
        ],
      }),
    });
    await openNote(user, 'Rodamiento con ruido');

    const select = screen.getByLabelText('Responsable');
    expect((select as HTMLSelectElement).value).toBe('u-pedro');
    expect(
      within(select)
        .getAllByRole('option')
        .some((o) => o.textContent?.includes('inactivo')),
    ).toBe(true);
    expect(latest().notes[0]?.assigneeId).toBe('u-pedro');
  });

  it('quitar el responsable borra nombre e identificador', async () => {
    // TEST-NAE-004: dejar uno de los dos produce una nota que se ve asignada y
    // no sale en ninguna lista de tareas.
    const user = userEvent.setup();
    const { latest } = mount({
      project: baseProject({
        notes: [
          makeNote(92, PROJECT_ID, {
            title: 'Revisar rótulo',
            assigneeId: 'u-ana',
            assigneeName: 'Ana Restrepo',
          }),
        ],
      }),
    });
    await openNote(user, 'Revisar rótulo');

    await user.selectOptions(screen.getByLabelText('Responsable'), '');

    expect(latest().notes[0]?.assigneeId).toBeNull();
    expect(latest().notes[0]?.assigneeName).toBeNull();
  });

  it('avisa en lugar de ofrecer un desplegable vacío si no hay equipo', async () => {
    // TEST-NAE-005: un proyecto nuevo no tiene equipo. Un desplegable con una
    // sola opción vacía parece averiado; el aviso dice dónde se añade gente.
    const user = userEvent.setup();
    mount({ project: baseProject({ users: [] }) });
    await openNote(user, 'Fuga en la brida');

    expect(screen.getByLabelText('Responsable')).toBeDisabled();
    expect(screen.getByText(/todavía no tiene equipo/i)).toBeTruthy();
  });
});

describe('filtro de tareas propias', () => {
  it('filtra por el mismo identificador que se guarda al asignar', async () => {
    // TEST-NAE-006: es la comprobación que cierra el defecto. El filtro usa el
    // identificador del servicio, así que sólo deja la nota de Ana; con el
    // `'local'` de antes habrían quedado las dos.
    const user = userEvent.setup();
    mount({
      project: baseProject({
        notes: [
          makeNote(93, PROJECT_ID, {
            title: 'Tarea de Ana',
            assigneeId: 'u-ana',
            assigneeName: 'Ana Restrepo',
          }),
          makeNote(94, PROJECT_ID, {
            title: 'Tarea de Luis',
            assigneeId: 'u-luis',
            assigneeName: 'Luis Pardo',
          }),
        ],
      }),
      currentUserId: 'u-ana',
    });

    await user.click(screen.getByLabelText('Asignadas a mí'));

    expect(screen.getByText('Tarea de Ana')).toBeTruthy();
    expect(screen.queryByText('Tarea de Luis')).toBeNull();
  });

  it('cuenta las tareas propias sin que el filtro de pantalla lo cambie', async () => {
    // TEST-NAE-007: el número se mira al entrar y tiene que decir lo mismo
    // cuando se está filtrando por otra cosa; si siguiera al filtro, buscar
    // una nota concreta haría pensar que no queda nada pendiente.
    const user = userEvent.setup();
    mount({
      project: baseProject({
        notes: [
          makeNote(95, PROJECT_ID, { title: 'Tarea de Ana', assigneeId: 'u-ana' }),
          makeNote(96, PROJECT_ID, { title: 'Otra de Ana', assigneeId: 'u-ana' }),
        ],
      }),
      currentUserId: 'u-ana',
    });

    expect(screen.getByText(/2 asignada\(s\) a usted/)).toBeTruthy();

    await user.type(screen.getByLabelText('Buscar notas'), 'Otra');

    expect(screen.getByText(/2 asignada\(s\) a usted/)).toBeTruthy();
  });

  it('sin identidad el interruptor no aparece', async () => {
    // TEST-NAE-008: un «asignadas a mí» que no puede saber quién es «mí»
    // devolvería siempre una lista vacía, y eso se lee como «no tengo tareas».
    mount({
      project: baseProject({
        notes: [makeNote(97, PROJECT_ID, { title: 'Tarea suelta', assigneeId: 'u-ana' })],
      }),
      currentUserId: null,
    });

    expect(screen.queryByLabelText('Asignadas a mí')).toBeNull();
    expect(screen.queryByText(/asignada\(s\) a usted/)).toBeNull();
  });
});
