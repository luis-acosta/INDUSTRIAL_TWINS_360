/**
 * Pruebas de los instrumentos.
 *
 * El objeto de estas pruebas es una sola idea: la condición operacional y la
 * calidad del dato son dos ejes distintos y la pantalla no los puede
 * confundir. «La bomba está en alarma» y «no sé cómo está la bomba porque no
 * llega el dato» llevan a acciones opuestas, y el día que un indicador
 * presente lo segundo como lo primero —o como normalidad— alguien tomará la
 * decisión equivocada delante del equipo.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConditionRule, TelemetryMapping, TelemetrySample } from '@it360/domain';
import { testUuid } from '@it360/domain/testing';
import { Gauge, Sparkline, formatAge, formatValue } from './instruments';

const NOW = new Date('2026-03-01T12:00:00.000Z');

const mapping: TelemetryMapping = {
  id: testUuid(1),
  connectionId: testUuid(2),
  assetId: testUuid(3),
  variable: 'Presión de descarga',
  instrumentTag: null,
  measurement: 'presion',
  field: 'valor',
  tags: {},
  unit: 'bar',
  decimals: 1,
  freshnessSeconds: 60,
  aggregation: 'last',
  displayMin: 0,
  displayMax: 10,
  enabled: true,
};

const rule: ConditionRule = {
  id: testUuid(4),
  mappingId: mapping.id,
  label: 'Presión alta',
  comparison: 'gt',
  threshold: 8,
  threshold2: null,
  level: 'alarm',
  hysteresis: 0.2,
  order: 0,
  enabled: true,
};

function sample(overrides: Partial<TelemetrySample>): TelemetrySample {
  return {
    mappingId: mapping.id,
    value: 5,
    rawValue: null,
    sourceTimestamp: new Date(NOW.getTime() - 10_000).toISOString(),
    fetchedAt: NOW.toISOString(),
    quality: 'fresh',
    errorMessage: null,
    fromCache: false,
    ...overrides,
  };
}

describe('formatValue', () => {
  // TEST-INS-001
  it('respeta los decimales declarados en el mapeo', () => {
    expect(formatValue(sample({ value: 5.678 }), mapping)).toBe('5,7');
  });

  // TEST-INS-002
  it('muestra el valor original cuando no es numérico', () => {
    // Un historiador puede devolver «RUNNING» en un campo de estado. Convertir
    // eso en 0 o en «—» perdería el único dato que hay.
    expect(formatValue(sample({ value: null, rawValue: 'RUNNING', quality: 'nonNumeric' }), mapping)).toBe(
      'RUNNING',
    );
  });

  // TEST-INS-003
  it('no inventa un valor cuando no hay dato', () => {
    expect(formatValue(sample({ value: null, rawValue: null, quality: 'missing' }), mapping)).toBe('—');
    expect(formatValue(undefined, mapping)).toBe('—');
  });
});

describe('formatAge', () => {
  // TEST-INS-004
  it('expresa la antigüedad en la unidad que se lee de un vistazo', () => {
    expect(formatAge(8)).toBe('hace 8 s');
    expect(formatAge(185)).toBe('hace 3 min');
    expect(formatAge(7_400)).toBe('hace 2 h');
    expect(formatAge(180_000)).toBe('hace 2 d');
  });

  // TEST-INS-005
  it('sin marca de tiempo no afirma nada sobre la antigüedad', () => {
    expect(formatAge(null)).toBe('sin marca de tiempo');
  });
});

describe('Gauge', () => {
  // TEST-INS-006
  it('separa la condición operacional de la calidad del dato', () => {
    render(<Gauge mapping={mapping} sample={sample({ value: 9 })} rules={[rule]} now={NOW} />);

    // En alarma por el valor, y con dato actual: las dos cosas a la vez, cada
    // una en su propio indicador.
    // La pastilla de condición nombra la regla que se cumple, no sólo la
    // severidad: «Presión alta» dice qué pasa, «Alarma» sólo que algo pasa.
    expect(screen.getByText('Presión alta')).toBeInTheDocument();
    expect(screen.getByText('Actual')).toBeInTheDocument();
  });

  // TEST-INS-007
  it('con el dato ausente la condición queda indeterminada, nunca normal', () => {
    render(
      <Gauge
        mapping={mapping}
        sample={sample({ value: null, quality: 'missing', sourceTimestamp: null })}
        rules={[rule]}
        now={NOW}
      />,
    );

    expect(screen.getByText('Sin dato')).toBeInTheDocument();
    expect(screen.queryByText('Normal')).not.toBeInTheDocument();
    expect(screen.getByText('Indeterminado')).toBeInTheDocument();
  });

  // TEST-INS-008
  it('con error de consulta tampoco afirma que todo está normal', () => {
    render(
      <Gauge
        mapping={mapping}
        sample={sample({ value: null, quality: 'error', errorMessage: 'tiempo de espera agotado' })}
        rules={[rule]}
        now={NOW}
      />,
    );

    expect(screen.getByText('Error de lectura')).toBeInTheDocument();
    expect(screen.queryByText('Normal')).not.toBeInTheDocument();
    expect(screen.getByText('Indeterminado')).toBeInTheDocument();
  });

  // TEST-INS-009
  it('etiqueta explícitamente el dato que viene de caché', () => {
    // «Datos offline se etiquetan como caché, no como telemetría actual.»
    render(
      <Gauge
        mapping={mapping}
        sample={sample({ value: 5, fromCache: true, quality: 'stale' })}
        rules={[rule]}
        now={NOW}
      />,
    );

    expect(screen.getByText('Dato de caché')).toBeInTheDocument();
  });

  // TEST-INS-010
  it('muestra la unidad junto al valor', () => {
    render(<Gauge mapping={mapping} sample={sample({ value: 4.25 })} rules={[rule]} now={NOW} />);
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('4,3')).toBeInTheDocument();
  });

  // TEST-INS-011
  it('sin ninguna regla configurada no afirma que el valor sea normal', () => {
    // Un valor dentro de rango no es «normal» si nadie ha definido el rango:
    // sólo es un número. El verde diría «lo he comprobado y está bien».
    render(<Gauge mapping={mapping} sample={sample({ value: 5 })} rules={[]} now={NOW} />);

    expect(screen.queryByText('Normal')).not.toBeInTheDocument();
    expect(screen.getByText('Sin reglas')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveClass('gauge--unknown');
  });

  // TEST-INS-018
  it('una regla deshabilitada no cuenta como vigilancia', () => {
    render(
      <Gauge
        mapping={mapping}
        sample={sample({ value: 9 })}
        rules={[{ ...rule, enabled: false }]}
        now={NOW}
      />,
    );

    // El valor supera el umbral de una regla apagada: no es alarma, pero
    // tampoco normalidad.
    expect(screen.getByText('Sin reglas')).toBeInTheDocument();
    expect(screen.queryByText('Presión alta')).not.toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  const points = [
    { timestamp: '2026-03-01T11:00:00.000Z', value: 1 },
    { timestamp: '2026-03-01T11:10:00.000Z', value: 2 },
    { timestamp: '2026-03-01T11:20:00.000Z', value: null },
    { timestamp: '2026-03-01T11:30:00.000Z', value: 4 },
    { timestamp: '2026-03-01T11:40:00.000Z', value: 5 },
  ];

  // TEST-INS-012
  it('dibuja los huecos como huecos y no une los extremos', () => {
    // Unir dos puntos separados por datos ausentes dibuja una recta que nunca
    // existió, y en una gráfica de proceso eso parece una rampa real.
    const { container } = render(<Sparkline points={points} unit="bar" label="Presión" />);
    // Dos tramos independientes, no un trazo con una recta sobre el hueco.
    expect(container.querySelectorAll('.sparkline__line')).toHaveLength(2);
  });

  // TEST-INS-013
  it('una serie continua se dibuja de un trazo', () => {
    const continuous = points.filter((p) => p.value !== null);
    const { container } = render(<Sparkline points={continuous} unit="bar" label="Presión" />);

    expect(container.querySelectorAll('.sparkline__line')).toHaveLength(1);
  });

  // TEST-INS-014
  it('sin puntos no dibuja una línea plana en cero', () => {
    // Una línea en cero se lee como «el valor es cero», que es distinto de
    // «no hay datos».
    const { container } = render(<Sparkline points={[]} unit="bar" label="Presión" />);
    expect(container.querySelector('.sparkline__line')).toBeNull();
  });

  // TEST-INS-015
  it('un solo punto se dibuja como punto y no como tendencia', () => {
    const { container } = render(
      <Sparkline points={[points[0] as { timestamp: string; value: number }]} unit="bar" label="Presión" />,
    );

    expect(container.querySelectorAll('.sparkline__line')).toHaveLength(0);
    expect(container.querySelectorAll('.sparkline__dot')).toHaveLength(1);
  });

  // TEST-INS-016
  it('una lectura aislada entre huecos no desaparece de la gráfica', () => {
    // Descartarla afirmaría que no hubo lectura en ese instante, cuando sí la
    // hubo: es el único dato del periodo y el más informativo.
    const { container } = render(
      <Sparkline
        points={[
          { timestamp: '2026-03-01T11:00:00.000Z', value: null },
          { timestamp: '2026-03-01T11:10:00.000Z', value: 7 },
          { timestamp: '2026-03-01T11:20:00.000Z', value: null },
        ]}
        unit="bar"
        label="Presión"
      />,
    );

    expect(container.querySelectorAll('.sparkline__dot')).toHaveLength(1);
  });

  // TEST-INS-017
  it('reparte los puntos por tiempo y no por posición en la lista', () => {
    // Tres lecturas con el último hueco de cincuenta minutos: dibujarlas
    // equiespaciadas mostraría una frecuencia de muestreo que no existió.
    const { container } = render(
      <Sparkline
        points={[
          { timestamp: '2026-03-01T11:00:00.000Z', value: 1 },
          { timestamp: '2026-03-01T11:10:00.000Z', value: 2 },
          { timestamp: '2026-03-01T12:00:00.000Z', value: 3 },
        ]}
        unit="bar"
        label="Presión"
      />,
    );
    const d = container.querySelector('.sparkline__line')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/[ML](-?\d+\.\d)/g)].map((m) => Number(m[1]));

    expect(xs).toHaveLength(3);
    // El segundo punto cae en el 16,7 % del ancho (10 de 60 minutos), no en
    // el 50 % que daría el reparto por índice.
    expect((xs[1] as number) / (xs[2] as number)).toBeCloseTo(10 / 60, 2);
  });
});
