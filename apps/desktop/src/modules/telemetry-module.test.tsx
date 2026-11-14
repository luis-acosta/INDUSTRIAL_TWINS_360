/**
 * Pruebas del panel de conexión de telemetría (X09).
 *
 * El defecto que motivó estas pruebas no era un fallo del código existente
 * sino una ausencia: el editor construía siempre el simulador, de modo que el
 * cliente contra el servicio local no era alcanzable desde ninguna parte de la
 * interfaz. Un cliente que no se puede elegir no está integrado.
 *
 * Lo que se comprueba es lo que el operador ve y decide: qué origen de datos
 * está en uso, que una dirección inservible no se acepta en silencio, y que
 * volver al simulador es una acción explícita.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { ok, type Project, type Result, type TelemetryMapping, type TelemetrySample, type TimeRange } from '@it360/domain';
import { makeConnection, makeMapping, makeProject, testUuid } from '@it360/domain/testing';
import { TelemetryModule } from './TelemetryModule';
import { useProjectStore } from '../state/project-store';
import type { TelemetryClient, TelemetryHistory } from '../telemetry/telemetry-client';

const CONNECTION = makeConnection(70);
const MAPPING = makeMapping(71, CONNECTION.id, testUuid(72), { variable: 'Presión de línea' });

/** Cliente inerte: estas pruebas miran el panel, no las lecturas. */
function stubClient(kind: 'backend' | 'simulated'): TelemetryClient {
  return {
    kind,
    latest: async (): Promise<Result<readonly TelemetrySample[]>> => ok([]),
    history: async (
      _mapping: TelemetryMapping,
      _range: TimeRange,
    ): Promise<Result<TelemetryHistory>> =>
      ok({ mappingId: MAPPING.id, points: [], windowSeconds: 60, fromCache: false }),
    ping: async () => ok({ reachable: true, latencyMs: 4 }),
  };
}

function project(): Project {
  return {
    ...makeProject(),
    telemetryConnections: [CONNECTION],
    telemetryMappings: [MAPPING],
  };
}

function Harness({
  endpoint,
  onChange,
  kind = 'simulated',
}: {
  readonly endpoint: string | null;
  readonly onChange: ((value: string | null) => void) | null;
  readonly kind?: 'backend' | 'simulated';
}): JSX.Element {
  const store = useProjectStore(project());
  return (
    <TelemetryModule
      store={store}
      client={stubClient(kind)}
      serviceEndpoint={endpoint}
      onServiceEndpointChange={onChange}
    />
  );
}

function renderPanel(props: {
  readonly endpoint: string | null;
  readonly onChange: ((value: string | null) => void) | null;
  readonly kind?: 'backend' | 'simulated';
}): void {
  render(
    <ToastProvider>
      <Harness {...props} />
    </ToastProvider>,
  );
}

/**
 * Valor de la fila «Origen de datos».
 *
 * Se lee por su etiqueta y no buscando el texto del distintivo: «servicio
 * local» aparece también en la ficha del historiador —como responsable de
 * resolver la credencial— y una prueba que buscase el texto suelto pasaría o
 * fallaría por el motivo equivocado.
 */
function origin(): string {
  const label = screen
    .getAllByText('Origen de datos')
    .find((node) => node.tagName.toLowerCase() === 'dt');
  const value = label?.parentElement?.querySelector('dd');
  return value?.textContent?.trim() ?? '';
}

describe('panel de conexión de telemetría', () => {
  it('rotula el origen simulado', () => {
    // TEST-TEL-053: la regla del contrato de datos es explícita: un panel con
    // números inventados tiene que decirlo. Si no, un operador toma una
    // decisión de planta con una señal que no existe.
    renderPanel({ endpoint: null, onChange: () => undefined });
    expect(origin()).toBe('simulado');
  });

  it('rotula el servicio local cuando hay dirección', () => {
    // TEST-TEL-054: y entonces no debe quedar ninguna marca de simulación, que
    // sembraría la duda sobre datos reales.
    renderPanel({ endpoint: 'http://127.0.0.1:8787', onChange: () => undefined, kind: 'backend' });
    expect(origin()).toBe('servicio local');
    expect(screen.queryByText('simulado')).toBeNull();
  });

  it('aplica una dirección válida normalizada', async () => {
    // TEST-TEL-055: la barra final se quita aquí y no en cada petición.
    const onChange = vi.fn();
    renderPanel({ endpoint: null, onChange });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dirección del servicio'), 'http://10.4.2.9:8787/');
    await user.click(screen.getByRole('button', { name: 'Conectar' }));

    expect(onChange).toHaveBeenCalledWith('http://10.4.2.9:8787');
  });

  it('no acepta una dirección con credenciales y explica por qué', async () => {
    // TEST-TEL-056: el editor no maneja credenciales de telemetría. Rechazarla
    // sin motivo dejaría al administrador probando variantes a ciegas.
    const onChange = vi.fn();
    renderPanel({ endpoint: null, onChange });
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText('Dirección del servicio'),
      'http://admin:secreto@10.4.2.9:8787',
    );
    await user.click(screen.getByRole('button', { name: 'Conectar' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('usuario');
  });

  it('advierte cuando el servicio no está en el propio equipo', () => {
    // TEST-TEL-057: con http y un servicio en red, las lecturas viajan en
    // claro. No se prohíbe —es un despliegue legítimo— pero se dice.
    renderPanel({ endpoint: 'http://10.4.2.9:8787', onChange: () => undefined, kind: 'backend' });
    expect(screen.getByText(/viajan en claro/)).toBeTruthy();
  });

  it('volver al simulador es una acción explícita', async () => {
    // TEST-TEL-058: y no se ofrece cuando ya se está usando, para que el botón
    // no sugiera un estado que no cambia.
    const onChange = vi.fn();
    renderPanel({ endpoint: 'http://127.0.0.1:8787', onChange, kind: 'backend' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Usar datos simulados' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('oculta el campo cuando el cliente viene impuesto', () => {
    // TEST-TEL-059: en la demostración y en las pruebas el cliente lo fija
    // quien monta la aplicación. Ofrecer un campo que no cambiaría nada es
    // peor que no ofrecerlo.
    renderPanel({ endpoint: null, onChange: null });
    expect(screen.queryByLabelText('Dirección del servicio')).toBeNull();
  });
});
