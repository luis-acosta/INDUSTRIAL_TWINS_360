/**
 * Catálogo de activos.
 *
 * Dos paneles: la jerarquía a la izquierda y la ficha a la derecha. El
 * criterio de la ficha es que un técnico que llega al equipo pueda responder
 * «qué es, dónde está, qué documentos tiene y cómo va» sin cambiar de
 * pantalla, porque esas cuatro preguntas son las que se hacen delante de una
 * bomba que no arranca.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  assetPath,
  currentRevision,
  DOCUMENT_STATUS_LABELS,
  HIERARCHY_LABELS,
  resolveClassAttributes,
  NOTE_STATUS_LABELS,
  type Asset,
} from '@it360/domain';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconAdd,
  IconDocument,
  IconEquipment,
  IconExternal,
  IconHistory,
  IconLayers,
  IconPanorama,
  IconSearch,
  Panel,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextInput,
  Tooltip,
  Tree,
  type TreeNode,
} from '@it360/ui';
import { AssetEditor } from './AssetEditor';
import { ClassEditor } from './ClassEditor';
import { CatalogCsvDialog } from './CatalogCsvDialog';
import type { ProjectStore } from '../state/project-store';
import type { TelemetryClient } from '../telemetry/telemetry-client';
import { useLatestTelemetry } from '../telemetry/use-telemetry';
import { Gauge } from '../components/instruments';

export interface AssetsModuleProps {
  readonly store: ProjectStore;
  readonly selectedAssetId: string | null;
  readonly onSelectAsset: (id: string) => void;
  readonly client: TelemetryClient;
  readonly onGoToLocation: (sceneId: string, hotspotId: string | null) => void;
}

export function AssetsModule({
  store,
  selectedAssetId,
  onSelectAsset,
  client,
  onGoToLocation,
}: AssetsModuleProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState('ficha');
  const [csvOpen, setCsvOpen] = useState(false);
  const [editing, setEditing] = useState<{ asset: Asset | null } | null>(null);
  const [classesOpen, setClassesOpen] = useState(false);

  const assets = store.project.assets;
  const byId = useMemo(() => new Map<string, Asset>(assets.map((a) => [a.id, a])), [assets]);
  const selected = selectedAssetId !== null ? (byId.get(selectedAssetId) ?? null) : null;

  const normalized = query.trim().toLowerCase();

  /**
   * Jerarquía filtrada.
   *
   * Cuando hay búsqueda se conservan los ancestros de cada coincidencia: un
   * resultado colgando de la nada no dice en qué unidad está el equipo, y esa
   * es justamente la información que se busca al teclear un TAG.
   */
  const treeNodes = useMemo<readonly TreeNode[]>(() => {
    const matches = (asset: Asset): boolean => {
      if (levelFilter !== 'all' && asset.level !== levelFilter) return false;
      if (normalized.length === 0) return true;
      return (
        asset.tag.toLowerCase().includes(normalized) ||
        asset.name.toLowerCase().includes(normalized) ||
        asset.manufacturer.toLowerCase().includes(normalized) ||
        asset.model.toLowerCase().includes(normalized)
      );
    };

    const visible = new Set<string>();
    for (const asset of assets) {
      if (!matches(asset)) continue;
      visible.add(asset.id);
      let parentId = asset.parentId;
      while (parentId !== null) {
        if (visible.has(parentId)) break;
        visible.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
    }

    const build = (parentId: string | null): TreeNode[] =>
      assets
        .filter((a) => a.parentId === parentId && visible.has(a.id))
        .map<TreeNode>((a) => {
          const children = build(a.id);
          return {
            id: a.id,
            label: a.name,
            meta: <span style={{ fontFamily: 'var(--it-font-mono)' }}>{a.tag}</span>,
            icon: <IconEquipment size={13} />,
            tone:
              a.criticality === 'critical'
                ? 'alarm'
                : a.criticality === 'high'
                  ? 'warning'
                  : undefined,
            ...(children.length > 0 ? { children } : {}),
          };
        });

    return build(null);
  }, [assets, byId, normalized, levelFilter]);

  // Al buscar se despliega todo: un árbol colapsado esconde el resultado.
  useEffect(() => {
    if (normalized.length > 0) setExpanded(new Set(assets.map((a) => a.id)));
  }, [normalized, assets]);

  const locations = useMemo(
    () => store.project.assetLocations.filter((l) => l.assetId === selected?.id),
    [store.project.assetLocations, selected?.id],
  );

  const documents = useMemo(
    () =>
      store.project.documents
        .filter((d) => d.assetId === selected?.id)
        .slice()
        .sort((a, b) => a.discipline.localeCompare(b.discipline) || a.title.localeCompare(b.title)),
    [store.project.documents, selected?.id],
  );

  const mappings = useMemo(
    () => store.project.telemetryMappings.filter((m) => m.assetId === selected?.id),
    [store.project.telemetryMappings, selected?.id],
  );

  const notes = useMemo(
    () => store.project.notes.filter((n) => n.assetId === selected?.id),
    [store.project.notes, selected?.id],
  );

  const { samples, now } = useLatestTelemetry(client, mappings);

  const classesById = useMemo(
    () => new Map<string, (typeof store.project.assetClasses)[number]>(store.project.assetClasses.map((c) => [c.id, c])),
    [store.project.assetClasses],
  );

  const attributes = useMemo(() => {
    if (selected === null) return [];
    return resolveClassAttributes(selected.classId, classesById).map((definition) => ({
      definition,
      value: selected.attributes[definition.key],
    }));
  }, [selected, classesById]);

  /**
   * Revisión vigente por código de documento.
   *
   * `currentRevision` razona dentro de un grupo de revisiones del mismo
   * documento, así que agrupar es responsabilidad de quien lo llama. Si no se
   * agrupa, la función compara hojas de datos con planos eléctricos y
   * «la vigente» deja de significar nada.
   */
  const currentByCode = useMemo(() => {
    const groups = new Map<string, typeof documents>();
    for (const doc of documents) {
      const key = doc.documentCode.length > 0 ? doc.documentCode : `#${doc.id}`;
      groups.set(key, [...(groups.get(key) ?? []), doc]);
    }
    const result = new Map<string, string>();
    for (const [key, group] of groups) {
      const current = currentRevision(group);
      if (current !== null) result.set(key, current.id);
    }
    return result;
  }, [documents]);

  return (
    <div className="module module--split">
      <aside className="module__aside">
        <div className="sidebar__head">
          <h2 className="sidebar__title">Activos</h2>
          <Badge tone="neutral">{assets.length}</Badge>
          <Tooltip content="Importar o exportar el catálogo en CSV">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Catálogo en CSV"
              icon={<IconDocument size={13} />}
              onClick={() => setCsvOpen(true)}
            />
          </Tooltip>
          <Tooltip content="Configurar las clases de activo y su ficha técnica">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clases de activo"
              icon={<IconLayers size={13} />}
              onClick={() => setClassesOpen(true)}
            />
          </Tooltip>
          <Tooltip content="Crear un activo nuevo">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Nuevo activo"
              icon={<IconAdd size={13} />}
              onClick={() => setEditing({ asset: null })}
            />
          </Tooltip>
        </div>

        <div className="sidebar__search">
          <TextInput
            size="sm"
            placeholder="TAG, nombre, fabricante"
            prefix={<IconSearch size={13} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Buscar activo"
          />
          <Select
            size="sm"
            value={levelFilter}
            onChange={(event) => setLevelFilter(event.currentTarget.value)}
            aria-label="Filtrar por nivel"
          >
            <option value="all">Todos los niveles</option>
            {Object.entries(HIERARCHY_LABELS).map(([level, label]) => (
              <option key={level} value={level}>
                {label}
              </option>
            ))}
          </Select>
        </div>

        <div className="sidebar__body">
          <Tree
            nodes={treeNodes}
            label="Jerarquía de activos"
            selectedId={selectedAssetId}
            expandedIds={expanded}
            onToggle={(id) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelect={onSelectAsset}
            emptyMessage={normalized.length > 0 ? 'Ningún activo coincide' : 'Sin activos registrados'}
          />
        </div>
      </aside>

      <div className="module__content">
        {selected === null ? (
          <EmptyState
            icon={<IconEquipment size={30} />}
            title="Seleccione un activo"
            description="La ficha reúne atributos, ubicaciones en el recorrido, documentos técnicos, telemetría y notas."
          />
        ) : (
          <>
            <header className="module__head">
              <div>
                <h1 className="module__title">
                  <span style={{ fontFamily: 'var(--it-font-mono)', color: 'var(--it-color-accent-default)' }}>
                    {selected.tag}
                  </span>{' '}
                  {selected.name}
                </h1>
                <p className="module__subtitle">{assetPath(selected, byId)}</p>
              </div>
              <div className="module__head-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditing({ asset: selected })}
                >
                  Editar ficha
                </Button>
                {selected.criticality !== null && (
                  <Badge
                    tone={
                      selected.criticality === 'critical'
                        ? 'alarm'
                        : selected.criticality === 'high'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    Criticidad{' '}
                    {{ low: 'baja', medium: 'media', high: 'alta', critical: 'crítica' }[selected.criticality]}
                  </Badge>
                )}
                <Badge tone={selected.status === 'published' ? 'nominal' : 'neutral'}>
                  {
                    { draft: 'Borrador', inReview: 'En revisión', published: 'Publicado', archived: 'Archivado' }[
                      selected.status
                    ]
                  }
                </Badge>
                {locations.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconPanorama size={14} />}
                    onClick={() => {
                      const primary = locations.find((l) => l.primary) ?? locations[0];
                      if (primary !== undefined) onGoToLocation(primary.sceneId, primary.hotspotId);
                    }}
                  >
                    Ver en el recorrido
                  </Button>
                )}
              </div>
            </header>

            <Tabs value={tab} onValueChange={setTab}>
              <TabList label="Ficha del activo">
                <Tab id="ficha">Ficha</Tab>
                <Tab id="ubicaciones" badge={locations.length > 0 ? locations.length : undefined}>
                  Ubicaciones
                </Tab>
                <Tab id="documentos" badge={documents.length > 0 ? documents.length : undefined}>
                  Documentos
                </Tab>
                <Tab id="telemetria" badge={mappings.length > 0 ? mappings.length : undefined}>
                  Telemetría
                </Tab>
                <Tab id="notas" badge={notes.length > 0 ? notes.length : undefined}>
                  Notas
                </Tab>
              </TabList>

              <TabPanel id="ficha">
                <div className="module__body module__grid">
                  <Panel title="Identificación" level="raised">
                    <PropertyList>
                      <PropertyRow label="TAG" mono value={selected.tag} />
                      <PropertyRow label="Nivel" value={HIERARCHY_LABELS[selected.level]} />
                      <PropertyRow label="Fabricante" value={selected.manufacturer || '—'} />
                      <PropertyRow label="Modelo" value={selected.model || '—'} />
                      <PropertyRow label="Número de serie" mono value={selected.serialNumber || '—'} />
                      <PropertyRow label="Revisión del registro" mono value={String(selected.revision)} />
                    </PropertyList>
                  </Panel>

                  <Panel title="Atributos de clase" level="raised">
                    {attributes.length === 0 ? (
                      <EmptyState title="Sin atributos definidos" description="La clase de este activo no declara atributos." />
                    ) : (
                      <PropertyList>
                        {attributes.map(({ definition, value }) => (
                          <PropertyRow
                            key={definition.key}
                            label={definition.label}
                            mono={definition.type === 'number' || definition.type === 'text'}
                            tone={value === undefined && definition.required ? 'alarm' : undefined}
                            value={
                              value === undefined
                                ? definition.required
                                  ? 'obligatorio y vacío'
                                  : '—'
                                : formatAttribute(value, definition.unit)
                            }
                          />
                        ))}
                      </PropertyList>
                    )}
                  </Panel>

                  {selected.description.length > 0 && (
                    <Panel title="Descripción" level="raised" style={{ gridColumn: '1 / -1' }}>
                      <p style={{ margin: 0, fontSize: 'var(--it-text-sm)', lineHeight: 1.6 }}>
                        {selected.description}
                      </p>
                    </Panel>
                  )}
                </div>
              </TabPanel>

              <TabPanel id="ubicaciones">
                <div className="module__body">
                  {locations.length === 0 ? (
                    <EmptyState
                      icon={<IconPanorama size={26} />}
                      title="Sin ubicaciones"
                      description="Este activo no está señalado en ninguna escena del recorrido."
                    />
                  ) : (
                    <DataTable
                      label="Ubicaciones del activo"
                      rows={locations}
                      rowKey={(row) => row.id}
                      columns={[
                        {
                          id: 'scene',
                          header: 'Escena',
                          render: (row) =>
                            store.project.scenes.find((s) => s.id === row.sceneId)?.title ?? 'escena inexistente',
                        },
                        {
                          id: 'hotspot',
                          header: 'Marcador',
                          render: (row) => {
                            if (row.hotspotId === null) return '—';
                            const scene = store.project.scenes.find((s) => s.id === row.sceneId);
                            return scene?.hotspots.find((h) => h.id === row.hotspotId)?.name ?? 'marcador inexistente';
                          },
                        },
                        {
                          id: 'primary',
                          header: 'Preferente',
                          width: '100px',
                          render: (row) => (row.primary ? <Badge tone="accent">Sí</Badge> : '—'),
                        },
                        { id: 'note', header: 'Nota', render: (row) => row.note || '—' },
                        {
                          id: 'go',
                          header: '',
                          width: '48px',
                          align: 'end',
                          render: (row) => (
                            <Tooltip content="Abrir en el recorrido">
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                icon={<IconExternal size={13} />}
                                aria-label="Abrir en el recorrido"
                                onClick={() => onGoToLocation(row.sceneId, row.hotspotId)}
                              />
                            </Tooltip>
                          ),
                        },
                      ]}
                    />
                  )}
                </div>
              </TabPanel>

              <TabPanel id="documentos">
                <div className="module__body">
                  {documents.length === 0 ? (
                    <EmptyState
                      icon={<IconDocument size={26} />}
                      title="Sin documentos"
                      description="Asocie planos, hojas de datos y manuales para que estén a mano desde el recorrido."
                    />
                  ) : (
                    <DataTable
                      label="Documentos técnicos"
                      rows={documents}
                      rowKey={(row) => row.id}
                      columns={[
                        {
                          id: 'code',
                          header: 'Código',
                          mono: true,
                          width: '160px',
                          render: (row) => row.documentCode || '—',
                        },
                        { id: 'title', header: 'Título', render: (row) => row.title },
                        {
                          id: 'discipline',
                          header: 'Disciplina',
                          width: '140px',
                          render: (row) => DISCIPLINE_LABELS[row.discipline],
                        },
                        { id: 'revision', header: 'Rev.', mono: true, width: '80px', render: (row) => row.revision || '—' },
                        {
                          id: 'status',
                          header: 'Estado',
                          width: '150px',
                          render: (row) => {
                            const key = row.documentCode.length > 0 ? row.documentCode : `#${row.id}`;
                            const vigente = currentByCode.get(key) === row.id;
                            return (
                              <span style={{ display: 'inline-flex', gap: 'var(--it-space-1)', alignItems: 'center' }}>
                                <Badge
                                  tone={
                                    row.status === 'approved'
                                      ? 'nominal'
                                      : row.status === 'superseded' || row.status === 'obsolete'
                                        ? 'warning'
                                        : 'neutral'
                                  }
                                >
                                  {DOCUMENT_STATUS_LABELS[row.status]}
                                </Badge>
                                {vigente && <Badge tone="accent">vigente</Badge>}
                              </span>
                            );
                          },
                        },
                      ]}
                    />
                  )}
                </div>
              </TabPanel>

              <TabPanel id="telemetria">
                <div className="module__body">
                  {mappings.length === 0 ? (
                    <EmptyState
                      icon={<IconHistory size={26} />}
                      title="Sin variables asociadas"
                      description="Vincule variables de InfluxDB para mostrar el estado del equipo en el recorrido."
                    />
                  ) : (
                    <>
                      <SectionLabel>
                        Lectura actual
                        {client.kind === 'simulated' && <Badge tone="experimental">simulado</Badge>}
                      </SectionLabel>
                      <div className="module__grid module__grid--instruments">
                        {mappings.map((mapping) => (
                          <Gauge
                            key={mapping.id}
                            mapping={mapping}
                            sample={samples.find((s) => s.mappingId === mapping.id)}
                            rules={store.project.conditionRules.filter((r) => r.mappingId === mapping.id)}
                            now={now}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </TabPanel>

              <TabPanel id="notas">
                <div className="module__body">
                  {notes.length === 0 ? (
                    <EmptyState title="Sin notas" description="No hay observaciones registradas sobre este activo." />
                  ) : (
                    <DataTable
                      label="Notas del activo"
                      rows={notes}
                      rowKey={(row) => row.id}
                      columns={[
                        { id: 'title', header: 'Asunto', render: (row) => row.title },
                        {
                          id: 'status',
                          header: 'Estado',
                          width: '130px',
                          render: (row) => (
                            <Badge tone={row.status === 'resolved' ? 'nominal' : 'warning'}>
                              {NOTE_STATUS_LABELS[row.status]}
                            </Badge>
                          ),
                        },
                        {
                          id: 'priority',
                          header: 'Prioridad',
                          width: '110px',
                          render: (row) => row.priority,
                        },
                        {
                          id: 'due',
                          header: 'Vence',
                          mono: true,
                          width: '120px',
                          render: (row) => (row.dueDate === null ? '—' : row.dueDate.slice(0, 10)),
                        },
                      ]}
                    />
                  )}
                </div>
              </TabPanel>
            </Tabs>
          </>
        )}
      </div>

      <CatalogCsvDialog open={csvOpen} onClose={() => setCsvOpen(false)} store={store} />

      <ClassEditor open={classesOpen} onClose={() => setClassesOpen(false)} store={store} />

      <AssetEditor
        open={editing !== null}
        onClose={() => setEditing(null)}
        store={store}
        asset={editing?.asset ?? null}
        // Al crear, el nodo seleccionado es el padre más probable: el autor
        // suele estar mirando la unidad a la que va a añadir el equipo.
        suggestedParentId={selected?.id ?? null}
        onSaved={onSelectAsset}
      />
    </div>
  );
}

const DISCIPLINE_LABELS: Readonly<Record<string, string>> = {
  process: 'Proceso',
  mechanical: 'Mecánica',
  electrical: 'Eléctrica',
  instrumentation: 'Instrumentación',
  civil: 'Civil',
  safety: 'Seguridad',
  other: 'Otra',
};

function formatAttribute(value: unknown, unit: string | null | undefined): string {
  if (typeof value === 'number') return unit != null && unit !== '' ? `${value} ${unit}` : String(value);
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (value === null) return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
