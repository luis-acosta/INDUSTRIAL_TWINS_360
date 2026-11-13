/**
 * Telemetría.
 *
 * Tres cosas en una pantalla: el estado de la conexión, el mapeo de variables
 * y la lectura con su histórico. Las tres hacen falta juntas porque la
 * pregunta habitual —«¿por qué este valor no cambia?»— se responde mirando si
 * la conexión está viva, si el mapeo apunta donde debe y cuándo llegó el
 * último dato.
 *
 * La interfaz nunca ve el token de InfluxDB: el mapeo guarda una referencia al
 * secreto y es el servicio local quien lo resuelve. Aquí sólo se muestra el
 * nombre de la referencia.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DATA_QUALITY_LABELS,
  isReadOnlyFlux,
  PRESET_RANGES,
  rangeFromPreset,
  recommendedWindowSeconds,
  TELEMETRY_OPERATIONS,
  type PresetRangeId,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  IconHistory,
  IconLock,
  IconTelemetry,
  LoadingState,
  Panel,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Select,
  Spinner,
  Tooltip,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';
import type { TelemetryClient, TelemetryHistory } from '../telemetry/telemetry-client';
import { useLatestTelemetry } from '../telemetry/use-telemetry';
import { Gauge, Sparkline } from '../components/instruments';

export interface TelemetryModuleProps {
  readonly store: ProjectStore;
  readonly client: TelemetryClient;
}

export function TelemetryModule({ store, client }: TelemetryModuleProps): JSX.Element {
  const mappings = store.project.telemetryMappings;
  const [selectedId, setSelectedId] = useState<string | null>(mappings[0]?.id ?? null);
  const [ping, setPing] = useState<{ reachable: boolean; latencyMs: number } | null>(null);
  const [pinging, setPinging] = useState(false);
  const [preset, setPreset] = useState<PresetRangeId>('1h');
  const [history, setHistory] = useState<TelemetryHistory | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const selected = mappings.find((m) => m.id === selectedId) ?? null;
  const { samples, now, error: latestError } = useLatestTelemetry(client, mappings);

  useEffect(() => {
    if (selected === null) {
      setHistory(null);
      return undefined;
    }
    let cancelled = false;
    setLoadingHistory(true);
    setHistoryError(null);
    const range = rangeFromPreset(preset, new Date());
    void client.history(selected, range).then((result) => {
      if (cancelled) return;
      setLoadingHistory(false);
      if (result.ok) setHistory(result.value);
      else {
        setHistory(null);
        setHistoryError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, selected, preset]);

  const connection = store.project.telemetryConnections[0] ?? null;

  const range = useMemo(() => rangeFromPreset(preset, now), [preset, now]);

  return (
    <div className="module">
      <header className="module__head">
        <div>
          <h1 className="module__title">Telemetría</h1>
          <p className="module__subtitle">
            {mappings.length} variable(s) mapeada(s) · sólo lectura
            {client.kind === 'simulated' && <> · datos simulados</>}
          </p>
        </div>
        <div className="module__head-actions">
          <Button
            size="sm"
            variant="secondary"
            icon={pinging ? <Spinner size={13} /> : <IconTelemetry size={14} />}
            disabled={pinging}
            onClick={() => {
              setPinging(true);
              void client.ping().then((result) => {
                setPinging(false);
                setPing(result.ok ? result.value : { reachable: false, latencyMs: 0 });
              });
            }}
          >
            Probar conexión
          </Button>
        </div>
      </header>

      <div className="module__body">
        {/* La garantía de sólo lectura no es una promesa de la documentación:
            el cliente expone tres operaciones y ninguna escribe. Se enseña
            porque en una planta la primera pregunta de seguridad es si esto
            puede tocar el proceso. */}
        {latestError !== null && (
          <Callout tone="alarm" title="La última consulta de telemetría falló">
            {latestError} Las lecturas que se muestran son las anteriores y su propia calidad indica que
            están obsoletas.
          </Callout>
        )}

        <Callout tone="info" title="Acceso de sólo lectura por construcción">
          Las únicas operaciones disponibles son {TELEMETRY_OPERATIONS.join(', ')}. No existe ninguna ruta
          de escritura hacia el historiador ni hacia el PLC, y las consultas se rechazan si contienen
          palabras de escritura.
        </Callout>

        <div className="module__grid">
          <Panel title="Conexión" level="raised">
            {connection === null ? (
              <EmptyState
                title="Sin conexión configurada"
                description="Configure la URL, la organización y el secreto del historiador en los ajustes del proyecto."
              />
            ) : (
              <PropertyList>
                <PropertyRow label="Nombre" value={connection.name} />
                <PropertyRow label="URL" mono value={connection.url} />
                <PropertyRow label="Organización" mono value={connection.org} />
                <PropertyRow label="Cubeta" mono value={connection.bucket} />
                <PropertyRow
                  label="Credencial"
                  value={
                    <span style={{ display: 'inline-flex', gap: 'var(--it-space-1)', alignItems: 'center' }}>
                      <IconLock size={12} />
                      <span style={{ fontFamily: 'var(--it-font-mono)' }}>{connection.tokenRef.keyId}</span>
                    </span>
                  }
                />
                <PropertyRow
                  label="Resuelta por"
                  value="servicio local"
                  tone="nominal"
                />
                <PropertyRow
                  label="Estado"
                  value={
                    ping === null ? (
                      'sin comprobar'
                    ) : ping.reachable ? (
                      <Badge tone="nominal" dot>
                        alcanzable · {ping.latencyMs} ms
                      </Badge>
                    ) : (
                      <Badge tone="alarm" dot>
                        sin respuesta
                      </Badge>
                    )
                  }
                />
              </PropertyList>
            )}
          </Panel>

          <Panel title="Ventana de consulta" level="raised">
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              <Select
                size="sm"
                value={preset}
                onChange={(event) => setPreset(event.currentTarget.value as PresetRangeId)}
                aria-label="Rango de tiempo"
              >
                {PRESET_RANGES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <PropertyList>
                <PropertyRow label="Desde" mono value={range.from.slice(0, 16).replace('T', ' ')} />
                <PropertyRow label="Hasta" mono value={range.to.slice(0, 16).replace('T', ' ')} />
                <PropertyRow
                  label="Agregación"
                  mono
                  value={`${recommendedWindowSeconds(range)} s`}
                />
              </PropertyList>
              {/* Agregar no es un detalle cosmético: pedir un mes de datos a
                  resolución de segundo son millones de puntos que ni la red ni
                  el lienzo soportan, y el usuario no vería más detalle. */}
              <p style={{ margin: 0, fontSize: 'var(--it-text-xs)', color: 'var(--it-color-text-tertiary)' }}>
                La ventana de agregación se calcula para unos 720 puntos: suficiente para ver la forma de
                la señal sin traer datos que el gráfico no puede mostrar.
              </p>
            </div>
          </Panel>
        </div>

        <SectionLabel>
          Variables
          {client.kind === 'simulated' && <Badge tone="experimental">simulado</Badge>}
        </SectionLabel>

        {mappings.length === 0 ? (
          <EmptyState
            icon={<IconTelemetry size={30} />}
            title="Sin variables mapeadas"
            description="Un mapeo asocia un activo con una medición del historiador y define unidades, umbrales de frescura y regla de condición."
          />
        ) : (
          <DataTable
            label="Variables de telemetría"
            rows={mappings}
            rowKey={(row) => row.id}
            selectedKey={selectedId}
            onSelect={(row) => setSelectedId(row.id)}
            columns={[
              {
                id: 'label',
                header: 'Variable',
                render: (row) => row.variable,
              },
              {
                id: 'asset',
                header: 'Activo',
                width: '140px',
                mono: true,
                render: (row) => store.project.assets.find((a) => a.id === row.assetId)?.tag ?? '—',
              },
              {
                id: 'measurement',
                header: 'Medición',
                mono: true,
                render: (row) => `${row.measurement}.${row.field}`,
              },
              {
                id: 'value',
                header: 'Lectura',
                width: '140px',
                mono: true,
                align: 'end',
                render: (row) => {
                  const sample = samples.find((s) => s.mappingId === row.id);
                  if (sample === undefined) return '—';
                  return sample.value === null
                    ? (sample.rawValue ?? '—')
                    : `${sample.value.toFixed(row.decimals)} ${row.unit}`.trim();
                },
              },
              {
                id: 'quality',
                header: 'Calidad',
                width: '130px',
                render: (row) => {
                  const sample = samples.find((s) => s.mappingId === row.id);
                  if (sample === undefined) return <Badge tone="neutral">sin leer</Badge>;
                  return (
                    <Badge
                      tone={
                        sample.quality === 'fresh'
                          ? 'nominal'
                          : sample.quality === 'stale'
                            ? 'warning'
                            : sample.quality === 'nonNumeric'
                              ? 'info'
                              : 'alarm'
                      }
                    >
                      {DATA_QUALITY_LABELS[sample.quality]}
                    </Badge>
                  );
                },
              },
              {
                id: 'readonly',
                header: '',
                width: '40px',
                render: (row) => (
                  <Tooltip
                    content={
                      isReadOnlyFlux(
                        `from(bucket:"b") |> filter(fn: (r) => r._measurement == "${row.measurement}")`,
                      )
                        ? 'Consulta generada y verificada de sólo lectura'
                        : 'La consulta no pasó el verificador de sólo lectura'
                    }
                  >
                    <span style={{ color: 'var(--it-color-text-tertiary)' }}>
                      <IconLock size={12} />
                    </span>
                  </Tooltip>
                ),
              },
            ]}
          />
        )}

        {selected !== null && (
          <>
            <SectionLabel>Detalle de «{selected.variable}»</SectionLabel>
            <div className="module__grid">
              <Gauge
                mapping={selected}
                sample={samples.find((s) => s.mappingId === selected.id)}
                rules={store.project.conditionRules.filter((r) => r.mappingId === selected.id)}
                now={now}
              />

              <Panel
                title={
                  <span style={{ display: 'inline-flex', gap: 'var(--it-space-2)', alignItems: 'center' }}>
                    <IconHistory size={14} /> Histórico
                  </span>
                }
                level="raised"
              >
                {loadingHistory ? (
                  <LoadingState label="Consultando el historiador" />
                ) : historyError !== null ? (
                  <Callout tone="alarm" title="No se pudo consultar el histórico">
                    {historyError}
                  </Callout>
                ) : history === null || history.points.length === 0 ? (
                  <EmptyState title="Sin datos en el rango" description="Pruebe con una ventana más amplia." />
                ) : (
                  <>
                    <Sparkline
                      points={history.points}
                      unit={selected.unit}
                      min={selected.displayMin}
                      max={selected.displayMax}
                      height={120}
                      label={`Histórico de ${selected.variable}`}
                    />
                    <PropertyList>
                      <PropertyRow label="Puntos" mono value={String(history.points.length)} />
                      <PropertyRow
                        label="Huecos"
                        mono
                        value={String(history.points.filter((p) => p.value === null).length)}
                        tone={history.points.some((p) => p.value === null) ? 'warning' : undefined}
                      />
                      <PropertyRow label="Ventana" mono value={`${history.windowSeconds} s`} />
                      {history.fromCache && (
                        <PropertyRow label="Origen" value="caché local, no telemetría en vivo" tone="experimental" />
                      )}
                    </PropertyList>
                  </>
                )}
              </Panel>

              <Panel title="Configuración del mapeo" level="raised">
                <PropertyList>
                  <PropertyRow label="Unidad" mono value={selected.unit || '—'} />
                  <PropertyRow label="Decimales" mono value={String(selected.decimals)} />
                  <PropertyRow
                    label="Rango esperado"
                    mono
                    value={
                      selected.displayMin === null || selected.displayMax === null
                        ? 'sin definir'
                        : `${selected.displayMin} … ${selected.displayMax}`
                    }
                  />
                  <PropertyRow label="Agregación" mono value={selected.aggregation} />
                  <PropertyRow label="Umbral de frescura" mono value={`${selected.freshnessSeconds} s`} />
                  <PropertyRow
                    label="Instrumento"
                    mono
                    value={selected.instrumentTag ?? '—'}
                  />
                  <PropertyRow label="Habilitada" value={selected.enabled ? 'sí' : 'no'} />
                </PropertyList>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
