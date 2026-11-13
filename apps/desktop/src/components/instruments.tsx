/**
 * Componentes de instrumentación.
 *
 * Son los que llevan el requisito X11 y X12: mostrar valor, unidad, timestamp
 * de origen y distinguir sin ambigüedad dato actual, obsoleto, ausente y
 * error. Cada decisión de presentación responde a eso:
 *
 *  - El valor va en monoespaciada para que una cifra que cambia cada segundo
 *    no desplace la unidad que tiene al lado.
 *  - El estado de calidad se comunica con color **y** con texto, nunca sólo
 *    con color (WCAG 1.4.1, y además un operador con la pantalla en una sala
 *    iluminada no distingue matices).
 *  - La antigüedad se muestra siempre. Un número sin antigüedad obliga a
 *    confiar, y la confianza es justo lo que la etapa 07 pide no pedir.
 */
import { useMemo } from 'react';
import {
  CONDITION_LABELS,
  DATA_QUALITY_LABELS,
  evaluateCondition,
  sampleAgeSeconds,
  type ConditionLevel,
  type ConditionRule,
  type DataQuality,
  type TelemetryMapping,
  type TelemetrySample,
} from '@it360/domain';
import { Badge, Tooltip, type Tone } from '@it360/ui';
import type { HistoryPoint } from '../telemetry/telemetry-client';


const CONDITION_TONE: Readonly<Record<ConditionLevel, Tone>> = {
  nominal: 'nominal',
  warning: 'warning',
  alarm: 'alarm',
  unknown: 'neutral',
};

/** Antigüedad en lenguaje natural y en la unidad que corresponde. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'sin marca de tiempo';
  if (seconds < 0) return 'marca de tiempo futura';
  if (seconds < 60) return `hace ${Math.round(seconds)} s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `hace ${Math.round(seconds / 3600)} h`;
  return `hace ${Math.round(seconds / 86_400)} d`;
}

/**
 * Formateador de lectura numérica.
 *
 * Separador decimal de coma y sin agrupación de miles. La coma es la
 * convención del idioma del producto, y la agrupación se omite a propósito:
 * «1.234,5» en una pantalla de proceso se confunde con «1234.5» de un sistema
 * en inglés, y el operador no tiene forma de saber cuál está leyendo.
 */
const READOUT_FORMATTERS = new Map<number, Intl.NumberFormat>();

function readoutFormatter(decimals: number): Intl.NumberFormat {
  const cached = READOUT_FORMATTERS.get(decimals);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
  READOUT_FORMATTERS.set(decimals, formatter);
  return formatter;
}

/**
 * Formatea el valor con sus decimales, o el marcador de ausencia.
 *
 * El número tiene prioridad sobre `rawValue`. El orden importa: el esquema
 * admite que una muestra traiga las dos cosas, y si se devolviera la cadena
 * original cuando hay número, los decimales declarados en el mapeo se
 * ignorarían y el valor aparecería con la precisión cruda del historiador —
 * «5.70000001 bar» en un indicador de una decimal.
 */
export function formatValue(
  sample: TelemetrySample | undefined,
  mapping: TelemetryMapping,
): string {
  if (sample === undefined) return '—';
  if (sample.value !== null) return readoutFormatter(mapping.decimals).format(sample.value);
  if (sample.rawValue !== null) return sample.rawValue;
  return '—';
}

export interface GaugeProps {
  readonly mapping: TelemetryMapping;
  readonly sample: TelemetrySample | undefined;
  readonly rules: readonly ConditionRule[];
  readonly previousLevel?: ConditionLevel;
  readonly now: Date;
  readonly onOpenHistory?: () => void;
}

/**
 * Indicador de una variable de proceso.
 *
 * El color del borde izquierdo lleva la condición operacional (X14) y la
 * pastilla inferior la calidad del dato (X12). Son dos ejes distintos y se
 * muestran por separado a propósito: una variable puede estar en alarma con
 * dato fresco, o en condición indeterminada precisamente porque el dato no
 * llega. Fundirlos en un solo color haría imposible distinguir «la bomba está
 * mal» de «no sé cómo está la bomba».
 */
export function Gauge({
  mapping,
  sample,
  rules,
  previousLevel = 'unknown',
  now,
  onOpenHistory,
}: GaugeProps): JSX.Element {
  /**
   * Condición operacional.
   *
   * Con ninguna regla habilitada la condición no es evaluable, y el indicador
   * lo dice en lugar de pintarse de verde. El dominio responde `nominal`
   * cuando «ninguna regla de alarma se cumple», que es correcto como respuesta
   * a esa pregunta; pero en pantalla, verde significa «lo he comprobado y está
   * bien», y sin reglas nadie ha comprobado nada. Es la diferencia entre un
   * equipo sano y un equipo sin vigilancia.
   */
  const evaluation = useMemo(() => {
    if (sample === undefined) {
      return {
        level: 'unknown' as ConditionLevel,
        ruleId: null,
        label: CONDITION_LABELS.unknown,
        reason: 'Sin lectura todavía',
      };
    }
    if (rules.every((rule) => !rule.enabled)) {
      return {
        level: 'unknown' as ConditionLevel,
        ruleId: null,
        label: 'Sin reglas',
        reason: 'No hay ninguna regla de condición habilitada para esta variable',
      };
    }
    return evaluateCondition(sample, rules, previousLevel);
  }, [sample, rules, previousLevel]);

  const quality: DataQuality = sample?.quality ?? 'missing';
  const age = sample === undefined ? null : sampleAgeSeconds(sample, now);

  const scalePercent = useMemo(() => {
    if (sample?.value == null) return 0;
    const min = mapping.displayMin ?? 0;
    const max = mapping.displayMax ?? Math.max(sample.value * 1.3, 1);
    if (max <= min) return 0;
    return Math.min(Math.max((sample.value - min) / (max - min), 0), 1) * 100;
  }, [sample, mapping.displayMin, mapping.displayMax]);

  const content = (
    <article className={`gauge gauge--${evaluation.level}`}>
      <div className="gauge__head">
        <span className="gauge__name" title={mapping.variable}>
          {mapping.variable}
        </span>
        {mapping.instrumentTag !== null && (
          <span style={{ fontFamily: 'var(--it-font-mono)', fontSize: 'var(--it-text-2xs)', color: 'var(--it-color-text-tertiary)' }}>
            {mapping.instrumentTag}
          </span>
        )}
      </div>

      <div>
        <span
          className="gauge__value"
          style={{
            color:
              quality === 'fresh'
                ? 'var(--it-color-text-primary)'
                : 'var(--it-color-telemetry-' + (quality === 'nonNumeric' ? 'error' : quality) + ')',
          }}
        >
          {sample === undefined ? '—' : formatValue(sample, mapping)}
        </span>
        {mapping.unit.length > 0 && sample?.value != null && (
          <span className="gauge__unit">{mapping.unit}</span>
        )}
      </div>

      {mapping.displayMin !== null && mapping.displayMax !== null && (
        <div className="gauge__scale">
          <span
            style={{
              width: `${scalePercent}%`,
              background:
                quality === 'fresh'
                  ? `var(--it-color-status-${evaluation.level === 'unknown' ? 'info' : evaluation.level})`
                  : 'var(--it-color-telemetry-stale)',
            }}
          />
        </div>
      )}

      <div className="gauge__foot">
        <span className="gauge__quality" style={{ color: `var(--it-color-telemetry-${quality === 'nonNumeric' ? 'error' : quality})` }}>
          <span
            className="statusbar__dot"
            style={{ background: `var(--it-color-telemetry-${quality === 'nonNumeric' ? 'error' : quality})` }}
          />
          {DATA_QUALITY_LABELS[quality]}
        </span>
        <span className="gauge__time">{formatAge(age)}</span>
      </div>

      {sample?.fromCache === true && (
        <Badge tone="experimental" dot>
          Dato de caché
        </Badge>
      )}

      {/* La condición indeterminada se enseña, no se deja en blanco: «no sé
          cómo está» es información, y su ausencia se leería como normalidad.
          Sólo se omite la pastilla cuando la condición es normal, porque un
          distintivo en cada variable correcta sería ruido que oculta las
          demás. */}
      {evaluation.level !== 'nominal' && (
        <Badge tone={CONDITION_TONE[evaluation.level]} dot>
          {evaluation.label}
        </Badge>
      )}
    </article>
  );

  const wrapped =
    onOpenHistory !== undefined ? (
      <button
        type="button"
        onClick={onOpenHistory}
        style={{ all: 'unset', cursor: 'pointer', display: 'block' }}
        aria-label={`Ver histórico de ${mapping.variable}`}
      >
        {content}
      </button>
    ) : (
      content
    );

  return (
    <Tooltip
      content={
        <>
          <strong>{evaluation.label}</strong>
          <br />
          {evaluation.reason}
          {sample?.sourceTimestamp != null && (
            <>
              <br />
              Origen: {new Date(sample.sourceTimestamp).toLocaleString('es-CO')}
            </>
          )}
          {sample?.errorMessage != null && (
            <>
              <br />
              {sample.errorMessage}
            </>
          )}
        </>
      }
    >
      {wrapped}
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ *
 * Gráfica de histórico
 * ------------------------------------------------------------------ */

export interface SparklineProps {
  readonly points: readonly HistoryPoint[];
  readonly unit: string;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly height?: number;
  readonly label: string;
}

/**
 * Gráfica compacta de histórico (X13).
 *
 * Los huecos se dibujan como huecos y no se interpolan. Unir dos puntos
 * separados por una hora de datos ausentes dibuja una recta que nunca existió
 * y que un operador leería como una variable estable; el hueco, en cambio,
 * dice la verdad.
 */
export function Sparkline({
  points,
  unit,
  min = null,
  max = null,
  height = 56,
  label,
}: SparklineProps): JSX.Element {
  const width = 320;
  const numeric = points.filter((p): p is HistoryPoint & { value: number } => p.value !== null);

  const bounds = useMemo(() => {
    if (numeric.length === 0) return { low: 0, high: 1 };
    const values = numeric.map((p) => p.value);
    const low = min ?? Math.min(...values);
    const high = max ?? Math.max(...values);
    return high === low ? { low: low - 1, high: high + 1 } : { low, high };
  }, [numeric, min, max]);

  /**
   * Posición horizontal por tiempo, no por índice.
   *
   * Con ventanas de agregación uniformes da lo mismo, pero un histórico
   * irregular —el que devuelve el historiador cuando el equipo estuvo parado—
   * se dibujaría con los puntos repartidos a distancias iguales, y la gráfica
   * mostraría una frecuencia de muestreo que no existió. Si las marcas de
   * tiempo no se pueden interpretar, se vuelve al índice.
   */
  const positions = useMemo(() => {
    const times = points.map((p) => Date.parse(p.timestamp));
    const usable = times.every((t) => Number.isFinite(t));
    const first = times[0];
    const last = times[times.length - 1];

    if (!usable || first === undefined || last === undefined || last <= first) {
      return points.map((_, index) => (index / Math.max(points.length - 1, 1)) * width);
    }
    const span = last - first;
    return times.map((t) => (((t as number) - first) / span) * width);
  }, [points]);

  const { segments, isolated } = useMemo(() => {
    const toY = (value: number): number =>
      height - ((value - bounds.low) / (bounds.high - bounds.low)) * height;

    const paths: string[] = [];
    const dots: ReadonlyArray<{ x: number; y: number }>[] = [];
    const loose: { x: number; y: number }[] = [];
    let current: string[] = [];
    let currentStart: { x: number; y: number } | null = null;

    const flush = (): void => {
      if (current.length > 1) paths.push(current.join(' '));
      // Un punto aislado entre huecos no se descarta: el dato existió y una
      // gráfica que lo omite afirma que no hubo lectura en ese instante.
      else if (current.length === 1 && currentStart !== null) loose.push(currentStart);
      current = [];
      currentStart = null;
    };

    points.forEach((point, index) => {
      if (point.value === null) {
        flush();
        return;
      }
      const x = positions[index] ?? 0;
      const y = toY(point.value);
      if (current.length === 0) currentStart = { x, y };
      current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    flush();

    void dots;
    return { segments: paths, isolated: loose as readonly { x: number; y: number }[] };
  }, [points, positions, bounds, height]);

  if (points.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--it-text-xs)', color: 'var(--it-color-text-tertiary)' }}>
        Sin datos en el intervalo seleccionado.
      </p>
    );
  }

  const last = numeric[numeric.length - 1];

  return (
    <figure style={{ margin: 0 }}>
      <svg
        className="sparkline"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${numeric.length} puntos entre ${bounds.low.toFixed(1)} y ${bounds.high.toFixed(1)} ${unit}`}
      >
        <line className="sparkline__grid" x1="0" y1={height / 2} x2={width} y2={height / 2} />
        {segments.map((d, index) => (
          <path key={index} className="sparkline__line" d={d} vectorEffect="non-scaling-stroke" />
        ))}
        {isolated.map((dot, index) => (
          <circle key={`dot-${index}`} className="sparkline__dot" cx={dot.x} cy={dot.y} r={2} />
        ))}
      </svg>
      <figcaption
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--it-font-mono)',
          fontSize: 'var(--it-text-2xs)',
          color: 'var(--it-color-text-tertiary)',
        }}
      >
        <span>
          {bounds.low.toFixed(1)}–{bounds.high.toFixed(1)} {unit}
        </span>
        {last !== undefined && (
          <span>
            último {last.value.toFixed(1)} {unit}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
