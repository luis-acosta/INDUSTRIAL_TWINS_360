/**
 * Pruebas de la entrada en VR desde el recorrido publicado (N01).
 *
 * El principio de la etapa 13 es «nunca ofrecer un botón de VR que no
 * funcione». Eso no se puede comprobar con unas gafas en el contenedor de
 * integración, pero sí se puede comprobar lo que lo garantiza: que el botón
 * aparece exactamente cuando `navigator.xr` dice que hay un dispositivo capaz,
 * que no aparece en un navegador de escritorio corriente, y que un fallo al
 * entrar se le cuenta al visitante en lugar de dejar el botón mudo.
 *
 * `PanoramaViewer` se sustituye por un doble, igual que en las demás pruebas
 * de este paquete: en jsdom no hay contexto WebGL.
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { toManifest, type Manifest } from '@it360/domain';
import { ISO_NOW, makeProject, makeScene, testUuid } from '@it360/domain/testing';

import { EMPTY_SKIN_STATE } from '@it360/viewer';

import { TourViewer } from './TourViewer';
import { useVrSession } from './useVrSession';
import type { LoadedTour } from './manifest';

vi.mock('@it360/viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@it360/viewer')>();
  return {
    ...actual,
    /**
     * Doble del visor panorámico que sí entrega un renderizador.
     *
     * Entregarlo importa: la sesión inmersiva necesita el contexto WebGL de la
     * escena, y un doble que no lo diera haría que el botón de VR no llegara
     * nunca a pedir la sesión, de modo que la prueba del permiso denegado
     * pasaría sin ejercitar nada.
     */
    PanoramaViewer: ({
      scene,
      onRenderer,
    }: {
      scene: { title: string } | null;
      onRenderer?: (renderer: unknown) => void;
    }) => {
      useEffect(() => {
        onRenderer?.({
          xrBridge: {
            enabled: false,
            setReferenceSpaceType: () => undefined,
            setSession: async () => undefined,
            setAnimationLoop: () => undefined,
          },
          attachXrObjects: () => undefined,
          detachXrObjects: () => undefined,
          setSceneryYaw: () => undefined,
          renderXr: () => undefined,
        });
        return () => onRenderer?.(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="panorama">{scene?.title ?? ''}</div>;
    },
  };
});

const PROJECT = testUuid(1);

function loaded(): LoadedTour {
  const base = makeProject();
  const scene = makeScene(10, PROJECT, { title: 'Sala de bombas' });
  const manifest: Manifest = toManifest(
    { ...base, scenes: [scene] },
    { publishedAt: ISO_NOW, appVersion: '0.38.0', offlineCapable: true },
  );
  return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
}

/** Instala un `navigator.xr` de prueba y devuelve la función para quitarlo. */
function installXr(options: {
  readonly supported: boolean;
  readonly onRequest?: () => Promise<never>;
}): void {
  Object.defineProperty(globalThis.navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (mode: string) => mode === 'immersive-vr' && options.supported,
      requestSession:
        options.onRequest ??
        (async () => {
          throw new Error('no se pide en esta prueba');
        }),
    },
  });
}

function renderTour(): void {
  render(
    <ToastProvider>
      <TourViewer tour={loaded()} />
    </ToastProvider>,
  );
}

afterEach(() => {
  if ('xr' in globalThis.navigator) {
    Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, 'xr');
  }
  vi.restoreAllMocks();
});

/**
 * Monta sólo el gancho, sin escena.
 *
 * Es la forma de ejercitar el caso «todavía no hay contexto gráfico» sin
 * falsear el visor: aquí el renderizador es `null` de verdad.
 */
function HookHarness(): JSX.Element {
  const vr = useVrSession({
    renderer: null,
    panels: [],
    skinState: EMPTY_SKIN_STATE,
    sceneId: null,
    onActivate: () => undefined,
  });
  return (
    <div>
      <button type="button" onClick={() => vr.enter()}>
        Entrar en VR
      </button>
      <span data-testid="motivo">{vr.status.error?.message ?? ''}</span>
    </div>
  );
}

describe('entrada en VR', () => {
  it('avisa si se pulsa antes de que la escena esté lista', async () => {
    // TEST-VRE-006: la sesión inmersiva necesita el contexto gráfico de la
    // escena. Antes de que exista, el botón no puede abrirla; lo que no puede
    // es quedarse mudo, porque el visitante tiene unas gafas en la mano y no
    // sabría si el fallo es del recorrido o suyo.
    installXr({ supported: true });
    render(<HookHarness />);

    await userEvent.click(screen.getByRole('button', { name: 'Entrar en VR' }));

    expect(screen.getByTestId('motivo').textContent).toContain('todavía no está lista');
  });

  it('no ofrece el botón en un navegador sin WebXR', async () => {
    // TEST-VRE-001: es el caso de la mayoría de los visitantes. Un botón que
    // lleva a una pantalla negra no se vuelve a pulsar nunca, y además hace
    // dudar de todo el recorrido.
    renderTour();

    await waitFor(() => expect(screen.getByTestId('panorama')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Entrar en VR' })).toBeNull();
  });

  it('no ofrece el botón si la API existe pero no hay visor', async () => {
    // TEST-VRE-002: Chrome de escritorio publica `navigator.xr` sin que haya
    // ningún dispositivo. Mirar sólo si la API existe ofrecería el botón a
    // todo el mundo, que es el error más fácil de cometer aquí.
    installXr({ supported: false });
    renderTour();

    await waitFor(() => expect(screen.getByTestId('panorama')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Entrar en VR' })).toBeNull();
  });

  it('ofrece el botón cuando hay un visor capaz', async () => {
    // TEST-VRE-003: y sólo entonces.
    installXr({ supported: true });
    renderTour();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Entrar en VR' })).toBeTruthy(),
    );
  });

  it('cuenta el motivo cuando no se puede entrar', async () => {
    // TEST-VRE-004: el visitante acaba de pulsar un botón y tiene unas gafas
    // puestas o en la mano. Si el botón no hace nada visible, no sabe si el
    // fallo es del recorrido, del navegador o suyo.
    installXr({
      supported: true,
      onRequest: async () => {
        const error = new Error('denegado');
        error.name = 'NotAllowedError';
        throw error;
      },
    });
    renderTour();

    const button = await screen.findByRole('button', { name: 'Entrar en VR' });
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByText(/permiso/i)).toBeTruthy());
  });

  it('el recorrido plano sigue utilizable con el visor disponible', async () => {
    // TEST-VRE-005: entrar en VR es opcional. La escena, su título y los
    // controles tienen que seguir funcionando igual en la pantalla.
    installXr({ supported: true });
    renderTour();

    await waitFor(() => expect(screen.getByTestId('panorama').textContent).toBe('Sala de bombas'));
    expect(screen.getByRole('button', { name: 'Notas de campo' })).toBeTruthy();
  });
});
