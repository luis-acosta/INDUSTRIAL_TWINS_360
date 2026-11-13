/**
 * Pruebas del módulo de ventanas de información (E01, F08, F09).
 *
 * Lo que se vigila: que el autor no pueda crear un bloque roto, que se le
 * diga cuando una ventana no la abre nadie —porque entonces no se publica— y
 * que borrar una ventana no deje acciones apuntando al vacío en silencio.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { actionSchema, createInfoWindow, type Action, type Project } from '@it360/domain';
import { makeMedia, makeProject, makeScene, testUuid } from '@it360/domain/testing';
import { InfoWindowsModule } from './InfoWindowsModule';
import { useProjectStore } from '../state/project-store';

const WINDOW_A = testUuid(200);
const TAB_A = testUuid(201);

const openAction = (id: string, windowId: string): Action =>
  actionSchema.parse({ id, event: 'click', config: { type: 'openInfoWindow', windowId } });

function baseProject(extra: Partial<Project> = {}): Project {
  const base = makeProject();
  return {
    ...base,
    media: [makeMedia(80, { originalName: 'bomba.jpg' })],
    scenes: [makeScene(10, base.id, { title: 'Sala de bombas' })],
    ...extra,
  };
}

const windowWithText = (text: string) => ({
  ...createInfoWindow('Ficha de la bomba', TAB_A, WINDOW_A),
  tabs: [
    {
      id: TAB_A as ReturnType<typeof createInfoWindow>['tabs'][number]['id'],
      title: 'General',
      blocks: [{ type: 'text' as const, text }],
    },
  ],
});

function Harness({
  project,
  onProject,
}: {
  readonly project: Project;
  readonly onProject?: (project: Project) => void;
}): JSX.Element {
  const store = useProjectStore(project);
  onProject?.(store.project);
  return <InfoWindowsModule store={store} />;
}

const mount = (project: Project): { latest: () => Project } => {
  let current = project;
  render(
    <ToastProvider>
      <Harness
        project={project}
        onProject={(next) => {
          current = next;
        }}
      />
    </ToastProvider>,
  );
  return { latest: () => current };
};

describe('InfoWindowsModule', () => {
  it('TEST-IWM-001 sin ventanas explica para qué sirven y ofrece crear una', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject());

    expect(screen.getByText('Sin ventanas de información')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Crear la primera ventana' }));

    await waitFor(() => expect(latest().infoWindows).toHaveLength(1));
    expect(latest().infoWindows[0]?.tabs).toHaveLength(1);
  });

  it('TEST-IWM-002 una ventana que nadie abre se señala en la lista', () => {
    // No se publica, y descubrirlo al abrir el paquete es tarde.
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    expect(screen.getByText('sin uso')).toBeInTheDocument();
    expect(
      screen.getByText(/Ninguna acción abre esta ventana, así que no viajará/),
    ).toBeInTheDocument();
  });

  it('TEST-IWM-003 cuando una acción la abre, se dice cuántas', () => {
    const project = baseProject({ infoWindows: [windowWithText('Contenido')] });
    const scene = project.scenes[0];
    if (scene === undefined) throw new Error('falta la escena de prueba');

    mount({
      ...project,
      scenes: [{ ...scene, actions: [openAction(testUuid(210), WINDOW_A)] }],
    });

    expect(screen.queryByText('sin uso')).not.toBeInTheDocument();
    expect(screen.getByText('La abren 1 acción(es).')).toBeInTheDocument();
  });

  it('TEST-IWM-004 se añade un bloque de texto y se edita', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Inicial')] }));

    await user.click(screen.getByRole('button', { name: /Texto/ }));
    const area = screen.getByLabelText('Texto');
    await user.clear(area);
    await user.type(area, 'Arranque de la bomba');

    await waitFor(() => {
      expect(latest().infoWindows[0]?.tabs[0]?.blocks[0]).toEqual({
        type: 'text',
        text: 'Arranque de la bomba',
      });
    });
  });

  it('TEST-IWM-005 un bloque que necesita algo que el proyecto no tiene no se crea a medias', async () => {
    // Crear un bloque de documento sin documentos daría una ventana con un
    // hueco que el autor descubriría delante del visitante.
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    await user.selectOptions(screen.getByLabelText('Tipo de bloque'), 'document');
    await user.click(screen.getByRole('button', { name: 'Añadir bloque' }));

    expect(
      await screen.findByText(/No hay ningún elemento para un bloque de documento/),
    ).toBeInTheDocument();
    expect(latest().infoWindows[0]?.tabs[0]?.blocks).toHaveLength(1);
  });

  it('TEST-IWM-006 un bloque de imagen se crea con el primer medio del proyecto', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    await user.selectOptions(screen.getByLabelText('Tipo de bloque'), 'image');
    await user.click(screen.getByRole('button', { name: 'Añadir bloque' }));

    await waitFor(() => expect(latest().infoWindows[0]?.tabs[0]?.blocks).toHaveLength(2));
    const block = latest().infoWindows[0]?.tabs[0]?.blocks[1];
    expect(block?.type).toBe('image');
    expect(block?.type === 'image' && block.mediaId).toBe(testUuid(80));
  });

  it('TEST-IWM-007 las variables disponibles están junto al campo de texto', async () => {
    // Sin la lista a la vista, «{{escna}}» saldría vacío sin ninguna queja.
    const user = userEvent.setup();
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    await user.click(screen.getByRole('button', { name: /Texto/ }));
    await user.click(screen.getByText('Variables disponibles'));

    expect(screen.getByText('{{escena}}')).toBeInTheDocument();
    expect(screen.getByText('{{puntuacion}}')).toBeInTheDocument();
  });

  it('TEST-IWM-008 una variable que el visor no conoce se denuncia', async () => {
    const user = userEvent.setup();
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    await user.click(screen.getByRole('button', { name: /Texto/ }));
    // Se pega en lugar de teclear: en `userEvent` las llaves abren un
    // descriptor de tecla, así que teclear «{{» produce una sola llave.
    const area = screen.getByLabelText('Texto');
    await user.clear(area);
    await user.click(area);
    await user.paste('Hola {{escna}}');

    expect(await screen.findByText(/variables que el visor no sabe rellenar/)).toBeInTheDocument();
  });

  it('TEST-IWM-009 un contenido web a la red interna impide publicar y se dice', async () => {
    const user = userEvent.setup();
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    await user.selectOptions(screen.getByLabelText('Tipo de bloque'), 'webframe');
    await user.click(screen.getByRole('button', { name: 'Añadir bloque' }));

    const url = await screen.findByLabelText('Dirección');
    await user.clear(url);
    await user.type(url, 'https://192.168.1.10/camara');

    const aviso = await screen.findByText('Esta ventana impide publicar');
    const callout = aviso.closest('.it-callout');
    expect(callout).not.toBeNull();
    expect(within(callout as HTMLElement).getByText(/red interna/)).toBeInTheDocument();
  });

  it('TEST-IWM-010 se añaden pestañas y cada una tiene sus bloques', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Lo general')] }));

    await user.click(screen.getByRole('button', { name: 'Añadir pestaña' }));
    await waitFor(() => expect(latest().infoWindows[0]?.tabs).toHaveLength(2));

    // La pestaña nueva queda abierta y vacía.
    expect(screen.getByText('Esta pestaña está vacía. Elija un tipo de bloque y añádalo.')).toBeInTheDocument();
    expect(screen.queryByText('Lo general')).not.toBeInTheDocument();
  });

  it('TEST-IWM-011 no se puede quedar sin pestañas', async () => {
    const user = userEvent.setup();
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    // Con una sola pestaña no se ofrece eliminarla.
    expect(screen.queryByRole('button', { name: 'Eliminar pestaña' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Añadir pestaña' }));
    expect(await screen.findByRole('button', { name: 'Eliminar pestaña' })).toBeInTheDocument();
  });

  it('TEST-IWM-012 el orden de los bloques se puede cambiar', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Primero')] }));

    await user.selectOptions(screen.getByLabelText('Tipo de bloque'), 'image');
    await user.click(screen.getByRole('button', { name: 'Añadir bloque' }));
    await waitFor(() => expect(latest().infoWindows[0]?.tabs[0]?.blocks).toHaveLength(2));

    // El bloque recién añadido queda seleccionado: se sube.
    await user.click(screen.getByRole('button', { name: 'Subir' }));

    await waitFor(() =>
      expect(latest().infoWindows[0]?.tabs[0]?.blocks.map((b) => b.type)).toEqual([
        'image',
        'text',
      ]),
    );
  });

  it('TEST-IWM-013 borrar una ventana avisa de las acciones que la abrían', async () => {
    const user = userEvent.setup();
    const project = baseProject({ infoWindows: [windowWithText('Contenido')] });
    const scene = project.scenes[0];
    if (scene === undefined) throw new Error('falta la escena de prueba');

    const { latest } = mount({
      ...project,
      scenes: [{ ...scene, actions: [openAction(testUuid(210), WINDOW_A)] }],
    });

    await user.click(screen.getByRole('button', { name: 'Eliminar ventana' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/quedarán sin destino/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(latest().infoWindows).toHaveLength(0));
  });

  it('TEST-IWM-014 borrar una ventana limpia las acciones de cierre que la abrían', async () => {
    // Si no, quedaría una ventana que al cerrarse intenta abrir otra que ya no
    // existe, y el visitante vería un aviso de contenido ausente.
    const user = userEvent.setup();
    const otra = {
      ...createInfoWindow('Siguiente', testUuid(203), testUuid(202)),
      onCloseActions: [openAction(testUuid(211), WINDOW_A)],
    };

    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Contenido'), otra] }));

    await user.click(screen.getByRole('button', { name: 'Eliminar ventana' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar' }),
    );

    await waitFor(() => expect(latest().infoWindows).toHaveLength(1));
    expect(latest().infoWindows[0]?.onCloseActions).toHaveLength(0);
  });

  it('TEST-IWM-015 el tamaño y el modo modal se guardan', async () => {
    const user = userEvent.setup();
    const { latest } = mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    const ancho = screen.getByLabelText('Ancho');
    await user.clear(ancho);
    await user.type(ancho, '900{Enter}');

    await user.click(screen.getByLabelText('Bloquear el recorrido hasta cerrarla'));

    await waitFor(() => {
      expect(latest().infoWindows[0]?.widthPx).toBe(900);
      expect(latest().infoWindows[0]?.modal).toBe(true);
    });
  });

  it('TEST-IWM-016 las acciones de cierre se editan con el evento fijo del cierre', () => {
    // Ofrecer «al pulsar» aquí dejaría acciones que no se ejecutan nunca.
    mount(baseProject({ infoWindows: [windowWithText('Contenido')] }));

    expect(screen.getByText('Al cerrar la ventana')).toBeInTheDocument();
    expect(screen.queryByLabelText('Evento')).not.toBeInTheDocument();
  });
});
