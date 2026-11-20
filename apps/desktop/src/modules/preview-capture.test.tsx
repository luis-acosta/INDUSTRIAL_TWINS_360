/**
 * Pruebas de la grabación desde la previsualización (S07).
 *
 * La mecánica del grabador está probada en `@it360/viewer` con dobles fieles
 * al navegador. Lo que sólo puede fallar aquí es la conexión: que no se ofrezca
 * grabar donde el navegador no puede, que se grabe **el lienzo que hay** y no
 * uno recordado de antes, y que se diga qué queda fuera del vídeo antes de
 * grabar y no después, que es cuando ya no sirve de nada.
 *
 * El visor se sustituye por un doble que monta un lienzo: en jsdom no hay
 * contexto WebGL y el visor real no llegaría a montar ninguno.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { makeFullProject } from '@it360/domain/testing';

import { PreviewDialog } from './PreviewDialog';

const saveBinaryFile = vi.hoisted(() => vi.fn(async () => true));
const startCapture = vi.hoisted(() => vi.fn());

vi.mock('../platform/save-file', () => ({ saveBinaryFile }));

vi.mock('@it360/viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@it360/viewer')>();
  return { ...actual, startCapture };
});

vi.mock('@it360/tour', () => ({
  TourViewer: () => (
    <div data-testid="visor">
      <canvas width={1280} height={720} />
    </div>
  ),
}));

/** `MediaRecorder` mínimo para que la consulta de capacidades diga que sí. */
class FakeRecorder {
  static isTypeSupported(type: string): boolean {
    return type === 'video/webm;codecs=vp9';
  }
}

function mount(): void {
  const project = makeFullProject();
  render(
    <ToastProvider>
      <PreviewDialog
        project={project}
        mediaUrls={new Map()}
        sceneId={project.scenes[0]?.id ?? null}
        view={null}
        appVersion="0.53.0"
        onClose={() => undefined}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  saveBinaryFile.mockClear();
  startCapture.mockReset();
  startCapture.mockReturnValue({
    elapsedMs: () => 2_000,
    /* El `Blob` de jsdom no trae `arrayBuffer`, que sí tienen todos los
       navegadores donde corre el producto; el doble lo añade para no tener que
       rodear en el código una ausencia que sólo existe en las pruebas. */
    stop: async () => ({
      size: 3,
      type: 'video/webm',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grabar el recorrido desde la previsualización', () => {
  it('graba el lienzo que hay montado', async () => {
    // TEST-PRC-001: el visor monta y desmonta el lienzo al pasar de una escena
    // panorámica a una de modelo. Grabar uno recordado de antes daría un vídeo
    // en negro, y eso sólo se descubre al abrir el archivo.
    mount();

    await userEvent.click(screen.getByRole('button', { name: 'Grabar vídeo' }));

    const canvas = screen.getByTestId('visor').querySelector('canvas');
    expect(startCapture).toHaveBeenCalledWith(canvas);
  });

  it('dice qué queda fuera del vídeo mientras graba', async () => {
    // TEST-PRC-002: se graba el lienzo, así que los paneles de la interfaz
    // —que son HTML encima— y el audio de las narraciones no entran. Quien
    // esperase un vídeo de la pantalla completa recibiría otra cosa, y
    // enterarse al abrir el archivo es enterarse tarde.
    mount();

    await userEvent.click(screen.getByRole('button', { name: 'Grabar vídeo' }));

    expect(screen.getByText(/no entran en el vídeo/i)).toBeTruthy();
  });

  it('al detener guarda el archivo con el nombre del proyecto', async () => {
    // TEST-PRC-003
    mount();

    await userEvent.click(screen.getByRole('button', { name: 'Grabar vídeo' }));
    await userEvent.click(screen.getByRole('button', { name: /Detener y guardar/ }));

    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    const [name, bytes] = saveBinaryFile.mock.calls[0] as unknown as [string, Uint8Array];
    expect(name).toMatch(/\.webm$/);
    expect(bytes.byteLength).toBe(3);
  });

  it('una grabación vacía se denuncia en lugar de guardarse', async () => {
    // TEST-PRC-004: un archivo de cero bytes con nombre de vídeo es la peor
    // salida posible: parece que funcionó hasta que alguien intenta abrirlo,
    // normalmente delante de la gente a la que iba dirigido.
    startCapture.mockReturnValue({
      elapsedMs: () => 1_000,
      stop: async () => ({ size: 0, type: 'video/webm', arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    mount();

    await userEvent.click(screen.getByRole('button', { name: 'Grabar vídeo' }));
    await userEvent.click(screen.getByRole('button', { name: /Detener y guardar/ }));

    expect(saveBinaryFile).not.toHaveBeenCalled();
    expect(await screen.findByText(/salió vacía/i)).toBeTruthy();
  });

  it('sin MediaRecorder el botón queda deshabilitado, no ausente', async () => {
    // TEST-PRC-005: deshabilitado con el motivo al pasar el ratón dice que la
    // función existe y por qué no se puede aquí. Ausente haría buscarla.
    vi.stubGlobal('MediaRecorder', undefined);
    mount();

    expect(screen.getByRole('button', { name: 'Grabar vídeo' })).toBeDisabled();
    expect(startCapture).not.toHaveBeenCalled();
  });
});
