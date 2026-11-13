/**
 * Visor del recorrido publicado.
 *
 * Es de sólo lectura por construcción, no por configuración: no importa el
 * almacén del editor, no tiene comandos de edición y no conoce ninguna ruta de
 * escritura. Lo único que puede hacer con datos externos es pedir lecturas de
 * telemetría al servicio declarado en el manifiesto.
 *
 * La interfaz se reduce a lo que un operador necesita delante de la pantalla:
 * la panorámica, los marcadores, el plano con el radar, y la ficha del activo
 * cuando pulsa uno. Todo lo demás —árboles, inspectores, paneles de
 * propiedades— es del editor y aquí sólo estorbaría.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONDITION_LABELS,
  DATA_QUALITY_LABELS,
  evaluateCondition,
  radToDeg,
  worstCondition,
  type ActionConfig,
  type CameraView,
  type ConditionLevel,
  type Hotspot,
  type Manifest,
  type Action,
  type ActionEvent,
  type Question,
  type Quiz,
  type QuizRuntime,
  type Scene,
  type TelemetrySample,
} from '@it360/domain';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconDocument,
  IconPanorama,
  IconNote,
  IconPlan,
  IconTour,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Tooltip,
  cx,
} from '@it360/ui';
import {
  ActionRunner,
  PanoramaViewer,
  resolveEntryView,
  type ActionHost,
  type ViewerScene,
} from '@it360/viewer';
import type { LoadedTour } from './manifest';
import { mediaUrlIndex } from './manifest';
import { FieldNotePanel } from './FieldNotePanel';
import { WindowHost } from './WindowHost';
import {
  documentWindow,
  mediaWindow,
  safeDownloadName,
  type TourWindow,
} from './windows';
import { PublishedTelemetry } from './telemetry';
import { QuizPlayer } from './QuizPlayer';
import { TourPlayerBar } from './TourPlayerBar';
import { useTourPlayback } from './useTourPlayback';
import { targetForHotspot, tourGate, type SessionResult } from './playback';

export interface TourViewerProps {
  readonly tour: LoadedTour;
}

export function TourViewer({ tour }: TourViewerProps): JSX.Element {
  const manifest = tour.manifest;
  const mediaUrls = useMemo(() => mediaUrlIndex(tour), [tour]);

  const [sceneId, setSceneId] = useState<string | null>(
    manifest.entrySceneId ?? manifest.scenes[0]?.id ?? null,
  );
  const [view, setView] = useState<CameraView | null>(null);
  const [pendingView, setPendingView] = useState<CameraView | null>(null);
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [info, setInfo] = useState<{ title: string; body: string } | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [openWindow, setOpenWindow] = useState<TourWindow | null>(null);
  /**
   * Puntuaciones de la sesión.
   *
   * Viven en memoria y se pierden al recargar, a propósito: el recorrido
   * publicado es de sólo lectura y no tiene dónde guardarlas. Persistirlas en
   * el navegador daría la impresión de un progreso guardado que nadie podría
   * recuperar en otro equipo.
   */
  const [scores, setScores] = useState<Readonly<Record<string, number>>>({});
  const scoresRef = useRef(scores);
  scoresRef.current = scores;

  /** Evaluación en curso y resultados de la sesión (J08, O09). */
  const [activeQuizId, setActiveQuizId] = useState<string | null>(null);
  const [results, setResults] = useState<readonly SessionResult[]>([]);
  const [huntQuestion, setHuntQuestion] = useState<Question | null>(null);
  const [huntFound, setHuntFound] = useState<readonly string[]>([]);
  /** Lo que impide arrancar un recorrido condicionado, para poder decirlo. */
  const [gateBlocked, setGateBlocked] = useState<{ reason: string; quizId: string | null } | null>(
    null,
  );

  const scene = useMemo(
    () => manifest.scenes.find((s) => s.id === sceneId) ?? manifest.scenes[0] ?? null,
    [manifest.scenes, sceneId],
  );

  const telemetry = useMemo(
    () => new PublishedTelemetry(manifest, tour.baseUrl),
    [manifest, tour.baseUrl],
  );

  /* ---------------------------------------------------------------- *
   * Navegación entre escenas
   * ---------------------------------------------------------------- */

  const goToScene = useCallback(
    (targetId: string, config?: Extract<ActionConfig, { type: 'goToScene' }>) => {
      const target = manifest.scenes.find((s) => s.id === targetId);
      if (target === undefined) return;

      /**
       * La vista de entrada la resuelve el motor del visor (C11), no esta
       * pantalla. Qué significa «entrada inteligente» —mirar hacia donde se
       * seguiría avanzando y no hacia el punto del que se viene— es una regla
       * del producto, y duplicarla aquí la haría divergir del editor en la
       * primera corrección.
       */
      const returnHotspot = target.hotspots.find((hotspot) =>
        hotspot.actions.some(
          (action) => action.config.type === 'goToScene' && action.config.sceneId === sceneId,
        ),
      );
      const returnYaw =
        returnHotspot !== undefined && returnHotspot.anchor.space === 'spherical'
          ? returnHotspot.anchor.yaw
          : undefined;

      const entry = resolveEntryView(view ?? target.camera.initialView, {
        sceneId: targetId,
        entryMode: config?.entryMode ?? 'smart',
        initialView: target.camera.initialView,
        ...(config?.customView !== undefined ? { customView: config.customView } : {}),
        ...(returnYaw !== undefined ? { returnHotspotYaw: returnYaw } : {}),
      });

      setSceneId(targetId);
      setPendingView(entry);
    },
    [manifest.scenes, view, sceneId],
  );

  /* ---------------------------------------------------------------- *
   * Ejecución de acciones
   * ---------------------------------------------------------------- */

  const runnerRef = useRef<ActionRunner | null>(null);

  /**
   * Ejecuta una lista de acciones sueltas (parada de recorrido, objetivo).
   *
   * El evento se pasa porque el ejecutor filtra por él: una acción de parada
   * declarada «al llegar» no se dispararía con el evento de un objetivo, y
   * ejecutarlas todas sin filtrar haría que una acción deshabilitada o de otro
   * evento se colase.
   */
  const runActions = useCallback((actions: readonly Action[], event: ActionEvent) => {
    const runner = runnerRef.current;
    if (runner === null) return;
    void runner.run(actions, event, {
      context: {
        device: 'desktop',
        online: globalThis.navigator?.onLine ?? true,
        published: true,
        inVr: false,
      },
      nowMs: Date.now(),
    });
  }, []);

  const playback = useTourPlayback({
    goTo: (targetSceneId, targetView) => {
      setSceneId(targetSceneId);
      setPendingView(targetView);
    },
    runActions: (actions) => runActions(actions, 'waypointReached'),
    audioUrl: (mediaId) => (mediaId === null ? null : (mediaUrls.get(mediaId) ?? null)),
  });

  /**
   * Arranca un recorrido comprobando antes su condición (J08).
   *
   * Si falta la evaluación no se arranca a medias ni en silencio: se dice qué
   * falta y se ofrece hacerla, que es lo único que el visitante puede hacer
   * al respecto.
   */
  const startTour = useCallback(
    (tourId: string) => {
      const target = manifest.tours.find((t) => t.id === tourId);
      if (target === undefined) return;

      const verdict = tourGate(target, manifest.quizzes, results);
      if (!verdict.allowed) {
        setGateBlocked({ reason: verdict.reason, quizId: verdict.quizId });
        return;
      }

      setGateBlocked(null);
      playback.start(target);
    },
    [manifest.tours, manifest.quizzes, results, playback],
  );

  const host = useMemo<ActionHost>(
    () => ({
      goToScene: (id, config) => {
        goToScene(id, config);
      },
      lookAt: (target) => setPendingView(target),
      openInfoWindow: (windowId) => {
        // Las ventanas que el autor define en la interfaz todavía no las
        // interpreta esta versión del visor. Se dice en una ventana, con el
        // identificador, en lugar de abrir un recuadro vacío: así el autor que
        // prueba su recorrido sabe qué le falta.
        setOpenWindow({
          kind: 'info',
          title: 'Ventana de información',
          body: `Esta versión del visor todavía no muestra las ventanas definidas en la interfaz (${windowId}).`,
          mediaUrl: null,
          modal: false,
        });
      },
      openMedia: (mediaId, albumMediaIds, autoplay) => {
        // Dentro del recorrido y no en una pestaña nueva: un álbum necesita un
        // «siguiente», y en una pestaña nueva no hay ninguno.
        const win = mediaWindow({ manifest, mediaUrls }, mediaId, albumMediaIds, autoplay);
        if (win !== null) setOpenWindow(win);
      },
      openDocument: (documentId, page) => {
        const win = documentWindow({ manifest, mediaUrls }, documentId, page);
        if (win !== null) setOpenWindow(win);
      },
      downloadFile: (mediaId, suggestedName) => {
        const url = mediaUrls.get(mediaId);
        if (url === undefined) return;

        const media = manifest.media.find((candidate) => candidate.id === mediaId);
        const link = globalThis.document.createElement('a');
        link.href = url;
        // El nombre se sanea: uno con `../` escrito en el proyecto no debe
        // poder decidir dónde se guarda el archivo.
        link.download = safeDownloadName(suggestedName, media?.originalName ?? 'archivo');
        link.rel = 'noopener';
        link.click();
      },
      openUrl: (url, external) => {
        // Siempre con `noopener`: sin él, la página abierta puede manipular
        // la que la abrió.
        globalThis.open(url, external ? '_blank' : '_self', 'noopener,noreferrer');
      },
      openWebframe: (url, width, height, allowFullscreen) => {
        // Se intenta enmarcar; si la dirección no estaba declarada al
        // publicar, la propia ventana lo explica y ofrece abrirla aparte.
        setOpenWindow({
          kind: 'webframe',
          title: 'Contenido web',
          url,
          widthPx: width,
          heightPx: height,
          allowFullscreen,
        });
      },
      setElementVisibility: () => undefined,
      setVariable: (namespace, key, operation, value) => {
        setScores((current) => {
          const previous = current[`${namespace}.${key}`] ?? 0;
          const next =
            operation === 'set'
              ? value
              : operation === 'add'
                ? previous + value
                : previous - value;
          return { ...current, [`${namespace}.${key}`]: next };
        });
      },
      getVariable: (namespace, key) => scoresRef.current[`${namespace}.${key}`] ?? 0,
      startTour: (tourId) => startTour(tourId),
      stopTour: () => playback.stop(),
      startQuiz: (quizId) => setActiveQuizId(quizId),
      showAsset: (assetId) => setOpenAssetId(assetId),
      createNote: () => undefined,
      showPlan: () => setShowPlan(true),
      setVisualEffect: () => undefined,
      playMedia: () => undefined,
      pauseMedia: () => undefined,
      enterVr: () => undefined,
      exitVr: () => undefined,
      modelPlayAnimation: () => undefined,
      modelSetVisibility: () => undefined,
      runScript: () => {
        /**
         * El plan de publicación retira estas acciones del paquete cuando la
         * política no permite guiones. Si una llega hasta aquí, el visor no la
         * ejecuta: es la segunda barrera, y la que no depende de que el
         * paquete se haya generado con esta versión del exportador.
         */
        console.warn('Acción de guion ignorada: el visor publicado no ejecuta código del autor.');
      },
      log: (level, message) => {
        if (level === 'error') console.error(message);
        else if (level === 'warn') console.warn(message);
      },
    }),
    [goToScene, manifest.documents, mediaUrls, scores, startTour, playback],
  );

  useEffect(() => {
    runnerRef.current = new ActionRunner(host);
    return () => {
      // Al cambiar de anfitrión se cancelan los retardos pendientes: una
      // acción programada que se dispara después de cambiar de escena mueve
      // la cámara sola y el visitante no sabe por qué.
      runnerRef.current?.cancelPending();
    };
  }, [host]);

  /**
   * Marcador activado, con el motivo por el que se activó (D13).
   *
   * El visor distingue la pulsación de la mirada sostenida, y ese dato hay que
   * respetarlo: ejecutar las acciones de «al pulsar» cuando el visitante sólo
   * ha mirado significa que la acción de mirada que el autor configuró no se
   * ejecuta nunca y, en su lugar, se dispara otra que no esperaba.
   */
  const activateHotspot = useCallback((hotspot: Hotspot, trigger: 'click' | 'focus' = 'click') => {
    /**
     * Durante una búsqueda de marcadores, pulsar uno de los buscados cuenta
     * como hallazgo **y además** ejecuta sus acciones: el marcador sigue
     * siendo lo que es, y silenciarlo haría que la escena se comportase de
     * forma distinta durante la evaluación sin avisar.
     */
    if (huntQuestion !== null) {
      const targetId = targetForHotspot(huntQuestion, hotspot.id);
      if (targetId !== null) {
        setHuntFound((current) => (current.includes(targetId) ? current : [...current, targetId]));
      }
    }

    const runner = runnerRef.current;
    if (runner === null) return;
    void runner.run(hotspot.actions, trigger === 'focus' ? 'focusEnter' : 'click', {
      context: {
        device: 'desktop',
        online: globalThis.navigator?.onLine ?? true,
        published: true,
        inVr: false,
      },
      nowMs: Date.now(),
    });
  }, [huntQuestion]);

  /**
   * Paso del puntero sobre un marcador (D13).
   *
   * Se ejecutan las acciones de entrada del marcador nuevo y las de salida del
   * anterior. Sin la salida, una acción de «al pasar el puntero» que muestra
   * algo lo dejaría visible para siempre en cuanto el puntero se moviera.
   */
  const hoveredRef = useRef<Hotspot | null>(null);

  const hoverHotspot = useCallback((hotspot: Hotspot | null) => {
    const runner = runnerRef.current;
    const previous = hoveredRef.current;
    hoveredRef.current = hotspot;

    if (runner === null || previous?.id === hotspot?.id) return;

    const context = {
      device: 'desktop' as const,
      online: globalThis.navigator?.onLine ?? true,
      published: true,
      inVr: false,
    };

    if (previous !== null) {
      void runner.run(previous.actions, 'hoverOut', { context, nowMs: Date.now() });
    }
    if (hotspot !== null) {
      void runner.run(hotspot.actions, 'hover', { context, nowMs: Date.now() });
    }
  }, []);

  /* ---------------------------------------------------------------- *
   * Escena del visor
   * ---------------------------------------------------------------- */

  const viewerScene = useMemo<ViewerScene | null>(() => {
    if (scene === null) return null;
    const media = manifest.media.find((m) => m.id === scene.mediaId);
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
  }, [scene, manifest.media, mediaUrls]);

  const activeQuiz = useMemo<Quiz | null>(
    () => manifest.quizzes.find((q) => q.id === activeQuizId) ?? null,
    [manifest.quizzes, activeQuizId],
  );

  const asset = useMemo(
    () => manifest.assets.find((a) => a.id === openAssetId) ?? null,
    [manifest.assets, openAssetId],
  );

  if (viewerScene === null) {
    return (
      <EmptyState
        icon={<IconPanorama size={32} />}
        title="El recorrido no tiene escenas publicadas"
        description="Vuelva a publicarlo incluyendo al menos una escena."
      />
    );
  }

  return (
    <div className="tour">
      <header className="tour__bar">
        <span className="tour__title">{manifest.branding.title || manifest.title}</span>
        <span className="tour__scene">{scene?.title}</span>
        <span className="tour__spacer" />
        <SceneCondition manifest={manifest} telemetry={telemetry} />
        {manifest.tours.length > 0 && playback.tour === null && (
          <TourMenu tours={manifest.tours} onStart={startTour} />
        )}
        {manifest.plans.length > 0 && (
          <Tooltip content="Ver el plano">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<IconPlan size={15} />}
              aria-label="Ver el plano"
              onClick={() => setShowPlan(true)}
            />
          </Tooltip>
        )}
        <Tooltip content="Tomar una nota anclada a este punto">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<IconNote size={15} />}
            aria-label="Notas de campo"
            onClick={() => setNotesOpen(true)}
          />
        </Tooltip>
        {manifest.offlineCapable && (
          <Badge tone="neutral">
            Publicado el {manifest.publishedAt.slice(0, 10)}
          </Badge>
        )}
      </header>

      <div className="tour__stage">
        <PanoramaViewer
          scene={viewerScene}
          {...(pendingView !== null ? { view: pendingView } : {})}
          onViewChange={(next) => {
            setView(next);
            // Una vez el visor ha adoptado la vista de entrada, se deja de
            // forzar: mantenerla haría imposible girar la cámara.
            if (pendingView !== null) setPendingView(null);
          }}
          onHotspotActivate={activateHotspot}
          onHotspotHover={hoverHotspot}
        />

        <SceneNav scenes={manifest.scenes} activeId={scene?.id ?? null} onSelect={(id) => goToScene(id)} />

        <TourPlayerBar playback={playback} />
      </div>

      {asset !== null && (
        <Dialog
          open
          onClose={() => setOpenAssetId(null)}
          title={`${asset.tag} — ${asset.name}`}
          size="md"
        >
          <AssetCard manifest={manifest} assetId={asset.id} telemetry={telemetry} mediaUrls={mediaUrls} />
        </Dialog>
      )}

      {info !== null && (
        <Dialog open onClose={() => setInfo(null)} title={info.title} size="md">
          <p style={{ margin: 0, lineHeight: 1.6 }}>{info.body}</p>
        </Dialog>
      )}

      {activeQuiz !== null && (
        <QuizPlayer
          quiz={activeQuiz}
          mediaUrl={(mediaId) => (mediaId === null ? null : (mediaUrls.get(mediaId) ?? null))}
          onGoalReached={(actions) => runActions(actions, 'scoreThreshold')}
          onGoToScene={(id) => goToScene(id)}
          huntFound={huntFound}
          onHuntStart={(question) => {
            setHuntQuestion(question);
            setHuntFound([]);
          }}
          onFinish={(finishedRuntime: QuizRuntime) => {
            setHuntQuestion(null);
            setResults((current) => [
              ...current.filter((r) => r.quizId !== activeQuiz.id),
              { quizId: activeQuiz.id, scores: finishedRuntime.scores, finished: true },
            ]);
          }}
          onClose={() => {
            setActiveQuizId(null);
            setHuntQuestion(null);
            setHuntFound([]);
          }}
        />
      )}

      {gateBlocked !== null && (
        <Dialog
          open
          onClose={() => setGateBlocked(null)}
          title="Este recorrido tiene una condición"
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setGateBlocked(null)}>
                Cerrar
              </Button>
              {gateBlocked.quizId !== null && (
                <Button
                  variant="primary"
                  onClick={() => {
                    const quizId = gateBlocked.quizId;
                    setGateBlocked(null);
                    if (quizId !== null) setActiveQuizId(quizId);
                  }}
                >
                  Hacer la evaluación
                </Button>
              )}
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>{gateBlocked.reason}</p>
          <p style={{ marginBottom: 0, lineHeight: 1.6, color: 'var(--it-color-text-tertiary)' }}>
            El resultado se guarda sólo durante esta visita: el paquete publicado no escribe nada.
          </p>
        </Dialog>
      )}

      <WindowHost
        window={openWindow}
        onClose={() => setOpenWindow(null)}
        onAlbumIndex={(index) =>
          setOpenWindow((current) =>
            current === null || current.kind !== 'media' ? current : { ...current, index },
          )
        }
        frameOrigins={manifest.frameOrigins ?? []}
      />

      <FieldNotePanel
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        manifest={manifest}
        sceneId={scene?.id ?? null}
        sceneTitle={scene?.title ?? 'la panorámica actual'}
        // El punto es el que la cámara está mirando ahora; si el visor aún no
        // ha informado de su vista, se usa la inicial de la escena.
        yaw={view?.yaw ?? scene?.camera.initialView.yaw ?? 0}
        pitch={view?.pitch ?? scene?.camera.initialView.pitch ?? 0}
      />

      {showPlan && manifest.plans.length > 0 && (
        <Dialog open onClose={() => setShowPlan(false)} title="Plano" size="lg">
          <PlanView
            manifest={manifest}
            mediaUrls={mediaUrls}
            activeSceneId={scene?.id ?? null}
            view={view}
            onSelect={(id) => {
              setShowPlan(false);
              goToScene(id);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Menú de recorridos automáticos
 *
 * Con un solo recorrido es un botón; con varios, una lista. Un desplegable
 * para una sola opción es un clic de más.
 * ------------------------------------------------------------------ */

function TourMenu({
  tours,
  onStart,
}: {
  tours: readonly Manifest['tours'][number][];
  onStart: (tourId: string) => void;
}): JSX.Element | null {
  const playable = tours.filter((tour) => tour.waypoints.length > 0);
  const [open, setOpen] = useState(false);

  if (playable.length === 0) return null;

  const first = playable[0];
  if (playable.length === 1 && first !== undefined) {
    return (
      <Tooltip content={`Iniciar «${first.name}»`}>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconTour size={15} />}
          onClick={() => onStart(first.id)}
        >
          Recorrido
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Button size="sm" variant="ghost" icon={<IconTour size={15} />} onClick={() => setOpen(true)}>
        Recorridos
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Recorridos automáticos" size="sm">
        <ul className="tour-list">
          {playable.map((tour) => (
            <li key={tour.id}>
              <button
                type="button"
                className="tour-list__item"
                onClick={() => {
                  setOpen(false);
                  onStart(tour.id);
                }}
              >
                <span className="tour-list__name">{tour.name}</span>
                <span className="tour-list__meta">
                  {tour.waypoints.length} parada(s)
                  {tour.requiresQuizId !== null && ' · con evaluación previa'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Navegación entre escenas
 * ------------------------------------------------------------------ */

function SceneNav({
  scenes,
  activeId,
  onSelect,
}: {
  scenes: readonly Scene[];
  activeId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element | null {
  if (scenes.length < 2) return null;

  // Agrupadas por el campo del autor: en una planta con tres pisos, una lista
  // plana de cuarenta escenas no se usa.
  const groups = new Map<string, Scene[]>();
  for (const scene of scenes) {
    const key = scene.group.trim().length > 0 ? scene.group : 'Recorrido';
    groups.set(key, [...(groups.get(key) ?? []), scene]);
  }

  return (
    <nav className="tour__nav" aria-label="Escenas del recorrido">
      {[...groups].map(([group, items]) => (
        <div key={group} className="tour__navgroup">
          <span className="tour__navlabel">{group}</span>
          {items.map((scene) => (
            <button
              key={scene.id}
              type="button"
              className={cx('tour__navitem', scene.id === activeId && 'tour__navitem--active')}
              aria-current={scene.id === activeId ? 'true' : undefined}
              onClick={() => onSelect(scene.id)}
            >
              {scene.title}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Condición general
 * ------------------------------------------------------------------ */

function SceneCondition({
  manifest,
  telemetry,
}: {
  manifest: Manifest;
  telemetry: PublishedTelemetry;
}): JSX.Element | null {
  const [samples, setSamples] = useState<readonly TelemetrySample[]>([]);

  useEffect(() => {
    if (manifest.telemetryMappings.length === 0 || manifest.offlineCapable) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await telemetry.latest();
      if (!cancelled && result.ok) setSamples(result.value);
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [manifest, telemetry]);

  if (manifest.telemetryMappings.length === 0) return null;

  if (manifest.offlineCapable) {
    // Un paquete sin conexión no consulta nada. Decirlo evita que alguien
    // interprete la ausencia de alarmas como que todo está bien.
    return <Badge tone="neutral">Sin datos de proceso en este paquete</Badge>;
  }

  if (samples.length === 0) return <Badge tone="neutral">Consultando proceso…</Badge>;

  const level: ConditionLevel = worstCondition(
    samples.map(
      (sample) =>
        evaluateCondition(
          sample,
          manifest.conditionRules.filter((r) => r.mappingId === sample.mappingId),
        ).level,
    ),
  );

  return (
    <Badge tone={level === 'unknown' ? 'neutral' : level} dot>
      {CONDITION_LABELS[level]}
    </Badge>
  );
}

/* ------------------------------------------------------------------ *
 * Ficha del activo
 * ------------------------------------------------------------------ */

function AssetCard({
  manifest,
  assetId,
  telemetry,
  mediaUrls,
}: {
  manifest: Manifest;
  assetId: string;
  telemetry: PublishedTelemetry;
  mediaUrls: ReadonlyMap<string, string>;
}): JSX.Element {
  const asset = manifest.assets.find((a) => a.id === assetId);
  const mappings = manifest.telemetryMappings.filter((m) => m.assetId === assetId);
  const documents = manifest.documents.filter((d) => d.assetId === assetId);
  const [samples, setSamples] = useState<readonly TelemetrySample[]>([]);

  useEffect(() => {
    if (mappings.length === 0 || manifest.offlineCapable) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await telemetry.latest(mappings.map((m) => m.id));
      if (!cancelled && result.ok) setSamples(result.value);
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [mappings, telemetry, manifest.offlineCapable]);

  if (asset === undefined) {
    return <EmptyState title="Activo no encontrado en el recorrido publicado" />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--it-space-4)' }}>
      <PropertyList>
        <PropertyRow label="TAG" mono value={asset.tag} />
        <PropertyRow label="Fabricante" value={asset.manufacturer || '—'} />
        <PropertyRow label="Modelo" value={asset.model || '—'} />
        {asset.serialNumber.length > 0 && (
          <PropertyRow label="Número de serie" mono value={asset.serialNumber} />
        )}
      </PropertyList>

      {asset.description.length > 0 && (
        <p style={{ margin: 0, fontSize: 'var(--it-text-sm)', lineHeight: 1.6 }}>{asset.description}</p>
      )}

      {mappings.length > 0 && (
        <>
          <SectionLabel>Proceso</SectionLabel>
          {manifest.offlineCapable ? (
            <Badge tone="neutral">
              Este paquete no incluye datos de proceso en vivo
            </Badge>
          ) : (
            <PropertyList>
              {mappings.map((mapping) => {
                const sample = samples.find((s) => s.mappingId === mapping.id);
                return (
                  <PropertyRow
                    key={mapping.id}
                    label={mapping.variable}
                    mono
                    value={
                      sample === undefined
                        ? 'consultando…'
                        : sample.value === null
                          ? (sample.rawValue ?? DATA_QUALITY_LABELS[sample.quality])
                          : `${sample.value.toFixed(mapping.decimals)} ${mapping.unit}`.trim()
                    }
                    tone={
                      sample === undefined || sample.quality === 'fresh'
                        ? undefined
                        : sample.quality === 'stale'
                          ? 'warning'
                          : 'alarm'
                    }
                  />
                );
              })}
            </PropertyList>
          )}
        </>
      )}

      {documents.length > 0 && (
        <>
          <SectionLabel>Documentos</SectionLabel>
          <div style={{ display: 'grid', gap: 'var(--it-space-2)' }}>
            {documents.map((document) => {
              const url = mediaUrls.get(document.mediaId);
              return (
                <Button
                  key={document.id}
                  size="sm"
                  variant="secondary"
                  icon={<IconDocument size={14} />}
                  disabled={url === undefined}
                  onClick={() => {
                    if (url !== undefined) globalThis.open(url, '_blank', 'noopener,noreferrer');
                  }}
                >
                  {document.documentCode.length > 0 ? `${document.documentCode} — ` : ''}
                  {document.title}
                </Button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Plano
 * ------------------------------------------------------------------ */

function PlanView({
  manifest,
  mediaUrls,
  activeSceneId,
  view,
  onSelect,
}: {
  manifest: Manifest;
  mediaUrls: ReadonlyMap<string, string>;
  activeSceneId: string | null;
  view: CameraView | null;
  onSelect: (sceneId: string) => void;
}): JSX.Element {
  const plan = manifest.plans[0];
  if (plan === undefined) return <EmptyState title="El recorrido no incluye planos" />;

  const markers = manifest.planMarkers.filter((m) => m.planId === plan.id);
  const url = mediaUrls.get(plan.mediaId);

  return (
    <div className="planview">
      {url === undefined ? (
        <EmptyState title="Falta la imagen del plano en el paquete" />
      ) : (
        <div className="planview__frame">
          <img src={url} alt={`Plano ${plan.name}`} />
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className={cx(
                'planview__marker',
                marker.sceneId === activeSceneId && 'planview__marker--active',
              )}
              style={{ left: `${marker.position.x * 100}%`, top: `${marker.position.y * 100}%` }}
              aria-label={`Ir a ${marker.label}`}
              title={marker.label}
              onClick={() => onSelect(marker.sceneId)}
            />
          ))}
        </div>
      )}
      {view !== null && (
        <p className="planview__bearing">
          Rumbo de la vista actual:{' '}
          {Math.round(
            ((radToDeg(view.yaw + plan.orientation.sceneNorthOffsetRad - plan.orientation.northRad) %
              360) +
              360) %
              360,
          )}
          °
        </p>
      )}
    </div>
  );
}

