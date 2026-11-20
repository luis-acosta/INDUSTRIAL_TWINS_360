/**
 * Pruebas de la pantalla de versiones de vídeo (V04).
 *
 * La regla del dominio —qué versión se entrega a qué dispositivo— está probada
 * aparte. Aquí se comprueba lo que sin esta pantalla no existiría: que el autor
 * pueda declarar las versiones. Sin ella, la escalera sólo podría llegar en un
 * proyecto importado, y la función sería una promesa del contrato que nadie
 * puede cumplir desde el editor.
 *
 * Lo que se fija, y es el defecto que esto evita: la altura se toma de la
 * medición del archivo y no se le pregunta al autor. Un número escrito a mano
 * que no coincida con el archivo haría que el visor eligiera mal sin que nada
 * lo delatara, y el fallo sólo se vería en el dispositivo equivocado.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import type { Project } from '@it360/domain';
import { makeMedia, makeProject } from '@it360/domain/testing';

import { PublishModule } from './PublishModule';
import { useProjectStore } from '../state/project-store';

const importMediaFile = vi.hoisted(() => vi.fn());

vi.mock('../platform/media-import', () => ({ importMediaFile }));

const MASTER = makeMedia(70, {
  kind: 'video',
  mime: 'video/mp4',
  relativePath: 'media/arranque.mp4',
  originalName: 'arranque-2160p.mp4',
  width: 3840,
  height: 2160,
  durationS: 92,
});

const SMALL = makeMedia(71, {
  kind: 'video',
  mime: 'video/mp4',
  relativePath: 'media/arranque-720.mp4',
  originalName: 'arranque-720p.mp4',
  width: 1280,
  height: 720,
  durationS: 92,
});

function mount(project: Project): { latest: () => Project } {
  let latest = project;

  function Harness(): JSX.Element {
    const store = useProjectStore(project);
    latest = store.project;
    return <PublishModule store={store} mediaFiles={new Map()} />;
  }

  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  return { latest: () => latest };
}

function videoProject(extra: Partial<Project> = {}): Project {
  const base = makeProject();
  return { ...base, media: [...base.media, MASTER], ...extra };
}

/** Archivo de vídeo de prueba; el importador está sustituido por un doble. */
const file = (): File => new File([new Uint8Array([0, 0, 0, 1])], 'arranque-720p.mp4', {
  type: 'video/mp4',
});

beforeEach(() => {
  importMediaFile.mockReset();
});

describe('versiones de vídeo en la pantalla de publicación', () => {
  it('lista los vídeos del proyecto con su altura', async () => {
    // TEST-PRN-001: el autor necesita ver de qué resolución parte para saber
    // qué versión le hace falta exportar.
    mount(videoProject());

    expect(await screen.findByText('arranque-2160p.mp4')).toBeTruthy();
    expect(screen.getByText('2160p')).toBeTruthy();
  });

  it('no aparece el panel si el proyecto no tiene vídeos', () => {
    // TEST-PRN-002: un panel vacío en una pantalla ya larga sólo estorba, y
    // sugiere que falta algo por hacer cuando no falta nada.
    mount(makeProject());

    expect(screen.queryByText('Versiones de vídeo')).toBeNull();
  });

  it('toma la altura del archivo medido y no la pregunta', async () => {
    // TEST-PRN-003: es la comprobación que importa. Una altura escrita a mano
    // que no coincida con el archivo haría que el visor eligiera mal, y el
    // fallo sólo se vería en el dispositivo equivocado.
    importMediaFile.mockResolvedValue({
      ok: true,
      value: { media: SMALL, reused: false, displayUrl: 'blob:x', bytes: new Uint8Array(), warning: null },
    });

    const { latest } = mount(videoProject());
    const input = screen
      .getByLabelText('Añadir versión de arranque-2160p.mp4') as HTMLInputElement;

    await userEvent.upload(input, file());

    const primary = latest().media.find((m) => m.id === MASTER.id);
    expect(primary?.renditions).toEqual([{ mediaId: SMALL.id, heightPx: 720 }]);
    // El archivo entra también en la biblioteca: si no, el paquete no lo
    // llevaría y el visor pediría algo que no existe.
    expect(latest().media.some((m) => m.id === SMALL.id)).toBe(true);
  });

  it('rechaza un archivo que no se pudo medir', async () => {
    // TEST-PRN-004: sin altura no se puede saber cuándo entregarlo. Guardarlo
    // con altura cero lo convertiría en el escalón más bajo de la escalera y
    // se entregaría a quien ahorra datos: lo contrario de lo que se quería.
    importMediaFile.mockResolvedValue({
      ok: true,
      value: {
        media: { ...SMALL, height: null },
        reused: false,
        displayUrl: 'blob:x',
        bytes: new Uint8Array(),
        warning: null,
      },
    });

    const { latest } = mount(videoProject());
    await userEvent.upload(
      screen.getByLabelText('Añadir versión de arranque-2160p.mp4') as HTMLInputElement,
      file(),
    );

    expect(latest().media.find((m) => m.id === MASTER.id)?.renditions).toEqual([]);
    expect(await screen.findByText(/no se pudo medir/i)).toBeTruthy();
  });

  it('rechaza un archivo que no es vídeo', async () => {
    // TEST-PRN-005: el selector filtra por tipo, pero el tipo declarado por el
    // sistema de archivos no es el contenido. El importador reconoce el
    // contenido y aquí se usa su veredicto.
    importMediaFile.mockResolvedValue({
      ok: true,
      value: {
        media: makeMedia(72, { kind: 'audio', mime: 'audio/mpeg', originalName: 'locucion.mp3' }),
        reused: false,
        displayUrl: 'blob:x',
        bytes: new Uint8Array(),
        warning: null,
      },
    });

    const { latest } = mount(videoProject());
    await userEvent.upload(
      screen.getByLabelText('Añadir versión de arranque-2160p.mp4') as HTMLInputElement,
      file(),
    );

    expect(latest().media.find((m) => m.id === MASTER.id)?.renditions).toEqual([]);
    expect(await screen.findByText(/no es un archivo de vídeo/i)).toBeTruthy();
  });

  it('quitar una versión no borra el archivo de la biblioteca', async () => {
    // TEST-PRN-006: el archivo puede estar en uso en otro sitio, y borrarlo
    // por quitarlo de esta escalera destruiría trabajo ajeno a esta pantalla.
    // Si no se usa en ninguna parte, el plan de publicación ya lo deja fuera
    // del paquete por su cuenta.
    const { latest } = mount(
      videoProject({
        media: [
          ...makeProject().media,
          { ...MASTER, renditions: [{ mediaId: SMALL.id, heightPx: 720 }] },
          SMALL,
        ],
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Quitar' }));

    expect(latest().media.find((m) => m.id === MASTER.id)?.renditions).toEqual([]);
    expect(latest().media.some((m) => m.id === SMALL.id)).toBe(true);
  });

  it('dice que la aplicación no reescala vídeo', async () => {
    // TEST-PRN-007: es la diferencia que importa a quien prepara el material.
    // Dejarlo sin decir haría esperar un reescalado que no va a ocurrir.
    mount(videoProject());

    expect(await screen.findByText(/no reescala vídeo/i)).toBeTruthy();
  });
});
