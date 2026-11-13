/**
 * Editor de activos (X01–X04, X07).
 *
 * Es la pantalla que convierte el catálogo en algo que el autor puede
 * construir, y no sólo consultar. Cuatro pestañas, una por pregunta que el
 * autor tiene delante:
 *
 * - **Identificación** — qué es y dónde encaja en la jerarquía.
 * - **Ficha técnica** — los atributos que su clase declara (X03).
 * - **Ubicaciones** — desde qué panorámicas se ve (X04).
 * - **Documentos** — qué planos y hojas de datos lleva, y cuál es la
 *   revisión vigente (X07).
 *
 * La validación no vive aquí: está en `@it360/domain/asset-draft`, probada
 * aparte, y este componente sólo la pinta. El criterio de reparto es que una
 * regla que decide si un activo es admisible la van a necesitar también la
 * importación y el servidor, y tenerla duplicada en un componente de React
 * sería garantizar que divergen.
 *
 * Los problemas se separan en bloqueantes y avisos: un TAG duplicado rompe la
 * búsqueda y la telemetría, así que impide guardar; un activo publicado sin
 * fabricante está incompleto pero es real, y bloquearlo obligaría al autor a
 * inventarse un dato para seguir.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  canSaveDraft,
  DOCUMENT_STATUS_LABELS,
  draftFromAsset,
  draftToAsset,
  eligibleParents,
  emptyDraft,
  HIERARCHY_LABELS,
  HIERARCHY_LEVELS,
  assetPath,
  currentRevision,
  newUuid,
  problemsFor,
  resolveClassAttributes,
  validateAssetDraft,
  type Asset,
  type AssetDraft,
  type AssetLocation,
  type AttributeDefinition,
  type AttributeValue,
  type DraftProblem,
  type HierarchyLevel,
  type TechnicalDocument,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface AssetEditorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: ProjectStore;
  /** Activo a editar, o `null` para crear uno nuevo. */
  readonly asset: Asset | null;
  /** Padre sugerido al crear: el nodo seleccionado en el árbol. */
  readonly suggestedParentId: Uuid | null;
  readonly onSaved: (assetId: Uuid) => void;
}

const CRITICALITY_LABELS: Readonly<Record<string, string>> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

const STATUS_LABELS: Readonly<Record<Asset['status'], string>> = {
  draft: 'Borrador',
  inReview: 'En revisión',
  published: 'Publicado',
  archived: 'Archivado',
};

const DISCIPLINE_LABELS: Readonly<Record<string, string>> = {
  process: 'Proceso',
  mechanical: 'Mecánica',
  electrical: 'Eléctrica',
  instrumentation: 'Instrumentación',
  civil: 'Civil',
  safety: 'Seguridad',
  other: 'Otra',
};

export function AssetEditor({
  open,
  onClose,
  store,
  asset,
  suggestedParentId,
  onSaved,
}: AssetEditorProps): JSX.Element {
  const project = store.project;
  const fallbackClass = project.assetClasses[0];

  const [draft, setDraft] = useState<AssetDraft>(() =>
    asset !== null
      ? draftFromAsset(asset)
      : emptyDraft({
          level: 'equipment',
          parentId: suggestedParentId,
          classId: fallbackClass?.id ?? newUuid(),
        }),
  );
  const [tab, setTab] = useState('identificacion');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Al abrir con otro activo se recarga el borrador: dejar el anterior haría
  // que el autor editase una ficha creyendo que es otra.
  useEffect(() => {
    if (!open) return;
    setDraft(
      asset !== null
        ? draftFromAsset(asset)
        : emptyDraft({
            level: 'equipment',
            parentId: suggestedParentId,
            classId: fallbackClass?.id ?? newUuid(),
          }),
    );
    setTab('identificacion');
  }, [open, asset, suggestedParentId, fallbackClass?.id]);

  const problems = useMemo(
    () =>
      validateAssetDraft(draft, {
        assets: project.assets,
        classes: project.assetClasses,
        uniquenessScope: project.settings.tagUniquenessScope,
      }),
    [draft, project.assets, project.assetClasses, project.settings.tagUniquenessScope],
  );

  const savable = canSaveDraft(problems);
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const advisories = problems.filter((p) => p.severity === 'advisory');

  const classesById = useMemo(
    () => new Map(project.assetClasses.map((c) => [c.id as string, c])),
    [project.assetClasses],
  );

  const attributeDefs = useMemo<readonly AttributeDefinition[]>(
    () => resolveClassAttributes(draft.classId, classesById),
    [draft.classId, classesById],
  );

  const parents = useMemo(() => eligibleParents(draft, project.assets), [draft, project.assets]);

  const byId = useMemo(
    () => new Map(project.assets.map((a) => [a.id as string, a])),
    [project.assets],
  );

  const locations = useMemo(
    () => project.assetLocations.filter((l) => l.assetId === draft.id),
    [project.assetLocations, draft.id],
  );

  const documents = useMemo(
    () => project.documents.filter((d) => d.assetId === draft.id),
    [project.documents, draft.id],
  );

  const vigente = useMemo(() => {
    const groups = new Map<string, TechnicalDocument[]>();
    for (const doc of documents) {
      const key = doc.documentCode.length > 0 ? doc.documentCode : `#${doc.id}`;
      groups.set(key, [...(groups.get(key) ?? []), doc]);
    }
    const ids = new Set<string>();
    for (const group of groups.values()) {
      const current = currentRevision(group);
      if (current !== null) ids.add(current.id);
    }
    return ids;
  }, [documents]);

  const set = <K extends keyof AssetDraft>(key: K, value: AssetDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const setAttribute = (key: string, value: AttributeValue): void =>
    setDraft((current) => ({ ...current, attributes: { ...current.attributes, [key]: value } }));

  /**
   * Cambiar el nivel reajusta el padre.
   *
   * Subir un equipo a planta deja un padre que ya no es admisible, y dejarlo
   * puesto produciría un error que el autor no provocó directamente. Se limpia
   * cuando deja de valer, y se conserva cuando sigue valiendo.
   */
  const changeLevel = (level: HierarchyLevel): void => {
    setDraft((current) => {
      const next: AssetDraft = { ...current, level };
      if (level === 'plant') return { ...next, parentId: null };
      const stillValid = eligibleParents(next, project.assets).some(
        (candidate) => candidate.id === current.parentId,
      );
      return stillValid ? next : { ...next, parentId: null };
    });
  };

  const onSave = (): void => {
    if (!savable) return;
    const now = new Date().toISOString();
    const built = draftToAsset(draft, {
      projectId: project.id,
      previous: asset,
      now,
      newId: newUuid(),
    });
    // El TAG es lo único que esta conversión no puede arreglar; si el dominio
    // lo rechaza, no se escribe nada y el error se queda junto al campo.
    if (!built.ok) return;
    const result = built.value;

    const assets =
      asset === null
        ? [...project.assets, result]
        : project.assets.map((a) => (a.id === result.id ? result : a));

    store.updateProject(
      asset === null ? `Crear activo ${result.tag}` : `Editar activo ${result.tag}`,
      { assets },
    );
    onSaved(result.id);
    onClose();
  };

  /**
   * Elimina el activo y lo que cuelga de él.
   *
   * Se borran también sus ubicaciones y se desvinculan sus documentos: dejar
   * una ubicación apuntando a un activo inexistente produce un marcador que
   * falla en el visor publicado, y el autor no tendría forma de saber por qué.
   */
  const onDelete = (): void => {
    if (asset === null) return;

    const descendants = new Set<string>([asset.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of project.assets) {
        if (
          candidate.parentId !== null &&
          descendants.has(candidate.parentId) &&
          !descendants.has(candidate.id)
        ) {
          descendants.add(candidate.id);
          grew = true;
        }
      }
    }

    store.updateProject(`Eliminar activo ${asset.tag}`, {
      assets: project.assets.filter((a) => !descendants.has(a.id)),
      assetLocations: project.assetLocations.filter((l) => !descendants.has(l.assetId)),
      documents: project.documents.map((d) =>
        d.assetId !== null && descendants.has(d.assetId) ? { ...d, assetId: null } : d,
      ),
      // Una asignación de telemetría exige un activo, así que las del activo
      // borrado se eliminan: dejarlas apuntando a la nada haría que el panel
      // mostrara una variable sin equipo al que pertenecer.
      telemetryMappings: project.telemetryMappings.filter((m) => !descendants.has(m.assetId)),
    });
    setConfirmDelete(false);
    onClose();
  };

  /** Añade una ubicación en la escena elegida, centrada en su vista inicial. */
  const addLocation = (sceneId: Uuid): void => {
    if (draft.id === null) return;
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (scene === undefined) return;

    const location: AssetLocation = {
      id: newUuid(),
      assetId: draft.id,
      sceneId,
      hotspotId: null,
      anchor: {
        space: 'spherical',
        yaw: scene.camera.initialView.yaw,
        pitch: scene.camera.initialView.pitch,
      },
      // La primera ubicación es la preferente; las siguientes, no, para no
      // cambiar en silencio a dónde lleva «ir al activo».
      primary: locations.length === 0,
      note: '',
    };

    store.updateProject(`Ubicar ${draft.tag} en ${scene.title}`, {
      assetLocations: [...project.assetLocations, location],
    });
  };

  const removeLocation = (locationId: Uuid): void => {
    store.updateProject('Quitar ubicación del activo', {
      assetLocations: project.assetLocations.filter((l) => l.id !== locationId),
    });
  };

  /** Marca una ubicación como preferente, quitando la marca a las demás. */
  const makePrimary = (locationId: Uuid): void => {
    store.updateProject('Cambiar ubicación preferente', {
      assetLocations: project.assetLocations.map((l) =>
        l.assetId === draft.id ? { ...l, primary: l.id === locationId } : l,
      ),
    });
  };

  const linkDocument = (mediaId: Uuid): void => {
    if (draft.id === null) return;
    const media = project.media.find((m) => m.id === mediaId);
    if (media === undefined) return;

    const document: TechnicalDocument = {
      id: newUuid(),
      assetId: draft.id,
      title: media.originalName,
      documentCode: '',
      revision: '',
      // Entra como borrador y no como aprobado: aprobar un plano es una
      // decisión de ingeniería, no un efecto de haberlo adjuntado.
      status: 'draft',
      mediaId,
      discipline: 'other',
      issuedAt: null,
      supersededById: null,
      createdAt: new Date().toISOString(),
    };

    store.updateProject(`Adjuntar documento a ${draft.tag}`, {
      documents: [...project.documents, document],
    });
  };

  const updateDocument = (id: Uuid, patch: Partial<TechnicalDocument>): void => {
    store.updateProject(
      'Editar documento del activo',
      { documents: project.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)) },
      `document.${id}`,
    );
  };

  const unlinkDocument = (id: Uuid): void => {
    store.updateProject('Desvincular documento', {
      documents: project.documents.map((d) => (d.id === id ? { ...d, assetId: null } : d)),
    });
  };

  const fieldError = (field: string): string | undefined => {
    const found = problemsFor(problems, field).filter((p) => p.severity === 'blocking');
    return found[0]?.message;
  };

  const fieldHint = (field: string, fallback?: string): string | undefined => {
    const advisory = problemsFor(problems, field).filter((p) => p.severity === 'advisory');
    return advisory[0]?.message ?? fallback;
  };

  const sinEscenas = project.scenes.length === 0;
  const docCandidates = project.media.filter(
    (m) => m.kind === 'document' && !documents.some((d) => d.mediaId === m.id),
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={asset === null ? 'Nuevo activo' : `Editar ${asset.tag}`}
        description={
          asset === null
            ? 'Un activo necesita TAG, nombre, nivel y clase. El resto se puede completar después.'
            : assetPath(asset, byId)
        }
        size="xl"
        footer={
          <>
            {asset !== null && (
              <Button
                variant="danger"
                onClick={() => setConfirmDelete(true)}
                style={{ marginRight: 'auto' }}
              >
                Eliminar
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={onSave} disabled={!savable}>
              {asset === null ? 'Crear activo' : 'Guardar cambios'}
            </Button>
          </>
        }
      >
        <div className="asset-editor">
          {!savable && (
            <Callout tone="warning" title="Falta algo para poder guardar">
              <ul className="asset-editor__problems">
                {blocking.map((problem: DraftProblem) => (
                  <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
                ))}
              </ul>
            </Callout>
          )}

          {savable && advisories.length > 0 && (
            <Callout tone="info" title="Se puede guardar, con estas observaciones">
              <ul className="asset-editor__problems">
                {advisories.map((problem) => (
                  <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
                ))}
              </ul>
            </Callout>
          )}

          <Tabs value={tab} onValueChange={setTab}>
            <TabList label="Secciones del activo">
              <Tab id="identificacion">Identificación</Tab>
              <Tab id="ficha">
                Ficha técnica{' '}
                {attributeDefs.length > 0 && <Badge tone="neutral">{attributeDefs.length}</Badge>}
              </Tab>
              <Tab id="ubicaciones">
                Ubicaciones {locations.length > 0 && <Badge tone="neutral">{locations.length}</Badge>}
              </Tab>
              <Tab id="documentos">
                Documentos {documents.length > 0 && <Badge tone="neutral">{documents.length}</Badge>}
              </Tab>
            </TabList>

            {/* ---------------- Identificación ---------------- */}

            <TabPanel id="identificacion">
              <div className="asset-editor__grid">
                <Field
                  label="TAG industrial"
                  required
                  error={fieldError('tag')}
                  hint="Mayúsculas, dígitos y los separadores - _ / ."
                >
                  {({ id, describedBy, invalid }) => (
                    <TextInput
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={draft.tag}
                      mono
                      onChange={(event) => set('tag', event.currentTarget.value)}
                    />
                  )}
                </Field>

                <Field label="Nombre" required error={fieldError('name')}>
                  {({ id, describedBy, invalid }) => (
                    <TextInput
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={draft.name}
                      onChange={(event) => set('name', event.currentTarget.value)}
                    />
                  )}
                </Field>

                <Field label="Nivel" required>
                  {({ id }) => (
                    <Select
                      id={id}
                      value={draft.level}
                      onChange={(event) =>
                        changeLevel(event.currentTarget.value as HierarchyLevel)
                      }
                    >
                      {HIERARCHY_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {HIERARCHY_LABELS[level]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  label="Elemento superior"
                  required={draft.level !== 'plant'}
                  error={fieldError('parentId')}
                  hint={
                    draft.level === 'plant'
                      ? 'Una planta es la raíz de la jerarquía.'
                      : `Sólo se ofrecen niveles por encima de «${HIERARCHY_LABELS[draft.level]}».`
                  }
                >
                  {({ id, describedBy, invalid }) => (
                    <Select
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={draft.parentId ?? ''}
                      disabled={draft.level === 'plant'}
                      onChange={(event) =>
                        set(
                          'parentId',
                          event.currentTarget.value === ''
                            ? null
                            : (event.currentTarget.value as Uuid),
                        )
                      }
                    >
                      <option value="">— sin elegir —</option>
                      {parents.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {HIERARCHY_LABELS[candidate.level]} · {candidate.tag} — {candidate.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  label="Clase de activo"
                  required
                  error={fieldError('classId')}
                  hint={fieldHint('classId', 'Determina los atributos de la ficha técnica.')}
                >
                  {({ id, describedBy, invalid }) => (
                    <Select
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={draft.classId}
                      onChange={(event) => set('classId', event.currentTarget.value as Uuid)}
                    >
                      {project.assetClasses.map((assetClass) => (
                        <option key={assetClass.id} value={assetClass.id}>
                          {assetClass.name} ({assetClass.code})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label="Criticidad" hint="La declara el cliente; ordena notas y alarmas.">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={draft.criticality ?? ''}
                      onChange={(event) =>
                        set(
                          'criticality',
                          event.currentTarget.value === ''
                            ? null
                            : (event.currentTarget.value as Asset['criticality']),
                        )
                      }
                    >
                      <option value="">— sin declarar —</option>
                      {Object.entries(CRITICALITY_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label="Estado del registro">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={draft.status}
                      onChange={(event) =>
                        set('status', event.currentTarget.value as Asset['status'])
                      }
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label="Fabricante" hint={fieldHint('manufacturer')}>
                  {({ id, describedBy }) => (
                    <TextInput
                      id={id}
                      aria-describedby={describedBy}
                      value={draft.manufacturer}
                      onChange={(event) => set('manufacturer', event.currentTarget.value)}
                    />
                  )}
                </Field>

                <Field label="Modelo">
                  {({ id }) => (
                    <TextInput
                      id={id}
                      value={draft.model}
                      onChange={(event) => set('model', event.currentTarget.value)}
                    />
                  )}
                </Field>

                <Field label="Número de serie">
                  {({ id }) => (
                    <TextInput
                      id={id}
                      mono
                      value={draft.serialNumber}
                      onChange={(event) => set('serialNumber', event.currentTarget.value)}
                    />
                  )}
                </Field>
              </div>

              <Field label="Observaciones">
                {({ id }) => (
                  <TextArea
                    id={id}
                    rows={3}
                    value={draft.description}
                    onChange={(event) => set('description', event.currentTarget.value)}
                  />
                )}
              </Field>
            </TabPanel>

            {/* ---------------- Ficha técnica (X03) ---------------- */}

            <TabPanel id="ficha">
              {attributeDefs.length === 0 ? (
                <EmptyState
                  title="La clase no declara atributos"
                  description="La ficha técnica se define en la clase de activo. Elija otra clase o añada atributos a esta."
                />
              ) : (
                <div className="asset-editor__attributes">
                  {groupAttributes(attributeDefs).map(([group, definitions]) => (
                    <section key={group} className="asset-editor__group">
                      <SectionLabel>{group}</SectionLabel>
                      <div className="asset-editor__grid">
                        {definitions.map((definition) => (
                          <AttributeField
                            key={definition.key}
                            definition={definition}
                            value={draft.attributes[definition.key] ?? null}
                            error={fieldError(`attributes.${definition.key}`)}
                            onChange={(value) => setAttribute(definition.key, value)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </TabPanel>

            {/* ---------------- Ubicaciones (X04) ---------------- */}

            <TabPanel id="ubicaciones">
              {draft.id === null ? (
                <EmptyState
                  title="Primero cree el activo"
                  description="Las ubicaciones se enlazan a un activo que ya existe. Guarde y vuelva a abrir la ficha."
                />
              ) : (
                <div className="asset-editor__section">
                  <p className="asset-editor__hint">
                    Un mismo activo puede verse desde varias panorámicas. La ubicación preferente es
                    la que abre «ir al activo» desde la búsqueda por TAG.
                  </p>

                  {locations.length === 0 ? (
                    <EmptyState
                      title="Sin ubicaciones"
                      description="El activo existe en el catálogo pero no se puede señalar en ninguna panorámica."
                    />
                  ) : (
                    <DataTable
                      label="Ubicaciones del activo"
                      compact
                      rowKey={(row) => row.id}
                      rows={locations}
                      columns={[
                        {
                          id: 'scene',
                          header: 'Panorámica',
                          render: (row) =>
                            project.scenes.find((s) => s.id === row.sceneId)?.title ??
                            'escena inexistente',
                        },
                        {
                          id: 'primary',
                          header: 'Preferente',
                          render: (row) =>
                            row.primary ? (
                              <Badge tone="accent">Preferente</Badge>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => makePrimary(row.id)}
                              >
                                Hacer preferente
                              </Button>
                            ),
                        },
                        {
                          id: 'remove',
                          header: '',
                          align: 'end',
                          render: (row) => (
                            <Button
                              variant="quiet"
                              size="sm"
                              onClick={() => removeLocation(row.id)}
                            >
                              Quitar
                            </Button>
                          ),
                        },
                      ]}
                    />
                  )}

                  <Field
                    label="Añadir ubicación"
                    hint={
                      sinEscenas
                        ? 'El proyecto no tiene panorámicas todavía.'
                        : 'Se coloca en la vista inicial de la panorámica; después se arrastra en el lienzo.'
                    }
                  >
                    {({ id, describedBy }) => (
                      <Select
                        id={id}
                        aria-describedby={describedBy}
                        value=""
                        disabled={sinEscenas}
                        onChange={(event) => {
                          if (event.currentTarget.value !== '') {
                            addLocation(event.currentTarget.value as Uuid);
                          }
                        }}
                      >
                        <option value="">— elegir panorámica —</option>
                        {project.scenes.map((scene) => (
                          <option key={scene.id} value={scene.id}>
                            {scene.title}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              )}
            </TabPanel>

            {/* ---------------- Documentos (X07) ---------------- */}

            <TabPanel id="documentos">
              {draft.id === null ? (
                <EmptyState
                  title="Primero cree el activo"
                  description="Los documentos se vinculan a un activo que ya existe."
                />
              ) : (
                <div className="asset-editor__section">
                  <p className="asset-editor__hint">
                    Sólo un documento <b>aprobado</b> puede ser la revisión vigente. Mostrar una
                    revisión reemplazada como vigente lleva a intervenir un equipo con un plano
                    antiguo, así que el estado se declara y no se adivina.
                  </p>

                  {documents.length === 0 ? (
                    <EmptyState title="Sin documentos" description="No hay planos ni hojas de datos vinculados." />
                  ) : (
                    <div className="asset-editor__docs">
                      {documents.map((doc) => (
                        <article key={doc.id} className="asset-editor__doc">
                          <header className="asset-editor__doc-head">
                            <strong>{doc.title}</strong>
                            {vigente.has(doc.id) && <Badge tone="nominal">Revisión vigente</Badge>}
                            <Button
                              variant="quiet"
                              size="sm"
                              onClick={() => unlinkDocument(doc.id)}
                              style={{ marginLeft: 'auto' }}
                            >
                              Desvincular
                            </Button>
                          </header>

                          <div className="asset-editor__grid">
                            <Field label="Título">
                              {({ id }) => (
                                <TextInput
                                  id={id}
                                  value={doc.title}
                                  onChange={(event) =>
                                    updateDocument(doc.id, { title: event.currentTarget.value })
                                  }
                                />
                              )}
                            </Field>
                            <Field label="Código de documento" hint="El del cliente: P-101-DS-001.">
                              {({ id }) => (
                                <TextInput
                                  id={id}
                                  mono
                                  value={doc.documentCode}
                                  onChange={(event) =>
                                    updateDocument(doc.id, {
                                      documentCode: event.currentTarget.value,
                                    })
                                  }
                                />
                              )}
                            </Field>
                            <Field label="Revisión" hint="Como la nombra el cliente: A, 0, Rev. 3.">
                              {({ id }) => (
                                <TextInput
                                  id={id}
                                  mono
                                  value={doc.revision}
                                  onChange={(event) =>
                                    updateDocument(doc.id, { revision: event.currentTarget.value })
                                  }
                                />
                              )}
                            </Field>
                            <Field label="Estado">
                              {({ id }) => (
                                <Select
                                  id={id}
                                  value={doc.status}
                                  onChange={(event) =>
                                    updateDocument(doc.id, {
                                      status: event.currentTarget
                                        .value as TechnicalDocument['status'],
                                    })
                                  }
                                >
                                  {Object.entries(DOCUMENT_STATUS_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>
                                      {label}
                                    </option>
                                  ))}
                                </Select>
                              )}
                            </Field>
                            <Field label="Disciplina">
                              {({ id }) => (
                                <Select
                                  id={id}
                                  value={doc.discipline}
                                  onChange={(event) =>
                                    updateDocument(doc.id, {
                                      discipline: event.currentTarget
                                        .value as TechnicalDocument['discipline'],
                                    })
                                  }
                                >
                                  {Object.entries(DISCIPLINE_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>
                                      {label}
                                    </option>
                                  ))}
                                </Select>
                              )}
                            </Field>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}

                  <Field
                    label="Vincular documento de la biblioteca"
                    hint={
                      docCandidates.length === 0
                        ? 'No hay documentos sin vincular en la biblioteca del proyecto.'
                        : 'Entra como borrador: aprobarlo es una decisión de ingeniería.'
                    }
                  >
                    {({ id, describedBy }) => (
                      <Select
                        id={id}
                        aria-describedby={describedBy}
                        value=""
                        disabled={docCandidates.length === 0}
                        onChange={(event) => {
                          if (event.currentTarget.value !== '') {
                            linkDocument(event.currentTarget.value as Uuid);
                          }
                        }}
                      >
                        <option value="">— elegir documento —</option>
                        {docCandidates.map((media) => (
                          <option key={media.id} value={media.id}>
                            {media.originalName}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              )}
            </TabPanel>
          </Tabs>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        destructive
        title={asset === null ? 'Eliminar activo' : `Eliminar ${asset.tag}`}
        confirmLabel="Eliminar"
        message={deleteMessage(asset, project.assets, project.assetLocations, project.documents)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Auxiliares
 * ------------------------------------------------------------------ */

/** Agrupa los atributos por su grupo declarado, respetando el orden. */
function groupAttributes(
  definitions: readonly AttributeDefinition[],
): readonly [string, readonly AttributeDefinition[]][] {
  const groups = new Map<string, AttributeDefinition[]>();
  for (const definition of [...definitions].sort((a, b) => a.order - b.order)) {
    const key = definition.group.length > 0 ? definition.group : 'General';
    groups.set(key, [...(groups.get(key) ?? []), definition]);
  }
  return [...groups.entries()];
}

/**
 * Mensaje de confirmación del borrado.
 *
 * Dice el número exacto de activos, ubicaciones y documentos afectados. Un
 * «¿seguro?» sin cifras no es una confirmación informada: borrar una unidad se
 * lleva por delante todos sus equipos, y eso tiene que estar escrito antes del
 * clic y no descubrirse después.
 */
function deleteMessage(
  asset: Asset | null,
  assets: readonly Asset[],
  allLocations: readonly AssetLocation[],
  allDocuments: readonly TechnicalDocument[],
): string {
  if (asset === null) return 'No hay nada que eliminar.';

  const descendants = new Set<string>([asset.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of assets) {
      if (
        candidate.parentId !== null &&
        descendants.has(candidate.parentId) &&
        !descendants.has(candidate.id)
      ) {
        descendants.add(candidate.id);
        grew = true;
      }
    }
  }

  const hijos = descendants.size - 1;
  const ubicaciones = allLocations.filter((l) => descendants.has(l.assetId)).length;
  const docs = allDocuments.filter((d) => d.assetId !== null && descendants.has(d.assetId)).length;

  const partes = [
    hijos > 0
      ? `Se eliminarán también ${hijos} activo(s) que cuelgan de él.`
      : 'No tiene activos por debajo.',
    ubicaciones > 0 ? `Se quitarán ${ubicaciones} ubicación(es) en panorámicas.` : null,
    docs > 0 ? `${docs} documento(s) quedarán sin activo asignado, no se borrarán.` : null,
    'La operación se puede deshacer con Ctrl+Z.',
  ].filter((part): part is string => part !== null);

  return partes.join(' ');
}

interface AttributeFieldProps {
  readonly definition: AttributeDefinition;
  readonly value: AttributeValue;
  readonly error: string | undefined;
  readonly onChange: (value: AttributeValue) => void;
}

/**
 * Control de un atributo, según el tipo que declara su definición.
 *
 * `quantity` y `number` se separan porque la unidad declarada es parte del
 * dato: una presión de diseño sin unidad es inservible, y el contrato prohíbe
 * inferirla. Aquí eso se traduce en que la unidad se muestra junto al campo y
 * viene de la definición, nunca de lo que el autor escriba.
 */
function AttributeField({ definition, value, error, onChange }: AttributeFieldProps): JSX.Element {
  const hint = definition.helpText.length > 0 ? definition.helpText : undefined;

  if (definition.type === 'boolean') {
    return (
      <Field label={definition.label} required={definition.required} error={error} hint={hint}>
        {({ id }) => (
          <Switch
            id={id}
            checked={value === true}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
        )}
      </Field>
    );
  }

  if (definition.type === 'number' || definition.type === 'quantity') {
    return (
      <Field label={definition.label} required={definition.required} error={error} hint={hint}>
        {({ id, describedBy, invalid }) => (
          <NumberInput
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typeof value === 'number' ? value : 0}
            onValueChange={onChange}
            {...(definition.unit !== null ? { unit: definition.unit } : {})}
          />
        )}
      </Field>
    );
  }

  if (definition.type === 'enum') {
    return (
      <Field label={definition.label} required={definition.required} error={error} hint={hint}>
        {({ id, describedBy, invalid }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) =>
              onChange(event.currentTarget.value === '' ? null : event.currentTarget.value)
            }
          >
            <option value="">— sin valor —</option>
            {definition.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  if (definition.type === 'longText') {
    return (
      <Field label={definition.label} required={definition.required} error={error} hint={hint}>
        {({ id, describedBy, invalid }) => (
          <TextArea
            id={id}
            rows={3}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </Field>
    );
  }

  return (
    <Field label={definition.label} required={definition.required} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          type={definition.type === 'date' ? 'date' : 'text'}
          mono={definition.type === 'tagRef'}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </Field>
  );
}
