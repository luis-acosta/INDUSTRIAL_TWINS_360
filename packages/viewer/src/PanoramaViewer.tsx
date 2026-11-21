/**
 * Componente de visor panorámico.
 *
 * Reúne el renderizador, el controlador de cámara, la capa de marcadores y la
 * entrada del usuario. Lo que no hace, deliberadamente: no sabe de proyectos,
 * ni de persistencia, ni de qué significa un hotspot en términos de negocio.
 * Recibe una escena y un anfitrión de acciones, y emite eventos.
 *
 * El bucle de dibujo es bajo demanda: `requestAnimationFrame` sólo se
 * encadena mientras algo se mueve. Una escena quieta no consume GPU, que en
 * un portátil con gráficos integrados es la diferencia entre dos horas de
 * batería y cuarenta minutos.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  boundingBoxUv,
  FULL_COVERAGE,
  isPublishable,
  isVisibleOn,
  pointInPolygonUv,
  sphericalToUv,
  uvToSpherical,
  type CameraControl,
  type CameraView,
  type DeviceKind,
  type Hotspot,
  type PanoramaCoverage,
  type Uv,
} from '@it360/domain';
import { AmbientLayer, projectFlareSource } from './AmbientLayer';
import type { AmbientState } from './ambient-effects';
import { CameraController } from './camera-controller';
import { detectCapabilities, PanoramaRenderer, type RendererCapabilities } from './panorama-renderer';
import {
  loadPanoramaTexture,
  loadProgressive,
  TextureCache,
  type LoadedTexture,
} from './texture-loader';
import { updateFocusDwell, IDLE_DWELL, type FocusDwellState } from './action-runtime';
import {
  baseSizePx,
  effectiveScale,
  markerMedia,
  markerTransform,
  polygonClipPath,
  polygonScreenPoints,
  quadTransform,
  resolveTemplate,
  type TemplateContext,
} from './hotspot-presentation';

/** Mapa vacío estable: evita recrear la referencia en cada renderizado. */
const EMPTY_MEDIA_URLS: ReadonlyMap<string, string> = new Map<string, string>();

export interface ViewerScene {
  readonly id: string;
  readonly title: string;
  /** URL de la panorámica. */
  readonly textureUrl: string | null;
  /**
   * Vista previa de 1024 px, si el paquete la trae (S08).
   *
   * Se carga primero para que el visitante pueda mirar la escena en el primer
   * segundo en lugar de esperar frente a una pantalla en negro los doce o
   * veinte segundos que tarda una panorámica completa en la red de una planta.
   * La imagen completa la sustituye en cuanto llega.
   */
  readonly previewUrl?: string | null;
  readonly coverage: PanoramaCoverage;
  readonly camera: CameraControl;
  readonly hotspots: readonly Hotspot[];
}

export interface PanoramaViewerProps {
  readonly scene: ViewerScene;
  readonly device?: DeviceKind;
  /** Vista controlada desde fuera: la usa el autopilot. */
  readonly view?: CameraView;
  readonly onViewChange?: (view: CameraView) => void;
  readonly onHotspotActivate?: (hotspot: Hotspot, trigger: 'click' | 'focus') => void;
  /**
   * Cambio del foco visual sostenido (J07).
   *
   * Se avisa de la entrada **y de la salida** porque son dos eventos del
   * vocabulario y el segundo no se podía disparar: la mirada sostenida sólo se
   * medía en marcadores con una acción de `focusEnter`, de modo que uno con
   * sólo `focusExit` no entraba nunca en foco y su acción no se ejecutaba
   * jamás.
   */
  readonly onFocusChange?: (previousId: string | null, nextId: string | null) => void;
  readonly onHotspotHover?: (hotspot: Hotspot | null) => void;
  /** Clic sobre el panorama, con la dirección: lo usa el editor para colocar. */
  readonly onCanvasPick?: (yaw: number, pitch: number) => void;
  readonly interactive?: boolean;
  /** Muestra los marcadores. El editor los dibuja por su cuenta. */
  readonly showHotspots?: boolean;
  /** Identificador del marcador seleccionado en el editor. */
  readonly selectedHotspotId?: string | null;
  readonly reducedMotion?: boolean;
  readonly overlay?: ReactNode;
  readonly className?: string;
  /**
   * URLs de los medios, para los marcadores con icono o imagen propios
   * (D01, D05, D15). Sin este mapa, esos marcadores caen al icono interno en
   * lugar de dejar un hueco.
   */
  readonly mediaUrls?: ReadonlyMap<string, string>;
  /**
   * Contexto de las variables de las plantillas de texto (D02, F09, J10).
   * Una variable que no esté aquí se deja visible como `{{nombre}}`.
   */
  readonly templateContext?: TemplateContext;
  /**
   * Se invoca con el renderizador recién creado y con `null` al liberarlo.
   *
   * Lo necesita la sesión inmersiva (etapa 13): WebXR exige entregar la
   * sesión al mismo contexto WebGL que dibuja la escena, de modo que el visor
   * inmersivo no puede crear un renderizador propio. Entregar el renderizador
   * es menos malo que mover la sesión aquí dentro: así este componente sigue
   * sin saber nada de WebXR.
   */
  readonly onRenderer?: (renderer: PanoramaRenderer | null) => void;
  /**
   * Efecto ambiental de la escena (V06, V08).
   *
   * Lo decide quien monta el visor y no este componente, porque la
   * preferencia de movimiento reducido y la fuente de luz del destello
   * dependen del contexto: en el editor hay que poder previsualizarlo aunque
   * el sistema pida movimiento reducido, y en el recorrido publicado no.
   */
  readonly ambient?: AmbientState | null;
  /** Dirección de la luz para el destello, en la esfera de la escena. */
  readonly flareDirection?: { readonly yaw: number; readonly pitch: number } | null;
}

export interface ViewerStatus {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  readonly message?: string;
  readonly progress?: number;
  readonly downscaled?: boolean;
  /**
   * Se está mostrando la vista previa y la imagen completa sigue llegando
   * (S08).
   *
   * Se dice, no se esconde: quien mire una escena borrosa sin explicación
   * pensará que el panorama se publicó mal y lo buscará en el editor, donde
   * está bien. Y se distingue de `downscaled`, que es una reducción
   * **definitiva** por los límites de la tarjeta gráfica: ahí no hay nada que
   * esperar.
   */
  readonly preview?: boolean;
}

/** Caché compartida: una sola por documento, como el contexto WebGL. */
const sharedCache = new TextureCache();

export function PanoramaViewer({
  scene,
  device = 'desktop',
  view: controlledView,
  onViewChange,
  onHotspotActivate,
  onFocusChange,
  onHotspotHover,
  onCanvasPick,
  interactive = true,
  showHotspots = true,
  selectedHotspotId = null,
  reducedMotion = false,
  overlay,
  className,
  mediaUrls,
  templateContext,
  onRenderer,
  ambient = null,
  flareDirection = null,
}: PanoramaViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PanoramaRenderer | null>(null);
  /**
   * El aviso se guarda en una referencia para que cambiarlo no vuelva a crear
   * el renderizador: reconstruir el contexto WebGL en cada render tiraría la
   * textura de la escena y produciría un parpadeo en cada cambio de estado.
   */
  const onRendererRef = useRef(onRenderer);
  onRendererRef.current = onRenderer;
  const controllerRef = useRef<CameraController | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameMsRef = useRef(0);
  const dragStateRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dwellRef = useRef<FocusDwellState>(IDLE_DWELL);
  /** Marcador que tiene el foco sostenido ahora mismo (J07). */
  const focusedRef = useRef<string | null>(null);

  const [capabilities, setCapabilities] = useState<RendererCapabilities | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ phase: 'idle' });
  const [view, setView] = useState<CameraView>(scene.camera.initialView);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dwell, setDwell] = useState<FocusDwellState>(IDLE_DWELL);

  /* ---------------------------------------------------------------- *
   * Arranque del renderizador
   * ---------------------------------------------------------------- */

  useLayoutEffect(() => {
    const caps = detectCapabilities();
    setCapabilities(caps);

    if (!caps.webgl) {
      setStatus({
        phase: 'unsupported',
        message:
          'Este equipo no puede mostrar gráficos 3D acelerados. Actualice el controlador de la tarjeta gráfica o abra el recorrido en otro equipo.',
      });
      return undefined;
    }

    const canvas = canvasRef.current;
    if (canvas === null) return undefined;

    const renderer = new PanoramaRenderer({
      canvas,
      // En un renderizador de software, subir la densidad de píxeles sólo
      // multiplica el trabajo de una GPU que ya no da abasto.
      maxPixelRatio: caps.softwareFallback ? 1 : 2,
    });
    rendererRef.current = renderer;
    onRendererRef.current?.(renderer);

    return () => {
      onRendererRef.current?.(null);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  /* ---------------------------------------------------------------- *
   * Tamaño
   * ---------------------------------------------------------------- */

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const apply = (width: number, height: number): void => {
      setSize({ width, height });
      rendererRef.current?.resize(width, height);
      controllerRef.current?.setViewport(width, height);
    };

    apply(container.clientWidth, container.clientHeight);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  /* ---------------------------------------------------------------- *
   * Controlador de cámara
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const controller = new CameraController({
      control: scene.camera,
      coverage: scene.coverage,
      viewportWidth: size.width || 1,
      viewportHeight: size.height || 1,
    });
    controllerRef.current = controller;
    setView(controller.getView());
    // Sólo al cambiar de escena: recrear el controlador en cada
    // redimensionado perdería la orientación actual del visitante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);

  useEffect(() => {
    controllerRef.current?.setControl(scene.camera);
  }, [scene.camera]);

  useEffect(() => {
    controllerRef.current?.setCoverage(scene.coverage);
  }, [scene.coverage]);

  /** Vista controlada desde fuera (autopilot, acción `lookAt`). */
  useEffect(() => {
    if (controlledView === undefined) return;
    controllerRef.current?.setView(controlledView);
    setView(controlledView);
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledView?.yaw, controlledView?.pitch, controlledView?.fov]);

  /* ---------------------------------------------------------------- *
   * Textura
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (capabilities === null || !capabilities.webgl) return undefined;
    const renderer = rendererRef.current;
    if (renderer === null) return undefined;

    if (scene.textureUrl === null) {
      renderer.setTexture(null, FULL_COVERAGE);
      setStatus({ phase: 'ready' });
      requestDraw();
      return undefined;
    }

    const cached = sharedCache.get(scene.textureUrl);
    if (cached !== undefined) {
      renderer.setTexture(cached.texture, scene.coverage);
      setStatus({ phase: 'ready', downscaled: cached.downscaled });
      requestDraw();
      return undefined;
    }

    const abort = new AbortController();
    setStatus({ phase: 'loading', progress: 0 });

    /* Carga progresiva (S08): la vista previa entra primero y la imagen
       completa la sustituye. Las reglas de orden viven en `loadProgressive`,
       donde se pueden probar sin WebGL; aquí sólo se dice qué hacer con cada
       resultado. */
    void loadProgressive<LoadedTexture>(
      scene.previewUrl == null
        ? null
        : () =>
            loadPanoramaTexture(scene.previewUrl as string, {
              maxTextureSize: capabilities.maxTextureSize,
              signal: abort.signal,
            }),
      (onProgress) =>
        loadPanoramaTexture(scene.textureUrl as string, {
          maxTextureSize: capabilities.maxTextureSize,
          signal: abort.signal,
          onProgress,
        }),
      {
        onPreview: (value) => {
          if (abort.signal.aborted) return;
          renderer.setTexture(value.texture, scene.coverage);
          setStatus({ phase: 'ready', preview: true });
          requestDraw();
        },
        onFull: (value) => {
          if (abort.signal.aborted) return;
          if (scene.textureUrl !== null) sharedCache.set(scene.textureUrl, value);
          renderer.setTexture(value.texture, scene.coverage);
          setStatus({ phase: 'ready', downscaled: value.downscaled });
          requestDraw();
        },
        onFullFailed: (error, withPreview) => {
          if (abort.signal.aborted || error.code === 'CANCELLED') return;
          /* Con la vista previa puesta, la escena sigue siendo utilizable:
             pasar a la pantalla de error se llevaría por delante lo que sí
             funciona. */
          setStatus(
            withPreview
              ? {
                  phase: 'ready',
                  preview: true,
                  message: 'No se pudo cargar la imagen completa; está viendo la vista previa.',
                }
              : { phase: 'error', message: error.recovery ?? error.message },
          );
        },
        onProgress: (fraction, withPreview) => {
          if (abort.signal.aborted) return;
          /* Mientras se ve la vista previa, el progreso no puede volver a
             «cargando»: la escena ya está mirable y una pantalla de carga
             encima sería quitarla. */
          setStatus((current) =>
            withPreview ? { ...current, progress: fraction } : { phase: 'loading', progress: fraction },
          );
        },
      },
    );

    // Cancelar al cambiar de escena evita que la textura abandonada llegue
    // tarde y sustituya a la correcta.
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.textureUrl, scene.previewUrl, scene.coverage, capabilities]);

  /* ---------------------------------------------------------------- *
   * Bucle de dibujo bajo demanda
   * ---------------------------------------------------------------- */

  const draw = useCallback(
    (timestampMs: number) => {
      frameRef.current = null;

      const renderer = rendererRef.current;
      const controller = controllerRef.current;
      if (renderer === null || controller === null) return;

      const delta = lastFrameMsRef.current === 0 ? 16 : timestampMs - lastFrameMsRef.current;
      lastFrameMsRef.current = timestampMs;

      const changed = controller.update(delta, timestampMs);
      const current = controller.getView();

      renderer.render(current);

      if (changed) {
        setView(current);
        onViewChange?.(current);
      }

      // Sólo se encadena otro fotograma si sigue habiendo movimiento.
      if (controller.isMoving() || scene.camera.autoRotate) {
        frameRef.current = requestAnimationFrame(draw);
      } else {
        lastFrameMsRef.current = 0;
      }
    },
    [onViewChange, scene.camera.autoRotate],
  );

  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    requestDraw();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [requestDraw, status.phase]);

  /* ---------------------------------------------------------------- *
   * Marcadores proyectados
   * ---------------------------------------------------------------- */

  const visibleHotspots = useMemo(
    () =>
      scene.hotspots.filter(
        (h) => isPublishable(h) && isVisibleOn(h.visibility, device) && !h.hiddenInEditor,
      ),
    [scene.hotspots, device],
  );

  const projected = useMemo(() => {
    const renderer = rendererRef.current;
    if (renderer === null || size.width === 0) return [];

    return visibleHotspots
      .map((hotspot) => {
        if (hotspot.anchor.space !== 'spherical') return null;
        const point = renderer.project(
          hotspot.anchor.yaw,
          hotspot.anchor.pitch,
          view,
          size.width,
          size.height,
        );
        if (point === null) return null;
        return { hotspot, ...point };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }, [visibleHotspots, view, size.width, size.height]);

  /**
   * Proyecta un punto UV de la panorámica a píxeles de pantalla.
   *
   * La necesitan los polígonos y las imágenes proyectadas: sus vértices están
   * en coordenadas de la imagen, no en una dirección de cámara, y hay que
   * convertirlos en cada fotograma porque cambian al girar.
   */
  const projectUv = useCallback(
    (uv: Uv): { x: number; y: number } | null => {
      const renderer = rendererRef.current;
      if (renderer === null || size.width === 0) return null;
      const spherical = uvToSpherical(uv);
      const point = renderer.project(
        spherical.yaw,
        spherical.pitch,
        view,
        size.width,
        size.height,
      );
      return point === null ? null : { x: point.x, y: point.y };
    },
    [view, size.width, size.height],
  );

  /* ---------------------------------------------------------------- *
   * Entrada
   * ---------------------------------------------------------------- */

  const hotspotAtUv = useCallback(
    (yaw: number, pitch: number): Hotspot | null => {
      const uv = sphericalToUv({ yaw, pitch });
      // Los polígonos se comprueban en UV; el resto por proximidad en pantalla.
      for (const hotspot of visibleHotspots) {
        if (hotspot.geometry.shape !== 'polygon') continue;
        const box = boundingBoxUv(hotspot.geometry.points);
        if (box === null) continue;
        if (uv.u < box.min.u || uv.u > box.max.u || uv.v < box.min.v || uv.v > box.max.v) continue;
        const inside = pointInPolygonUv(uv, hotspot.geometry.points);
        if (inside !== hotspot.geometry.inverted) return hotspot;
      }
      return null;
    },
    [visibleHotspots],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragStateRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    controller.beginDrag(performance.now());
    requestDraw();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const controller = controllerRef.current;
    const renderer = rendererRef.current;
    if (controller === null || renderer === null) return;

    const drag = dragStateRef.current;
    if (drag !== null && drag.pointerId === event.pointerId) {
      controller.drag(event.clientX - drag.x, event.clientY - drag.y, performance.now());
      dragStateRef.current = { ...drag, x: event.clientX, y: event.clientY };
      setView(controller.getView());
      requestDraw();
      return;
    }

    if (!interactive) return;
    const pick = renderer.pick(event.clientX, event.clientY, controller.getView());
    const hovered = hotspotAtUv(pick.yaw, pick.pitch);
    const id = hovered?.id ?? null;
    if (id !== hoveredId) {
      setHoveredId(id);
      onHotspotHover?.(hovered);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragStateRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    controllerRef.current?.endDrag();
    requestDraw();
  };

  const onClick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const renderer = rendererRef.current;
    const controller = controllerRef.current;
    if (renderer === null || controller === null) return;

    const pick = renderer.pick(event.clientX, event.clientY, controller.getView());
    const hit = hotspotAtUv(pick.yaw, pick.pitch);
    if (hit !== null) {
      onHotspotActivate?.(hit, 'click');
      return;
    }
    onCanvasPick?.(pick.yaw, pick.pitch);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const controller = controllerRef.current;
    if (controller === null) return;
    // Un paso multiplicativo por «clic» de rueda, independiente del hardware:
    // algunos ratones reportan 100 y otros 3 en el mismo gesto.
    const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
    controller.zoom(factor, performance.now());
    setView(controller.getView());
    requestDraw();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const map: Record<string, 'left' | 'right' | 'up' | 'down'> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    const direction = map[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      controller.nudge(direction, event.shiftKey ? 15 : 5);
      setView(controller.getView());
      requestDraw();
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      controller.zoom(1 / 1.15, performance.now());
      setView(controller.getView());
      requestDraw();
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      controller.zoom(1.15, performance.now());
      setView(controller.getView());
      requestDraw();
    }
  };

  /* ---------------------------------------------------------------- *
   * Disparo por mirada sostenida
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!interactive || hoveredId === null) {
      dwellRef.current = IDLE_DWELL;
      setDwell(IDLE_DWELL);
      // Apartar la mirada es salir del foco: sin esto, la acción de salida se
      // quedaría pendiente hasta que el visitante mirase otro marcador.
      if (focusedRef.current !== null) {
        const previous = focusedRef.current;
        focusedRef.current = null;
        onFocusChange?.(previous, null);
      }
      return undefined;
    }

    const hotspot = visibleHotspots.find((h) => h.id === hoveredId);
    // Sirve cualquiera de los dos eventos de foco: un marcador con sólo
    // «al salir del foco» tiene que poder entrar en foco, o su acción no se
    // ejecutaría nunca.
    const focusAction = hotspot?.actions.find(
      (a) => (a.event === 'focusEnter' || a.event === 'focusExit') && a.enabled,
    );
    if (hotspot === undefined || focusAction === undefined) return undefined;

    let raf = 0;
    const tick = (): void => {
      const next = updateFocusDwell(
        dwellRef.current,
        hoveredId,
        focusAction.focusDwellMs,
        performance.now(),
      );
      dwellRef.current = next;
      setDwell(next);
      if (next.triggered) {
        const previous = focusedRef.current;
        focusedRef.current = hoveredId;
        onFocusChange?.(previous, hoveredId);
        // La activación por mirada sigue siendo cosa de `focusEnter`: un
        // marcador con sólo acción de salida entra en foco pero no se activa.
        if (hotspot.actions.some((a) => a.event === 'focusEnter' && a.enabled)) {
          onHotspotActivate?.(hotspot, 'focus');
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [hoveredId, interactive, visibleHotspots, onHotspotActivate, onFocusChange]);

  /* ---------------------------------------------------------------- *
   * Presentación
   * ---------------------------------------------------------------- */

  return (
    <div
      ref={containerRef}
      className={['it-viewer', className].filter(Boolean).join(' ')}
      data-status={status.phase}
      role="application"
      aria-label={`Vista panorámica: ${scene.title}`}
      aria-roledescription="visor panorámico"
      tabIndex={interactive ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="it-viewer__canvas" />

      {showHotspots && status.phase === 'ready' && (
        <div className="it-viewer__hotspots" aria-hidden={!interactive}>
          {projected.map(({ hotspot, x, y, scale }) => (
            <HotspotMarker
              key={hotspot.id}
              hotspot={hotspot}
              x={x}
              y={y}
              scale={scale}
              hovered={hotspot.id === hoveredId}
              selected={hotspot.id === selectedHotspotId}
              dwellProgress={dwell.targetId === hotspot.id ? dwell.progress : 0}
              reducedMotion={reducedMotion}
              mediaUrls={mediaUrls ?? EMPTY_MEDIA_URLS}
              templateContext={templateContext ?? {}}
              projectUv={projectUv}
              onActivate={() => onHotspotActivate?.(hotspot, 'click')}
            />
          ))}
        </div>
      )}

      {status.phase === 'loading' && (
        <div className="it-viewer__status" role="status">
          <span className="it-viewer__spinner" aria-hidden="true" />
          <p>Cargando panorámica…</p>
          {status.progress !== undefined && status.progress > 0 && (
            <div className="it-viewer__progress">
              <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {(status.phase === 'error' || status.phase === 'unsupported') && (
        <div className="it-viewer__status it-viewer__status--error" role="alert">
          <p>
            {status.phase === 'unsupported'
              ? 'Gráficos 3D no disponibles'
              : 'No se pudo mostrar la panorámica'}
          </p>
          {status.message !== undefined && <p className="it-viewer__status-detail">{status.message}</p>}
        </div>
      )}

      {status.downscaled === true && (
        <p className="it-viewer__notice" role="status">
          La imagen se ha reducido para caber en esta tarjeta gráfica.
        </p>
      )}

      {/* Vista previa en curso (S08). Se dice para que nadie piense que el
          panorama se publicó mal y lo vaya a buscar en el editor, donde está
          bien. Y si la imagen completa falló, el texto lo dice en lugar de
          dejar una escena borrosa sin explicación para siempre. */}
      {status.preview === true && (
        <p className="it-viewer__notice" role="status">
          {status.message ?? 'Vista previa: la imagen completa se está cargando.'}
        </p>
      )}

      {capabilities?.softwareFallback === true && status.phase === 'ready' && (
        <p className="it-viewer__notice it-viewer__notice--warning" role="status">
          Sin aceleración por hardware: el movimiento puede resultar lento.
        </p>
      )}

      {/* Debajo del `overlay` del autor: la lluvia pasa delante de los
          marcadores pero no delante de un panel que se está leyendo. */}
      {ambient !== null && ambient !== undefined && (
        <AmbientLayer
          state={ambient}
          flareSource={
            flareDirection === null
              ? null
              : projectFlareSource(
                  flareDirection.yaw,
                  flareDirection.pitch,
                  view.yaw,
                  view.pitch,
                  rendererRef.current?.horizontalFovDeg(view) ?? view.fov,
                  size.width / Math.max(size.height, 1),
                )
          }
        />
      )}

      {overlay}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Marcador
 * ------------------------------------------------------------------ */

interface HotspotMarkerProps {
  readonly hotspot: Hotspot;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly hovered: boolean;
  readonly selected: boolean;
  readonly dwellProgress: number;
  readonly reducedMotion: boolean;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly templateContext: TemplateContext;
  readonly projectUv: (uv: Uv) => { x: number; y: number } | null;
  readonly onActivate: () => void;
}

const TONE_VARIABLE: Record<string, string> = {
  accent: 'var(--it-color-canvas-hotspot)',
  nominal: 'var(--it-color-status-nominal)',
  warning: 'var(--it-color-status-warning)',
  alarm: 'var(--it-color-status-alarm)',
  info: 'var(--it-color-status-info)',
  experimental: 'var(--it-color-status-experimental)',
  neutral: 'var(--it-color-text-secondary)',
};

/**
 * Marcador.
 *
 * Dibuja cada forma declarada en el dominio (D01-D07). No es un detalle
 * estético: un proyecto puede traer un polígono sobre el contorno de un equipo
 * o un plano proyectado sobre una pared, y dibujar un icono genérico en su
 * lugar significa que el autor no ve lo que hizo y el visitante tampoco.
 *
 * Los polígonos y las imágenes proyectadas se dibujan aparte, antes de los
 * marcadores puntuales, porque cubren área y deben quedar debajo.
 */
function HotspotMarker({
  hotspot,
  x,
  y,
  scale,
  hovered,
  selected,
  dwellProgress,
  reducedMotion,
  mediaUrls,
  templateContext,
  projectUv,
  onActivate,
}: HotspotMarkerProps): JSX.Element | null {
  const color =
    hotspot.style.colorOverride ?? TONE_VARIABLE[hotspot.style.colorToken] ?? TONE_VARIABLE['accent'];
  const geometry = hotspot.geometry;
  const appliedScale = effectiveScale({ hotspot, projectionScale: scale, hovered });

  const classes = [
    'it-hotspot',
    `it-hotspot--${geometry.shape}`,
    hovered && 'it-hotspot--hovered',
    selected && 'it-hotspot--selected',
    hotspot.locked && 'it-hotspot--locked',
    hotspot.style.pulse && !reducedMotion && 'it-hotspot--pulse',
  ]
    .filter(Boolean)
    .join(' ');

  const activate = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
    onActivate();
  };

  /* --- Polígono (D03, D11) --- */

  if (geometry.shape === 'polygon') {
    const points = polygonScreenPoints(geometry.points, projectUv);
    // Un vértice sin proyección válida significa que el polígono cruza por
    // detrás de la cámara: no se dibuja nada en lugar de una forma arbitraria
    // que además capturaría clics donde no debe.
    if (points === null) return null;

    return (
      <button
        type="button"
        className={classes}
        style={{
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          color,
          opacity: hotspot.style.opacity,
          clipPath: polygonClipPath(points, { inverted: geometry.inverted }),
          transform: 'none',
        }}
        onClick={activate}
        aria-label={hotspot.name}
      />
    );
  }

  /* --- Imagen proyectada (D05) --- */

  if (geometry.shape === 'projectedImage') {
    const url = mediaUrls.get(geometry.mediaId);
    const corners = geometry.corners.map((uv) => projectUv(uv));
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;

    if (
      url === undefined ||
      topLeft == null ||
      topRight == null ||
      bottomRight == null ||
      bottomLeft == null
    ) {
      return null;
    }

    // El rectángulo de origen se dimensiona por la caja que envuelve al
    // destino: así la imagen se muestrea a una resolución parecida a la que
    // va a ocupar, en lugar de escalarse dos veces.
    const width = Math.max(
      Math.abs(topRight.x - topLeft.x),
      Math.abs(bottomRight.x - bottomLeft.x),
      1,
    );
    const height = Math.max(
      Math.abs(bottomLeft.y - topLeft.y),
      Math.abs(bottomRight.y - topRight.y),
      1,
    );

    const matrix = quadTransform(width, height, {
      topLeft,
      topRight,
      bottomRight,
      bottomLeft,
    });
    if (matrix === null) return null;

    return (
      <button
        type="button"
        className={classes}
        style={{
          left: 0,
          top: 0,
          width,
          height,
          opacity: geometry.opacity * hotspot.style.opacity,
          transform: matrix,
          transformOrigin: '0 0',
          padding: 0,
          border: 'none',
          background: 'none',
        }}
        onClick={activate}
        aria-label={hotspot.name}
      >
        <img src={url} alt="" style={{ width: '100%', height: '100%', display: 'block' }} />
      </button>
    );
  }

  /* --- Marcadores puntuales --- */

  const size = baseSizePx(geometry);
  const media = markerMedia(hotspot, mediaUrls);
  const label =
    hotspot.style.showLabel && hotspot.style.labelTemplate.length > 0
      ? resolveTemplate(hotspot.style.labelTemplate, templateContext)
      : null;

  return (
    <button
      type="button"
      className={classes}
      style={{
        left: x,
        top: y,
        width: geometry.shape === 'text' ? 'auto' : size,
        height: geometry.shape === 'text' ? 'auto' : size,
        maxWidth: geometry.shape === 'text' ? size : undefined,
        color,
        opacity: hotspot.style.opacity,
        transform: markerTransform({
          transform: hotspot.style.transform,
          projection: hotspot.style.projection,
          appliedScale,
        }),
      }}
      onClick={activate}
      aria-label={geometry.shape === 'text' ? resolveTemplate(geometry.template, templateContext) : hotspot.name}
    >
      {geometry.shape === 'text' ? (
        <span className="it-hotspot__text">{resolveTemplate(geometry.template, templateContext)}</span>
      ) : geometry.shape === 'webframe' ? (
        // El contenido web no se incrusta aquí: la política de seguridad del
        // paquete publicado no permite marcos de terceros. El marcador abre el
        // enlace, y eso lo decide la acción, no el dibujo.
        <svg viewBox="0 0 24 24" className="it-hotspot__icon" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      ) : media !== null ? (
        <img
          className="it-hotspot__image"
          src={media.url}
          alt=""
          // Con movimiento reducido se congela el icono animado: un APNG en
          // bucle es exactamente lo que esa preferencia pide desactivar.
          style={reducedMotion && media.animated ? { animationPlayState: 'paused' } : undefined}
        />
      ) : (
        <svg viewBox="0 0 24 24" className="it-hotspot__icon" aria-hidden="true">
          <circle cx="12" cy="12" r="5" fill="currentColor" fillOpacity="0.9" />
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.6" />
        </svg>
      )}

      {dwellProgress > 0 && dwellProgress < 1 && (
        <svg className="it-hotspot__dwell" viewBox="0 0 36 36" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(dwellProgress * 100.5).toFixed(1)} 100.5`}
            transform="rotate(-90 18 18)"
          />
        </svg>
      )}

      {label !== null && <span className="it-hotspot__label">{label}</span>}
    </button>
  );
}
