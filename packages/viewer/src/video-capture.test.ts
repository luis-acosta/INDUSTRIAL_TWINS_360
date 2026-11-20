/**
 * Pruebas de la grabación del recorrido en vídeo (S07).
 *
 * jsdom no tiene `MediaRecorder` ni `captureStream`, así que los dos se
 * sustituyen por dobles fieles a lo que hace el navegador: entregan trozos
 * mientras graban, uno de ellos vacío al parar —cosa que algunos navegadores
 * hacen de verdad— y avisan del fin con `onstop`.
 *
 * Lo que se comprueba es lo que falla de verdad en esta clase de función: que
 * no se ofrezca grabar donde no se puede, que el archivo no lleve un bloque
 * vacío que algunos reproductores rechazan, que las pistas del lienzo se paren
 * —si no, el lienzo sigue produciendo fotogramas para un flujo que nadie lee—,
 * y que la tasa de bits no se quede en la del navegador, que apunta a
 * videollamada y deshace los rótulos de los equipos en bloques.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CAPTURE_FPS,
  MAX_BITRATE,
  MIN_BITRATE,
  bitrateFor,
  captureFileName,
  captureSupport,
  extensionForCapture,
  startCapture,
} from './video-capture';

/** Doble de `MediaRecorder` fiel a la secuencia del navegador. */
class FakeRecorder {
  static supported: readonly string[] = ['video/webm;codecs=vp9', 'video/webm'];
  static isTypeSupported(type: string): boolean {
    return FakeRecorder.supported.includes(type);
  }

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;

  constructor(
    readonly stream: { getTracks(): { stop(): void }[] },
    readonly options: { mimeType: string; bitsPerSecond: number },
  ) {
    FakeRecorder.last = this;
  }

  static last: FakeRecorder | null = null;

  start(): void {
    this.state = 'recording';
    this.ondataavailable?.({ data: new Blob(['abc']) });
  }

  stop(): void {
    this.state = 'inactive';
    // Algunos navegadores entregan un último trozo vacío antes de `onstop`.
    this.ondataavailable?.({ data: new Blob([]) });
    this.onstop?.(new Event('stop'));
  }
}

function fakeCanvas(width = 1920, height = 1080): {
  canvas: HTMLCanvasElement;
  stopped: () => number;
} {
  let stopped = 0;
  const tracks = [{ stop: () => (stopped += 1) }, { stop: () => (stopped += 1) }];
  const canvas = {
    width,
    height,
    captureStream: () => ({ getTracks: () => tracks }),
  } as unknown as HTMLCanvasElement;

  return { canvas, stopped: () => stopped };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecorder.supported = ['video/webm;codecs=vp9', 'video/webm'];
});

describe('captureSupport', () => {
  it('elige el formato que mejor comprime de los admitidos', () => {
    // TEST-CAP-001: VP9 primero; en una panorámica con paneo, la diferencia
    // frente a VP8 es la mitad del archivo a igual calidad.
    expect(captureSupport(FakeRecorder as unknown as typeof MediaRecorder).mimeType).toBe(
      'video/webm;codecs=vp9',
    );
  });

  it('baja al que haya cuando el mejor no está', () => {
    // TEST-CAP-002
    FakeRecorder.supported = ['video/mp4'];

    expect(captureSupport(FakeRecorder as unknown as typeof MediaRecorder).mimeType).toBe(
      'video/mp4',
    );
  });

  it('sin MediaRecorder no se puede grabar, y lo dice', () => {
    // TEST-CAP-003: se consulta antes de ofrecer el botón. Uno que falla al
    // pulsarlo, después de que el autor haya preparado la escena, desperdicia
    // su trabajo y no explica por qué.
    const support = captureSupport(undefined);

    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/no puede grabar/i);
  });

  it('sin ningún formato admitido tampoco, con otro motivo', () => {
    // TEST-CAP-004: los dos casos se distinguen porque el autor puede hacer
    // algo distinto en cada uno —cambiar de navegador, o actualizarlo—.
    FakeRecorder.supported = [];
    const support = captureSupport(FakeRecorder as unknown as typeof MediaRecorder);

    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/formatos/i);
  });

  it('un `isTypeSupported` que lanza no tumba la consulta', () => {
    // TEST-CAP-005: alguna implementación lanza con un tipo que no conoce en
    // lugar de devolver `false`. Sin esto, el botón desaparecería por un
    // detalle del navegador y no por falta de capacidad.
    const throwing = {
      isTypeSupported: (type: string) => {
        if (type.includes('vp9')) throw new TypeError('tipo desconocido');
        return type === 'video/webm';
      },
    };

    expect(
      captureSupport(throwing as unknown as typeof MediaRecorder).mimeType,
    ).toBe('video/webm');
  });
});

describe('bitrateFor', () => {
  it('escala con los píxeles y los fotogramas', () => {
    // TEST-CAP-006: la tasa por omisión del navegador apunta a videollamada;
    // en un paneo de panorámica, los rótulos de los equipos se deshacen en
    // bloques, que es justo lo que alguien va a mirar en el vídeo.
    const hd = bitrateFor(1280, 720, DEFAULT_CAPTURE_FPS);
    const fullHd = bitrateFor(1920, 1080, DEFAULT_CAPTURE_FPS);

    expect(fullHd).toBeGreaterThan(hd);
  });

  it('se acota por los dos lados', () => {
    // TEST-CAP-007: pedir demasiado en un portátil hace que el codificador
    // pierda fotogramas y el paneo salga a tirones, que es peor que un poco de
    // compresión. Y una ventana diminuta no justifica un vídeo ilegible.
    expect(bitrateFor(64, 64, 30)).toBe(MIN_BITRATE);
    expect(bitrateFor(7680, 4320, 60)).toBe(MAX_BITRATE);
  });
});

describe('startCapture', () => {
  it('entrega un archivo con lo grabado y sin el trozo vacío', () => {
    // TEST-CAP-008: el bloque de cero bytes que algunos navegadores entregan
    // al parar hace que ciertos reproductores rechacen el archivo entero.
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const { canvas } = fakeCanvas();

    const handle = startCapture(canvas);
    return handle.stop().then((blob) => {
      expect(blob.size).toBe(3);
      expect(blob.type).toBe('video/webm;codecs=vp9');
    });
  });

  it('para las pistas del lienzo al terminar', async () => {
    // TEST-CAP-009: sin esto, el lienzo sigue produciendo fotogramas para un
    // flujo que ya nadie lee; en un portátil se oye el ventilador y la batería
    // se va sin que nada en pantalla lo explique.
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const { canvas, stopped } = fakeCanvas();

    await startCapture(canvas).stop();

    expect(stopped()).toBe(2);
  });

  it('pide la tasa calculada y no la del navegador', async () => {
    // TEST-CAP-010
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const { canvas } = fakeCanvas(1920, 1080);

    await startCapture(canvas).stop();

    expect(FakeRecorder.last?.options.bitsPerSecond).toBe(
      bitrateFor(1920, 1080, DEFAULT_CAPTURE_FPS),
    );
  });

  it('cuenta el tiempo grabado', async () => {
    // TEST-CAP-011: la interfaz lo muestra mientras graba. Sin un contador,
    // una grabación larga parece colgada.
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    let clock = 1_000;
    const handle = startCapture(fakeCanvas().canvas, {}, () => clock);

    clock = 4_500;

    expect(handle.elapsedMs()).toBe(3_500);
    await handle.stop();
  });

  it('parar dos veces no deja la promesa colgada', async () => {
    // TEST-CAP-012: el botón se puede pulsar dos veces, y una promesa que no
    // resuelve deja la interfaz en «guardando…» para siempre.
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const handle = startCapture(fakeCanvas().canvas);

    await handle.stop();
    await expect(handle.stop()).resolves.toBeInstanceOf(Blob);
  });
});

describe('nombre del archivo', () => {
  it('lleva el nombre del recorrido y la fecha', () => {
    // TEST-CAP-013: quien exporta tres veces en una tarde necesita
    // distinguirlos sin abrirlos.
    const name = captureFileName(
      'Visita de seguridad',
      'video/webm',
      new Date('2026-11-20T09:30:00Z'),
    );

    expect(name).toBe('Visita-de-seguridad-2026-11-20-0930.webm');
  });

  it('sanea lo que no vale en un nombre de archivo', () => {
    // TEST-CAP-014: el nombre lo escribe el autor y puede llevar barras, dos
    // puntos o acentos, que en Windows no valen o se guardan mal.
    const name = captureFileName('Inducción / contratas: 2026', 'video/mp4', new Date(0));

    expect(name.startsWith('Induccion-contratas-2026')).toBe(true);
    expect(name.endsWith('.mp4')).toBe(true);
  });

  it('un nombre vacío no produce un archivo sin nombre', () => {
    // TEST-CAP-015: «.webm» a secas es un archivo oculto en Linux y macOS, y
    // el autor no lo encontraría en su carpeta.
    expect(captureFileName('···', 'video/webm', new Date(0)).startsWith('recorrido-')).toBe(true);
  });

  it('la extensión sigue al formato grabado', () => {
    // TEST-CAP-016: un WebM con extensión .mp4 no lo abre el reproductor de
    // Windows, y el autor creería que el archivo está dañado.
    expect(extensionForCapture('video/webm;codecs=vp9')).toBe('.webm');
    expect(extensionForCapture('video/mp4')).toBe('.mp4');
  });
});
