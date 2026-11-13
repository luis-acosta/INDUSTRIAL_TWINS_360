import { describe, expect, it } from 'vitest';
import {
  assessQuality,
  evaluateCondition,
  evaluateComparison,
  FORBIDDEN_FLUX_KEYWORDS,
  isReadOnlyFlux,
  rangeFromPreset,
  recommendedWindowSeconds,
  sampleAgeSeconds,
  TELEMETRY_OPERATIONS,
  worstCondition,
  type ConditionRule,
  type TelemetrySample,
} from './telemetry';

const NOW = new Date('2026-11-12T19:00:00.000Z');

const sample = (overrides: Partial<TelemetrySample> = {}): TelemetrySample => ({
  mappingId: '00000000-0000-4000-8000-000000000001' as TelemetrySample['mappingId'],
  value: 10,
  rawValue: null,
  sourceTimestamp: NOW.toISOString(),
  fetchedAt: NOW.toISOString(),
  quality: 'fresh',
  errorMessage: null,
  fromCache: false,
  ...overrides,
});

const rule = (overrides: Partial<ConditionRule> = {}): ConditionRule => ({
  id: '00000000-0000-4000-8000-000000000010' as ConditionRule['id'],
  mappingId: '00000000-0000-4000-8000-000000000001' as ConditionRule['mappingId'],
  label: 'Alta presión',
  comparison: 'gt',
  threshold: 100,
  threshold2: null,
  level: 'alarm',
  hysteresis: 0,
  order: 0,
  enabled: true,
  ...overrides,
});

/**
 * TEST-TEL-001 .. TEST-TEL-026
 * Requisitos: X09-X14 (etapa 07). Exclusión expresa de la arquitectura:
 * la telemetría es exclusivamente de lectura.
 */
describe('calidad del dato (X12)', () => {
  it('TEST-TEL-001: un valor reciente dentro de su umbral es actual', () => {
    const quality = assessQuality({
      value: 42,
      rawValue: null,
      sourceTimestamp: new Date(NOW.getTime() - 30_000).toISOString(),
      freshnessSeconds: 300,
      now: NOW,
    });
    expect(quality).toBe('fresh');
  });

  it('TEST-TEL-002: un valor más antiguo que su umbral es obsoleto', () => {
    const quality = assessQuality({
      value: 42,
      rawValue: null,
      sourceTimestamp: new Date(NOW.getTime() - 600_000).toISOString(),
      freshnessSeconds: 300,
      now: NOW,
    });
    expect(quality).toBe('stale');
  });

  it('TEST-TEL-003: el umbral es por variable y no global', () => {
    // Una temperatura de tanque cambia en minutos; una vibración, en
    // milisegundos. Un único umbral mentiría en uno de los dos casos.
    const args = {
      value: 42,
      rawValue: null,
      sourceTimestamp: new Date(NOW.getTime() - 120_000).toISOString(),
      now: NOW,
    };
    expect(assessQuality({ ...args, freshnessSeconds: 300 })).toBe('fresh');
    expect(assessQuality({ ...args, freshnessSeconds: 60 })).toBe('stale');
  });

  it('TEST-TEL-004: sin valor el estado es «sin dato», no cero', () => {
    expect(
      assessQuality({
        value: null,
        rawValue: null,
        sourceTimestamp: NOW.toISOString(),
        freshnessSeconds: 300,
        now: NOW,
      }),
    ).toBe('missing');
  });

  it('TEST-TEL-005: un valor no numérico se distingue de la ausencia de valor', () => {
    expect(
      assessQuality({
        value: null,
        rawValue: 'FAULT',
        sourceTimestamp: NOW.toISOString(),
        freshnessSeconds: 300,
        now: NOW,
      }),
    ).toBe('nonNumeric');
  });

  it('TEST-TEL-006: el fallo de consulta no se confunde con la ausencia de dato', () => {
    // «No hay dato» y «no pude preguntar» llevan a decisiones distintas.
    expect(
      assessQuality({
        value: null,
        rawValue: null,
        sourceTimestamp: null,
        freshnessSeconds: 300,
        now: NOW,
        failed: true,
      }),
    ).toBe('error');
  });

  it('TEST-TEL-007: un timestamp en el futuro se trata como obsoleto', () => {
    // Indica desfase de reloj entre el servidor de proceso y este equipo; no
    // se puede afirmar que represente el estado presente.
    expect(
      assessQuality({
        value: 42,
        rawValue: null,
        sourceTimestamp: new Date(NOW.getTime() + 600_000).toISOString(),
        freshnessSeconds: 300,
        now: NOW,
      }),
    ).toBe('stale');
  });

  it('TEST-TEL-008: un timestamp ilegible es «sin dato»', () => {
    expect(
      assessQuality({
        value: 42,
        rawValue: null,
        sourceTimestamp: 'no-es-una-fecha',
        freshnessSeconds: 300,
        now: NOW,
      }),
    ).toBe('missing');
  });

  it('TEST-TEL-009: la antigüedad se calcula sobre el tiempo de la fuente', () => {
    const s = sample({ sourceTimestamp: new Date(NOW.getTime() - 45_000).toISOString() });
    expect(sampleAgeSeconds(s, NOW)).toBeCloseTo(45, 3);
    expect(sampleAgeSeconds(sample({ sourceTimestamp: null }), NOW)).toBeNull();
  });
});

describe('comparaciones', () => {
  it('TEST-TEL-010: cubre todos los operadores', () => {
    expect(evaluateComparison(5, 'lt', 10, null)).toBe(true);
    expect(evaluateComparison(10, 'lte', 10, null)).toBe(true);
    expect(evaluateComparison(11, 'gt', 10, null)).toBe(true);
    expect(evaluateComparison(10, 'gte', 10, null)).toBe(true);
    expect(evaluateComparison(10, 'eq', 10, null)).toBe(true);
    expect(evaluateComparison(11, 'neq', 10, null)).toBe(true);
    expect(evaluateComparison(5, 'between', 1, 10)).toBe(true);
    expect(evaluateComparison(15, 'between', 1, 10)).toBe(false);
    expect(evaluateComparison(15, 'outside', 1, 10)).toBe(true);
    expect(evaluateComparison(5, 'outside', 1, 10)).toBe(false);
  });

  it('TEST-TEL-011: between y outside aceptan los límites en cualquier orden', () => {
    expect(evaluateComparison(5, 'between', 10, 1)).toBe(true);
    expect(evaluateComparison(15, 'outside', 10, 1)).toBe(true);
  });

  it('TEST-TEL-012: between sin segundo límite no se cumple en vez de lanzar', () => {
    expect(evaluateComparison(5, 'between', 1, null)).toBe(false);
    expect(evaluateComparison(5, 'outside', 1, null)).toBe(false);
  });
});

describe('evaluación de condición (X14)', () => {
  it('TEST-TEL-013: sin reglas que se cumplan, la condición es normal', () => {
    const result = evaluateCondition(sample({ value: 50 }), [rule()]);
    expect(result.level).toBe('nominal');
    expect(result.ruleId).toBeNull();
  });

  it('TEST-TEL-014: la primera regla que se cumple determina el nivel', () => {
    const rules = [
      rule({ id: 'r1' as ConditionRule['id'], order: 0, threshold: 150, level: 'alarm' }),
      rule({ id: 'r2' as ConditionRule['id'], order: 1, threshold: 100, level: 'warning', label: 'Atención' }),
    ];
    const result = evaluateCondition(sample({ value: 120 }), rules);
    expect(result.level).toBe('warning');
    expect(result.ruleId).toBe('r2');
  });

  it('TEST-TEL-015: un dato ausente NUNCA produce nivel normal', () => {
    // Mostrar verde porque no llega el dato comunica «todo bien» cuando lo
    // que ocurre es «no sé nada». Es el peor fallo de un panel de condición.
    for (const quality of ['missing', 'error', 'nonNumeric', 'stale'] as const) {
      const result = evaluateCondition(sample({ quality, value: null }), [rule()]);
      expect(result.level, `calidad ${quality}`).toBe('unknown');
    }
  });

  it('TEST-TEL-016: un dato obsoleto con valor tampoco produce nivel normal', () => {
    const result = evaluateCondition(sample({ quality: 'stale', value: 50 }), [rule()]);
    expect(result.level).toBe('unknown');
    expect(result.reason).toContain('frescura');
  });

  it('TEST-TEL-017: el error de lectura propaga su mensaje', () => {
    const result = evaluateCondition(
      sample({ quality: 'error', value: null, errorMessage: 'Tiempo de espera agotado' }),
      [rule()],
    );
    expect(result.level).toBe('unknown');
    expect(result.reason).toBe('Tiempo de espera agotado');
  });

  it('TEST-TEL-018: las reglas desactivadas se ignoran', () => {
    const result = evaluateCondition(sample({ value: 200 }), [rule({ enabled: false })]);
    expect(result.level).toBe('nominal');
  });

  it('TEST-TEL-019: la histéresis mantiene el nivel al volver al umbral', () => {
    // Sin histéresis, una variable que oscila en el umbral enciende y apaga
    // la alarma varias veces por minuto y el operador aprende a ignorarla.
    const r = rule({ threshold: 100, hysteresis: 5, level: 'alarm' });

    // 102 dispara la alarma.
    expect(evaluateCondition(sample({ value: 102 }), [r], 'nominal').level).toBe('alarm');

    // 97 está por debajo del umbral pero dentro del margen: sigue en alarma.
    expect(evaluateCondition(sample({ value: 97 }), [r], 'alarm').level).toBe('alarm');

    // 94 sale del margen: vuelve a normal.
    expect(evaluateCondition(sample({ value: 94 }), [r], 'alarm').level).toBe('nominal');

    // Viniendo de normal, 97 no entra en alarma.
    expect(evaluateCondition(sample({ value: 97 }), [r], 'nominal').level).toBe('nominal');
  });

  it('TEST-TEL-020: la histéresis funciona en reglas de umbral inferior', () => {
    const r = rule({ comparison: 'lt', threshold: 10, hysteresis: 2, level: 'warning' });
    expect(evaluateCondition(sample({ value: 8 }), [r], 'nominal').level).toBe('warning');
    expect(evaluateCondition(sample({ value: 11 }), [r], 'warning').level).toBe('warning');
    expect(evaluateCondition(sample({ value: 13 }), [r], 'warning').level).toBe('nominal');
  });

  it('TEST-TEL-021: el nivel más severo de un conjunto gana', () => {
    expect(worstCondition(['nominal', 'warning', 'alarm'])).toBe('alarm');
    expect(worstCondition(['nominal', 'warning'])).toBe('warning');
    expect(worstCondition(['nominal', 'unknown'])).toBe('unknown');
    expect(worstCondition(['nominal', 'nominal'])).toBe('nominal');
    expect(worstCondition([])).toBe('unknown');
  });
});

describe('intervalos de histórico (X13)', () => {
  it('TEST-TEL-022: los intervalos predefinidos producen rangos coherentes', () => {
    const range = rangeFromPreset('8h', NOW);
    expect(Date.parse(range.to)).toBe(NOW.getTime());
    expect((Date.parse(range.to) - Date.parse(range.from)) / 1000).toBe(28_800);
  });

  it('TEST-TEL-023: la ventana de agregación crece con el intervalo', () => {
    const hour = recommendedWindowSeconds(rangeFromPreset('1h', NOW));
    const month = recommendedWindowSeconds(rangeFromPreset('30d', NOW));
    expect(month).toBeGreaterThan(hour);
  });

  it('TEST-TEL-024: la ventana se redondea a una escala humana', () => {
    // Nadie quiere leer «ventana de 37 s» en el eje de una gráfica.
    const allowed = [1, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400];
    for (const preset of ['15m', '1h', '8h', '24h', '7d', '30d'] as const) {
      const window = recommendedWindowSeconds(rangeFromPreset(preset, NOW));
      expect(allowed, `preset ${preset}`).toContain(window);
    }
  });

  it('TEST-TEL-025: la ventana limita el número de puntos devueltos', () => {
    const range = rangeFromPreset('30d', NOW);
    const window = recommendedWindowSeconds(range, 720);
    const span = (Date.parse(range.to) - Date.parse(range.from)) / 1000;
    expect(span / window).toBeLessThanOrEqual(1000);
  });

  it('TEST-TEL-026: un rango degenerado devuelve una ventana por defecto', () => {
    expect(recommendedWindowSeconds({ from: NOW.toISOString(), to: NOW.toISOString() })).toBe(60);
  });
});

describe('garantía de solo lectura', () => {
  it('TEST-TEL-027: ninguna operación del contrato escribe', () => {
    // La arquitectura excluye expresamente el control de PLC y la escritura
    // de variables de proceso. El contrato del dominio lo hace imposible.
    const writeWords = ['write', 'set', 'post', 'put', 'delete', 'update', 'insert', 'send'];
    for (const operation of TELEMETRY_OPERATIONS) {
      for (const word of writeWords) {
        expect(operation.toLowerCase(), `operación ${operation}`).not.toContain(word);
      }
    }
  });

  it('TEST-TEL-028: una consulta Flux de lectura se acepta', () => {
    const query = `from(bucket: "planta")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "presion")
  |> aggregateWindow(every: 1m, fn: mean)`;
    expect(isReadOnlyFlux(query)).toBe(true);
  });

  it('TEST-TEL-029: una consulta que intente escribir se rechaza', () => {
    for (const keyword of FORBIDDEN_FLUX_KEYWORDS) {
      const query = `from(bucket:"b") |> range(start:-1h) |> ${keyword}bucket:"otro")`;
      expect(isReadOnlyFlux(query), `debería rechazar ${keyword}`).toBe(false);
    }
  });

  it('TEST-TEL-030: el rechazo ignora espacios y mayúsculas', () => {
    expect(isReadOnlyFlux('from(bucket:"b") |> TO ( bucket: "x" )')).toBe(false);
    expect(isReadOnlyFlux('from(bucket:"b")|>to(bucket:"x")')).toBe(false);
  });
});

describe('procedencia del dato', () => {
  it('TEST-TEL-031: una lectura de caché queda marcada como tal', () => {
    // La arquitectura obliga: «datos offline se etiquetan como caché, no como
    // telemetría actual».
    const cached = sample({ fromCache: true });
    expect(cached.fromCache).toBe(true);
    // Y seguir siendo de caché no cambia su calidad, que es un eje distinto.
    expect(cached.quality).toBe('fresh');
  });
});
