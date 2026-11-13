/**
 * Telemetría y condición operacional (etapa 07, grupo X09-X14).
 *
 * Dos restricciones gobiernan este módulo y no son negociables:
 *
 *  1. **Solo lectura.** La arquitectura excluye expresamente el control de
 *     PLC y la escritura de variables de proceso. No existe ningún tipo, ni
 *     función, ni ruta en este dominio que produzca una escritura. La
 *     prohibición se comprueba en pruebas (`telemetry.test.ts`), porque una
 *     regla que sólo está en la documentación se incumple tarde o temprano.
 *  2. **El token nunca pasa por la interfaz.** El visor pide un valor a su
 *     backend; el backend consulta InfluxDB con credenciales que viven en el
 *     almacén seguro del sistema operativo. Un recorrido publicado no puede
 *     llevar incrustado un token de lectura del histórico de la planta.
 *
 * La tercera decisión de fondo es que el tiempo del dato y el tiempo de la
 * consulta son dos campos distintos. Un valor leído hace diez minutos con
 * timestamp de ayer no es un dato actual, y la única forma de no confundirlos
 * es no guardarlos en el mismo sitio.
 */
import { z } from 'zod';
import { tagSchema, uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Conexión (X09)
 * ------------------------------------------------------------------ */

/**
 * Referencia a una credencial, no la credencial.
 *
 * El proyecto guarda un identificador; el valor vive en el almacén de
 * secretos del sistema (Credential Manager en Windows). Así un `.ivp`
 * compartido por correo no incluye el token, que es el requisito del
 * contrato de datos: «sin credenciales».
 */
export const secretRefSchema = z.object({
  /** Clave en el almacén de secretos. */
  keyId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._\-]+$/, 'La clave del secreto admite letras, dígitos y . _ -'),
  /** Descripción para que un administrador sepa qué credencial es. */
  label: z.string().max(200).default(''),
});

export type SecretRef = z.infer<typeof secretRefSchema>;

export const influxConnectionSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(160),
  /** URL del servidor InfluxDB 2.x. */
  url: z.string().url(),
  org: z.string().min(1).max(160),
  bucket: z.string().min(1).max(160),
  /** Referencia al token de SOLO LECTURA en el almacén seguro. */
  tokenRef: secretRefSchema,
  /** Tiempo máximo de espera de una consulta, en ms. */
  timeoutMs: z.number().int().min(500).max(60_000).default(8000),
  /** Verificar el certificado TLS. Desactivarlo exige justificación escrita. */
  verifyTls: z.boolean().default(true),
  tlsExemptionReason: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
});

export type InfluxConnection = z.infer<typeof influxConnectionSchema>;

/* ------------------------------------------------------------------ *
 * Mapeo de variable (X10)
 * ------------------------------------------------------------------ */

export const aggregationSchema = z.enum(['last', 'mean', 'min', 'max', 'sum', 'median']);
export type Aggregation = z.infer<typeof aggregationSchema>;

export const telemetryMappingSchema = z.object({
  id: uuidSchema,
  connectionId: uuidSchema,
  assetId: uuidSchema,
  /** Nombre de la variable en la interfaz: `Presión de descarga`. */
  variable: z.string().min(1).max(160),
  /** TAG de instrumento, cuando difiere del activo que lo contiene. */
  instrumentTag: tagSchema.nullable().default(null),
  /** `_measurement` de InfluxDB. */
  measurement: z.string().min(1).max(200),
  /** `_field` de InfluxDB. */
  field: z.string().min(1).max(200),
  /** Etiquetas de filtrado. */
  tags: z.record(z.string().max(120), z.string().max(240)).default({}),
  /** Unidad de ingeniería mostrada junto al valor (X11). */
  unit: z.string().max(32).default(''),
  /** Decimales en la presentación. */
  decimals: z.number().int().min(0).max(6).default(2),
  /**
   * Antigüedad a partir de la cual el dato se considera obsoleto, en segundos
   * (X12).
   *
   * No hay un valor universal: una temperatura de tanque cambia en minutos y
   * una vibración en milisegundos. El umbral se declara por variable porque
   * sólo el cliente conoce la frecuencia real de su histórico.
   */
  freshnessSeconds: z.number().int().min(1).max(31_536_000).default(300),
  /** Agregación aplicada en las consultas de histórico. */
  aggregation: aggregationSchema.default('mean'),
  /** Límites de la gráfica; `null` = escala automática. */
  displayMin: z.number().finite().nullable().default(null),
  displayMax: z.number().finite().nullable().default(null),
  enabled: z.boolean().default(true),
});

export type TelemetryMapping = z.infer<typeof telemetryMappingSchema>;

/* ------------------------------------------------------------------ *
 * Calidad del dato (X12)
 * ------------------------------------------------------------------ */

/**
 * Estados de calidad. Son cinco y cada uno significa algo distinto para el
 * operador:
 *
 *  - `fresh`: hay valor y es reciente según su propio umbral.
 *  - `stale`: hay valor, pero es más antiguo que su umbral de frescura.
 *  - `missing`: la consulta respondió y no había dato para ese periodo.
 *  - `error`: la consulta falló (red, autorización, servidor).
 *  - `nonNumeric`: había dato pero no es un número y no se puede graficar.
 *
 * Fundir `missing` con `error` sería el atajo natural y el equivocado: «no
 * hay dato» y «no pude preguntar» llevan a decisiones distintas.
 */
export const dataQualitySchema = z.enum(['fresh', 'stale', 'missing', 'error', 'nonNumeric']);
export type DataQuality = z.infer<typeof dataQualitySchema>;

export const DATA_QUALITY_LABELS: Readonly<Record<DataQuality, string>> = {
  fresh: 'Actual',
  stale: 'Obsoleto',
  missing: 'Sin dato',
  error: 'Error de lectura',
  nonNumeric: 'No numérico',
};

/** Token de color del sistema de diseño por estado de calidad. */
export const DATA_QUALITY_TOKEN: Readonly<Record<DataQuality, string>> = {
  fresh: 'var(--it-color-telemetry-fresh)',
  stale: 'var(--it-color-telemetry-stale)',
  missing: 'var(--it-color-telemetry-missing)',
  error: 'var(--it-color-telemetry-error)',
  nonNumeric: 'var(--it-color-telemetry-error)',
};

export const telemetrySampleSchema = z.object({
  mappingId: uuidSchema,
  /** Valor numérico, o `null` si no hay o no es numérico. */
  value: z.number().finite().nullable(),
  /** Valor original cuando no es numérico, para poder mostrarlo tal cual. */
  rawValue: z.string().max(500).nullable().default(null),
  /** Momento al que corresponde el dato, según la fuente. UTC ISO 8601. */
  sourceTimestamp: z.string().datetime({ offset: true }).nullable(),
  /** Momento en que esta aplicación obtuvo el dato. UTC ISO 8601. */
  fetchedAt: z.string().datetime({ offset: true }),
  quality: dataQualitySchema,
  /** Mensaje de error, cuando `quality` es `error`. Sin datos sensibles. */
  errorMessage: z.string().max(500).nullable().default(null),
  /**
   * El dato proviene de la caché local y no de una consulta en vivo.
   * La arquitectura obliga a etiquetarlo: «datos offline se etiquetan como
   * caché, no como telemetría actual».
   */
  fromCache: z.boolean().default(false),
});

export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;

/**
 * Deduce la calidad de una lectura.
 *
 * Toda la lógica de «¿puedo confiar en este número?» está aquí, en una
 * función pura, y no repartida por la interfaz. `now` es un parámetro y no
 * `Date.now()` porque de otro modo la prueba del caso «obsoleto» tendría que
 * esperar en tiempo real.
 */
export function assessQuality(input: {
  readonly value: number | null;
  readonly rawValue: string | null;
  readonly sourceTimestamp: string | null;
  readonly freshnessSeconds: number;
  readonly now: Date;
  readonly failed?: boolean;
}): DataQuality {
  if (input.failed === true) return 'error';
  if (input.value === null && input.rawValue !== null) return 'nonNumeric';
  if (input.value === null || input.sourceTimestamp === null) return 'missing';

  const sourceMs = Date.parse(input.sourceTimestamp);
  if (Number.isNaN(sourceMs)) return 'missing';

  const ageSeconds = (input.now.getTime() - sourceMs) / 1000;

  // Un dato con timestamp futuro indica desfase de reloj entre el servidor
  // de proceso y este equipo. Se trata como obsoleto —no como actual— porque
  // no se puede afirmar que represente el estado presente.
  if (ageSeconds < -60) return 'stale';

  return ageSeconds <= input.freshnessSeconds ? 'fresh' : 'stale';
}

/** Antigüedad de una lectura en segundos, o `null` si no se puede calcular. */
export function sampleAgeSeconds(sample: TelemetrySample, now: Date): number | null {
  if (sample.sourceTimestamp === null) return null;
  const ms = Date.parse(sample.sourceTimestamp);
  if (Number.isNaN(ms)) return null;
  return (now.getTime() - ms) / 1000;
}

/* ------------------------------------------------------------------ *
 * Reglas de condición (X14)
 * ------------------------------------------------------------------ */

export const conditionLevelSchema = z.enum(['nominal', 'warning', 'alarm', 'unknown']);
export type ConditionLevel = z.infer<typeof conditionLevelSchema>;

export const CONDITION_LABELS: Readonly<Record<ConditionLevel, string>> = {
  nominal: 'Normal',
  warning: 'Atención',
  alarm: 'Alarma',
  unknown: 'Indeterminado',
};

export const comparisonSchema = z.enum(['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'between', 'outside']);
export type Comparison = z.infer<typeof comparisonSchema>;

export const conditionRuleSchema = z.object({
  id: uuidSchema,
  mappingId: uuidSchema,
  label: z.string().min(1).max(160),
  comparison: comparisonSchema,
  /** Primer operando. En `between`/`outside`, el límite inferior. */
  threshold: z.number().finite(),
  /** Segundo operando, sólo para `between` y `outside`. */
  threshold2: z.number().finite().nullable().default(null),
  level: conditionLevelSchema,
  /**
   * Histéresis en unidades de ingeniería.
   *
   * Sin histéresis, una variable que oscila en el umbral enciende y apaga la
   * alarma varias veces por minuto, y el operador aprende a ignorarla. La
   * condición debe salir del estado sólo cuando el valor se separa del
   * umbral por este margen.
   */
  hysteresis: z.number().min(0).default(0),
  /** Prioridad de evaluación: gana la primera regla que se cumple. */
  order: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
});

export type ConditionRule = z.infer<typeof conditionRuleSchema>;

/** Evalúa una comparación sin histéresis. */
export function evaluateComparison(
  value: number,
  comparison: Comparison,
  threshold: number,
  threshold2: number | null,
): boolean {
  switch (comparison) {
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    case 'between': {
      if (threshold2 === null) return false;
      const [lo, hi] = threshold <= threshold2 ? [threshold, threshold2] : [threshold2, threshold];
      return value >= lo && value <= hi;
    }
    case 'outside': {
      if (threshold2 === null) return false;
      const [lo, hi] = threshold <= threshold2 ? [threshold, threshold2] : [threshold2, threshold];
      return value < lo || value > hi;
    }
    default: {
      const exhaustive: never = comparison;
      throw new Error(`Comparación no contemplada: ${String(exhaustive)}`);
    }
  }
}

export interface ConditionEvaluation {
  readonly level: ConditionLevel;
  /** Regla que determinó el nivel, si alguna. */
  readonly ruleId: string | null;
  readonly label: string;
  /** Explicación legible de por qué se alcanzó ese nivel. */
  readonly reason: string;
}

/**
 * Evalúa la condición de una variable.
 *
 * El dato ausente o erróneo produce `unknown` y nunca `nominal`. Mostrar
 * verde porque no llega el dato es el peor fallo posible en un panel de
 * condición: comunica «todo bien» cuando lo que ocurre es «no sé nada».
 *
 * `previousLevel` habilita la histéresis: sin saber de dónde viene la
 * variable no se puede aplicar un margen de salida.
 */
export function evaluateCondition(
  sample: TelemetrySample,
  rules: readonly ConditionRule[],
  previousLevel: ConditionLevel = 'unknown',
): ConditionEvaluation {
  if (sample.quality === 'error') {
    return {
      level: 'unknown',
      ruleId: null,
      label: CONDITION_LABELS.unknown,
      reason: sample.errorMessage ?? 'No se pudo leer la variable',
    };
  }

  if (sample.quality === 'missing' || sample.quality === 'nonNumeric' || sample.value === null) {
    return {
      level: 'unknown',
      ruleId: null,
      label: CONDITION_LABELS.unknown,
      reason:
        sample.quality === 'nonNumeric'
          ? 'El valor recibido no es numérico y no admite reglas de condición'
          : 'No hay valor para el periodo consultado',
    };
  }

  if (sample.quality === 'stale') {
    return {
      level: 'unknown',
      ruleId: null,
      label: CONDITION_LABELS.unknown,
      reason: 'El último valor disponible es más antiguo que su umbral de frescura',
    };
  }

  const active = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)));

  const value = sample.value;

  for (const rule of active) {
    const meets = evaluateComparison(value, rule.comparison, rule.threshold, rule.threshold2);

    if (meets) {
      return {
        level: rule.level,
        ruleId: rule.id,
        label: rule.label,
        reason: `${value} cumple «${rule.label}»`,
      };
    }

    // Histéresis: si veníamos de este nivel, hace falta separarse del umbral
    // por el margen declarado para abandonarlo.
    if (rule.hysteresis > 0 && previousLevel === rule.level) {
      const relaxed = evaluateComparison(
        value,
        rule.comparison,
        relaxThreshold(rule.comparison, rule.threshold, rule.hysteresis),
        rule.threshold2 === null
          ? null
          : relaxThreshold(rule.comparison, rule.threshold2, rule.hysteresis, true),
      );
      if (relaxed) {
        return {
          level: rule.level,
          ruleId: rule.id,
          label: rule.label,
          reason: `${value} permanece en «${rule.label}» por histéresis de ${rule.hysteresis}`,
        };
      }
    }
  }

  return {
    level: 'nominal',
    ruleId: null,
    label: CONDITION_LABELS.nominal,
    reason: 'Ninguna regla de atención o alarma se cumple',
  };
}

/** Desplaza un umbral en la dirección que ensancha la zona de permanencia. */
function relaxThreshold(
  comparison: Comparison,
  threshold: number,
  hysteresis: number,
  isUpperBound = false,
): number {
  switch (comparison) {
    case 'gt':
    case 'gte':
      return threshold - hysteresis;
    case 'lt':
    case 'lte':
      return threshold + hysteresis;
    case 'between':
      return isUpperBound ? threshold + hysteresis : threshold - hysteresis;
    case 'outside':
      return isUpperBound ? threshold - hysteresis : threshold + hysteresis;
    default:
      return threshold;
  }
}

/** Nivel más severo de un conjunto: lo que muestra el indicador del activo. */
export function worstCondition(levels: readonly ConditionLevel[]): ConditionLevel {
  if (levels.includes('alarm')) return 'alarm';
  if (levels.includes('warning')) return 'warning';
  if (levels.includes('unknown')) return 'unknown';
  return levels.length > 0 ? 'nominal' : 'unknown';
}

/* ------------------------------------------------------------------ *
 * Consulta de histórico (X13)
 * ------------------------------------------------------------------ */

export const timeRangeSchema = z
  .object({
    /** Inicio, UTC ISO 8601. */
    from: z.string().datetime({ offset: true }),
    /** Fin, UTC ISO 8601. */
    to: z.string().datetime({ offset: true }),
  })
  .refine((r) => Date.parse(r.from) < Date.parse(r.to), {
    message: 'El inicio del intervalo debe ser anterior al fin',
    path: ['from'],
  });

export type TimeRange = z.infer<typeof timeRangeSchema>;

/** Intervalos predefinidos del selector de histórico. */
export const PRESET_RANGES = [
  { id: '15m', label: 'Últimos 15 min', seconds: 900 },
  { id: '1h', label: 'Última hora', seconds: 3600 },
  { id: '8h', label: 'Último turno (8 h)', seconds: 28_800 },
  { id: '24h', label: 'Últimas 24 h', seconds: 86_400 },
  { id: '7d', label: 'Últimos 7 días', seconds: 604_800 },
  { id: '30d', label: 'Últimos 30 días', seconds: 2_592_000 },
] as const;

export type PresetRangeId = (typeof PRESET_RANGES)[number]['id'];

export function rangeFromPreset(preset: PresetRangeId, now: Date): TimeRange {
  const entry = PRESET_RANGES.find((r) => r.id === preset);
  const seconds = entry?.seconds ?? 3600;
  return {
    from: new Date(now.getTime() - seconds * 1000).toISOString(),
    to: now.toISOString(),
  };
}

/**
 * Ventana de agregación recomendada para un intervalo.
 *
 * Devolver un punto por milisegundo de un intervalo de 30 días traería
 * millones de muestras por variable: la consulta tardaría, la red se
 * saturaría y la gráfica dibujaría más puntos que píxeles tiene. Se apunta a
 * unos 720 puntos, que llenan una gráfica ancha sin desperdiciar nada.
 */
export function recommendedWindowSeconds(range: TimeRange, targetPoints = 720): number {
  const spanSeconds = (Date.parse(range.to) - Date.parse(range.from)) / 1000;
  if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return 60;
  const raw = spanSeconds / Math.max(targetPoints, 1);
  // Se redondea a una escala humana: nadie quiere ver «ventana de 37 s».
  const steps = [1, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400];
  for (const step of steps) {
    if (raw <= step) return step;
  }
  return 86_400;
}

/* ------------------------------------------------------------------ *
 * Garantía de solo lectura
 * ------------------------------------------------------------------ */

/**
 * Operaciones admitidas contra la fuente de telemetría.
 *
 * El tipo es la garantía: no hay ningún valor de esta unión que represente
 * una escritura, de modo que un adaptador no puede exponer una sin cambiar
 * el contrato del dominio, y ese cambio no pasaría la revisión.
 */
export const TELEMETRY_OPERATIONS = ['latest', 'history', 'ping', 'listMeasurements'] as const;
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

/** Palabras de Flux que modifican estado. Ninguna consulta puede contenerlas. */
export const FORBIDDEN_FLUX_KEYWORDS = [
  'to(',
  'to_http',
  'experimental.to',
  'influxdb.to',
  'delete(',
  'drop(',
  'write(',
  'sql.to',
] as const;

/**
 * Comprueba que una consulta Flux no intente escribir.
 *
 * Es defensa en profundidad: las consultas las construye esta aplicación a
 * partir de plantillas parametrizadas, así que en teoría nunca contendrán un
 * `to()`. La comprobación existe porque «en teoría» no es un control, y
 * porque el token de la conexión podría tener más permisos de los debidos.
 */
export function isReadOnlyFlux(query: string): boolean {
  const normalized = query.toLowerCase().replace(/\s+/g, '');
  return !FORBIDDEN_FLUX_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase().replace(/\s+/g, '')));
}
