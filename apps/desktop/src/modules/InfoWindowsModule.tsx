/**
 * Ventanas de información (E01, con pestañas F08 y texto dinámico F09).
 *
 * El contenido técnico de la planta se escribe aquí: la ficha de un equipo, un
 * procedimiento, el vídeo de un montaje, el mapa del emplazamiento.
 *
 * La pantalla tiene tres columnas porque el trabajo tiene tres niveles —qué
 * ventana, qué pestaña, qué bloque— y esconder uno obliga a ir y venir para
 * mover un párrafo de sitio.
 *
 * Dos cosas que el autor necesita ver sin pedirlas:
 *
 * **Quién abre esta ventana.** Una ventana que ninguna acción abre no se
 * publica, y descubrirlo al abrir el paquete es tarde. Se dice en el propio
 * panel, con el número de acciones que la abren.
 *
 * **Las variables que no existen.** `{{escna}}` saldría vacío en el visor sin
 * ninguna queja. La lista de variables admitidas está a la vista junto al
 * campo de texto, y la validación denuncia las que no reconoce.
 */
import { useMemo, useState } from 'react';
import {
  createInfoBlock,
  createInfoWindow,
  INFO_VARIABLES,
  newUuid,
  richTextSummary,
  validateInfoWindows,
  walkSkin,
  type Action,
  type InfoBlock,
  type InfoBlockType,
  type InfoTab,
  type InfoWindow,
  type Project,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CountPill,
  EmptyState,
  Field,
  IconNote,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  TextArea,
  TextInput,
  useToast,
} from '@it360/ui';
import { ActionEditor } from './ActionEditor';
import type { ProjectStore } from '../state/project-store';

export interface InfoWindowsModuleProps {
  readonly store: ProjectStore;
}

/** Tipos de bloque que se ofrecen, con su etiqueta y lo que necesitan. */
const BLOCK_OPTIONS: readonly {
  readonly type: InfoBlockType;
  readonly label: string;
  readonly needs: 'media' | 'document' | 'asset' | 'mapping' | 'scene' | null;
}[] = [
  { type: 'text', label: 'Texto', needs: null },
  { type: 'image', label: 'Imagen', needs: 'media' },
  { type: 'video', label: 'Vídeo', needs: 'media' },
  { type: 'audio', label: 'Audio', needs: 'media' },
  { type: 'document', label: 'Documento', needs: 'document' },
  { type: 'asset', label: 'Ficha de activo', needs: 'asset' },
  { type: 'telemetry', label: 'Valor de proceso', needs: 'mapping' },
  { type: 'webframe', label: 'Contenido web', needs: null },
  { type: 'sceneLink', label: 'Enlace a escena', needs: 'scene' },
];

const BLOCK_LABEL = new Map(BLOCK_OPTIONS.map((option) => [option.type, option.label]));

/** Todas las acciones del proyecto, para saber quién abre cada ventana. */
function allActions(project: Project): Action[] {
  const actions: Action[] = [];
  for (const scene of project.scenes) {
    actions.push(...scene.actions);
    for (const hotspot of scene.hotspots) actions.push(...hotspot.actions);
  }
  for (const skin of project.skins) {
    for (const { node } of walkSkin(skin.root)) actions.push(...node.actions);
  }
  for (const tour of project.tours) {
    actions.push(...tour.onStart, ...tour.onEnd);
    for (const waypoint of tour.waypoints) actions.push(...waypoint.actions);
  }
  for (const window of project.infoWindows) actions.push(...window.onCloseActions);
  return actions;
}

export function InfoWindowsModule({ store }: InfoWindowsModuleProps): JSX.Element {
  const { project } = store;
  const { push } = useToast();

  const [windowId, setWindowId] = useState<string | null>(project.infoWindows[0]?.id ?? null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [blockIndex, setBlockIndex] = useState<number | null>(null);
  const [newBlockType, setNewBlockType] = useState<InfoBlockType>('text');
  const [confirmDelete, setConfirmDelete] = useState<'window' | 'tab' | 'block' | null>(null);

  const window = useMemo(
    () => project.infoWindows.find((w) => w.id === windowId) ?? project.infoWindows[0] ?? null,
    [project.infoWindows, windowId],
  );

  const tab = useMemo<InfoTab | null>(
    () => (window === null ? null : (window.tabs.find((t) => t.id === tabId) ?? window.tabs[0] ?? null)),
    [window, tabId],
  );

  const block = useMemo<InfoBlock | null>(
    () => (tab === null || blockIndex === null ? null : (tab.blocks[blockIndex] ?? null)),
    [tab, blockIndex],
  );

  const problems = useMemo(
    () =>
      validateInfoWindows(project.infoWindows, {
        mediaIds: new Set<string>(project.media.map((m) => m.id)),
        documentIds: new Set<string>(project.documents.map((d) => d.id)),
        assetIds: new Set<string>(project.assets.map((a) => a.id)),
        mappingIds: new Set<string>(project.telemetryMappings.map((m) => m.id)),
        sceneIds: new Set<string>(project.scenes.map((s) => s.id)),
      }),
    [project.infoWindows, project.media, project.documents, project.assets, project.telemetryMappings, project.scenes],
  );

  /** Cuántas acciones abren cada ventana. */
  const openedBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const action of allActions(project)) {
      if (action.config.type !== 'openInfoWindow') continue;
      const id = action.config.windowId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [project]);

  /**
   * Escena de referencia para el editor de acciones.
   *
   * Una ventana no pertenece a ninguna escena, pero el editor necesita saber
   * «la actual» para no ofrecerla como destino de un salto. Se usa la de
   * entrada del recorrido, que es la que el autor reconoce.
   */
  const anchorScene = useMemo(
    () =>
      project.scenes.find((scene) => scene.id === project.settings.entrySceneId) ??
      project.scenes[0] ??
      null,
    [project.scenes, project.settings.entrySceneId],
  );

  const windowProblems = useMemo(
    () => (window === null ? [] : problems.filter((p) => p.windowId === window.id)),
    [problems, window],
  );

  /* ---------------------------------------------------------------- *
   * Órdenes
   * ---------------------------------------------------------------- */

  const saveWindows = (next: readonly InfoWindow[], label: string, coalesceKey?: string): void => {
    store.updateProject(label, { infoWindows: [...next] }, coalesceKey);
  };

  const patchWindow = (patch: Partial<InfoWindow>, label: string, coalesceKey?: string): void => {
    if (window === null) return;
    saveWindows(
      project.infoWindows.map((w) => (w.id === window.id ? { ...w, ...patch } : w)),
      label,
      coalesceKey,
    );
  };

  const patchTab = (patch: Partial<InfoTab>, label: string, coalesceKey?: string): void => {
    if (window === null || tab === null) return;
    patchWindow(
      { tabs: window.tabs.map((t) => (t.id === tab.id ? { ...t, ...patch } : t)) },
      label,
      coalesceKey,
    );
  };

  const patchBlock = (next: InfoBlock, label: string, coalesceKey?: string): void => {
    if (tab === null || blockIndex === null) return;
    patchTab(
      { blocks: tab.blocks.map((b, index) => (index === blockIndex ? next : b)) },
      label,
      coalesceKey,
    );
  };

  const onNewWindow = (): void => {
    const created = createInfoWindow(
      `Ventana ${project.infoWindows.length + 1}`,
      newUuid(),
      newUuid(),
    );
    saveWindows([...project.infoWindows, created], `Crear ventana ${created.name}`);
    setWindowId(created.id);
    setTabId(created.tabs[0]?.id ?? null);
    setBlockIndex(null);
  };

  const onNewTab = (): void => {
    if (window === null) return;
    const created: InfoTab = {
      id: newUuid() as InfoTab['id'],
      title: `Pestaña ${window.tabs.length + 1}`,
      blocks: [],
    };
    patchWindow({ tabs: [...window.tabs, created] }, 'Añadir pestaña');
    setTabId(created.id);
    setBlockIndex(null);
  };

  const onAddBlock = (): void => {
    if (tab === null) return;

    const option = BLOCK_OPTIONS.find((candidate) => candidate.type === newBlockType);
    const created = createInfoBlock(newBlockType, {
      ...(option?.needs === 'media' ? { mediaId: project.media[0]?.id } : {}),
      ...(option?.needs === 'document' ? { documentId: project.documents[0]?.id } : {}),
      ...(option?.needs === 'asset' ? { assetId: project.assets[0]?.id } : {}),
      ...(option?.needs === 'mapping' ? { mappingId: project.telemetryMappings[0]?.id } : {}),
      ...(option?.needs === 'scene' ? { sceneId: project.scenes[0]?.id } : {}),
    });

    if (created === null) {
      // Pasa cuando el proyecto no tiene todavía eso que el bloque necesita.
      push({
        tone: 'warning',
        title: `No hay ningún elemento para un bloque de ${option?.label.toLowerCase() ?? 'ese tipo'}`,
        description: 'Añádalo primero al proyecto y vuelva aquí.',
      });
      return;
    }

    patchTab({ blocks: [...tab.blocks, created] }, `Añadir bloque de ${option?.label ?? ''}`);
    setBlockIndex(tab.blocks.length);
  };

  const onMoveBlock = (delta: number): void => {
    if (tab === null || blockIndex === null) return;
    const to = blockIndex + delta;
    if (to < 0 || to >= tab.blocks.length) return;

    const blocks = [...tab.blocks];
    const [moved] = blocks.splice(blockIndex, 1);
    if (moved === undefined) return;
    blocks.splice(to, 0, moved);

    patchTab({ blocks }, 'Mover bloque');
    setBlockIndex(to);
  };

  const onDelete = (): void => {
    if (confirmDelete === 'window' && window !== null) {
      // Las acciones que la abrían quedarían apuntando al vacío: se limpian en
      // la misma operación, que es lo que el autor espera de «eliminar».
      const cleaned = project.infoWindows
        .filter((w) => w.id !== window.id)
        .map((w) => ({
          ...w,
          onCloseActions: w.onCloseActions.filter(
            (action) => !(action.config.type === 'openInfoWindow' && action.config.windowId === window.id),
          ),
        }));

      saveWindows(cleaned, `Eliminar ventana ${window.name}`);
      const opened = openedBy.get(window.id) ?? 0;
      push({
        tone: opened > 0 ? 'warning' : 'neutral',
        title: `Ventana «${window.name}» eliminada`,
        ...(opened > 0
          ? { description: `${opened} acción(es) la abrían: revise los marcadores que la usaban.` }
          : {}),
      });
      setWindowId(cleaned[0]?.id ?? null);
      setTabId(null);
      setBlockIndex(null);
    } else if (confirmDelete === 'tab' && window !== null && tab !== null) {
      if (window.tabs.length <= 1) {
        push({ tone: 'warning', title: 'Una ventana necesita al menos una pestaña' });
      } else {
        patchWindow({ tabs: window.tabs.filter((t) => t.id !== tab.id) }, 'Eliminar pestaña');
        setTabId(null);
        setBlockIndex(null);
      }
    } else if (confirmDelete === 'block' && tab !== null && blockIndex !== null) {
      patchTab({ blocks: tab.blocks.filter((_, index) => index !== blockIndex) }, 'Eliminar bloque');
      setBlockIndex(null);
    }
    setConfirmDelete(null);
  };

  /* ---------------------------------------------------------------- *
   * Interfaz
   * ---------------------------------------------------------------- */

  if (project.infoWindows.length === 0) {
    return (
      <div className="iwin">
        <EmptyState
          icon={<IconNote size={28} />}
          title="Sin ventanas de información"
          description="Una ventana reúne texto, imágenes, documentos y valores de proceso, y se abre desde un marcador o un botón de la interfaz. Es la vía por la que el contenido técnico llega a quien recorre la planta."
          action={<Button onClick={onNewWindow}>Crear la primera ventana</Button>}
        />
      </div>
    );
  }

  return (
    <div className="iwin">
      <div className="iwin__list">
        <SectionLabel actions={<Button size="sm" variant="ghost" onClick={onNewWindow}>Nueva</Button>}>
          Ventanas
        </SectionLabel>
        <ul>
          {project.infoWindows.map((candidate) => {
            const opened = openedBy.get(candidate.id) ?? 0;
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  className={`iwin__item${candidate.id === window?.id ? ' iwin__item--active' : ''}`}
                  aria-current={candidate.id === window?.id ? 'true' : undefined}
                  onClick={() => {
                    setWindowId(candidate.id);
                    setTabId(null);
                    setBlockIndex(null);
                  }}
                >
                  <span>{candidate.name}</span>
                  {opened === 0 && (
                    <Badge tone="warning" title="Ninguna acción la abre: no se publicará">
                      sin uso
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {window !== null && tab !== null && (
        <div className="iwin__main">
          {windowProblems.length > 0 && (
            <Callout
              tone={windowProblems.some((p) => p.severity === 'blocking') ? 'alarm' : 'warning'}
              title={
                windowProblems.some((p) => p.severity === 'blocking')
                  ? 'Esta ventana impide publicar'
                  : 'Revise esta ventana'
              }
            >
              <ul className="iwin__problems">
                {windowProblems.map((problem) => (
                  <li key={`${problem.tabId ?? ''}-${problem.blockIndex ?? ''}-${problem.message}`}>
                    {problem.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <div className="iwin__tabs" role="tablist" aria-label="Pestañas de la ventana">
            {window.tabs.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === tab.id}
                className={`iwin__tab${candidate.id === tab.id ? ' iwin__tab--active' : ''}`}
                onClick={() => {
                  setTabId(candidate.id);
                  setBlockIndex(null);
                }}
              >
                {candidate.title}
              </button>
            ))}
            <Button size="sm" variant="ghost" onClick={onNewTab}>
              Añadir pestaña
            </Button>
          </div>

          <div className="iwin__compose">
            <Select
              aria-label="Tipo de bloque"
              value={newBlockType}
              onChange={(event) => setNewBlockType(event.currentTarget.value as InfoBlockType)}
            >
              {BLOCK_OPTIONS.map((option) => (
                <option key={option.type} value={option.type}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={onAddBlock}>
              Añadir bloque
            </Button>
            <CountPill count={tab.blocks.length} label="bloques en esta pestaña" />
          </div>

          {tab.blocks.length === 0 ? (
            <p className="iwin__empty">
              Esta pestaña está vacía. Elija un tipo de bloque y añádalo.
            </p>
          ) : (
            <ol className="iwin__blocks">
              {tab.blocks.map((candidate, index) => (
                <li key={index}>
                  <button
                    type="button"
                    className={`iwin__block${index === blockIndex ? ' iwin__block--active' : ''}`}
                    onClick={() => setBlockIndex(index)}
                  >
                    <Badge tone="neutral">{BLOCK_LABEL.get(candidate.type) ?? candidate.type}</Badge>
                    <span className="iwin__block-summary">{blockSummary(candidate, project)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <aside className="iwin__side">
        {window !== null && (
          <>
            <SectionLabel>Ventana</SectionLabel>
            <Field label="Nombre" hint="Sólo para usted, en estas listas.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={window.name}
                  onChange={(event) =>
                    patchWindow({ name: event.currentTarget.value }, 'Renombrar ventana', `iwin.name.${window.id}`)
                  }
                />
              )}
            </Field>

            <Field label="Título" hint="El que ve el visitante. Admite variables.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={window.title}
                  placeholder={window.name}
                  onChange={(event) =>
                    patchWindow({ title: event.currentTarget.value }, 'Cambiar título de la ventana', `iwin.title.${window.id}`)
                  }
                />
              )}
            </Field>

            <div className="iwin__row">
              <Field label="Ancho" inline>
                {({ id }) => (
                  <NumberInput
                    id={id}
                    value={window.widthPx}
                    min={240}
                    max={2400}
                    step={20}
                    decimals={0}
                    unit="px"
                    onValueChange={(value) => patchWindow({ widthPx: Math.round(value) }, 'Cambiar ancho')}
                  />
                )}
              </Field>
              <Field label="Alto" inline>
                {({ id }) => (
                  <NumberInput
                    id={id}
                    value={window.heightPx}
                    min={180}
                    max={2000}
                    step={20}
                    decimals={0}
                    unit="px"
                    onValueChange={(value) => patchWindow({ heightPx: Math.round(value) }, 'Cambiar alto')}
                  />
                )}
              </Field>
            </div>

            <div className="iwin__row">
              <Switch
                checked={window.modal}
                onChange={(event) => patchWindow({ modal: event.currentTarget.checked }, 'Cambiar modo modal')}
                label="Bloquear el recorrido hasta cerrarla"
              />
            </div>

            <p className="iwin__opened">
              {(openedBy.get(window.id) ?? 0) === 0
                ? 'Ninguna acción abre esta ventana, así que no viajará en el paquete publicado.'
                : `La abren ${openedBy.get(window.id) ?? 0} acción(es).`}
            </p>

            {tab !== null && (
              <>
                <SectionLabel>Pestaña</SectionLabel>
                <Field label="Título de la pestaña">
                  {({ id }) => (
                    <TextInput
                      id={id}
                      value={tab.title}
                      onChange={(event) =>
                        patchTab({ title: event.currentTarget.value }, 'Renombrar pestaña', `iwin.tab.${tab.id}`)
                      }
                    />
                  )}
                </Field>
                {window.tabs.length > 1 && (
                  <Button size="sm" variant="danger" onClick={() => setConfirmDelete('tab')}>
                    Eliminar pestaña
                  </Button>
                )}
              </>
            )}

            {block !== null && (
              <>
                <SectionLabel>Bloque</SectionLabel>
                <BlockEditor
                  block={block}
                  project={project}
                  onChange={(next, label) => patchBlock(next, label)}
                />
                <div className="iwin__row">
                  <Button size="sm" variant="ghost" onClick={() => onMoveBlock(-1)}>
                    Subir
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onMoveBlock(1)}>
                    Bajar
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setConfirmDelete('block')}>
                    Eliminar
                  </Button>
                </div>
              </>
            )}

            <SectionLabel>Al cerrar</SectionLabel>
            {/* El evento es fijo: estas acciones sólo tienen un momento, el
                cierre de la ventana. Ofrecer «al pulsar» aquí dejaría acciones
                que no se ejecutan nunca, sin que nada lo advirtiera. */}
            <ActionEditor
              actions={window.onCloseActions}
              project={project}
              scene={{ id: anchorScene?.id ?? '', title: anchorScene?.title ?? 'Escena' }}
              title="Al cerrar la ventana"
              emptyWarning={null}
              fixedEvent="windowClose"
              onChange={(actions) =>
                patchWindow({ onCloseActions: [...actions] }, 'Cambiar acciones de cierre')
              }
            />

            <Button variant="danger" onClick={() => setConfirmDelete('window')}>
              Eliminar ventana
            </Button>
          </>
        )}
      </aside>

      {confirmDelete !== null && (
        <ConfirmDialog
          open
          title={
            confirmDelete === 'window'
              ? 'Eliminar esta ventana'
              : confirmDelete === 'tab'
                ? 'Eliminar esta pestaña'
                : 'Eliminar este bloque'
          }
          message={
            confirmDelete === 'window'
              ? `Se eliminará «${window?.name ?? ''}» con todas sus pestañas.${
                  (openedBy.get(window?.id ?? '') ?? 0) > 0
                    ? ` La abren ${openedBy.get(window?.id ?? '') ?? 0} acción(es), que quedarán sin destino.`
                    : ''
                }`
              : confirmDelete === 'tab'
                ? `Se eliminará «${tab?.title ?? ''}» con sus ${tab?.blocks.length ?? 0} bloque(s).`
                : 'Se eliminará este bloque de la pestaña.'
          }
          confirmLabel="Eliminar"
          destructive
          onConfirm={onDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Edición de un bloque
 * ------------------------------------------------------------------ */

interface BlockEditorProps {
  readonly block: InfoBlock;
  readonly project: Project;
  readonly onChange: (block: InfoBlock, label: string) => void;
}

function BlockEditor({ block, project, onChange }: BlockEditorProps): JSX.Element {
  switch (block.type) {
    case 'text':
      return (
        <>
          <Field
            label="Texto"
            hint="Formato sencillo: **negrita**, *cursiva*, `código`, - listas y [enlaces](https://…)."
          >
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={8}
                value={block.text}
                onChange={(event) => onChange({ ...block, text: event.currentTarget.value }, 'Editar texto')}
              />
            )}
          </Field>
          <details className="iwin__variables">
            <summary>Variables disponibles</summary>
            <dl>
              {Object.entries(INFO_VARIABLES).map(([name, description]) => (
                <div key={name}>
                  <dt>{`{{${name}}}`}</dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      );

    case 'image':
    case 'video':
    case 'audio':
      return (
        <>
          <Field label="Medio">
            {({ id }) => (
              <Select
                id={id}
                value={block.mediaId}
                onChange={(event) =>
                  onChange({ ...block, mediaId: event.currentTarget.value as typeof block.mediaId }, 'Cambiar medio')
                }
              >
                {project.media.map((media) => (
                  <option key={media.id} value={media.id}>
                    {media.originalName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Pie" hint="Opcional. Admite variables.">
            {({ id }) => (
              <TextInput
                id={id}
                value={block.caption}
                onChange={(event) => onChange({ ...block, caption: event.currentTarget.value }, 'Cambiar pie')}
              />
            )}
          </Field>
          {block.type === 'video' && (
            <Switch
              checked={block.autoplay}
              onChange={(event) =>
                onChange({ ...block, autoplay: event.currentTarget.checked }, 'Cambiar reproducción automática')
              }
              label="Reproducir al abrir"
            />
          )}
        </>
      );

    case 'document':
      return (
        <>
          <Field label="Documento">
            {({ id }) => (
              <Select
                id={id}
                value={block.documentId}
                onChange={(event) =>
                  onChange(
                    { ...block, documentId: event.currentTarget.value as typeof block.documentId },
                    'Cambiar documento',
                  )
                }
              >
                {project.documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Página inicial" hint="Sólo se respeta en PDF.">
            {({ id }) => (
              <NumberInput
                id={id}
                value={block.page}
                min={1}
                step={1}
                decimals={0}
                onValueChange={(value) => onChange({ ...block, page: Math.max(1, Math.round(value)) }, 'Cambiar página')}
              />
            )}
          </Field>
        </>
      );

    case 'asset':
      return (
        <Field label="Activo" hint="Se muestran su TAG, su clase y sus atributos.">
          {({ id }) => (
            <Select
              id={id}
              value={block.assetId}
              onChange={(event) =>
                onChange({ ...block, assetId: event.currentTarget.value as typeof block.assetId }, 'Cambiar activo')
              }
            >
              {project.assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.tag} · {asset.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'telemetry':
      return (
        <Field label="Variable de proceso" hint="Sólo lectura, como todo el dato de proceso.">
          {({ id }) => (
            <Select
              id={id}
              value={block.mappingId}
              onChange={(event) =>
                onChange(
                  { ...block, mappingId: event.currentTarget.value as typeof block.mappingId },
                  'Cambiar variable de proceso',
                )
              }
            >
              {project.telemetryMappings.map((mapping) => (
                <option key={mapping.id} value={mapping.id}>
                  {mapping.variable}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'webframe':
      return (
        <>
          <Field
            label="Dirección"
            hint="Sólo https, y de un sitio público: no se puede enmarcar la red interna."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={block.url}
                onChange={(event) => onChange({ ...block, url: event.currentTarget.value }, 'Cambiar dirección')}
              />
            )}
          </Field>
          <Field label="Alto" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                value={block.heightPx}
                min={120}
                max={2048}
                step={20}
                decimals={0}
                unit="px"
                onValueChange={(value) => onChange({ ...block, heightPx: Math.round(value) }, 'Cambiar alto del marco')}
              />
            )}
          </Field>
          <Switch
            checked={block.allowFullscreen}
            onChange={(event) =>
              onChange({ ...block, allowFullscreen: event.currentTarget.checked }, 'Cambiar pantalla completa')
            }
            label="Permitir pantalla completa"
          />
        </>
      );

    case 'sceneLink':
      return (
        <>
          <Field label="Escena">
            {({ id }) => (
              <Select
                id={id}
                value={block.sceneId}
                onChange={(event) =>
                  onChange({ ...block, sceneId: event.currentTarget.value as typeof block.sceneId }, 'Cambiar escena')
                }
              >
                {project.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Rótulo" hint="Vacío: se usa el título de la escena.">
            {({ id }) => (
              <TextInput
                id={id}
                value={block.label}
                onChange={(event) => onChange({ ...block, label: event.currentTarget.value }, 'Cambiar rótulo')}
              />
            )}
          </Field>
        </>
      );

    default:
      return <p className="iwin__empty">Este bloque no tiene nada que configurar.</p>;
  }
}

/** Resumen de un bloque para la lista. */
function blockSummary(block: InfoBlock, project: Project): string {
  switch (block.type) {
    case 'text': {
      const summary = richTextSummary(block.text, 80);
      return summary === '' ? '(vacío)' : summary;
    }
    case 'image':
    case 'video':
    case 'audio':
      return project.media.find((m) => m.id === block.mediaId)?.originalName ?? '(medio ausente)';
    case 'document':
      return project.documents.find((d) => d.id === block.documentId)?.title ?? '(documento ausente)';
    case 'asset': {
      const asset = project.assets.find((a) => a.id === block.assetId);
      return asset === undefined ? '(activo ausente)' : `${asset.tag} · ${asset.name}`;
    }
    case 'telemetry':
      return (
        project.telemetryMappings.find((m) => m.id === block.mappingId)?.variable ??
        '(variable ausente)'
      );
    case 'webframe':
      return block.url;
    case 'sceneLink':
      return block.label !== ''
        ? block.label
        : (project.scenes.find((s) => s.id === block.sceneId)?.title ?? '(escena ausente)');
    default:
      return '';
  }
}
