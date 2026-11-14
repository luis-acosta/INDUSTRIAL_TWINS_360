/**
 * Pruebas de carga del recorrido publicado.
 *
 * El visor se ejecuta en el equipo de un cliente, a veces sin nadie a quien
 * preguntar. Lo que se comprueba aquí es que cada forma de fallar produzca un
 * mensaje que diga qué pasó y qué hacer, en lugar de una pantalla en blanco:
 * manifiesto ausente, JSON roto, campos que no validan, y versión del formato
 * más nueva que el visor.
 */
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, toManifest, type Manifest } from '@it360/domain';
import { makeFullProject } from '@it360/domain/testing';
import { loadTour, mediaUrl, mediaUrlIndex, MANIFEST_PATH } from './manifest';

const LOCATION = { href: 'https://intranet.cliente/recorridos/u200/index.html' };
const BASE = 'https://intranet.cliente/recorridos/u200/';

function validManifest(): Manifest {
  return toManifest(makeFullProject(), {
    publishedAt: '2026-03-01T10:00:00.000Z',
    appVersion: '0.14.0',
    offlineCapable: false,
  });
}

/** `fetch` de prueba que devuelve lo que se le indique. */
function fetchStub(body: unknown, init: { status?: number; invalidJson?: boolean } = {}): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      json: async () => {
        if (init.invalidJson === true) throw new SyntaxError('JSON inesperado');
        return body;
      },
    }) as unknown as Response,
  ) as unknown as typeof fetch;
}

describe('loadTour', () => {
  // TEST-VW-001
  it('carga el manifiesto junto al documento, no desde la raíz del dominio', async () => {
    // Un recorrido publicado en una subcarpeta de la intranet es el caso
    // habitual; pedir «/manifiesto.json» fallaría en todos ellos.
    const fetchImpl = fetchStub(validManifest());
    const result = await loadTour(fetchImpl, LOCATION);

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${MANIFEST_PATH}`, expect.anything());
    if (result.ok) expect(result.value.baseUrl).toBe(BASE);
  });

  // TEST-VW-002
  it('explica el fallo de red y menciona la limitación de file://', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await loadTour(fetchImpl, LOCATION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_UNAVAILABLE');
      // Abrir index.html con doble clic es lo primero que hace cualquiera con
      // un paquete en USB, y el bloqueo del navegador no se explica solo.
      expect(result.error.recovery).toContain('desde el disco');
    }
  });

  // TEST-VW-003
  it('informa del código cuando el servidor no entrega el manifiesto', async () => {
    const result = await loadTour(fetchStub(null, { status: 404 }), LOCATION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('404');
      expect(result.error.recovery).toContain('junto a index.html');
    }
  });

  // TEST-VW-004
  it('distingue un JSON roto de un manifiesto que no valida', async () => {
    const broken = await loadTour(fetchStub(null, { invalidJson: true }), LOCATION);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toContain('no es un JSON válido');

    const invalid = await loadTour(fetchStub({ format: 'otra-cosa' }), LOCATION);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('VALIDATION_FAILED');
      expect(invalid.error.message).toContain('formato esperado');
      // El primer problema concreto va en el error: «no valida» a secas no
      // ayuda a nadie a arreglarlo.
      expect(invalid.error.path).toBeDefined();
    }
  });

  // TEST-VW-005
  it('se niega a mostrar un paquete de un formato más nuevo', async () => {
    // Mostrarlo omitiría contenido en silencio: el visor no sabe interpretar
    // campos que no conoce, y el cliente creería que el recorrido está
    // incompleto.
    const manifest = { ...validManifest(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    const result = await loadTour(fetchStub(manifest), LOCATION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCHEMA_TOO_NEW');
      expect(result.error.recovery).toContain('Actualice el visor');
    }
  });

  // TEST-VW-006
  it('acepta el formato de la versión actual', async () => {
    const result = await loadTour(fetchStub(validManifest()), LOCATION);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('mediaUrl', () => {
  // TEST-VW-007
  it('codifica cada segmento de la ruta', () => {
    // Los nombres del cliente llevan espacios y acentos con normalidad.
    expect(mediaUrl(BASE, 'media/Sala de bombas.jpg')).toBe(
      `${BASE}media/Sala%20de%20bombas.jpg`,
    );
    expect(mediaUrl(BASE, 'media/subestación.jpg')).toBe(`${BASE}media/subestaci%C3%B3n.jpg`);
  });

  // TEST-VW-008
  it('no convierte las barras de la ruta en texto codificado', () => {
    // Codificar la ruta completa transformaría «/» en «%2F» y el servidor
    // buscaría un archivo con ese nombre literal.
    const url = mediaUrl(BASE, 'media/thumbs/p-101.webp');
    expect(url).toContain('media/thumbs/');
    expect(url).not.toContain('%2F');
  });

  // TEST-VW-009
  it('indexa los medios del recorrido por identificador', async () => {
    const result = await loadTour(fetchStub(validManifest()), LOCATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const index = mediaUrlIndex(result.value);
    const first = result.value.manifest.media[0];

    expect(first).toBeDefined();
    expect(index.get(first?.id ?? '')).toContain(BASE);
    expect(index.size).toBe(result.value.manifest.media.length);
  });
});
