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

import { useVrSession } from './useVrSession';
import {
  CONDITION_LABELS,
  DATA_QUALITY_LABELS,
  evaluateCondition,
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
  type DeviceKind,
  type TelemetrySample,
  findSkinNode,
} from '@it360/domain';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconDocument,
  IconPanorama,
  IconNote,
  IconLink,
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
  type PanoramaRenderer,
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
  infoWindow,
  mediaWindow,
  type VariableValues,
  safeDownloadName,
  type TourWindow,
} from './windows';
import { PublishedTelemetry } from './telemetry';
import { SkinRenderer } from './SkinRenderer';
import { ModelSceneView } from './ModelSceneView';
import { classifyDevice, currentDeviceSignals } from './device';
import {
  applyVisibilityAction,
  EMPTY_SKIN_STATE,
  progressFraction,
  type SkinState,
} from '@it360/viewer';
import { QuizPlayer } from './QuizPlayer';
import { TourPlayerBar } from './TourPlayerBar';
import { useSceneTransition } from './useSceneTransition';
import { useTourPlayback } from './useTourPlayback';
import { TransitionOverlay } from './TransitionOverlay';
import { formatElapsed, targetForHotspot, tourGate, type SessionResult } from './playback';
import { buildShareUrl, parseDeepLink, resolveDeepLink } from './deep-link';
import { ShareDialog } from './ShareDialog';
import { PlanView } from './PlanView';

export interface TourViewerProps {
  readonly tour: LoadedTour;
  /**
   * Punto de entrada explícito, en lugar de la dirección del navegador.
   *
   * Lo usa la previsualización del editor, que monta este mismo componente sin
   * ser la página: leer la dirección del editor daría la escena equivocada, y
   * escribirla cambiaría la del editor. Cuando se pasa, el visor no toca el
   * historial.
   */
  readonly initialHash?: string;
}

export function TourViewer({ tour, initialHash }: TourViewerProps): JSX.Element {
  const manifest = tour.manifest;
  const mediaUrls = useMemo(() => mediaUrlIndex(tour), [tour]);

  /**
   * Enlace recibido, leído una sola vez (S09).
   *
   * Se resuelve al construir el estado inicial y no en un efecto: aplicarlo
   * después haría que el visitante viese primero la escena de entrada y luego
   * un salto a la del enlace.
   */
  const embedded = initialHash !== undefined;

  const initialLink = useMemo(() => {
    const link = parseDeepLink(initialHash ?? globalThis.location?.hash ?? '');
    return resolveDeepLink(link, new Set(manifest.scenes.map((s) => s.id)));
    // Sólo al montar: después manda la navegación del visitante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sceneId, setSceneId] = useState<string | null>(
    initialLink.kind === 'resolved'
      ? initialLink.sceneId
      : (manifest.entrySceneId ?? manifest.scenes[0]?.id ?? null),
  );
  const [view, setView] = useState<CameraView | null>(null);
  const [pendingView, setPendingView] = useState<CameraView | null>(
    initialLink.kind === 'resolved' ? initialLink.view : null,
  );
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [info, setInfo] = useState<{ title: string; body: string } | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  /**
   * Forma del escenario al abrir el plano.
   *
   * El cono del radar se acota a lo que el visitante ve de ancho, y eso
   * depende de la forma de la ventana: en un móvil vertical se ve mucho menos
   * a lo ancho que en una pantalla apaisada. Se mide al abrir el plano, que es
   * cuando hace falta, en lugar de vigilar el tamaño todo el rato.
   */
  const [planAspect, setPlanAspect] = useState<number | null>(null);
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
  /** Momento en que empezó la visita, para la variable de tiempo (F09). */
  const startedAtRef = useRef<number | null>(null);
  if (startedAtRef.current === null) startedAtRef.current = Date.now();

  /**
   * Estado de la interfaz del autor: qué está oculto, qué pestaña está
   * abierta, en qué posición va cada carrusel (J05, F08, F13).
   */
  const [skinState, setSkinState] = useState<SkinState>(EMPTY_SKIN_STATE);

  /**
   * Tamaño del escenario, que es el lienzo de la interfaz.
   *
   * Se vigila con `ResizeObserver` porque el modo fijo escala el diseño
   * completo según el tamaño disponible: sin volver a medir, al cambiar de
   * tamaño la ventana la interfaz quedaría a la escala de la carga.
   */
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  /**
   * Clase de dispositivo, que decide qué componentes de la interfaz aparecen
   * (D14). Se vuelve a calcular al cambiar el tamaño porque girar una tableta
   * cambia la respuesta.
   */
  const [device, setDevice] = useState<DeviceKind>(() =>
    classifyDevice(currentDeviceSignals()),
  );

  useEffect(() => {
    const update = (): void => setDevice(classifyDevice(currentDeviceSignals()));
    globalThis.addEventListener?.('resize', update);
    return () => globalThis.removeEventListener?.('resize', update);
  }, []);

  /* Las acciones se ejecutan desde callbacks estables, así que leen el
     dispositivo de una referencia y no de la variable capturada. */
  const deviceRef = useRef(device);
  deviceRef.current = device;

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

  /**
   * Interfaz que el autor diseñó para este recorrido.
   *
   * `null` cuando el proyecto no declara ninguna: entonces se dibuja la barra
   * propia del visor, que es la que ha existido hasta ahora. Un recorrido sin
   * interfaz diseñada no debe quedarse sin controles.
   */
  const skin = useMemo(() => {
    const declared = manifest.skins.find((candidate) => candidate.id === manifest.defaultSkinId);
    return declared ?? null;
  }, [manifest.skins, manifest.defaultSkinId]);

  const skinNodes = useMemo(() => skin?.root ?? [], [skin]);

  /**
   * Valores de proceso de la ventana abierta.
   *
   * Se piden sólo los de la ventana que está a la vista, y sólo mientras lo
   * está: una ventana con tres variables no debe poner al servicio a servir
   * todas las del recorrido.
   */
  const [windowSamples, setWindowSamples] = useState<readonly TelemetrySample[]>([]);

  const windowMappingIds = useMemo(() => {
    if (openWindow?.kind !== 'info') return [];
    const ids = new Set<string>();
    for (const tab of openWindow.tabs) {
      for (const block of tab.blocks) {
        if (block.kind === 'telemetry') ids.add(block.mappingId);
      }
    }
    return [...ids];
  }, [openWindow]);

  useEffect(() => {
    setWindowSamples([]);
    if (windowMappingIds.length === 0 || manifest.offlineCapable) return undefined;

    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await telemetry.latest(windowMappingIds);
      if (!cancelled && result.ok) setWindowSamples(result.value);
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [windowMappingIds, telemetry, manifest.offlineCapable]);

  /** Valor con su unidad, o `null` si todavía no hay dato. */
  const telemetryText = useCallback(
    (mappingId: string): string | null => {
      const mapping = manifest.telemetryMappings.find((m) => m.id === mappingId);
      const sample = windowSamples.find((s) => s.mappingId === mappingId);
      if (mapping === undefined || sample === undefined || sample.value === null) return null;
      return `${sample.value.toFixed(mapping.decimals)} ${mapping.unit}`.trim();
    },
    [manifest.telemetryMappings, windowSamples],
  );

  /* Se mide el escenario mientras haya interfaz que dibujar: el modo fijo
     escala el diseño completo según el espacio disponible. */
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || skin === null) return undefined;

    const measure = (): void =>
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    measure();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [skin]);

  /**
   * La dirección refleja la escena en la que se está (S09).
   *
   * Se usa `replaceState` y no `pushState`: cada parada de un recorrido
   * automático añadiría una entrada al historial y el botón de atrás del
   * navegador dejaría de servir para salir del recorrido, que es para lo que
   * el visitante lo usa. La orientación no se escribe de forma continua por lo
   * mismo —y porque reescribir la dirección en cada fotograma del arrastre
   * agota la cuota del historial en algunos navegadores—: el enlace con vista
   * se obtiene al compartir.
   */
  useEffect(() => {
    // Embebido —la previsualización del editor— el visor no es la página: la
    // dirección pertenece al editor y reescribirla lo descolocaría.
    if (embedded || sceneId === null || globalThis.history === undefined) return;

    const next = buildShareUrl(globalThis.location.href, sceneId);
    if (next !== globalThis.location.href) {
      globalThis.history.replaceState(null, '', next);
    }
  }, [embedded, sceneId]);

  /* ---------------------------------------------------------------- *
   * Navegación entre escenas
   * ---------------------------------------------------------------- */

  const transition = useSceneTransition();
  const stageRef = useRef<HTMLDivElement | null>(null);

  /**
   * Escena y vista pedidas por la dirección (S09).
   *
   * Se lee una sola vez, al abrir: después manda la navegación del visitante.
   * Volver a aplicarla en cada cambio de dirección devolvería al visitante a
   * la escena del enlace cada vez que el visor actualiza la barra.
   */
  const [shareOpen, setShareOpen] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(
    initialLink.kind === 'missing'
      ? 'El enlace apuntaba a una escena que ya no está en este recorrido. Se abrió la escena de entrada.'
      : null,
  );

  /** Abre el plano midiendo antes la forma del escenario. */
  const openPlan = useCallback((): void => {
    const stage = stageRef.current;
    const aspect =
      stage === null || stage.clientHeight <= 0 ? null : stage.clientWidth / stage.clientHeight;
    setPlanAspect(aspect);
    setShowPlan(true);
  }, []);

  const goToScene = useCallback(
    (targetId: string, config?: Extract<ActionConfig, { type: 'goToScene' }>) => {
      const target = manifest.scenes.find((s) => s.id === targetId);
      if (target === undefined) return;
      if (targetId === sceneId) return;

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

      const transitionTarget = {
        sceneId: targetId,
        entryMode: config?.entryMode ?? 'smart',
        initialView: target.camera.initialView,
        ...(config?.customView !== undefined ? { customView: config.customView } : {}),
        ...(returnYaw !== undefined ? { returnHotspotYaw: returnYaw } : {}),
      };

      /*
       * De dónde se viene. `view` sólo se rellena cuando la cámara se ha
       * movido, así que quien pulsa un marcador nada más abrir el recorrido
       * lo tiene vacío; entonces la vista de partida es la inicial de la
       * escena en la que está, no la de la escena a la que va.
       */
      const departure = view ?? scene?.camera.initialView ?? target.camera.initialView;

      const entry = resolveEntryView(departure, transitionTarget);

      /*
       * La transición es decoración sobre un cambio que ya ocurre: se arranca
       * antes de cambiar de escena, con la fotografía del lienzo actual, y la
       * escena cambia a continuación pase lo que pase. Si no se puede
       * fotografiar, el visitante navega igual, sin animación.
       */
      if (config !== undefined) {
        transition.begin({
          canvas: stageRef.current?.querySelector('canvas') ?? null,
          transition: config.transition,
          fromView: departure,
          target: transitionTarget,
          hasGeometry: target.kind === 'model',
        });
      }

      setSceneId(targetId);
      setPendingView(entry);
    },
    [manifest.scenes, view, sceneId, scene, transition],
  );

  /* ---------------------------------------------------------------- *
   * Ejecución de acciones
   * ---------------------------------------------------------------- */

  const runnerRef = useRef<ActionRunner | null>(null);

  /**
   * Renderizador del visor plano, para la sesión inmersiva.
   *
   * WebXR exige entregar la sesión al mismo contexto WebGL que dibuja la
   * escena, de modo que el modo inmersivo no puede crear un renderizador
   * propio: reutiliza éste.
   */
  const [panoramaRenderer, setPanoramaRenderer] = useState<PanoramaRenderer | null>(null);

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
        device: deviceRef.current,
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
   * Valores de las variables del texto de las ventanas (F09).
   *
   * Se calculan al abrir la ventana y no se refrescan mientras está abierta:
   * un texto que cambia debajo de quien lo está leyendo es peor que un texto
   * fijo, y lo que el autor escribe con variables son frases de contexto
   * («está en la Sala de bombas»), no marcadores en vivo. Para un valor que
   * cambia está el bloque de proceso, que sí se actualiza.
   */
  const variableValues = useCallback((): VariableValues => {
    const elapsedS = startedAtRef.current === null
      ? 0
      : Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    const total = Object.values(scoresRef.current).reduce((sum, value) => sum + value, 0);

    const sceneIndex = manifest.scenes.findIndex((candidate) => candidate.id === scene?.id);

    /* Las puntuaciones con clave libre entran con su espacio: el autor escribe
       `{{score.seguridad}}` y aquí llega `score.seguridad`. */
    const scoreEntries = Object.fromEntries(
      Object.entries(scoresRef.current).map(([key, value]) => [
        key.startsWith('score.') || key.startsWith('quiz.') ? key : `score.${key}`,
        value,
      ]),
    );

    return {
      ...scoreEntries,
      'scene.title': scene?.title ?? '',
      'scene.index': sceneIndex < 0 ? '' : sceneIndex + 1,
      'scene.total': manifest.scenes.length,
      'project.title': manifest.title,
      'tour.name': playback.tour?.name ?? '',
      'tour.step': playback.tour === null ? '' : playback.stopIndex + 1,
      'tour.steps': playback.tour === null ? '' : playback.stopCount,
      'score.total': total,
      'time.elapsed': formatElapsed(elapsedS),
      'date.today': new Date().toLocaleDateString('es-ES'),
    };
  }, [manifest, playback.tour, playback.stopIndex, playback.stopCount, scene]);

  /**
   * Progreso de las barras de la interfaz (F10).
   *
   * Devuelve `null` cuando no hay nada en curso, y no cero: una barra vacía
   * dice «empezado y sin avance», que es distinto de «no empezado». Para la
   * puntuación hace falta un objetivo, y el visor no lo conoce; mientras no se
   * declare, esa barra no se dibuja en lugar de inventarse un máximo.
   */
  const skinProgress = useCallback(
    (source: 'tour' | 'media' | 'score' | 'quiz', _scoreKey: string): number | null => {
      if (source === 'tour') {
        return playback.tour === null ? null : progressFraction(playback.progress, 1);
      }
      if (source === 'quiz') {
        return activeQuizId === null ? null : progressFraction(playback.progress, 1);
      }
      return null;
    },
    [playback.tour, playback.progress, activeQuizId],
  );

  /** Texto del temporizador de la interfaz (F10). */
  const timerText = useCallback((mode: 'elapsed' | 'countdown', durationS: number): string => {
    const started = startedAtRef.current ?? Date.now();
    const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
    return mode === 'countdown'
      ? formatElapsed(Math.max(0, durationS - elapsed))
      : formatElapsed(elapsed);
  }, []);

  /** Líneas del marcador de puntuación (O06). */
  const skinScoreLines = useCallback(
    (keys: readonly string[]): readonly { label: string; value: string }[] => {
      const entries = Object.entries(scoresRef.current);
      const wanted =
        keys.length === 0 ? entries : entries.filter(([key]) => keys.includes(key.split('.')[1] ?? key));

      return wanted.map(([key, value]) => ({ label: key, value: String(value) }));
    },
    [],
  );

  /**
   * Cierra la ventana abierta y ejecuta lo que el autor encadenó al cierre
   * (J06).
   *
   * El orden importa: primero se cierra y luego se ejecuta. Si la acción
   * encadenada abre otra ventana, cerrar después la cerraría de inmediato.
   */
  const closeWindow = useCallback((): void => {
    const closing = openWindow;
    setOpenWindow(null);
    if (closing?.kind === 'info' && closing.onClose.length > 0) {
      runActions(closing.onClose, 'windowClose');
    }
  }, [openWindow, runActions]);

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
      openInfoWindow: (windowId, modal) => {
        const authored = manifest.infoWindows.find((candidate) => candidate.id === windowId);
        if (authored === undefined) {
          // Una ventana que falta del paquete se dice, con su identificador:
          // el autor que prueba su recorrido necesita saber qué no se publicó,
          // y un recuadro vacío no se lo dice.
          setOpenWindow({
            kind: 'info',
            title: 'Falta una ventana',
            tabs: [
              {
                id: 'missing',
                title: 'General',
                blocks: [
                  {
                    kind: 'missing',
                    what: `una ventana que no viajó en el paquete (${windowId})`,
                  },
                ],
              },
            ],
            widthPx: 520,
            heightPx: 220,
            modal: false,
            onClose: [],
          });
          return;
        }

        // La acción puede forzar modal aunque la ventana no lo sea: es el
        // caso de una advertencia de seguridad que hay que leer antes de
        // seguir, y el autor la configura en la acción, no en la ventana.
        const built = infoWindow({ manifest, mediaUrls }, authored, variableValues());
        setOpenWindow(modal && built.kind === 'info' ? { ...built, modal: true } : built);
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
      setElementVisibility: (elementIds, visible) => {
        // El estado de la interfaz lo gobierna la acción; la declaración del
        // autor (dispositivo, escena, pestaña) sigue mandando al dibujar.
        setSkinState((current) => applyVisibilityAction(current, elementIds, visible, skinNodes));
      },
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
      showPlan: () => openPlan(),
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
        device: deviceRef.current,
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
      device: deviceRef.current,
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

  /**
   * Sesión inmersiva (etapa 13).
   *
   * Los paneles de VR se componen con los mismos nodos de piel que la versión
   * plana y se activan con el mismo `ActionRunner`: en el visor y en la
   * pantalla, un botón del recorrido hace exactamente lo mismo. Lo que cambia
   * es la maquetación, porque dentro del visor no hay HTML sobre la imagen.
   */
  const vrPanels = useMemo(
    () =>
      skin === null
        ? []
        : [
            {
              id: 'skin',
              nodes: skin.root,
              paint: {
                // Las variables del recorrido admiten números y ausencias; el
                // panel pinta texto. La conversión se hace aquí, una vez, y no
                // en cada sitio donde se pinta una plantilla.
                variables: Object.fromEntries(
                  Object.entries(variableValues()).map(([name, value]) => [
                    name,
                    value === null || value === undefined ? '' : String(value),
                  ]),
                ),
                scoreEntries: skinScoreLines([]).map((line) => ({
                  label: line.label,
                  value: String(line.value),
                })),
                timerText: timerText('elapsed', 0),
                progress: skinProgress('tour', '') ?? 0,
              },
            },
          ],
    // `variableValues` y los ayudantes dependen del estado del recorrido; se
    // recalcula con la escena y el estado de la piel, que es cuando el panel
    // tiene que repintarse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skin, sceneId, skinState],
  );

  const vr = useVrSession({
    renderer: panoramaRenderer,
    panels: vrPanels,
    skinState,
    sceneId: scene?.id ?? null,
    onActivate: (targetId) => {
      // El identificador es el del nodo de piel, o «nodo:opción» en una
      // tarjeta de pregunta. Se resuelve contra la misma piel que se pinta.
      const nodeId = targetId.split(':')[0] ?? targetId;
      const node = findSkinNode(skin?.root ?? [], nodeId);
      if (node !== null) runActions(node.actions, 'click');
    },
  });

  return (
    <div className="tour">
      <header className="tour__bar">
        <span className="tour__title">{manifest.branding.title || manifest.title}</span>
        <span className="tour__scene">{scene?.title}</span>
        <span className="tour__spacer" />
        <SceneCondition manifest={manifest} telemetry={telemetry} />
        {scene !== null && (
          <Tooltip content="Compartir esta vista">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="Compartir esta vista"
              onClick={() => setShareOpen(true)}
              icon={<IconLink size={15} />}
            />
          </Tooltip>
        )}
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
              onClick={() => openPlan()}
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
        {/* El botón sólo existe si el equipo puede entrar: un «Entrar en VR»
            que lleva a una pantalla negra no se vuelve a pulsar nunca. */}
        {vr.capabilities?.immersiveVrSupported === true && (
          <Tooltip content={vr.presenting ? 'Salir del modo inmersivo' : 'Ver en el visor de realidad virtual'}>
            <Button
              size="sm"
              variant={vr.presenting ? 'primary' : 'ghost'}
              onClick={() => (vr.presenting ? vr.exit() : vr.enter())}
            >
              {vr.presenting ? 'Salir de VR' : 'Entrar en VR'}
            </Button>
          </Tooltip>
        )}
        {vr.status.error !== null && (
          <Badge tone="warning">{vr.status.error.message}</Badge>
        )}
        {manifest.offlineCapable && (
          <Badge tone="neutral">
            Publicado el {manifest.publishedAt.slice(0, 10)}
          </Badge>
        )}
      </header>

      <div className="tour__stage" ref={stageRef}>
        {transition.run !== null && (
          <TransitionOverlay snapshot={transition.run.snapshot} state={transition.run.state} />
        )}

        {/* Una escena de modelo se dibuja con su propio visor. Antes caía en
            el de panorámicas, que sin textura mostraba una esfera negra: la
            escena parecía no haberse publicado. */}
        {scene?.kind === 'model' ? (
          <ModelSceneView
            scene={scene}
            mediaUrls={mediaUrls}
            onHotspot={(hotspot) => activateHotspot(hotspot, 'click')}
          />
        ) : (
          <PanoramaViewer
            scene={viewerScene}
            onRenderer={setPanoramaRenderer}
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
        )}

        {/* La interfaz del autor, si la hay, sustituye a la navegación propia
            del visor: dos barras de escenas superpuestas es peor que
            cualquiera de las dos. Sin interfaz diseñada se mantiene la de
            siempre, porque un recorrido no puede quedarse sin controles. */}
        {skin !== null && stageSize.width > 0 ? (
          <SkinRenderer
            skin={skin}
            viewport={stageSize}
            host={{
              manifest,
              mediaUrls,
              device,
              sceneId: scene?.id ?? null,
              state: skinState,
              variables: variableValues(),
              onActions: (actions) => runActions(actions, 'click'),
              onTab: (nodeId, tabId) =>
                setSkinState((current) => ({
                  ...current,
                  activeTab: new Map(current.activeTab).set(nodeId, tabId),
                })),
              onCarousel: (nodeId, index) =>
                setSkinState((current) => ({
                  ...current,
                  carouselIndex: new Map(current.carouselIndex).set(nodeId, index),
                })),
              onSelectScene: (id) => goToScene(id),
              progress: (source, scoreKey) => skinProgress(source, scoreKey),
              timerText: (mode, durationS) => timerText(mode, durationS),
              scoreLines: (keys) => skinScoreLines(keys),
              slots: {
                planView: () => (
                  <PlanView
                    manifest={manifest}
                    mediaUrls={mediaUrls}
                    activeSceneId={scene?.id ?? null}
                    view={view ?? scene?.camera.initialView ?? null}
                    onSelect={(id) => goToScene(id)}
                  />
                ),
                assetPanel: (assetId) => {
                  const target = assetId ?? openAssetId;
                  return target === null ? (
                    <p className="skin-missing">Ningún activo seleccionado.</p>
                  ) : (
                    <AssetCard
                      manifest={manifest}
                      assetId={target}
                      telemetry={telemetry}
                      mediaUrls={mediaUrls}
                    />
                  );
                },
              },
            }}
          />
        ) : (
          <>
            <SceneNav
              scenes={manifest.scenes}
              activeId={scene?.id ?? null}
              onSelect={(id) => goToScene(id)}
            />
            <TourPlayerBar playback={playback} />
          </>
        )}
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

      {scene !== null && (
        <ShareDialog
          open={shareOpen}
          sceneId={scene.id}
          sceneTitle={scene.title}
          view={view}
          onClose={() => setShareOpen(false)}
        />
      )}

      {linkNotice !== null && (
        <Dialog
          open
          onClose={() => setLinkNotice(null)}
          title="El enlace no está completo"
          size="sm"
          footer={
            <Button variant="primary" onClick={() => setLinkNotice(null)}>
              Entendido
            </Button>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>{linkNotice}</p>
        </Dialog>
      )}

      <WindowHost
        window={openWindow}
        onClose={closeWindow}
        onSceneLink={(sceneId) => {
          closeWindow();
          goToScene(sceneId);
        }}
        telemetryValue={(mappingId) => telemetryText(mappingId)}
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
            {...(planAspect !== null ? { aspect: planAspect } : {})}
            activeSceneId={scene?.id ?? null}
            /* La vista inicial de la escena cuando el visor todavía no ha
               informado de la suya: `view` sólo se llena al mover la cámara, y
               quien abre el plano antes de arrastrar se quedaba sin radar
               justo cuando más lo necesita —acaba de llegar—. */
            view={view ?? scene?.camera.initialView ?? null}
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


