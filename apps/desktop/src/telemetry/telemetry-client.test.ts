/**
 * Pruebas del cliente contra el servicio local.
 *
 * Hasta ahora sólo estaba probado el simulador, y el cliente real pedía dos
 * rutas que el servicio no publicaba: el histórico no existía y el sondeo
 * apuntaba a `/telemetry/health` en lugar de a `/telemetry/ping`. Un desajuste
 * así no lo detecta ninguna prueba del simulador, porque el simulador no habla
 * con nadie. Estas pruebas fijan el contrato de red: ruta, forma de la
 * respuesta y traducción de los fallos.
 *
 * El `fetch` se sustituye por uno de prueba que registra la petición. No es un
 * atajo: lo que se quiere comprobar es exactamente qué se pide y qué se hace
 * con lo que llega.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeMapping, testUuid } from '@it360/domain/testing';

import { BackendTelemetryClient } from './telemetry-client';

const mapping = makeMapping(1, testUuid(90), testUuid(91));

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  responder: (url: string) => { status?: number; body?: unknown },
): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body = {} } = responder(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BackendTelemetryClient', () => {
  it('pide el histórico a la ruta que publica el servicio', async () => {
    // TEST-TEL-032: la ruta es el contrato. Con una ruta que el servicio no
    // sirve, la gráfica queda vacía para siempre y el error que se muestra
    // («el servicio respondió 404») no señala la causa.
    const { calls } = stubFetch(() => ({
      body: {
        mappingId: mapping.id,
        points: [{ timestamp: '2026-03-01T11:00:00+00:00', value: 3 }],
        windowSeconds: 60,
        fromCache: false,
        failed: false,
        errorMessage: null,
      },
    }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.history(mapping, {
      from: '2026-03-01T11:00:00.000Z',
      to: '2026-03-01T12:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    const requested = new URL(calls[0]!.url);
    expect(requested.pathname).toBe(`/api/v1/telemetry/${mapping.id}/history`);
    expect(requested.searchParams.get('from')).toBe('2026-03-01T11:00:00.000Z');
    expect(requested.searchParams.get('to')).toBe('2026-03-01T12:00:00.000Z');
    expect(Number(requested.searchParams.get('window'))).toBeGreaterThan(0);
  });

  it('adopta la ventana que aplicó el servicio, no la que pidió', async () => {
    // TEST-TEL-033: el servicio no baja de su ventana recomendada. Si la
    // gráfica rotulase la pedida, el eje mentiría sobre la agregación.
    stubFetch(() => ({
      body: {
        mappingId: mapping.id,
        points: [],
        windowSeconds: 3600,
        fromCache: false,
        failed: false,
        errorMessage: null,
      },
    }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.history(mapping, {
      from: '2026-03-01T11:00:00.000Z',
      to: '2026-03-01T11:10:00.000Z',
    });

    expect(result.ok && result.value.windowSeconds).toBe(3600);
  });

  it('traduce un fallo del historiador en error y no en serie vacía', async () => {
    // TEST-TEL-034: el servicio contesta 200 con «failed» cuando la consulta
    // al historiador falló. Sin esta rama, el lienzo vacío se lee como «no hay
    // datos en ese intervalo», que es una afirmación distinta y falsa.
    stubFetch(() => ({
      body: {
        mappingId: mapping.id,
        points: [],
        windowSeconds: 60,
        fromCache: false,
        failed: true,
        errorMessage: 'el historiador no respondió',
      },
    }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.history(mapping, {
      from: '2026-03-01T11:00:00.000Z',
      to: '2026-03-01T12:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TELEMETRY_UNAVAILABLE');
      expect(result.error.message).toContain('historiador');
    }
  });

  it('descarta valores no numéricos del histórico', async () => {
    // TEST-TEL-035: una variable de estado puede devolver texto. La gráfica
    // dibuja números; convertir «FAULT» en 0 pintaría una caída a cero que no
    // ocurrió.
    stubFetch(() => ({
      body: {
        mappingId: mapping.id,
        points: [
          { timestamp: '2026-03-01T11:00:00+00:00', value: 'FAULT' },
          { timestamp: '2026-03-01T11:01:00+00:00', value: 7.5 },
        ],
        windowSeconds: 60,
        fromCache: false,
        failed: false,
        errorMessage: null,
      },
    }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.history(mapping, {
      from: '2026-03-01T11:00:00.000Z',
      to: '2026-03-01T12:00:00.000Z',
    });

    expect(result.ok && result.value.points.map((p) => p.value)).toEqual([null, 7.5]);
  });

  it('sondea la ruta de sondeo y respeta su veredicto', async () => {
    // TEST-TEL-036: el servicio responde 200 aunque el historiador no
    // contestara. Dar por alcanzable el historiador en ese caso afirmaría algo
    // que nadie midió, y «Probar conexión» dejaría de servir para nada.
    const { calls } = stubFetch(() => ({
      body: { reachable: false, latencyMs: 412, errorMessage: 'tiempo agotado' },
    }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.ping();

    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/api/v1/telemetry/ping');
    expect(result.ok && result.value).toEqual({ reachable: false, latencyMs: 412 });
  });

  it('distingue el rechazo de permisos de la caída del servicio', async () => {
    // TEST-TEL-037: un 403 se arregla revisando el token del servicio; una
    // caída, levantándolo. El mismo mensaje para ambos manda al administrador
    // al sitio equivocado.
    stubFetch(() => ({ status: 403 }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    const result = await client.latest([mapping]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TELEMETRY_UNAUTHORIZED');
  });

  it('no envía ninguna credencial en la consulta', async () => {
    // TEST-TEL-038: la arquitectura lo exige: «UI no accede directamente a
    // InfluxDB con token». El editor no tiene credencial que enviar, y esta
    // prueba falla si alguien añade una cabecera de autorización.
    const { calls } = stubFetch(() => ({ body: [] }));

    const client = new BackendTelemetryClient('http://127.0.0.1:8787');
    await client.latest([mapping]);

    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(JSON.stringify(calls[0])).not.toMatch(/token/i);
  });

  it('agota el tiempo de espera en lugar de dejar la gráfica colgada', async () => {
    // TEST-TEL-039: un servicio que acepta la conexión y no contesta dejaría
    // el panel con el indicador de carga indefinidamente.
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('abortado', 'AbortError'));
        });
      });
    });

    const client = new BackendTelemetryClient('http://127.0.0.1:8787', 20);
    const result = await client.ping();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TELEMETRY_UNAVAILABLE');
  });
});
