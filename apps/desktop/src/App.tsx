/**
 * Armazón de la aplicación.
 *
 * Mantiene el estado del proyecto, el módulo activo y la selección, y reparte
 * el espacio entre raíl, panel contextual, lienzo e inspector.
 *
 * El criterio de reparto: el lienzo es el trabajo y nunca se le quita espacio
 * para añadir un panel. Cuando algo necesita más sitio del que hay —el
 * catálogo completo, la tabla de notas, las opciones de publicación— ocupa el
 * lienzo entero en lugar de comprimir todo. Una herramienta con cinco paneles
 * de 200 px y un lienzo de 300 no sirve para inspeccionar nada.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONDITION_LABELS,
  evaluateCondition,
  newUuid,
  radToDeg,
  worstCondition,
  allTags,
  isEmptyQuery,
  matchesSearch,
  parseSearchQuery,
  type CameraView,
  type ConditionLevel,
  type Hotspot,
  type Project,
  type Scene,
  type Uuid,
  sceneSchema,
  markerForScene,
  planBearingDegrees,
  planForScene,
  radarCone,
  radarConePoints,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  cx,
  EmptyState,
  ErrorState,
  Field,
  IconAdd,
  IconCheck,
  IconClose,
  IconDocument,
  IconEquipment,
  IconExperimental,
  IconFolder,
  IconEye,
  IconEyeOff,
  IconHotspot,
  IconLayers,
  IconLock,
  IconMore,
  IconNote,
  IconPanorama,
  IconPlan,
  IconPublish,
  IconRedo,
  IconSave,
  IconSearch,
  IconTag,
  IconSettings,
  IconTelemetry,
  IconTour,
  IconTrash,
  IconUndo,
  LoadingState,
  Menu,
  NumberInput,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Spinner,
  Select,
  Slider,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
  ThumbnailStrip,
  Tooltip,
  Tree,
  useToast,
  type TreeNode,
} from '@it360/ui';
import { PanoramaViewer, type ViewerScene } from '@it360/viewer';
import { useProjectStore, type ProjectStore } from './state/project-store';
import { collectPackageFiles, pickAndOpenProject, saveProject } from './platform/project-files';
import { buildDemoProject, type DemoAssets } from './demo/demo-project';
import { Gauge } from './components/instruments';
import { useLatestTelemetry } from './telemetry/use-telemetry';
import {
  CachingTelemetryClient,
  SimulatedTelemetryClient,
  type TelemetryClient,
} from './telemetry/telemetry-client';
import { AssetsModule } from './modules/AssetsModule';
import { NotesModule } from './modules/NotesModule';
import { TelemetryModule } from './modules/TelemetryModule';
import { defaultModelSettings, ModelSceneModule } from './modules/ModelSceneModule';
import { BackupPanel } from './modules/BackupPanel';
import { PublishModule } from './modules/PublishModule';
import { PlansModule } from './modules/PlansModule';
import { InfoWindowsModule } from './modules/InfoWindowsModule';
import { SkinEditor } from './modules/SkinEditor';
import { ToursModule } from './modules/ToursModule';
import { HotspotGeometryPanel } from './modules/HotspotGeometry';
import { TagField } from './modules/TagField';
import { TagManager } from './modules/TagManager';
import { HotspotAxes } from './modules/HotspotAxes';
import { SettingsModule } from './modules/SettingsModule';
import { ThemeToggle } from './modules/ThemeToggle';
import { AutoConnectDialog } from './modules/AutoConnectDialog';
import { ActionEditor } from './modules/ActionEditor';

export type ModuleId =
  | 'scenes'
  | 'plans'
  | 'assets'
  | 'windows'
  | 'notes'
  | 'telemetry'
  | 'skin'
  | 'tours'
  | 'publish'
  | 'settings';

interface ModuleDescriptor {
  readonly id: ModuleId;
  readonly label: string;
  readonly icon: JSX.Element;
  readonly shortcut: string;
}

/* Se exporta para que las pruebas lean el atajo de cada módulo en lugar de
   repetir el dígito: así añadir un módulo en medio no rompe una prueba que no
   tiene nada que ver con él. */
export const MODULES: readonly ModuleDescriptor[] = [
  { id: 'scenes', label: 'Escenas y marcadores', icon: <IconPanorama size={18} />, shortcut: '1' },
  { id: 'plans', label: 'Planos y zonas', icon: <IconPlan size={18} />, shortcut: '2' },
  { id: 'assets', label: 'Catálogo de activos', icon: <IconEquipment size={18} />, shortcut: '3' },
  { id: 'windows', label: 'Ventanas de información', icon: <IconDocument size={18} />, shortcut: '4' },
  { id: 'notes', label: 'Notas y tareas', icon: <IconNote size={18} />, shortcut: '5' },
  { id: 'telemetry', label: 'Telemetría', icon: <IconTelemetry size={18} />, shortcut: '6' },
  { id: 'skin', label: 'Interfaz del recorrido', icon: <IconLayers size={18} />, shortcut: '7' },
  { id: 'tours', label: 'Recorridos y formación', icon: <IconTour size={18} />, shortcut: '8' },
  { id: 'publish', label: 'Publicación', icon: <IconPublish size={18} />, shortcut: '9' },
];

export interface AppProps {
  /** Proyecto a editar. Se exige: el armazón nunca opera sin proyecto. */
  readonly initialProject: Project;
  readonly initialMediaUrls?: ReadonlyMap<string, string>;
  readonly telemetryClient?: TelemetryClient;
}

const EMPTY_MEDIA: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Arranque con el proyecto de demostración.
 *
 * La construcción del proyecto de demostración es asíncrona porque calcula las
 * sumas SHA-256 reales de las imágenes que genera, y Web Crypto sólo ofrece
 * una interfaz asíncrona. Se prefiere esperar unos milisegundos a rellenar el
 * campo con una suma inventada: un proyecto con sumas falsas falla la
 * verificación de integridad en cuanto se guarda y se vuelve a abrir, y el
 * fallo aparecería muy lejos de su causa.
 */
export function AppRoot({ telemetryClient }: { readonly telemetryClient?: TelemetryClient }): JSX.Element {
  const [demo, setDemo] = useState<DemoAssets | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void buildDemoProject().then(
      (assets) => {
        if (!cancelled) setDemo(assets);
      },
      (cause: unknown) => {
        if (!cancelled) setFailure(String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failure !== null) {
    return (
      <div className="app app--boot">
        <ErrorState
          title="No se pudo preparar el proyecto de demostración"
          detail={failure}
          recovery="Abra un proyecto existente, o compruebe que el entorno ofrece Web Crypto para calcular las sumas de verificación."
        />
      </div>
    );
  }

  if (demo === null) {
    return (
      <div className="app app--boot">
        <LoadingState label="Preparando el proyecto de demostración" />
      </div>
    );
  }

  return (
    <App
      initialProject={demo.project}
      initialMediaUrls={demo.mediaUrls}
      {...(telemetryClient !== undefined ? { telemetryClient } : {})}
    />
  );
}

export function App({ initialProject, initialMediaUrls, telemetryClient }: AppProps): JSX.Element {
  const store = useProjectStore(initialProject);

  /**
   * URLs con las que se muestran los medios.
   *
   * Es estado y no una constante porque el editor importa imágenes —los
   * planos, por ejemplo—: sus bytes viven en memoria hasta que se guarda el
   * proyecto, y hasta entonces la única forma de mostrarlas es la URL que se
   * creó al leerlas.
   */
  const [mediaUrls, setMediaUrls] = useState<ReadonlyMap<string, string>>(
    initialMediaUrls ?? EMPTY_MEDIA,
  );

  const addMediaUrl = useCallback((mediaId: string, url: string): void => {
    setMediaUrls((previous) => new Map(previous).set(mediaId, url));
  }, []);

  const client = useMemo(
    () => telemetryClient ?? new CachingTelemetryClient(new SimulatedTelemetryClient()),
    [telemetryClient],
  );

  const [moduleId, setModuleId] = useState<ModuleId>('scenes');
  const [sceneId, setSceneId] = useState<string | null>(store.project.scenes[0]?.id ?? null);
  const [hotspotId, setHotspotId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<readonly Hotspot[]>([]);
  /**
   * Bytes de los medios abiertos desde un paquete.
   *
   * Se conservan en memoria porque guardar vuelve a escribir el paquete
   * completo: sin ellos, guardar un proyecto abierto escribiría el manifiesto
   * y la base de datos sin las imágenes, y el archivo resultante no abriría.
   */
  const [openedFiles, setOpenedFiles] = useState<ReadonlyMap<string, Uint8Array>>(
    () => new Map<string, Uint8Array>(),
  );
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'scene' | 'hotspot'; id: string } | null>(null);
  const [autoConnect, setAutoConnect] = useState(false);

  const { push } = useToast();

  /* ---------------------------------------------------------------- *
   * Atajos de teclado
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }
      // Los módulos se alcanzan con Alt y un dígito: sin Alt, escribir «3» en
      // un panel de propiedades cambiaría de módulo. La combinación con Alt sí
      // se atiende mientras se escribe, porque no produce texto y el usuario
      // que viene de teclear un título espera poder cambiar de módulo sin
      // sacar primero el foco del campo.
      if (event.altKey) {
        const found = MODULES.find((m) => m.shortcut === event.key);
        if (found !== undefined) {
          event.preventDefault();
          setModuleId(found.id);
        }
        return;
      }

      if (typing) return;
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  const scene = useMemo(
    () => store.project.scenes.find((s) => s.id === sceneId) ?? store.project.scenes[0] ?? null,
    [store.project.scenes, sceneId],
  );

  const hotspot = useMemo(
    () => scene?.hotspots.find((h) => h.id === hotspotId) ?? null,
    [scene, hotspotId],
  );

  const mediaFiles = useMemo(
    () => collectPackageFiles(store.project, mediaUrls, openedFiles),
    [store.project, mediaUrls, openedFiles],
  );

  const errors = store.integrity.filter((p) => p.severity === 'error');
  const warnings = store.integrity.filter((p) => p.severity === 'warning');

  const [busy, setBusy] = useState<'saving' | 'opening' | null>(null);

  /**
   * Guardado.
   *
   * El bloqueo por integridad se resuelve aquí y no en la capa de
   * persistencia: `saveProject` ya se niega a escribir un proyecto con
   * referencias roto, y lo que falta es ofrecer al usuario la salida —guardar
   * de todas formas— sin que sea el camino por defecto. Perder el trabajo de
   * una tarde por un marcador que apunta a una escena borrada sería peor que
   * guardar un archivo con un aviso.
   */
  const onSave = useCallback(
    async (force = false) => {
      if (errors.length > 0 && !force) {
        push({
          tone: 'alarm',
          title: 'El proyecto tiene referencias sin resolver',
          description: `${errors.length} problema(s) impiden guardar. Revise el panel de integridad, o use «Guardar de todas formas».`,
        });
        return;
      }

      setBusy('saving');
      const result = await saveProject(store.project, mediaFiles, store.filePath, { force });
      setBusy(null);

      if (!result.ok) {
        push({
          tone: 'alarm',
          title: 'No se pudo guardar',
          description: `${result.error.message}${result.error.recovery !== undefined ? ` ${result.error.recovery}` : ''}`,
        });
        return;
      }
      if (result.value === null) return; // El usuario canceló el diálogo.

      store.markSaved(result.value.path);
      push({
        tone: 'nominal',
        title: 'Proyecto guardado',
        description: `${(result.value.byteSize / 1_000_000).toFixed(1)} MB · ${result.value.backupsKept} copia(s) de respaldo conservada(s)`,
      });
    },
    [errors.length, store, mediaFiles, push],
  );

  const onOpen = useCallback(async () => {
    if (store.dirty) {
      // No se abre encima de trabajo sin guardar sin preguntar: el historial
      // de comandos se descarta al cargar otro proyecto y no hay vuelta atrás.
      const confirmed = globalThis.confirm(
        'Hay cambios sin guardar que se perderán al abrir otro proyecto. ¿Continuar?',
      );
      if (!confirmed) return;
    }

    setBusy('opening');
    const result = await pickAndOpenProject();
    setBusy(null);

    if (!result.ok) {
      push({ tone: 'alarm', title: 'No se pudo abrir el proyecto', description: result.error.message });
      return;
    }
    if (result.value === null) return;

    setOpenedFiles(result.value.files);
    store.load(result.value.project, result.value.path);
    setSceneId(result.value.project.scenes[0]?.id ?? null);
    setHotspotId(null);

    if (result.value.warnings.length > 0) {
      push({
        tone: 'warning',
        title: `El proyecto se abrió con ${result.value.warnings.length} aviso(s)`,
        description: result.value.warnings.slice(0, 3).join(' · '),
      });
    }
  }, [store, push]);

  return (
    <div className="app">
      <CommandBar
        store={store}
        errors={errors.length}
        warnings={warnings.length}
        busy={busy}
        onSave={() => void onSave(false)}
        onForceSave={() => void onSave(true)}
        onOpen={() => void onOpen()}
        onPublish={() => setModuleId('publish')}
        onSettings={() => setModuleId('settings')}
      />

      <div className="app__body">
        <nav className="rail" aria-label="Módulos">
          {MODULES.map((module) => (
            <Tooltip key={module.id} content={`${module.label} · Alt+${module.shortcut}`} placement="bottom">
              <button
                type="button"
                className={cx('rail__item', moduleId === module.id && 'rail__item--active')}
                aria-current={moduleId === module.id ? 'page' : undefined}
                aria-label={module.label}
                onClick={() => setModuleId(module.id)}
              >
                {module.icon}
                {module.id === 'notes' && openNoteCount(store.project) > 0 && (
                  <span className="rail__badge">{openNoteCount(store.project)}</span>
                )}
              </button>
            </Tooltip>
          ))}
          <span className="rail__spacer" />
          <Tooltip content="Ajustes del proyecto" placement="top">
            <button
              type="button"
              className={cx('rail__item', moduleId === 'settings' && 'rail__item--active')}
              aria-label="Ajustes del proyecto"
              onClick={() => setModuleId('settings')}
            >
              <IconSettings size={18} />
            </button>
          </Tooltip>
        </nav>

        {moduleId === 'scenes' ? (
          <ScenesModule
            store={store}
            mediaUrls={mediaUrls}
            client={client}
            scene={scene}
            hotspot={hotspot}
            onSelectScene={(id) => {
              setSceneId(id);
              setHotspotId(null);
            }}
            onSelectHotspot={setHotspotId}
            onSelectAsset={(id) => {
              setAssetId(id);
              setModuleId('assets');
            }}
            clipboard={clipboard}
            onCopy={setClipboard}
            onRequestDelete={setConfirmDelete}
            onAutoConnect={() => setAutoConnect(true)}
          />
        ) : (
          <>
            {/* Los módulos de datos ocupan panel y lienzo: una tabla de
                cuatrocientas notas en 288 px no se puede leer. */}
            <div className="app__main">
              {moduleId === 'assets' && (
                <AssetsModule
                  store={store}
                  selectedAssetId={assetId}
                  onSelectAsset={setAssetId}
                  client={client}
                  onGoToLocation={(targetSceneId, targetHotspotId) => {
                    setSceneId(targetSceneId);
                    setHotspotId(targetHotspotId);
                    setModuleId('scenes');
                  }}
                />
              )}
              {moduleId === 'notes' && (
                <NotesModule
                  store={store}
                  onGoToScene={(targetSceneId) => {
                    setSceneId(targetSceneId);
                    setModuleId('scenes');
                  }}
                />
              )}
              {moduleId === 'plans' && (
                <PlansModule
                  store={store}
                  mediaUrls={mediaUrls}
                  onMediaUrl={addMediaUrl}
                  activeSceneId={sceneId}
                  onSelectScene={setSceneId}
                />
              )}
              {moduleId === 'windows' && <InfoWindowsModule store={store} />}
              {moduleId === 'telemetry' && <TelemetryModule store={store} client={client} />}
              {moduleId === 'tours' && <ToursModule store={store} />}
              {moduleId === 'skin' && <SkinEditor store={store} />}
              {moduleId === 'publish' && <PublishModule store={store} mediaFiles={mediaFiles} />}
              {moduleId === 'settings' && (
                <>
                  <SettingsModule store={store} />
                  <BackupPanel
                    store={store}
                    mediaUrls={mediaUrls}
                    mediaFiles={mediaFiles}
                    projectPath={store.filePath}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>

      <StatusBar store={store} scene={scene} client={client} />

      <AutoConnectDialog open={autoConnect} onClose={() => setAutoConnect(false)} store={store} />

      <ConfirmDialog
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete === null) return;
          if (confirmDelete.kind === 'scene') {
            store.removeScene(confirmDelete.id);
            if (sceneId === confirmDelete.id) setSceneId(store.project.scenes[0]?.id ?? null);
          } else if (scene !== null) {
            store.removeHotspots(scene.id, [confirmDelete.id]);
            setHotspotId(null);
          }
          setConfirmDelete(null);
        }}
        title={confirmDelete?.kind === 'scene' ? 'Eliminar escena' : 'Eliminar marcador'}
        message={
          confirmDelete?.kind === 'scene'
            ? 'Se eliminarán la escena, sus marcadores y las ubicaciones de activos que la referencian. La acción se puede deshacer.'
            : 'Se eliminará el marcador y sus acciones. La acción se puede deshacer.'
        }
        confirmLabel="Eliminar"
        destructive
      />
    </div>
  );
}

function openNoteCount(project: Project): number {
  return project.notes.filter((n) => n.status === 'open' || n.status === 'inProgress').length;
}

/* ------------------------------------------------------------------ *
 * Barra de comandos
 * ------------------------------------------------------------------ */

interface CommandBarProps {
  readonly store: ProjectStore;
  readonly errors: number;
  readonly warnings: number;
  readonly busy: 'saving' | 'opening' | null;
  readonly onSave: () => void;
  readonly onForceSave: () => void;
  readonly onOpen: () => void;
  readonly onPublish: () => void;
  readonly onSettings: () => void;
}

function CommandBar({
  store,
  errors,
  warnings,
  busy,
  onSave,
  onForceSave,
  onOpen,
  onPublish,
  onSettings,
}: CommandBarProps): JSX.Element {
  return (
    <header className="commandbar">
      <div className="commandbar__brand">
        <span className="brandmark" aria-hidden="true" />
        <span className="commandbar__name">INDUSTRIAL TWINS 360</span>
      </div>

      <div className="commandbar__title">
        <span className="commandbar__project">{store.project.title}</span>
        {store.dirty && (
          <Tooltip content="Hay cambios sin guardar">
            <span className="commandbar__dirty" aria-label="Cambios sin guardar" />
          </Tooltip>
        )}
        {store.filePath !== null && <span className="commandbar__path">{store.filePath}</span>}
      </div>

      <div className="commandbar__group">
        <Tooltip content={store.undoLabel !== null ? `Deshacer ${store.undoLabel.toLowerCase()} · Ctrl+Z` : 'Nada que deshacer'}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<IconUndo size={15} />}
            aria-label="Deshacer"
            disabled={!store.canUndo}
            onClick={store.undo}
          />
        </Tooltip>
        <Tooltip content={store.redoLabel !== null ? `Rehacer ${store.redoLabel.toLowerCase()} · Ctrl+Shift+Z` : 'Nada que rehacer'}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<IconRedo size={15} />}
            aria-label="Rehacer"
            disabled={!store.canRedo}
            onClick={store.redo}
          />
        </Tooltip>
      </div>

      <div className="commandbar__group">
        <Button size="sm" variant="ghost" icon={<IconFolder size={15} />} disabled={busy !== null} onClick={onOpen}>
          Abrir
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={busy === 'saving' ? <Spinner size={14} /> : <IconSave size={15} />}
          disabled={busy !== null}
          onClick={onSave}
        >
          Guardar
        </Button>
        <Menu
          label="Más opciones de archivo"
          align="start"
          trigger={(props) => (
            <Button size="sm" variant="ghost" iconOnly icon={<IconMore size={14} />} aria-label="Más opciones de archivo" {...props} />
          )}
          items={[
            { id: 'open', label: 'Abrir proyecto…', icon: <IconFolder size={13} />, onSelect: onOpen },
            { id: 'save', label: 'Guardar', icon: <IconSave size={13} />, onSelect: onSave },
            {
              id: 'force',
              label: 'Guardar de todas formas',
              icon: <IconExperimental size={13} />,
              separatorBefore: true,
              disabled: errors === 0,
              onSelect: onForceSave,
            },
          ]}
        />
      </div>

      <div className="commandbar__group">
        {errors > 0 ? (
          <Badge tone="alarm" dot>
            {errors} error{errors === 1 ? '' : 'es'} de integridad
          </Badge>
        ) : warnings > 0 ? (
          <Badge tone="warning" dot>
            {warnings} aviso{warnings === 1 ? '' : 's'}
          </Badge>
        ) : (
          <Badge tone="nominal" dot>
            Integridad correcta
          </Badge>
        )}
      </div>

      <div className="commandbar__group">
        <ThemeToggle />
        <Tooltip content="Ajustes del proyecto">
          <Button size="sm" variant="ghost" iconOnly icon={<IconSettings size={15} />} aria-label="Ajustes" onClick={onSettings} />
        </Tooltip>
        <Button size="sm" variant="primary" icon={<IconPublish size={15} />} onClick={onPublish}>
          Publicar
        </Button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Módulo de escenas
 * ------------------------------------------------------------------ */

interface ScenesModuleProps {
  readonly store: ProjectStore;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly client: TelemetryClient;
  readonly scene: Scene | null;
  readonly hotspot: Hotspot | null;
  readonly onSelectScene: (id: string) => void;
  readonly onSelectHotspot: (id: string | null) => void;
  readonly onSelectAsset: (id: string) => void;
  readonly clipboard: readonly Hotspot[];
  readonly onCopy: (hotspots: readonly Hotspot[]) => void;
  readonly onRequestDelete: (target: { kind: 'scene' | 'hotspot'; id: string }) => void;
  readonly onAutoConnect: () => void;
}

function ScenesModule({
  store,
  mediaUrls,
  client,
  scene,
  hotspot,
  onSelectScene,
  onSelectHotspot,
  onSelectAsset,
  clipboard,
  onCopy,
  onRequestDelete,
  onAutoConnect,
}: ScenesModuleProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [tagsOpen, setTagsOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(store.project.scenes.map((s) => s.id)),
  );
  const [view, setView] = useState<CameraView | null>(null);
  const [placing, setPlacing] = useState(false);
  const { push } = useToast();

  /**
   * Consulta del buscador, con etiquetas (Y08).
   *
   * «bomba #critico» busca lo que se llame «bomba» y además esté etiquetado
   * como crítico. La tilde no hace falta: quien escribe deprisa la omite, y
   * obligarle a acertarla convertiría la búsqueda en un acertijo.
   */
  const searchQuery = useMemo(() => parseSearchQuery(query), [query]);

  /**
   * Árbol de escenas con sus marcadores (Y08).
   *
   * El filtro conserva la escena cuando alguno de sus marcadores coincide,
   * de modo que buscar «P-101» muestra en qué escenas aparece ese equipo en
   * vez de vaciar el árbol.
   */
  const treeNodes = useMemo<readonly TreeNode[]>(() => {
    const sceneMatches = (scene: (typeof store.project.scenes)[number]): boolean =>
      matchesSearch(searchQuery, { tags: scene.tags, fields: [scene.title] });

    return store.project.scenes
      .map<TreeNode | null>((s) => {
        const hotspotNodes = s.hotspots
          .filter(
            (h) =>
              matchesSearch(searchQuery, { tags: h.tags, fields: [h.name] }) || sceneMatches(s),
          )
          .map<TreeNode>((h) => ({
            id: h.id,
            label: h.name,
            icon: <IconHotspot size={13} />,
            tone: h.autoGenerated && !h.reviewed ? 'experimental' : 'accent',
            meta: h.locked ? <IconLock size={11} /> : undefined,
            warning:
              h.autoGenerated && !h.reviewed
                ? 'Propuesta automática sin revisar: no se publicará'
                : undefined,
          }));

        if (!sceneMatches(s) && hotspotNodes.length === 0) return null;

        return {
          id: s.id,
          label: s.title,
          icon: s.kind === 'model' ? <IconLayers size={14} /> : <IconPanorama size={14} />,
          meta: String(s.hotspots.length),
          children: hotspotNodes,
          tone: s.excludedFromPublish ? 'neutral' : undefined,
          warning: s.excludedFromPublish ? 'Excluida de la publicación' : undefined,
        } satisfies TreeNode;
      })
      .filter((n): n is TreeNode => n !== null);
  }, [store.project.scenes, searchQuery]);

  const viewerScene = useMemo<ViewerScene | null>(() => {
    if (scene === null) return null;
    const media = store.project.media.find((m) => m.id === scene.mediaId);
    return {
      id: scene.id,
      title: scene.title,
      textureUrl: scene.mediaId !== null ? (mediaUrls.get(scene.mediaId) ?? null) : null,
      coverage: media?.panorama?.coverage ?? {
        horizontalDeg: 360,
        verticalDeg: 180,
        centerYaw: 0,
        centerPitch: 0,
      },
      camera: scene.camera,
      hotspots: scene.hotspots,
    };
  }, [scene, store.project.media, mediaUrls]);

  const addScene = useCallback(() => {
    const now = new Date().toISOString();
    const firstMedia = store.project.media.find((m) => m.panorama !== null);
    const created: Scene = {
      id: newUuid(),
      projectId: store.project.id,
      kind: 'panorama',
      title: `Escena ${store.project.scenes.length + 1}`,
      description: '',
      mediaId: firstMedia?.id ?? null,
      camera: scene?.camera ?? {
        initialView: { yaw: 0, pitch: 0, fov: 75 },
        zoom: { minFovDeg: 30, maxFovDeg: 100 },
        dragSpeed: 1,
        inertia: 0.82,
        autoRotate: false,
        autoRotateSpeed: 0.05,
        autoRotateIdleS: 8,
        invertPitch: false,
      },
      model: null,
      hotspots: [],
      actions: [],
      order: store.project.scenes.length,
      group: scene?.group ?? '',
      tags: [],
      excludedFromPublish: false,
      ambientEffect: { effect: 'none', intensity: 0.5 },
      createdAt: now,
      updatedAt: now,
    };
    store.addScene(created);
    onSelectScene(created.id);
  }, [store, scene, onSelectScene]);

  /**
   * Alta de una escena de modelo 3D.
   *
   * Nace con los tres modos de cámara permitidos y la resolución adaptativa
   * puesta: son los valores con los que un modelo de planta es navegable en un
   * portátil corriente, que es donde se va a abrir.
   */
  const addModelScene = useCallback(() => {
    const now = new Date().toISOString();

    // Se construye pasando por el esquema para que los valores por defecto los
    // ponga él. Enumerarlos aquí a mano produciría una escena a la que le
    // falta un campo en cuanto el esquema gane uno, y el fallo saldría al
    // abrir el proyecto, no al crearla.
    const created = sceneSchema.parse({
      id: newUuid(),
      projectId: store.project.id,
      kind: 'model',
      title: `Modelo ${store.project.scenes.filter((candidate) => candidate.kind === 'model').length + 1}`,
      mediaId: null,
      model: defaultModelSettings(),
      order: store.project.scenes.length,
      createdAt: now,
      updatedAt: now,
    });

    store.addScene(created);
    onSelectScene(created.id);
  }, [store, onSelectScene]);

  const placeHotspot = useCallback(
    (yaw: number, pitch: number) => {
      if (scene === null) return;
      const now = new Date().toISOString();
      const created = {
        id: newUuid(),
        sceneId: scene.id,
        name: `Marcador ${scene.hotspots.length + 1}`,
        anchor: { space: 'spherical', yaw, pitch },
        geometry: { shape: 'icon', mediaId: null, builtinIcon: 'marker', sizePx: 40 },
        style: {
          colorToken: 'accent',
          colorOverride: null,
          opacity: 1,
          pulse: false,
          showLabel: false,
          labelTemplate: '',
          hoverScale: 1.15,
          transform: { scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 },
          projection: 'billboard',
        },
        actions: [],
        assetId: null,
        visibility: { desktop: true, tablet: true, mobile: true, vr: true },
        preload: 'lazy',
        locked: false,
        hiddenInEditor: false,
        tags: [],
        autoGenerated: false,
        autoConfidence: null,
        reviewed: true,
        order: scene.hotspots.length,
        createdAt: now,
        updatedAt: now,
      } as Hotspot;

      store.addHotspot(scene.id, created);
      onSelectHotspot(created.id);
      setPlacing(false);
    },
    [scene, store, onSelectHotspot],
  );

  return (
    <>
      <aside className="app__sidebar">
        <div className="sidebar__head">
          <h2 className="sidebar__title">Escenas</h2>
          <Menu
            label="Acciones de escenas"
            align="end"
            trigger={(props) => (
              <Button size="sm" variant="ghost" iconOnly icon={<IconMore size={14} />} aria-label="Más acciones" {...props} />
            )}
            items={[
              { id: 'add', label: 'Añadir escena', icon: <IconAdd size={13} />, onSelect: addScene },
      {
        id: 'add-model',
        label: 'Añadir escena de modelo 3D',
        icon: <IconAdd size={13} />,
        onSelect: addModelScene,
      },
              {
                id: 'entry',
                label: 'Marcar como escena de entrada',
                icon: <IconCheck size={13} />,
                disabled: scene === null,
                onSelect: () => {
                  if (scene === null) return;
                  store.updateProject('Cambiar escena de entrada', {
                    settings: { ...store.project.settings, entrySceneId: scene.id as Uuid },
                  });
                  push({ tone: 'nominal', title: `«${scene.title}» es la escena de entrada` });
                },
              },
              {
                id: 'autoconnect',
                label: 'Proponer conexiones automáticamente…',
                icon: <IconExperimental size={13} />,
                separatorBefore: true,
                // La función es experimental y el proyecto decide si se ofrece:
                // deshabilitada por defecto, como exige la configuración segura.
                disabled: !store.project.settings.experimentalFeatures,
                onSelect: onAutoConnect,
              },
              {
                id: 'exclude',
                label: scene?.excludedFromPublish === true ? 'Incluir en la publicación' : 'Excluir de la publicación',
                icon: scene?.excludedFromPublish === true ? <IconEye size={13} /> : <IconEyeOff size={13} />,
                disabled: scene === null,
                separatorBefore: true,
                onSelect: () => {
                  if (scene === null) return;
                  store.updateScene(
                    scene.id,
                    scene.excludedFromPublish ? 'Incluir escena' : 'Excluir escena',
                    { excludedFromPublish: !scene.excludedFromPublish },
                  );
                },
              },
              {
                id: 'delete',
                label: 'Eliminar escena',
                icon: <IconTrash size={13} />,
                destructive: true,
                disabled: scene === null,
                onSelect: () => {
                  if (scene !== null) onRequestDelete({ kind: 'scene', id: scene.id });
                },
              },
            ]}
          />
        </div>

        <div className="sidebar__search">
          <TextInput
            size="sm"
            placeholder="Buscar, o #etiqueta"
            prefix={<IconSearch size={13} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Buscar en el recorrido"
          />
          <Tooltip content="Organizar etiquetas del proyecto">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="Organizar etiquetas"
              onClick={() => setTagsOpen(true)}
              icon={<IconTag size={13} />}
            />
          </Tooltip>
        </div>

        <div className="sidebar__body">
          <Tree
            nodes={treeNodes}
            label="Escenas y marcadores"
            selectedId={hotspot?.id ?? scene?.id ?? null}
            expandedIds={expanded}
            onToggle={(id) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelect={(id) => {
              const isScene = store.project.scenes.some((s) => s.id === id);
              if (isScene) onSelectScene(id);
              else {
                const owner = store.project.scenes.find((s) => s.hotspots.some((h) => h.id === id));
                if (owner !== undefined) onSelectScene(owner.id);
                onSelectHotspot(id);
              }
            }}
            emptyMessage={
              isEmptyQuery(searchQuery) ? 'Añada una escena para empezar' : 'Ningún resultado'
            }
          />
        </div>

        <div className="sidebar__foot">
          <Button size="sm" variant="secondary" fullWidth icon={<IconAdd size={14} />} onClick={addScene}>
            Añadir escena
          </Button>
        </div>
        <TagManager
          open={tagsOpen}
          project={store.project}
          onClose={() => setTagsOpen(false)}
          onApply={(project, label) =>
            store.updateProject(label, { scenes: [...project.scenes] })
          }
        />
      </aside>

      <div className="app__main">
        <div className="canvas">
          {viewerScene === null ? (
            <EmptyState
              icon={<IconPanorama size={32} />}
              title="Sin escenas en el proyecto"
              description="Importe una panorámica equirectangular para crear la primera escena del recorrido."
              action={
                <Button variant="primary" icon={<IconAdd size={14} />} onClick={addScene}>
                  Añadir escena
                </Button>
              }
            />
          ) : (
            <>
              <div className="canvas__toolbar">
                <Tooltip content={placing ? 'Pulse en la panorámica para colocar el marcador' : 'Colocar marcador'}>
                  <Button
                    size="sm"
                    variant={placing ? 'primary' : 'ghost'}
                    iconOnly
                    icon={<IconHotspot size={15} />}
                    aria-label="Colocar marcador"
                    aria-pressed={placing}
                    onClick={() => setPlacing((v) => !v)}
                  />
                </Tooltip>
                <span className="canvas__toolbar-sep" />
                <Tooltip content="Copiar marcador seleccionado">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<IconDocument size={15} />}
                    aria-label="Copiar marcador"
                    disabled={hotspot === null}
                    onClick={() => {
                      if (hotspot === null) return;
                      onCopy([hotspot]);
                      push({ tone: 'nominal', title: 'Marcador copiado' });
                    }}
                  />
                </Tooltip>
                <Tooltip content={clipboard.length === 0 ? 'Portapapeles vacío' : `Pegar ${clipboard.length} marcador(es)`}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<IconAdd size={15} />}
                    aria-label="Pegar marcadores"
                    disabled={clipboard.length === 0 || scene === null}
                    onClick={() => {
                      if (scene === null) return;
                      store.pasteHotspots(scene.id, clipboard);
                    }}
                  />
                </Tooltip>
                <span className="canvas__toolbar-sep" />
                <Tooltip content="Volver a la vista inicial de la escena">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<IconCheck size={15} />}
                    aria-label="Vista inicial"
                    onClick={() => setView(scene?.camera.initialView ?? null)}
                  />
                </Tooltip>
                <Tooltip content="Fijar la vista actual como vista inicial">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconSave size={15} />}
                    disabled={scene === null || view === null}
                    onClick={() => {
                      if (scene === null || view === null) return;
                      store.updateScene(scene.id, 'Fijar vista inicial', {
                        camera: { ...scene.camera, initialView: view },
                      });
                      push({ tone: 'nominal', title: 'Vista inicial actualizada' });
                    }}
                  >
                    Fijar vista
                  </Button>
                </Tooltip>
              </div>

              {scene !== null && scene.kind === 'model' ? (
                <ModelSceneModule store={store} scene={scene} />
              ) : (
              <PanoramaViewer
                scene={viewerScene}
                selectedHotspotId={hotspot?.id ?? null}
                onViewChange={setView}
                {...(view !== null && placing === false ? {} : {})}
                onHotspotActivate={(activated) => onSelectHotspot(activated.id)}
                onCanvasPick={(yaw, pitch) => {
                  if (placing) placeHotspot(yaw, pitch);
                }}
              />
              )}

              <div className="canvas__corner canvas__corner--br">
                <Minimap
                  store={store}
                  mediaUrls={mediaUrls}
                  activeSceneId={scene?.id ?? null}
                  view={view}
                  onSelectScene={onSelectScene}
                />
              </div>
            </>
          )}
        </div>

        {store.project.scenes.length > 1 && (
          <div className="canvas__filmstrip">
            <ThumbnailStrip
              label="Escenas del recorrido"
              activeId={scene?.id ?? null}
              onSelect={onSelectScene}
              size={104}
              items={store.project.scenes.map((s) => ({
                id: s.id,
                title: s.title,
                src: s.mediaId !== null ? mediaUrls.get(s.mediaId) : undefined,
                badge:
                  s.id === store.project.settings.entrySceneId ? (
                    <Badge tone="accent">Entrada</Badge>
                  ) : s.excludedFromPublish ? (
                    <Badge tone="neutral">No publicada</Badge>
                  ) : undefined,
              }))}
            />
          </div>
        )}
      </div>

      <aside className="app__inspector">
        <Inspector
          store={store}
          scene={scene}
          hotspot={hotspot}
          client={client}
          view={view}
          onSelectAsset={onSelectAsset}
          onRequestDelete={onRequestDelete}
        />
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Minimapa con radar
 * ------------------------------------------------------------------ */

interface MinimapProps {
  readonly store: ProjectStore;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly activeSceneId: string | null;
  readonly view: CameraView | null;
  readonly onSelectScene: (id: string) => void;
}

/**
 * Plano con los puntos navegables y el radar de mirada (G01-G05).
 *
 * El cono del radar se dibuja con la apertura real del campo de visión y con
 * el rumbo corregido por la orientación declarada del plano. Un radar que
 * ignora esa corrección apunta sistemáticamente desviado, y sobre el terreno
 * eso es peor que no tener radar.
 */
function Minimap({ store, mediaUrls, activeSceneId, view, onSelectScene }: MinimapProps): JSX.Element | null {
  const { plans, planMarkers } = store.project;

  /* El plano que se muestra es el de la escena activa, no el primero: con
     varias zonas, mostrar siempre el primero deja al autor mirando un plano
     que no contiene la escena que está editando. */
  const plan =
    (activeSceneId === null ? null : planForScene(plans, planMarkers, activeSceneId)) ?? plans[0];
  if (plan === undefined) return null;

  const planUrl = mediaUrls.get(plan.mediaId);
  const markers = planMarkers.filter((m) => m.planId === plan.id);
  const active = activeSceneId === null ? null : markerForScene(markers, plan.id, activeSceneId);

  /* El rumbo y la apertura salen del dominio, los mismos que usa el visor: si
     el editor los calculase por su cuenta, el autor orientaría el plano con un
     radar y el visitante vería otro. */
  const cone = view !== null && active !== null && plan.showRadar ? radarCone(view, plan, active) : null;
  const conePath =
    cone === null || active === null
      ? null
      : radarConePoints(cone, { x: 0, y: 0 }, 44)
          .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
          .join(' ') + ' Z';

  const sceneTitleOf = (id: string): string =>
    store.project.scenes.find((scene) => scene.id === id)?.title ?? 'Escena';

  return (
    <div className="minimap">
      <div className="minimap__head">
        <span>{plan.name}</span>
        <span style={{ fontFamily: 'var(--it-font-mono)' }}>
          {view === null || active === null
            ? '—'
            : `${Math.round(planBearingDegrees(view, plan, active))}°`}
        </span>
      </div>
      <div style={{ position: 'relative' }}>
        {planUrl !== undefined ? (
          <img className="minimap__image" src={planUrl} alt={`Plano ${plan.name}`} />
        ) : (
          <div className="minimap__image" style={{ height: 120, background: 'var(--it-color-surface-sunken)' }} />
        )}

        {markers.map((marker) => {
          /* El rótulo del punto manda; vacío, el título de la escena. Sin esta
             reserva el botón se anunciaría como «Ir a», sin destino. */
          const name = marker.label !== '' ? marker.label : sceneTitleOf(marker.sceneId);
          return (
            <button
              key={marker.id}
              type="button"
              className={cx('minimap__marker', marker.sceneId === activeSceneId && 'minimap__marker--active')}
              title={name}
              aria-label={marker.sceneId === activeSceneId ? `${name} (escena actual)` : `Ir a ${name}`}
              style={{ left: `${marker.position.x * 100}%`, top: `${marker.position.y * 100}%` }}
              onClick={() => onSelectScene(marker.sceneId)}
            />
          );
        })}

        {conePath !== null && active !== null && (
          <svg
            className="minimap__radar"
            viewBox="-50 -50 100 100"
            width="56"
            height="56"
            style={{
              left: `calc(${active.position.x * 100}% - 28px)`,
              top: `calc(${active.position.y * 100}% - 28px)`,
            }}
            aria-hidden="true"
          >
            <path
              d={conePath}
              fill="var(--it-color-canvas-radarCone)"
              stroke="var(--it-color-accent-default)"
              strokeWidth="0.8"
              strokeOpacity="0.6"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

interface InspectorProps {
  readonly store: ProjectStore;
  readonly scene: Scene | null;
  readonly hotspot: Hotspot | null;
  readonly client: TelemetryClient;
  readonly view: CameraView | null;
  readonly onSelectAsset: (id: string) => void;
  readonly onRequestDelete: (target: { kind: 'scene' | 'hotspot'; id: string }) => void;
}

function Inspector({
  store,
  scene,
  hotspot,
  client,
  view,
  onSelectAsset,
  onRequestDelete,
}: InspectorProps): JSX.Element {
  const [tab, setTab] = useState('general');

  if (scene === null) {
    return (
      <div className="inspector__body">
        <EmptyState title="Sin selección" description="Seleccione una escena para ver sus propiedades." />
      </div>
    );
  }

  if (hotspot !== null) {
    return (
      <HotspotInspector
        store={store}
        scene={scene}
        hotspot={hotspot}
        client={client}
        onSelectAsset={onSelectAsset}
        onRequestDelete={onRequestDelete}
      />
    );
  }

  return (
    <>
      <div className="inspector__head">
        <div style={{ minWidth: 0 }}>
          <h2 className="inspector__title">{scene.title}</h2>
          <p className="inspector__subtitle">{scene.hotspots.length} marcador(es)</p>
        </div>
        <Badge tone={scene.excludedFromPublish ? 'neutral' : 'nominal'}>
          {scene.excludedFromPublish ? 'No publicada' : 'Publicable'}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Propiedades de la escena">
          <Tab id="general">General</Tab>
          <Tab id="camara">Cámara</Tab>
          <Tab id="integridad" badge={store.integrity.length > 0 ? store.integrity.length : undefined}>
            Integridad
          </Tab>
        </TabList>

        <TabPanel id="general">
          <div className="inspector__body inspector__group">
            <Field label="Título">
              {({ id }) => (
                <TextInput
                  id={id}
                  value={scene.title}
                  onChange={(event) =>
                    store.updateScene(scene.id, 'Renombrar escena', { title: event.currentTarget.value }, `scene.title:${scene.id}`)
                  }
                />
              )}
            </Field>

            <Field label="Descripción">
              {({ id }) => (
                <TextArea
                  id={id}
                  value={scene.description}
                  rows={3}
                  onChange={(event) =>
                    store.updateScene(scene.id, 'Editar descripción', { description: event.currentTarget.value }, `scene.desc:${scene.id}`)
                  }
                />
              )}
            </Field>

            <Field label="Agrupación" hint="Organiza el árbol por unidad, piso o recorrido.">
              {({ id }) => (
                <TextInput
                  id={id}
                  value={scene.group}
                  onChange={(event) =>
                    store.updateScene(scene.id, 'Cambiar agrupación', { group: event.currentTarget.value }, `scene.group:${scene.id}`)
                  }
                />
              )}
            </Field>

            <SectionLabel>Panorámica</SectionLabel>
            <PropertyList>
              <PropertyRow
                label="Archivo"
                mono
                value={store.project.media.find((m) => m.id === scene.mediaId)?.originalName ?? 'sin asignar'}
              />
              <PropertyRow
                label="Resolución"
                mono
                value={(() => {
                  const media = store.project.media.find((m) => m.id === scene.mediaId);
                  return media?.width != null ? `${media.width} × ${media.height}` : '—';
                })()}
              />
              <PropertyRow
                label="Cobertura"
                mono
                value={(() => {
                  const coverage = store.project.media.find((m) => m.id === scene.mediaId)?.panorama?.coverage;
                  return coverage === undefined
                    ? '—'
                    : `${coverage.horizontalDeg}° × ${coverage.verticalDeg}°`;
                })()}
              />
            </PropertyList>

            <SectionLabel>Publicación</SectionLabel>
            <Switch
              label="Excluir de la publicación"
              checked={scene.excludedFromPublish}
              onChange={(event) =>
                store.updateScene(scene.id, 'Cambiar publicación de escena', {
                  excludedFromPublish: event.currentTarget.checked,
                })
              }
            />
            <Switch
              label="Escena de entrada del recorrido"
              checked={store.project.settings.entrySceneId === scene.id}
              onChange={(event) =>
                store.updateProject('Cambiar escena de entrada', {
                  settings: {
                    ...store.project.settings,
                    entrySceneId: event.currentTarget.checked ? (scene.id as Uuid) : null,
                  },
                })
              }
            />

            <SectionLabel>Etiquetas</SectionLabel>
            <TagField
              tags={scene.tags}
              available={allTags(store.project)}
              onChange={(tags, label) => store.updateScene(scene.id, label, { tags: [...tags] })}
            />
          </div>
        </TabPanel>

        <TabPanel id="camara">
          <div className="inspector__body inspector__group">
            <SectionLabel>Vista inicial</SectionLabel>
            <PropertyList>
              <PropertyRow label="Azimut" mono value={`${radToDeg(scene.camera.initialView.yaw).toFixed(1)}°`} />
              <PropertyRow label="Elevación" mono value={`${radToDeg(scene.camera.initialView.pitch).toFixed(1)}°`} />
              <PropertyRow label="Campo de visión" mono value={`${scene.camera.initialView.fov.toFixed(1)}°`} />
              {view !== null && (
                <PropertyRow
                  label="Vista actual"
                  mono
                  value={`${radToDeg(view.yaw).toFixed(1)}° / ${radToDeg(view.pitch).toFixed(1)}° / ${view.fov.toFixed(0)}°`}
                />
              )}
            </PropertyList>

            <SectionLabel>Movimiento</SectionLabel>
            <Field
              label="Inercia"
              inline
              hint="0 detiene la cámara en seco al soltar; 0,95 la deja deslizar mucho."
            >
              {() => (
                <Slider
                  value={scene.camera.inertia}
                  onValueChange={(value) =>
                    store.updateScene(scene.id, 'Ajustar inercia', { camera: { ...scene.camera, inertia: value } }, `camera.inertia:${scene.id}`)
                  }
                  min={0}
                  max={0.98}
                  step={0.01}
                  aria-label="Inercia de la cámara"
                />
              )}
            </Field>

            <Field label="Velocidad de arrastre" inline>
              {() => (
                <Slider
                  value={scene.camera.dragSpeed}
                  onValueChange={(value) =>
                    store.updateScene(scene.id, 'Ajustar velocidad', { camera: { ...scene.camera, dragSpeed: value } }, `camera.drag:${scene.id}`)
                  }
                  min={0.2}
                  max={3}
                  step={0.05}
                  aria-label="Velocidad de arrastre"
                />
              )}
            </Field>

            <SectionLabel>Límites de zoom</SectionLabel>
            <Field label="FOV mínimo" inline hint="El zoom más cercano permitido.">
              {() => (
                <NumberInput
                  value={scene.camera.zoom.minFovDeg}
                  onValueChange={(value) =>
                    store.updateScene(scene.id, 'Ajustar zoom mínimo', {
                      camera: { ...scene.camera, zoom: { ...scene.camera.zoom, minFovDeg: value } },
                    }, `camera.zoomMin:${scene.id}`)
                  }
                  min={10}
                  max={scene.camera.zoom.maxFovDeg}
                  step={1}
                  unit="°"
                  decimals={0}
                  aria-label="FOV mínimo"
                />
              )}
            </Field>
            <Field label="FOV máximo" inline>
              {() => (
                <NumberInput
                  value={scene.camera.zoom.maxFovDeg}
                  onValueChange={(value) =>
                    store.updateScene(scene.id, 'Ajustar zoom máximo', {
                      camera: { ...scene.camera, zoom: { ...scene.camera.zoom, maxFovDeg: value } },
                    }, `camera.zoomMax:${scene.id}`)
                  }
                  min={scene.camera.zoom.minFovDeg}
                  max={120}
                  step={1}
                  unit="°"
                  decimals={0}
                  aria-label="FOV máximo"
                />
              )}
            </Field>

            <SectionLabel>Giro automático</SectionLabel>
            <Switch
              label="Girar al quedar inactivo"
              checked={scene.camera.autoRotate}
              onChange={(event) =>
                store.updateScene(scene.id, 'Cambiar giro automático', {
                  camera: { ...scene.camera, autoRotate: event.currentTarget.checked },
                })
              }
            />
            {scene.camera.autoRotate && (
              <Field label="Inactividad" inline>
                {() => (
                  <NumberInput
                    value={scene.camera.autoRotateIdleS}
                    onValueChange={(value) =>
                      store.updateScene(scene.id, 'Ajustar inactividad', {
                        camera: { ...scene.camera, autoRotateIdleS: value },
                      }, `camera.idle:${scene.id}`)
                    }
                    min={0}
                    max={600}
                    step={1}
                    unit="s"
                    decimals={0}
                    aria-label="Segundos de inactividad"
                  />
                )}
              </Field>
            )}
          </div>
        </TabPanel>

        <TabPanel id="integridad">
          <div className="inspector__body">
            {store.integrity.length === 0 ? (
              <EmptyState
                icon={<IconCheck size={28} />}
                tone="nominal"
                title="Sin problemas de integridad"
                description="Todas las referencias del proyecto resuelven correctamente."
              />
            ) : (
              <div className="integrity">
                {store.integrity.map((problem, index) => (
                  <div
                    key={`${problem.entityId}-${index}`}
                    className={cx('integrity__item', problem.severity === 'error' && 'integrity__item--error')}
                  >
                    <span className="integrity__entity">{problem.entity}</span>
                    <div>
                      <p style={{ margin: 0 }}>{problem.message}</p>
                      {problem.recovery !== undefined && (
                        <p className="integrity__recovery" style={{ margin: 0 }}>
                          {problem.recovery}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabPanel>
      </Tabs>

      <div className="sidebar__foot">
        <Button
          size="sm"
          variant="ghost"
          fullWidth
          icon={<IconTrash size={14} />}
          onClick={() => onRequestDelete({ kind: 'scene', id: scene.id })}
        >
          Eliminar escena
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Inspector de marcador
 * ------------------------------------------------------------------ */

interface HotspotInspectorProps {
  readonly store: ProjectStore;
  readonly scene: Scene;
  readonly hotspot: Hotspot;
  readonly client: TelemetryClient;
  readonly onSelectAsset: (id: string) => void;
  readonly onRequestDelete: (target: { kind: 'scene' | 'hotspot'; id: string }) => void;
}

function HotspotInspector({
  store,
  scene,
  hotspot,
  client,
  onSelectAsset,
  onRequestDelete,
}: HotspotInspectorProps): JSX.Element {
  const [tab, setTab] = useState('general');
  const asset = store.project.assets.find((a) => a.id === hotspot.assetId) ?? null;
  const mappings = useMemo(
    () => store.project.telemetryMappings.filter((m) => m.assetId === hotspot.assetId),
    [store.project.telemetryMappings, hotspot.assetId],
  );
  const { samples, now } = useLatestTelemetry(client, mappings);

  const update = (label: string, patch: Partial<Hotspot>, coalesceKey?: string): void => {
    store.updateHotspot(scene.id, hotspot.id, label, patch, coalesceKey);
  };

  return (
    <>
      <div className="inspector__head">
        <div style={{ minWidth: 0 }}>
          <h2 className="inspector__title">{hotspot.name}</h2>
          <p className="inspector__subtitle">{hotspot.geometry.shape}</p>
        </div>
        {hotspot.autoGenerated && !hotspot.reviewed && (
          <Badge tone="experimental" dot>
            Sin revisar
          </Badge>
        )}
      </div>

      {hotspot.autoGenerated && !hotspot.reviewed && (
        <div style={{ padding: 'var(--it-space-2) var(--it-space-3) 0' }}>
          <Callout
            tone="experimental"
            title="Propuesta automática"
            action={
              <Button size="sm" variant="primary" onClick={() => update('Confirmar propuesta', { reviewed: true })}>
                Confirmar
              </Button>
            }
          >
            Generada por la conexión automática con una confianza de{' '}
            {((hotspot.autoConfidence ?? 0) * 100).toFixed(0)} %. No se publicará hasta que se confirme.
          </Callout>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Propiedades del marcador">
          <Tab id="general">General</Tab>
          <Tab id="geometria">Geometría</Tab>
          <Tab id="estilo">Estilo</Tab>
          <Tab id="acciones" badge={hotspot.actions.length > 0 ? hotspot.actions.length : undefined}>
            Acciones
          </Tab>
          {asset !== null && (
            <Tab id="activo" icon={<IconEquipment size={13} />}>
              Activo
            </Tab>
          )}
        </TabList>

        <TabPanel id="general">
          <div className="inspector__body inspector__group">
            <Field label="Nombre">
              {({ id }) => (
                <TextInput
                  id={id}
                  value={hotspot.name}
                  onChange={(event) => update('Renombrar marcador', { name: event.currentTarget.value }, `hotspot.name:${hotspot.id}`)}
                />
              )}
            </Field>

            <SectionLabel>Posición</SectionLabel>
            {hotspot.anchor.space === 'spherical' && (
              <>
                <Field label="Azimut" inline>
                  {() => (
                    <NumberInput
                      value={radToDeg(hotspot.anchor.space === 'spherical' ? hotspot.anchor.yaw : 0)}
                      onValueChange={(deg) =>
                        update('Mover marcador', {
                          anchor: { space: 'spherical', yaw: (deg * Math.PI) / 180, pitch: hotspot.anchor.space === 'spherical' ? hotspot.anchor.pitch : 0 },
                        }, `hotspot.anchor:${hotspot.id}`)
                      }
                      min={-180}
                      max={180}
                      step={0.5}
                      unit="°"
                      decimals={1}
                      disabled={hotspot.locked}
                      aria-label="Azimut del marcador"
                    />
                  )}
                </Field>
                <Field label="Elevación" inline>
                  {() => (
                    <NumberInput
                      value={radToDeg(hotspot.anchor.space === 'spherical' ? hotspot.anchor.pitch : 0)}
                      onValueChange={(deg) =>
                        update('Mover marcador', {
                          anchor: { space: 'spherical', yaw: hotspot.anchor.space === 'spherical' ? hotspot.anchor.yaw : 0, pitch: (deg * Math.PI) / 180 },
                        }, `hotspot.anchor:${hotspot.id}`)
                      }
                      min={-90}
                      max={90}
                      step={0.5}
                      unit="°"
                      decimals={1}
                      disabled={hotspot.locked}
                      aria-label="Elevación del marcador"
                    />
                  )}
                </Field>
              </>
            )}

            <Switch
              label="Bloquear posición"
              checked={hotspot.locked}
              onChange={(event) => update('Cambiar bloqueo', { locked: event.currentTarget.checked })}
            />

            <SectionLabel>Visibilidad por dispositivo</SectionLabel>
            {(['desktop', 'tablet', 'mobile', 'vr'] as const).map((device) => (
              <Switch
                key={device}
                label={{ desktop: 'Escritorio', tablet: 'Tableta', mobile: 'Móvil', vr: 'Realidad virtual' }[device]}
                checked={hotspot.visibility[device]}
                onChange={(event) =>
                  update('Cambiar visibilidad', {
                    visibility: { ...hotspot.visibility, [device]: event.currentTarget.checked },
                  })
                }
              />
            ))}

            <Field label="Precarga" inline hint="Precargar todo satura la red y retrasa la primera imagen.">
              {({ id }) => (
                <Select
                  id={id}
                  size="sm"
                  value={hotspot.preload}
                  onChange={(event) => update('Cambiar precarga', { preload: event.currentTarget.value as Hotspot['preload'] })}
                >
                  <option value="lazy">Al interactuar</option>
                  <option value="onHover">Al pasar el puntero</option>
                  <option value="eager">Al entrar en la escena</option>
                </Select>
              )}
            </Field>

            <SectionLabel>Etiquetas</SectionLabel>
            <TagField
              tags={hotspot.tags}
              available={allTags(store.project)}
              onChange={(tags, label) => update(label, { tags: [...tags] })}
            />
          </div>
        </TabPanel>

        <TabPanel id="geometria">
          <div className="inspector__body">
            <HotspotGeometryPanel
              project={store.project}
              hotspot={hotspot}
              onChange={(patch, label, coalesceKey) => update(label, patch, coalesceKey)}
            />
          </div>
        </TabPanel>

        <TabPanel id="estilo">
          <div className="inspector__body inspector__group">
            <Field label="Color" inline>
              {({ id }) => (
                <Select
                  id={id}
                  size="sm"
                  value={hotspot.style.colorToken}
                  onChange={(event) =>
                    update('Cambiar color', {
                      style: { ...hotspot.style, colorToken: event.currentTarget.value as Hotspot['style']['colorToken'] },
                    })
                  }
                >
                  <option value="accent">Acento</option>
                  <option value="nominal">Normal</option>
                  <option value="warning">Atención</option>
                  <option value="alarm">Alarma</option>
                  <option value="info">Información</option>
                  <option value="experimental">Experimental</option>
                  <option value="neutral">Neutro</option>
                </Select>
              )}
            </Field>

            <Field label="Proyección" inline hint="Adherido se deforma con la perspectiva; de frente siempre se lee.">
              {({ id }) => (
                <Select
                  id={id}
                  size="sm"
                  value={hotspot.style.projection}
                  onChange={(event) =>
                    update('Cambiar proyección', {
                      style: { ...hotspot.style, projection: event.currentTarget.value as Hotspot['style']['projection'] },
                    })
                  }
                >
                  <option value="billboard">De frente al observador</option>
                  <option value="sticker">Adherido a la escena</option>
                  <option value="floating">Fijo en pantalla</option>
                </Select>
              )}
            </Field>

            <Field label="Escala" inline>
              {() => (
                <Slider
                  value={hotspot.style.transform.scale}
                  onValueChange={(value) =>
                    update('Cambiar escala', {
                      style: { ...hotspot.style, transform: { ...hotspot.style.transform, scale: value } },
                    }, `hotspot.scale:${hotspot.id}`)
                  }
                  min={0.2}
                  max={4}
                  step={0.05}
                  aria-label="Escala del marcador"
                />
              )}
            </Field>

            <HotspotAxes
              projection={hotspot.style.projection}
              transform={hotspot.style.transform}
              onChange={(transform, label) =>
                update(label, { style: { ...hotspot.style, transform } }, `hotspot.axes:${hotspot.id}`)
              }
            />

            <Field label="Opacidad" inline>
              {() => (
                <Slider
                  value={hotspot.style.opacity}
                  onValueChange={(value) =>
                    update('Cambiar opacidad', { style: { ...hotspot.style, opacity: value } }, `hotspot.opacity:${hotspot.id}`)
                  }
                  min={0.1}
                  max={1}
                  step={0.05}
                  aria-label="Opacidad del marcador"
                />
              )}
            </Field>

            <Switch
              label="Etiqueta permanente"
              checked={hotspot.style.showLabel}
              onChange={(event) =>
                update('Cambiar etiqueta', { style: { ...hotspot.style, showLabel: event.currentTarget.checked } })
              }
            />
            {hotspot.style.showLabel && (
              <Field label="Texto de la etiqueta" hint="Admite variables como {{asset.tag}}.">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={hotspot.style.labelTemplate}
                    onChange={(event) =>
                      update('Editar etiqueta', { style: { ...hotspot.style, labelTemplate: event.currentTarget.value } }, `hotspot.label:${hotspot.id}`)
                    }
                  />
                )}
              </Field>
            )}

            <Switch
              label="Pulso de atención"
              checked={hotspot.style.pulse}
              onChange={(event) =>
                update('Cambiar pulso', { style: { ...hotspot.style, pulse: event.currentTarget.checked } })
              }
            />
            {hotspot.style.pulse && (
              <Callout tone="warning">
                Una escena con muchos marcadores pulsando a la vez resulta ilegible. Resérvelo para lo que
                de verdad deba llamar la atención.
              </Callout>
            )}
          </div>
        </TabPanel>

        <TabPanel id="acciones">
          <div className="inspector__body">
            <ActionEditor
              project={store.project}
              scene={scene}
              actions={hotspot.actions}
              emptyWarning={{
                title: 'Este marcador no hace nada',
                detail: 'Se ve en la escena pero no responde al pulsarlo. Añada al menos una acción.',
              }}
              onChange={(actions, label) => update(label, { actions: [...actions] })}
            />
          </div>
        </TabPanel>

        {asset !== null && (
          <TabPanel id="activo">
            <div className="inspector__body inspector__group">
              <div className="assetcard">
                <span className="assetcard__tag">{asset.tag}</span>
                <span className="assetcard__name">{asset.name}</span>
                <Button size="sm" variant="quiet" onClick={() => onSelectAsset(asset.id)}>
                  Abrir ficha completa
                </Button>
              </div>

              {mappings.length > 0 && (
                <>
                  <SectionLabel>
                    Instrumentos
                    {client.kind === 'simulated' && <Badge tone="experimental">simulado</Badge>}
                  </SectionLabel>
                  {mappings.map((mapping) => (
                    <Gauge
                      key={mapping.id}
                      mapping={mapping}
                      sample={samples.find((s) => s.mappingId === mapping.id)}
                      rules={store.project.conditionRules.filter((r) => r.mappingId === mapping.id)}
                      now={now}
                    />
                  ))}
                </>
              )}
            </div>
          </TabPanel>
        )}
      </Tabs>

      <div className="sidebar__foot">
        <Button
          size="sm"
          variant="ghost"
          fullWidth
          icon={<IconTrash size={14} />}
          onClick={() => onRequestDelete({ kind: 'hotspot', id: hotspot.id })}
        >
          Eliminar marcador
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Barra de estado
 * ------------------------------------------------------------------ */

function StatusBar({
  store,
  scene,
  client,
}: {
  store: ProjectStore;
  scene: Scene | null;
  client: TelemetryClient;
}): JSX.Element {
  const mappings = store.project.telemetryMappings;
  // La barra de estado se refresca más despacio que los instrumentos: resume
  // el estado general y no hace falta que vaya al ritmo de una variable.
  const { samples } = useLatestTelemetry(client, mappings, 10_000);

  const condition: ConditionLevel = useMemo(() => {
    if (samples.length === 0) return 'unknown';
    return worstCondition(
      samples.map((sample) =>
        evaluateCondition(
          sample,
          store.project.conditionRules.filter((r) => r.mappingId === sample.mappingId),
        ).level,
      ),
    );
  }, [samples, store.project.conditionRules]);

  const errors = store.integrity.filter((p) => p.severity === 'error').length;

  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        Escenas <span className="statusbar__value">{store.stats.scenes}</span>
      </span>
      <span className="statusbar__item">
        Marcadores <span className="statusbar__value">{store.stats.hotspots}</span>
      </span>
      <span className="statusbar__item">
        Activos <span className="statusbar__value">{store.stats.assets}</span>
      </span>
      <span className="statusbar__item">
        Notas abiertas <span className="statusbar__value">{store.stats.openNotes}</span>
      </span>

      {store.stats.unreviewedHotspots > 0 && (
        <span className="statusbar__item" style={{ color: 'var(--it-color-status-experimental)' }}>
          <IconExperimental size={11} />
          {store.stats.unreviewedHotspots} propuesta(s) sin revisar
        </span>
      )}

      <span className="statusbar__spacer" />

      {scene !== null && (
        <span className="statusbar__item">
          <IconPanorama size={11} />
          {scene.title}
        </span>
      )}

      {mappings.length > 0 && (
        <span className="statusbar__item">
          <span
            className="statusbar__dot"
            style={{
              background:
                condition === 'unknown'
                  ? 'var(--it-color-text-tertiary)'
                  : `var(--it-color-status-${condition})`,
            }}
          />
          {CONDITION_LABELS[condition]}
          {client.kind === 'simulated' && <span style={{ opacity: 0.7 }}>· simulado</span>}
        </span>
      )}

      <span
        className="statusbar__item"
        style={{ color: errors > 0 ? 'var(--it-color-status-alarm)' : undefined }}
      >
        {errors > 0 ? <IconClose size={11} /> : <IconCheck size={11} />}
        {errors > 0 ? `${errors} error(es)` : 'Integridad correcta'}
      </span>

      <span className="statusbar__item">
        <IconPlan size={11} />
        Formato v{store.project.schemaVersion}
      </span>
    </footer>
  );
}
