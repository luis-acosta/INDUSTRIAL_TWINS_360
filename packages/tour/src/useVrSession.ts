/**
 * Entrada en VR desde el recorrido publicado (N01, N02, N12).
 *
 * El principio que fija `webxr.ts` gobierna este gancho: **nunca ofrecer un
 * botón de VR que no funcione**. Por eso la detección de capacidades ocurre al
 * montar y el botón sólo existe si el equipo puede entrar; y por eso el estado
 * que devuelve distingue «este navegador no tiene WebXR» —donde no hay nada
 * que ofrecer— de «no se pudo entrar» —donde sí tiene sentido volver a
 * intentarlo—.
 *
 * El gancho no dibuja: compone. La sesión la lleva `XrSessionController`, el
 * fotograma `XrRuntime`, los paneles `xr-stage`, y las acciones el mismo
 * `ActionRunner` que usa la versión plana.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  IDLE_XR_STATUS,
  VR_PROFILES,
  XrRuntime,
  XrSessionController,
  XrWorld,
  createPanelSurface,
  createPointer,
  createVideoSurface,
  detectXrCapabilities,
  layoutVrPanel,
  paintPanel,
  panelTargets,
  placePanelMesh,
  rayFromPoseMatrix,
  type PanoramaRenderer,
  type PaintOptions,
  type Painter2D,
  type SkinState,
  type VrOptimizationProfile,
  type VrPanelPlacement,
  type XrCapabilities,
  type XrInputSnapshot,
  type XrPanelSpec,
  type XrRay,
  type XrSessionStatus,
  type XrVideoSurface,
  DEFAULT_VR_PANEL,
} from '@it360/viewer';
import { domainError, type SkinNode } from '@it360/domain';

export interface VrPanelSource {
  readonly id: string;
  readonly placement?: VrPanelPlacement;
  /** Nodos de piel que componen el panel. */
  readonly nodes: readonly SkinNode[];
  /** Datos variables para pintarlo. */
  readonly paint?: PaintOptions;
}

export interface UseVrSessionOptions {
  readonly renderer: PanoramaRenderer | null;
  readonly panels: readonly VrPanelSource[];
  readonly skinState: SkinState;
  readonly sceneId: string | null;
  /** Se invoca con el identificador de la zona activada con el gatillo. */
  readonly onActivate: (targetId: string) => void;
  /** Perfil de optimización por clase de dispositivo (N12). */
  readonly profile?: VrOptimizationProfile;
  /**
   * Vídeo que se está reproduciendo en una ventana del recorrido (N10).
   *
   * Entra aquí porque **un vídeo en DOM no se compone sobre la imagen del
   * visor**: mientras la sesión presenta, el navegador dibuja lo que entrega el
   * bucle de WebXR, así que la ventana de HTML existe para quien mire la
   * pantalla del PC y no para quien lleva las gafas. Se lleva el mismo elemento
   * a una textura en lugar de crear otro: con dos, el sonido se oiría dos veces.
   *
   * El audio no pasa por aquí y no le hace falta: suena desde su elemento
   * porque el audio del navegador no pasa por el bucle de fotogramas. Lo que sí
   * necesita es un panel que diga que está sonando, y eso lo compone el
   * recorrido con los mismos nodos de piel que todo lo demás.
   */
  readonly video?: HTMLVideoElement | null;
  /** Anchura del panel de vídeo en metros; 1,2 m a 2 m se ve como un televisor. */
  readonly videoWidthM?: number;
}

export interface VrSessionHandle {
  readonly capabilities: XrCapabilities | null;
  readonly status: XrSessionStatus;
  /** `true` mientras la sesión está presentando en el visor. */
  readonly presenting: boolean;
  enter(): void;
  exit(): void;
}

export function useVrSession(options: UseVrSessionOptions): VrSessionHandle {
  const [capabilities, setCapabilities] = useState<XrCapabilities | null>(null);
  const [status, setStatus] = useState<XrSessionStatus>(IDLE_XR_STATUS);

  const controllerRef = useRef<XrSessionController | null>(null);
  const runtimeRef = useRef<XrRuntime | null>(null);
  const worldRef = useRef<XrWorld | null>(null);
  const surfacesRef = useRef(new Map<string, ReturnType<typeof createPanelSurface>>());
  const pointerRef = useRef<ReturnType<typeof createPointer> | null>(null);
  const paintedRef = useRef(new Map<string, string>());
  /* Superficie del vídeo en curso (N10). Se guarda con su elemento para poder
     saber si el que llega es otro: cambiar de vídeo tiene que rehacer la
     textura, y no rehacerla deja el primero congelado en el panel. */
  const videoRef = useRef<{ element: HTMLVideoElement; surface: XrVideoSurface } | null>(null);

  // Las opciones cambian en cada render del recorrido; el bucle inmersivo las
  // lee de una referencia para no reinstalarse en cada cambio de estado, que
  // en una sesión activa se ve como un parpadeo del panel.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let cancelled = false;
    void detectXrCapabilities().then((caps) => {
      if (!cancelled) setCapabilities(caps);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Dibuja un fotograma inmersivo completo. */
  const onXrFrame = useCallback(
    (_time: number, frame: XRFrame | undefined, session: XRSession, space: XRReferenceSpace) => {
    const current = latest.current;
    const renderer = current.renderer;
    const runtime = runtimeRef.current;
    const world = worldRef.current;
    if (renderer === null || runtime === null || world === null) return;

    const head = readHeadPose(frame, space);
    const { inputs, rays } = readSources(frame, session, space);

    const specs: XrPanelSpec[] = [];
    const layouts = new Map<string, ReturnType<typeof layoutVrPanel>>();
    for (const panel of current.panels) {
      const layout = layoutVrPanel(panel.nodes, {
        state: current.skinState,
        sceneId: current.sceneId,
        quizOptions: panel.paint?.quizOptions,
        scoreEntries: panel.paint?.scoreEntries,
      });
      layouts.set(panel.id, layout);
      specs.push({
        id: panel.id,
        placement: panel.placement ?? DEFAULT_VR_PANEL,
        targets: panelTargets(layout),
      });
    }

    const output = runtime.frame({ head, inputs, rays, panels: specs });
    world.setYawOffset(output.yawOffset);
    renderer.setSceneryYaw(output.yawOffset);

    for (const panel of current.panels) {
      const surface = ensureSurface(surfacesRef.current, world, panel.id);
      const layout = layouts.get(panel.id);
      const frameBox = output.frames.get(panel.id);
      if (layout === undefined || frameBox === undefined) continue;
      placePanelMesh(surface.mesh, frameBox);

      // La textura se repinta sólo si su contenido cambió: subir un lienzo de
      // 1024×666 a la GPU en cada fotograma se come el presupuesto de un visor
      // autónomo que tiene que sostener 72 fps.
      const paintOptions: PaintOptions = { ...panel.paint, hoveredTargetId: output.hovered };
      const signature = `${layout.rows.length}|${output.hovered ?? ''}|${JSON.stringify(panel.paint ?? {})}`;
      if (paintedRef.current.get(panel.id) !== signature) {
        const ctx = surface.canvas.getContext('2d');
        if (ctx !== null) {
          paintPanel(ctx as unknown as Painter2D, layout, paintOptions);
          surface.invalidate();
        }
        paintedRef.current.set(panel.id, signature);
      }
    }

    /* Panel de vídeo (N10). Se crea al abrirse la ventana, se recoloca delante
       del panel de interfaz y se libera al cerrarse: una textura de vídeo
       olvidada sigue decodificando fotogramas que nadie mira. */
    const video = current.video ?? null;
    const existing = videoRef.current;

    if (video === null || (existing !== null && existing.element !== video)) {
      if (existing !== null) {
        existing.surface.dispose();
        videoRef.current = null;
      }
    }

    if (video !== null && videoRef.current === null) {
      const surface = createVideoSurface(video, current.videoWidthM ?? 1.2);
      world.overlay.add(surface.mesh);
      videoRef.current = { element: video, surface };
    }

    const videoSurface = videoRef.current;
    if (videoSurface !== null) {
      /* La proporción se pone al día en cada fotograma hasta que el vídeo
         declara su tamaño: antes de cargar los metadatos no lo sabe, y un
         panel que se quedara con la proporción provisional mostraría la
         imagen estirada durante toda la reproducción. */
      videoSurface.surface.resize(current.videoWidthM ?? 1.2);
      /* Delante del panel de interfaz y a la altura de la mirada: el vídeo es
         lo que se está mirando, y detrás del panel no se vería. */
      videoSurface.surface.mesh.position.set(0, 0, -1.8);
      videoSurface.surface.mesh.rotation.set(0, 0, 0);
    }

    // Las superficies de paneles que se han cerrado se liberan: en la GPU, una
    // textura olvidada no la recoge nadie.
    for (const [id, surface] of [...surfacesRef.current.entries()]) {
      if (current.panels.some((panel) => panel.id === id)) continue;
      surface.mesh.removeFromParent();
      surface.dispose();
      surfacesRef.current.delete(id);
      paintedRef.current.delete(id);
    }

    const pointer = pointerRef.current;
    if (pointer !== null) {
      const ray = rays[0];
      if (ray === undefined) pointer.setVisible(false);
      else {
        pointer.setVisible(true);
        pointer.aim(ray.origin, ray.direction, output.pointerLengthM);
      }
    }

    for (const targetId of output.activated) current.onActivate(targetId);
    if (output.exitRequested) void controllerRef.current?.exit();

      renderer.renderXr();
    },
    [],
  );

  const enter = useCallback(() => {
    const renderer = latest.current.renderer;
    if (renderer === null) {
      // Ocurre si se pulsa antes de que la escena haya creado su contexto
      // gráfico. Devolver sin hacer nada deja un botón mudo, y el visitante
      // —que tiene unas gafas en la mano— no sabe si el fallo es suyo.
      setStatus({
        phase: 'idle',
        referenceSpace: null,
        error: domainError('XR_UNAVAILABLE', 'La escena todavía no está lista para el modo inmersivo', {
          recovery: 'Espere a que la escena termine de cargarse y vuelva a intentarlo.',
        }),
      });
      return;
    }

    const world = new XrWorld();
    const pointer = createPointer();
    world.overlay.add(pointer.object);
    renderer.attachXrObjects(world.scenery);
    renderer.attachXrObjects(world.overlay);
    worldRef.current = world;
    pointerRef.current = pointer;
    runtimeRef.current = new XrRuntime();

    const xr = (globalThis.navigator as Navigator & { xr?: XRSystem | undefined }).xr;
    const controller = new XrSessionController({
      xr,
      renderer: renderer.xrBridge,
      onStatusChange: setStatus,
      onXrFrame,
    });
    controllerRef.current = controller;
    void controller.enter();
  }, [onXrFrame]);

  const exit = useCallback(() => {
    void controllerRef.current?.exit();
  }, []);

  // Al terminar la sesión —por el botón, por el mando o porque el visitante se
  // quitó el visor— hay que soltar la geometría propia de VR. Sin esto, los
  // paneles se quedan en la escena plana, flotando delante de la panorámica.
  useEffect(() => {
    if (status.phase !== 'idle') return;
    const renderer = latest.current.renderer;
    const world = worldRef.current;
    if (world !== null) {
      for (const surface of surfacesRef.current.values()) surface.dispose();
      surfacesRef.current.clear();
      paintedRef.current.clear();
      /* El panel de vídeo también: la textura de un vídeo sigue decodificando
         fotogramas mientras exista, y al salir del visor nadie los mira (N10). */
      videoRef.current?.surface.dispose();
      videoRef.current = null;
      pointerRef.current?.dispose();
      pointerRef.current = null;
      if (renderer !== null) {
        renderer.detachXrObjects(world.scenery);
        renderer.detachXrObjects(world.overlay);
        renderer.setSceneryYaw(0);
      }
      world.detach();
      worldRef.current = null;
      runtimeRef.current = null;
    }
  }, [status.phase]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      for (const surface of surfacesRef.current.values()) surface.dispose();
      surfacesRef.current.clear();
      videoRef.current?.surface.dispose();
      videoRef.current = null;
      pointerRef.current?.dispose();
    },
    [],
  );

  return useMemo(
    () => ({
      capabilities,
      status,
      presenting: status.phase === 'active',
      enter,
      exit,
    }),
    [capabilities, status, enter, exit],
  );
}

/** Perfil por omisión: el conservador, que es el del visor autónomo (N12). */
export const DEFAULT_VR_PROFILE = VR_PROFILES.standalone!;

/** Crea la superficie de un panel la primera vez que se necesita. */
function ensureSurface(
  surfaces: Map<string, ReturnType<typeof createPanelSurface>>,
  world: XrWorld,
  id: string,
): ReturnType<typeof createPanelSurface> {
  const existing = surfaces.get(id);
  if (existing !== undefined) return existing;
  const surface = createPanelSurface(globalThis.document);
  world.overlay.add(surface.mesh);
  surfaces.set(id, surface);
  return surface;
}

/**
 * Pose de la cabeza en el espacio de referencia.
 *
 * Un fotograma sin pose válida es normal durante el arranque de la sesión y
 * cuando el visor pierde el seguimiento: se devuelve la última altura típica
 * en vez de ceros, porque con posición cero los paneles aparecerían a la
 * altura del suelo.
 */
function readHeadPose(
  frame: XRFrame | undefined,
  space: XRReferenceSpace,
): { readonly position: readonly [number, number, number]; readonly yaw: number } {
  if (frame === undefined) return { position: [0, 1.6, 0], yaw: 0 };

  const pose = frame.getViewerPose(space);
  const view = pose?.views[0];
  if (view === undefined) return { position: [0, 1.6, 0], yaw: 0 };

  const matrix = view.transform.matrix;
  const position: readonly [number, number, number] = [matrix[12] ?? 0, matrix[13] ?? 1.6, matrix[14] ?? 0];
  // El giro se extrae de la tercera columna: es la dirección de la mirada
  // proyectada en el plano horizontal.
  const yaw = Math.atan2(-(matrix[8] ?? 0), -(matrix[10] ?? 1));
  return { position, yaw };
}

/** Instantánea de los mandos y sus rayos. */
function readSources(
  frame: XRFrame | undefined,
  session: XRSession,
  space: XRReferenceSpace,
): { readonly inputs: readonly XrInputSnapshot[]; readonly rays: readonly XrRay[] } {
  const sources = session.inputSources ?? [];
  const inputs: XrInputSnapshot[] = [];
  const rays: XrRay[] = [];

  for (const source of sources) {
    const gamepad = source.gamepad;
    inputs.push({
      handedness: source.handedness as 'left' | 'right' | 'none',
      buttons: (gamepad?.buttons ?? []).map((button) => button.pressed),
      axes: [...(gamepad?.axes ?? [])],
    });

    const grip = source.targetRaySpace;
    const pose = frame === undefined ? undefined : frame.getPose(grip, space);
    rays.push(
      pose === undefined
        ? { origin: [0, 1.6, 0], direction: [0, 0, -1] }
        : rayFromPoseMatrix(pose.transform.matrix),
    );
  }

  return { inputs, rays };
}
