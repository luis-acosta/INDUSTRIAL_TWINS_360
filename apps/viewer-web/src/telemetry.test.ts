/**
 * Pruebas de la telemetría del recorrido publicado.
 *
 * Dos reglas se comprueban aquí, y las dos son de las que hacen daño si se
 * rompen:
 *
 *  1. Un paquete publicado para funcionar sin conexión no consulta datos de
 *     proceso. Si lo hiciera, el visitante vería errores de red donde debería
 *     leer «este paquete no trae datos actuales», y un error de red se
 *     interpreta como un problema del equipo, no del paquete.
 *  2. La calidad del dato se decide en el visor con el reloj del visor. El
 *     servicio no sabe cuánto tardó la respuesta en llegar, y «actual» es una
 *     afirmación sobre el momento en que alguien mira la pantalla.
 */
import { describe, expect, it, vi } from 'vitest';
import { toManifest, type Manifest, type Uuid } from '@it360/domain';
import { makeFullProject, testUuid } from '@it360/domain/testing';
import { PublishedTelemetry } from './telemetry';

const BASE = 'https://intranet.cliente/recorridos/u200/';

function manifestFor(options: { offline: boolean }): Manifest {
  return toManifest(makeFullProject(), {
    publishedAt: '2026-03-01T10:00:00.000Z',
    appVersion: '0.14.0',
    offlineCapable: options.offline,
  });
}

/**
 * Mapeo tal como aparece en el manifiesto publicado.
 *
 * No es un `TelemetryMapping`: el manifiesto omite `connectionId` a propósito,
 * porque el visor no debe conocer a qué servidor pertenece la variable. El tipo
 * se deriva del manifiesto en lugar de forzarse con una conversión, que es lo
 * que escondería un cambio futuro en esa omisión.
 */
type PublishedMapping = Manifest['telemetryMappings'][number];

/** Respuesta del servicio con una muestra para el primer mapeo. */
function sampleResponse(mapping: PublishedMapping | { id: Uuid }, overrides: Record<string, unknown> = {}) {
  return [
    {
      mappingId: mapping.id,
      value: 5.2,
      rawValue: null,
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      quality: 'fresh',
      errorMessage: null,
      fromCache: false,
      ...overrides,
    },
  ];
}

function fetchStub(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: status < 400,
      status,
      json: async () => body,
    }) as unknown as Response,
  ) as unknown as typeof fetch;
}

describe('PublishedTelemetry', () => {
  // TEST-VWT-001
  it('un paquete sin conexión no consulta y lo dice con palabras del visitante', async () => {
    const manifest = manifestFor({ offline: true });
    const fetchImpl = fetchStub([]);
    const telemetry = new PublishedTelemetry(manifest, BASE, fetchImpl);

    expect(telemetry.available).toBe(false);
    const result = await telemetry.latest();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TELEMETRY_UNAVAILABLE');
      expect(result.error.recovery).toContain('no son lecturas actuales');
    }
  });

  // TEST-VWT-002
  it('pide las lecturas por identificador de mapeo y sin credenciales', async () => {
    const manifest = manifestFor({ offline: false });
    const mapping = manifest.telemetryMappings[0];
    expect(mapping).toBeDefined();
    if (mapping === undefined) return;

    const fetchImpl = fetchStub(sampleResponse(mapping));
    const telemetry = new PublishedTelemetry(manifest, BASE, fetchImpl);

    const result = await telemetry.latest();

    expect(result.ok).toBe(true);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const init = call?.[1] as RequestInit;

    // Sin cookies: el visor no tiene sesión y arrastrar las de la intranet
    // del cliente a esta petición sería enviar credenciales que no son suyas.
    expect(init.credentials).toBe('omit');
    expect(String(init.body)).toContain(mapping?.id ?? '');
    // El cuerpo lleva identificadores, nunca URL ni organización ni token.
    expect(String(init.body)).not.toContain('influx');
  });

  // TEST-VWT-003
  it('resuelve el endpoint relativo contra la ubicación del paquete', async () => {
    const manifest = manifestFor({ offline: false });
    const fetchImpl = fetchStub([]);
    await new PublishedTelemetry(manifest, BASE, fetchImpl).latest();

    const url = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]);
    expect(url.startsWith(BASE)).toBe(true);
    expect(url.endsWith('/latest')).toBe(true);
  });

  // TEST-VWT-004
  it('reevalúa la calidad con el reloj del visor y no con la etiqueta del servicio', async () => {
    const manifest = manifestFor({ offline: false });
    const mapping = manifest.telemetryMappings[0];
    expect(mapping).toBeDefined();
    if (mapping === undefined) return;

    // El servicio afirma «fresh» con una marca de tiempo de hace dos días.
    const stale = sampleResponse(mapping, {
      sourceTimestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      quality: 'fresh',
    });

    const result = await new PublishedTelemetry(manifest, BASE, fetchStub(stale)).latest();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.quality).toBe('stale');
  });

  // TEST-VWT-005
  it('marca como ausente el dato sin valor', async () => {
    const manifest = manifestFor({ offline: false });
    const mapping = manifest.telemetryMappings[0];
    expect(mapping).toBeDefined();
    if (mapping === undefined) return;
    const missing = sampleResponse(mapping, { value: null, rawValue: null, quality: 'fresh' });

    const result = await new PublishedTelemetry(manifest, BASE, fetchStub(missing)).latest();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.quality).toBe('missing');
  });

  // TEST-VWT-006
  it('descarta una muestra inválida y conserva las demás', async () => {
    const manifest = manifestFor({ offline: false });
    const mapping = manifest.telemetryMappings[0];
    expect(mapping).toBeDefined();
    if (mapping === undefined) return;
    const mixed = [
      { mappingId: 'no-es-un-uuid', value: 1 },
      ...sampleResponse(mapping),
    ];

    const result = await new PublishedTelemetry(manifest, BASE, fetchStub(mixed)).latest();

    // Perder una variable es mejor que dejar el panel entero en blanco: la
    // que falta aparecerá como «sin dato», que es la verdad.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  // TEST-VWT-007
  it('descarta una muestra de un mapeo que no está en el manifiesto', async () => {
    // Un servicio que devuelve variables de otro recorrido no debe pintar
    // valores en este: el visitante no tendría forma de saber de dónde salen.
    const manifest = manifestFor({ offline: false });
    const foreign = sampleResponse({ id: testUuid(999) });

    const result = await new PublishedTelemetry(manifest, BASE, fetchStub(foreign)).latest();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });

  // TEST-VWT-008
  it('informa del estado cuando el servicio responde con error', async () => {
    const manifest = manifestFor({ offline: false });
    const result = await new PublishedTelemetry(manifest, BASE, fetchStub(null, 503)).latest();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TELEMETRY_UNAVAILABLE');
      expect(result.error.message).toContain('503');
    }
  });

  // TEST-VWT-009
  it('rechaza una respuesta que no es una lista', async () => {
    const manifest = manifestFor({ offline: false });
    const result = await new PublishedTelemetry(manifest, BASE, fetchStub({ datos: [] })).latest();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  // TEST-VWT-010
  it('no consulta cuando no hay ninguna variable que pedir', async () => {
    const manifest = { ...manifestFor({ offline: false }), telemetryMappings: [] };
    const fetchImpl = fetchStub([]);

    const result = await new PublishedTelemetry(manifest, BASE, fetchImpl).latest();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
