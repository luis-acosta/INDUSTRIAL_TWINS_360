/**
 * Pruebas del importador de audio y vídeo del editor.
 *
 * Lo que se verifica es la parte que sólo puede fallar en el entorno: que la
 * medida de la duración tenga plazo —un archivo con la cabecera dañada deja al
 * reproductor sin disparar nada y el importador se quedaría colgado—, que un
 * infinito no acabe en el proyecto, y que un archivo que el reproductor de
 * este equipo no entiende se importe con aviso en lugar de rechazarse: puede
 * ser el único original que tiene el autor.
 *
 * jsdom no reproduce nada, de modo que los elementos de medios se sustituyen
 * por dobles que disparan los eventos que el navegador dispararía. Eso es
 * exactamente lo que hay que probar aquí: la reacción a cada caso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEASURE_TIMEOUT_MS, importMediaFile, measureMedia } from './media-import';

/** Cabecera de MP3 con etiqueta ID3, rellenada a 64 bytes. */
function mp3Bytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);
  return bytes;
}

/** Cabecera de MP4 (ISO-BMFF, marca «isom»). */
function mp4Bytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
  bytes.set(header, 0);
  return bytes;
}

function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as File;
}

/**
 * Elemento de medios de prueba.
 *
 * `behaviour` decide qué hace al recibir la fuente, que es lo que distingue
 * los casos: informar, fallar o quedarse callado.
 */
interface FakeMediaOptions {
  readonly behaviour: 'metadata' | 'error' | 'silent';
  readonly duration?: number;
  readonly width?: number;
  readonly height?: number;
}

function installFakeMedia(options: FakeMediaOptions): { readonly created: string[] } {
  const created: string[] = [];
  const original = document.createElement.bind(document);

  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'audio' && tag !== 'video') return original(tag as 'div');
    created.push(tag);

    const listeners = new Map<string, (() => void)[]>();
    const element = {
      preload: '',
      muted: false,
      duration: options.duration ?? 0,
      videoWidth: options.width ?? 0,
      videoHeight: options.height ?? 0,
      addEventListener(name: string, listener: () => void) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
      },
      removeAttribute() {},
      load() {},
      set src(_value: string) {
        if (options.behaviour === 'silent') return;
        const name = options.behaviour === 'metadata' ? 'loadedmetadata' : 'error';
        // Asíncrono, como lo haría el navegador: si fuera sincrónico, el
        // oyente todavía no estaría instalado.
        setTimeout(() => {
          for (const listener of listeners.get(name) ?? []) listener();
        }, 0);
      },
    };
    return element as unknown as HTMLElement;
  }) as typeof document.createElement);

  return { created };
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:prueba' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('measureMedia', () => {
  it('devuelve la duración que informa el reproductor', async () => {
    // TEST-MDI-001: es el dato que permite a una parada esperar a que acabe
    // la narración.
    installFakeMedia({ behaviour: 'metadata', duration: 12.75 });
    await expect(measureMedia('blob:x', 'audio')).resolves.toMatchObject({ durationS: 12.75 });
  });

  it('devuelve las dimensiones de un vídeo', async () => {
    // TEST-MDI-002: sin ellas el visor no puede encuadrarlo y se vería
    // estirado.
    installFakeMedia({ behaviour: 'metadata', duration: 5, width: 1920, height: 1080 });
    await expect(measureMedia('blob:x', 'video')).resolves.toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it('no guarda dimensiones al medir un audio', async () => {
    // TEST-MDI-003: un elemento de audio puede traer valores residuales en
    // esos campos, y guardarlos haría que algo intentara encuadrar un audio.
    installFakeMedia({ behaviour: 'metadata', duration: 5, width: 300, height: 150 });
    await expect(measureMedia('blob:x', 'audio')).resolves.toMatchObject({
      width: null,
      height: null,
    });
  });

  it('trata una duración infinita como no medida', async () => {
    // TEST-MDI-004: es lo que devuelven los flujos sin duración declarada —un
    // MP3 grabado por tramos—. Un infinito en el proyecto rompe cualquier
    // cálculo que lo use.
    installFakeMedia({ behaviour: 'metadata', duration: Number.POSITIVE_INFINITY });
    await expect(measureMedia('blob:x', 'audio')).resolves.toMatchObject({ durationS: null });
  });

  it('trata una duración cero como no medida', async () => {
    // TEST-MDI-005: cero significa «no lo sé» en la práctica, y guardarlo
    // haría que una parada que espera al audio avanzara de inmediato.
    installFakeMedia({ behaviour: 'metadata', duration: 0 });
    await expect(measureMedia('blob:x', 'audio')).resolves.toMatchObject({ durationS: null });
  });

  it('resuelve cuando el reproductor falla', async () => {
    // TEST-MDI-006: un códec que falta en este equipo no debe dejar colgado
    // el importador.
    installFakeMedia({ behaviour: 'error' });
    await expect(measureMedia('blob:x', 'audio')).resolves.toMatchObject({ durationS: null });
  });

  it('resuelve por plazo cuando el reproductor no dice nada', async () => {
    // TEST-MDI-007: un archivo con la cabecera dañada deja al elemento sin
    // disparar «loadedmetadata» ni «error». Sin plazo, el importador se queda
    // colgado y el autor no sabe si sigue trabajando.
    vi.useFakeTimers();
    installFakeMedia({ behaviour: 'silent' });

    const pending = measureMedia('blob:x', 'audio');
    vi.advanceTimersByTime(MEASURE_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ durationS: null });
  });
});

describe('importMediaFile', () => {
  it('importa un audio con su duración', async () => {
    // TEST-MDI-008
    installFakeMedia({ behaviour: 'metadata', duration: 30 });
    const result = await importMediaFile(fileOf(mp3Bytes(), 'narracion.mp3', 'audio/mpeg'), []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.media.kind).toBe('audio');
      expect(result.value.media.durationS).toBe(30);
      expect(result.value.warning).toBeNull();
    }
  });

  it('importa un vídeo con dimensiones y duración', async () => {
    // TEST-MDI-009
    installFakeMedia({ behaviour: 'metadata', duration: 8, width: 1280, height: 720 });
    const result = await importMediaFile(fileOf(mp4Bytes(), 'linea.mp4', 'video/mp4'), []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.media.kind).toBe('video');
      expect(result.value.media.width).toBe(1280);
      expect(result.value.media.durationS).toBe(8);
    }
  });

  it('importa con aviso cuando no se pudo medir la duración', async () => {
    // TEST-MDI-010: negarse sería peor —puede ser el único original que tiene
    // el autor, y el códec puede faltar aquí y estar en el equipo del
    // visitante—, pero callarlo también: una parada que espera al audio no
    // sabría cuánto esperar.
    installFakeMedia({ behaviour: 'error' });
    const result = await importMediaFile(fileOf(mp3Bytes(), 'nota.mp3', 'audio/mpeg'), []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.media.durationS).toBeNull();
      expect(result.value.warning).toContain('duración');
    }
  });

  it('rechaza un contenido que no es audio ni vídeo sin llegar a medir', async () => {
    // TEST-MDI-011: el orden importa. Al revés, arrastrar una carpeta con
    // veinte archivos equivocados haría esperar veinte plazos.
    const fake = installFakeMedia({ behaviour: 'silent' });
    const png = new Uint8Array(512);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    const result = await importMediaFile(fileOf(png, 'foto.png', 'image/png'), []);

    expect(result.ok).toBe(false);
    expect(fake.created).toEqual([]);
  });

  it('rechaza un archivo renombrado', async () => {
    // TEST-MDI-012: la extensión dice mp4 y dentro no hay un mp4. Es el caso
    // que justifica mirar el contenido, y el contrato del proyecto lo exige.
    installFakeMedia({ behaviour: 'silent' });
    const result = await importMediaFile(
      fileOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'linea.mp4', 'video/mp4'),
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('no vuelve a medir un medio que ya estaba', async () => {
    // TEST-MDI-013: ya tiene sus metadatos; medirlo otra vez sólo gasta el
    // plazo, y al importar una carpeta repetida eso son minutos.
    installFakeMedia({ behaviour: 'metadata', duration: 30 });
    const first = await importMediaFile(fileOf(mp3Bytes(), 'narracion.mp3', 'audio/mpeg'), []);
    if (!first.ok) throw new Error('la primera importación debía salir bien');

    vi.restoreAllMocks();
    const fake = installFakeMedia({ behaviour: 'silent' });
    const second = await importMediaFile(fileOf(mp3Bytes(), 'narracion.mp3', 'audio/mpeg'), [
      first.value.media,
    ]);

    expect(second.ok && second.value.reused).toBe(true);
    expect(fake.created).toEqual([]);
  });

  it('informa de un archivo que no se pudo leer', async () => {
    // TEST-MDI-014: ocurre con un archivo en una unidad que se desconecta a
    // mitad, y el mensaje tiene que decir qué hacer.
    installFakeMedia({ behaviour: 'silent' });
    const broken = {
      name: 'nota.mp3',
      type: 'audio/mpeg',
      size: 10,
      arrayBuffer: async () => {
        throw new Error('dispositivo desconectado');
      },
    } as unknown as File;

    const result = await importMediaFile(broken, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.recovery).toContain('vuelva a elegirlo');
  });
});
