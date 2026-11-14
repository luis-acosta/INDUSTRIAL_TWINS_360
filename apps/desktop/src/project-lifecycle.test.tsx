/**
 * Pruebas del ciclo de vida del proyecto (Y01, Y03, Y07).
 *
 * El ciclo básico del producto es crear, guardar y seguir mañana. Estaba roto
 * en el último paso: al abrir un proyecto guardado se cargaban el modelo y los
 * bytes de los archivos, pero nadie construía las direcciones con las que
 * mostrarlos, así que todas las escenas aparecían en blanco. Ninguna prueba lo
 * vio porque las pruebas de la aplicación arrancaban con las direcciones ya
 * dadas, como si el proyecto viniera del demo y no del disco.
 *
 * Aquí se abre de verdad —con el diálogo de archivos sustituido, que es lo
 * único que no se puede ejecutar— y se comprueba en la interfaz que la imagen
 * del plano se ve.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { createPlan, ok, type Project } from '@it360/domain';
import { makeMedia, makeProject, makeScene } from '@it360/domain/testing';

const openMock = vi.fn();
const saveMock = vi.fn();
const saveAsMock = vi.fn();

vi.mock('./platform/project-files', () => ({
  pickAndOpenProject: () => openMock(),
  saveProject: () => saveMock(),
  saveProjectAs: () => saveAsMock(),
  collectPackageFiles: () => new Map<string, Uint8Array>(),
}));

const { App } = await import('./App');

const PLAN_MEDIA = makeMedia(80, {
  relativePath: 'media/planos/planta.png',
  originalName: 'planta.png',
  mime: 'image/png',
});

/** Proyecto guardado en disco: un plano con su imagen en el paquete. */
function savedProject(): { project: Project; files: Map<string, Uint8Array> } {
  const base = makeProject({ title: 'Planta Norte' });
  const plan = createPlan(PLAN_MEDIA.id, 'Planta general');

  return {
    project: {
      ...base,
      media: [PLAN_MEDIA],
      scenes: [makeScene(10, base.id, { title: 'Sala de bombas', mediaId: null })],
      plans: [plan],
    },
    // Un PNG mínimo: lo que importa es que los bytes estén, no que se decodifique.
    files: new Map([
      ['media/planos/planta.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ]),
  };
}

async function renderApp(): Promise<void> {
  await act(async () => {
    render(
      <ToastProvider>
        <App initialProject={makeProject({ title: 'Sin título' })} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  openMock.mockReset();
  saveMock.mockReset();
  saveAsMock.mockReset();
});

describe('abrir un proyecto guardado', () => {
  it('TEST-PLC-001 las imágenes del proyecto se ven después de abrirlo', async () => {
    // La prueba del defecto: sin construir las direcciones, el módulo de
    // planos decía «falta la imagen de este plano» para un plano cuya imagen
    // estaba en el paquete.
    const user = userEvent.setup();
    const saved = savedProject();
    openMock.mockResolvedValue(ok({ ...saved, path: 'C:\\proyectos\\planta.ivp', warnings: [] }));

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Abrir' }));

    await waitFor(() => expect(screen.getByText('Planta Norte')).toBeInTheDocument());

    // Al módulo de planos, que es donde la imagen se ve como tal.
    await user.keyboard('{Alt>}2{/Alt}');

    // El nombre del plano sale en la lista y en la cabecera del lienzo: lo que
    // se comprueba es la imagen, que es lo que faltaba.
    await waitFor(() => expect(document.querySelector('.plans__image')).not.toBeNull());
    expect(screen.queryByText('Falta la imagen de este plano')).not.toBeInTheDocument();

    const image = document.querySelector('.plans__image');
    expect(image?.getAttribute('src') ?? '').not.toBe('');
  });

  it('TEST-PLC-002 un archivo que falta del paquete se dice, no se finge', async () => {
    const user = userEvent.setup();
    const saved = savedProject();
    openMock.mockResolvedValue(
      ok({ project: saved.project, files: new Map(), path: 'C:\\x.ivp', warnings: [] }),
    );

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await waitFor(() => expect(screen.getByText('Planta Norte')).toBeInTheDocument());

    await user.keyboard('{Alt>}2{/Alt}');
    expect(await screen.findByText('Falta la imagen de este plano')).toBeInTheDocument();
  });

  it('TEST-PLC-003 los avisos de carga se cuentan al usuario', async () => {
    const user = userEvent.setup();
    const saved = savedProject();
    openMock.mockResolvedValue(
      ok({ ...saved, path: 'C:\\x.ivp', warnings: ['una fila de escena no validó'] }),
    );

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Abrir' }));

    expect(await screen.findByText(/se abrió con 1 aviso/)).toBeInTheDocument();
  });
});

describe('guardar una copia (Y03)', () => {
  it('TEST-PLC-004 la copia se ofrece en el menú de archivo', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Más opciones de archivo' }));
    expect(screen.getByRole('menuitem', { name: /Guardar una copia como/ })).toBeInTheDocument();
  });

  it('TEST-PLC-005 después de guardar la copia se trabaja sobre ella', async () => {
    // Seguir sobre el original dejaría los siguientes guardados en el archivo
    // equivocado sin que nada lo indicase.
    const user = userEvent.setup();
    saveAsMock.mockResolvedValue(
      ok({ path: 'C:\\proyectos\\variante.ivp', byteSize: 1_000, backupsKept: 0 }),
    );

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Más opciones de archivo' }));
    await user.click(screen.getByRole('menuitem', { name: /Guardar una copia como/ }));

    // La ruta aparece en el aviso y en la barra de comandos: se comprueba la
    // barra, que es la que dice sobre qué archivo se está trabajando.
    await waitFor(() =>
      expect(document.querySelector('.commandbar__path')?.textContent).toBe(
        'C:\\proyectos\\variante.ivp',
      ),
    );
  });

  it('TEST-PLC-006 si el usuario cancela el diálogo no pasa nada', async () => {
    const user = userEvent.setup();
    saveAsMock.mockResolvedValue(ok(null));

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Más opciones de archivo' }));
    await user.click(screen.getByRole('menuitem', { name: /Guardar una copia como/ }));

    await waitFor(() => expect(saveAsMock).toHaveBeenCalled());
    expect(screen.queryByText('Copia guardada')).not.toBeInTheDocument();
  });
});

describe('previsualizar (Y07)', () => {
  it('TEST-PLC-007 se ofrece previsualizar el recorrido', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: 'Previsualizar' })).toBeInTheDocument();
  });

  it('TEST-PLC-008 sin escenas se dice que no hay nada que ver', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Previsualizar' }));

    expect(await screen.findByText('Todavía no hay nada que previsualizar')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('TEST-PLC-008b F5 previsualiza, y no recarga la aplicación', async () => {
    // En una vista web F5 recargaría y se perdería el trabajo sin guardar.
    const user = userEvent.setup();
    const saved = savedProject();
    openMock.mockResolvedValue(ok({ ...saved, path: 'C:\\x.ivp', warnings: [] }));

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await waitFor(() => expect(screen.getByText('Planta Norte')).toBeInTheDocument());

    await act(async () => {
      await user.keyboard('{F5}');
    });

    expect(await screen.findByRole('dialog')).toHaveAccessibleName(
      'Previsualización del recorrido',
    );
  });

  it('TEST-PLC-009 con escenas se abre el visor de verdad', async () => {
    // Es el mismo componente que ejecuta el visitante: una previsualización
    // escrita aparte no probaría lo que se publica.
    const user = userEvent.setup();
    const saved = savedProject();
    openMock.mockResolvedValue(ok({ ...saved, path: 'C:\\x.ivp', warnings: [] }));

    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await waitFor(() => expect(screen.getByText('Planta Norte')).toBeInTheDocument());

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Previsualizar' }));
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Previsualización del recorrido');
    expect(document.querySelector('.preview__stage')).not.toBeNull();
  });
});
