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
import { ISO_NOW, makeMedia, makeProject, makeScene, testUuid } from '@it360/domain/testing';

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
      scene: { title: string; textureUrl: string | null } | null;
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
      return (
        <div data-testid="panorama" data-texture={scene?.textureUrl ?? ''}>
          {scene?.title ?? ''}
        </div>
      );
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

/**
 * Recorrido con una panorámica reducida para visor autónomo (N12).
 *
 * El medio y la escena se montan a mano porque lo que se comprueba es el
 * cruce entre el mapa del manifiesto y la ruta que el visor pide.
 */
function loadedWithVrPanorama(): LoadedTour {
  const base = makeProject();
  const media = makeMedia(80, { relativePath: 'media/escena-80.jpg' });
  const scene = makeScene(10, PROJECT, { title: 'Sala de bombas', mediaId: media.id });
  const manifest: Manifest = toManifest(
    { ...base, media: [media], scenes: [scene] },
    {
      publishedAt: ISO_NOW,
      appVersion: '0.48.0',
      offlineCapable: true,
      vrPanoramas: { [media.id]: { standalone: 'media/vr/standalone/escena-80.jpg' } },
    },
  );
  return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
}

/** Sesión inmersiva de prueba, fiel a lo que usa `XrSessionController`. */
function fakeSession(): XRSession & { fireEnd: () => void } {
  const listeners: (() => void)[] = [];
  const session = {
    addEventListener(type: string, listener: () => void) {
      if (type === 'end') listeners.push(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type !== 'end') return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    async requestReferenceSpace() {
      return {} as XRReferenceSpace;
    },
    async end() {
      for (const listener of [...listeners]) listener();
    },
    fireEnd() {
      for (const listener of [...listeners]) listener();
    },
  };
  return session as unknown as XRSession & { fireEnd: () => void };
}

/** Instala un `navigator.xr` de prueba y devuelve la función para quitarlo. */
function installXr(options: {
  readonly supported: boolean;
  readonly onRequest?: () => Promise<XRSession>;
  readonly session?: XRSession;
}): void {
  Object.defineProperty(globalThis.navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (mode: string) => mode === 'immersive-vr' && options.supported,
      requestSession:
        options.onRequest ??
        (options.session === undefined
          ? async () => {
              throw new Error('no se pide en esta prueba');
            }
          : async () => options.session),
    },
  });
}

function renderTour(tour: LoadedTour = loaded()): void {
  render(
    <ToastProvider>
      <TourViewer tour={tour} />
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

describe('panorámica reducida en la sesión inmersiva (N12)', () => {
  /* El reparto está probado en el dominio y en el exportador; lo que sólo se
     puede comprobar aquí es el cruce: que la copia reducida se use **mientras
     se presenta** y no antes, porque en la pantalla plana se quiere la imagen
     completa, y que un paquete sin copia cargue la ruta plana en lugar de
     pedir un archivo que no existe. */

  function userAgent(value: string): void {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      configurable: true,
      value,
    });
  }

  it('en la pantalla plana se carga la panorámica completa', async () => {
    // TEST-VRE-007: con el visor disponible pero sin sesión, nada cambia.
    installXr({ supported: true });
    renderTour(loadedWithVrPanorama());

    await waitFor(() =>
      expect(screen.getByTestId('panorama').getAttribute('data-texture')).toBe(
        'https://ejemplo.invalid/recorrido/media/escena-80.jpg',
      ),
    );
  });

  it('al presentar se carga la copia del perfil del dispositivo', async () => {
    // TEST-VRE-008: es la comprobación que hace real la función. Sin ella, el
    // paquete llevaría las copias reducidas y el visor seguiría pidiendo las
    // completas: peso de más y ninguna mejora.
    userAgent('Mozilla/5.0 (Linux; Android 12; Quest 3) OculusBrowser/33.0');
    installXr({ supported: true, session: fakeSession() });
    renderTour(loadedWithVrPanorama());

    await userEvent.click(await screen.findByRole('button', { name: 'Entrar en VR' }));

    await waitFor(() =>
      expect(screen.getByTestId('panorama').getAttribute('data-texture')).toBe(
        'https://ejemplo.invalid/recorrido/media/vr/standalone/escena-80.jpg',
      ),
    );
  });

  it('sin copia para ese perfil se carga la completa', async () => {
    // TEST-VRE-009: el manifiesto sólo declara las copias escritas, así que
    // un perfil sin entrada tiene que caer en la ruta plana. Pedir una ruta
    // construida a mano dejaría la escena en negro dentro de las gafas.
    userAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131');
    installXr({ supported: true, session: fakeSession() });
    renderTour(loadedWithVrPanorama());

    await userEvent.click(await screen.findByRole('button', { name: 'Entrar en VR' }));

    // Que la sesión está presentando de verdad se comprueba aparte: sin esto,
    // la prueba pasaría también si no se hubiera entrado nunca, y entonces no
    // estaría comprobando la elección de perfil sino el caso plano otra vez.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salir de VR' })).toBeTruthy());
    expect(screen.getByTestId('panorama').getAttribute('data-texture')).toBe(
      'https://ejemplo.invalid/recorrido/media/escena-80.jpg',
    );
  });
});
