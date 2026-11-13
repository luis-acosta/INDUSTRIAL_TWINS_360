/**
 * Escena de modelo 3D (L01–L04, L08–L10, L12, V03).
 *
 * Es la capa delgada que une lo que ya está probado aparte: el cargador
 * (`model-loader`), la cámara y la resolución adaptativa (`model-viewer`). Aquí
 * sólo vive lo que no se puede comprobar sin GPU —crear el contexto WebGL y
 * pintar— y por eso se mantiene corto a propósito: toda decisión que pueda
 * tomarse fuera, se toma fuera.
 *
 * El bucle de dibujo se detiene cuando nada cambia. Un modelo quieto
 * repintándose sesenta veces por segundo calienta el portátil y gasta batería
 * sin mostrar nada nuevo; en una tableta recorriendo una planta eso se nota en
 * media jornada.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnimationMixer,
  Box3,
  Clock,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type AnimationClip,
  type Object3D,
} from 'three';
import type { CameraBounds, CameraMode, ModelLighting } from '@it360/domain';
import {
  AdaptiveResolution,
  applyLighting,
  collectMeshNames,
  ModelCameraController,
  pickMesh,
  setNodeVisibility,
  type ModelCameraState,
  type ModelPick,
} from './model-viewer';

export interface ModelSceneProps {
  /** Modelo ya cargado y normalizado. */
  readonly root: Object3D | null;
  readonly animations?: readonly AnimationClip[];
  readonly lighting: ModelLighting;
  readonly bounds: CameraBounds;
  readonly mode: CameraMode;
  /** Vista inicial; si falta, se encuadra el modelo entero. */
  readonly initialView?: ModelCameraState;
  /** Nodos ocultos por nombre (L12). */
  readonly hiddenNodes?: readonly string[];
  readonly onPick?: (pick: ModelPick | null) => void;
  readonly onCameraChange?: (state: ModelCameraState) => void;
  /** Nombres de las mallas, cuando el modelo termina de prepararse. */
  readonly onMeshNames?: (names: readonly string[]) => void;
  readonly onDegraded?: (degraded: boolean, fps: number) => void;
  readonly className?: string;
  readonly ariaLabel?: string;
}

const DEFAULT_VIEW: ModelCameraState = {
  target: new Vector3(0, 0, 0),
  distance: 15,
  azimuth: Math.PI / 4,
  polar: Math.PI / 3,
  fov: 60,
};

export function ModelScene({
  root,
  animations = [],
  lighting,
  bounds,
  mode,
  initialView,
  hiddenNodes = [],
  onPick,
  onCameraChange,
  onMeshNames,
  onDegraded,
  className,
  ariaLabel = 'Modelo 3D',
}: ModelSceneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controllerRef = useRef<ModelCameraController | null>(null);
  const mixerRef = useRef<AnimationMixer | null>(null);
  const adaptiveRef = useRef(new AdaptiveResolution(50, 0.6, Math.min(2, globalThis.devicePixelRatio ?? 1)));
  /** Pedir un fotograma: el bucle duerme cuando nada cambia. */
  const dirtyRef = useRef(true);
  const [failed, setFailed] = useState<string | null>(null);

  const requestFrame = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  /* --- Contexto WebGL --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      // Sin WebGL no hay modelo. Se dice, en lugar de dejar un lienzo negro.
      setFailed(
        'Este equipo no puede mostrar modelos 3D: el navegador no ofrece aceleración gráfica. Actualice los controladores de la tarjeta gráfica o abra el recorrido en otro equipo.',
      );
      return;
    }

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1, 0.01, 10_000);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    requestFrame();

    return () => {
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [requestFrame]);

  /* --- Modelo --- */

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;

    // Se quita el modelo anterior sin tocar las luces, que se reponen aparte.
    for (const child of [...scene.children]) {
      if (child.userData['isModel'] === true) scene.remove(child);
    }
    mixerRef.current = null;

    if (root === null) {
      requestFrame();
      return;
    }

    root.userData['isModel'] = true;
    scene.add(root);

    if (animations.length > 0) mixerRef.current = new AnimationMixer(root);

    onMeshNames?.(collectMeshNames(root));
    requestFrame();
  }, [root, animations, onMeshNames, requestFrame]);

  /* --- Cámara --- */

  const initial = useMemo(() => initialView ?? DEFAULT_VIEW, [initialView]);

  useEffect(() => {
    const controller = new ModelCameraController(initial, mode, bounds);

    // Sin vista declarada se encuadra el modelo entero: abrir un modelo y no
    // verlo es indistinguible de que no haya cargado.
    if (initialView === undefined && root !== null) {
      controller.frameObject(new Box3().setFromObject(root), initial.fov);
    }

    controllerRef.current = controller;
    requestFrame();
  }, [root, initial, initialView, mode, bounds, requestFrame]);

  useEffect(() => {
    controllerRef.current?.setMode(mode);
    requestFrame();
  }, [mode, requestFrame]);

  useEffect(() => {
    controllerRef.current?.setBounds(bounds);
    requestFrame();
  }, [bounds, requestFrame]);

  /* --- Iluminación --- */

  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (scene === null || renderer === null) return;

    applyLighting(scene, renderer, lighting);
    requestFrame();
  }, [lighting, requestFrame]);

  /* --- Visibilidad por nodo --- */

  useEffect(() => {
    if (root === null) return;
    // Primero se muestra todo y luego se oculta lo pedido: así quitar un nodo
    // de la lista lo devuelve a la vista sin recargar el modelo.
    root.traverse((child) => {
      child.visible = true;
    });
    if (hiddenNodes.length > 0) setNodeVisibility(root, hiddenNodes, false);
    requestFrame();
  }, [root, hiddenNodes, requestFrame]);

  /* --- Interacción --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let panning = false;

    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      panning = event.button === 1 || event.shiftKey;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const controller = controllerRef.current;
      if (controller === null) return;

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;

      if (panning) controller.pan(dx, dy, canvas.clientHeight);
      else controller.rotate(dx, dy, canvas.clientHeight);

      onCameraChange?.(controller.getState());
      requestFrame();
    };

    const onPointerUp = (event: PointerEvent): void => {
      dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const controller = controllerRef.current;
      if (controller === null) return;
      controller.zoom(event.deltaY > 0 ? 1.1 : 0.9);
      onCameraChange?.(controller.getState());
      requestFrame();
    };

    const onClick = (event: MouseEvent): void => {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (scene === null || camera === null || onPick === undefined) return;

      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      onPick(pickMesh(scene, camera, x, y));
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('click', onClick);
    };
  }, [onCameraChange, onPick, requestFrame]);

  /* --- Teclado: mover en primera persona y Fly Over --- */

  useEffect(() => {
    if (mode === 'orbit') return;

    const held = new Set<string>();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        return;
      }
      held.add(event.key);
      requestFrame();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      held.delete(event.key);
    };

    const tick = window.setInterval(() => {
      if (held.size === 0) return;
      const controller = controllerRef.current;
      if (controller === null) return;

      const forward =
        (held.has('w') || held.has('ArrowUp') ? 1 : 0) -
        (held.has('s') || held.has('ArrowDown') ? 1 : 0);
      const strafe =
        (held.has('d') || held.has('ArrowRight') ? 1 : 0) -
        (held.has('a') || held.has('ArrowLeft') ? 1 : 0);

      if (forward !== 0 || strafe !== 0) {
        controller.move(forward, strafe, 1 / 30);
        onCameraChange?.(controller.getState());
        requestFrame();
      }
    }, 1000 / 30);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [mode, onCameraChange, requestFrame]);

  /* --- Bucle de dibujo --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const clock = new Clock();
    let raf = 0;
    let running = true;

    const frame = (): void => {
      if (!running) return;
      raf = requestAnimationFrame(frame);

      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controller = controllerRef.current;
      if (renderer === null || scene === null || camera === null || controller === null) return;

      const delta = clock.getDelta();
      const mixer = mixerRef.current;

      // Una animación en curso siempre pide fotograma; lo demás sólo cuando
      // algo ha cambiado.
      if (mixer !== null) {
        mixer.update(delta);
        dirtyRef.current = true;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      const state = adaptiveRef.current.sample(delta * 1000, performance.now());
      renderer.setPixelRatio(state.pixelRatio);
      renderer.setSize(width, height, false);
      onDegraded?.(state.degraded, state.measuredFps);

      const view = controller.getState();
      camera.aspect = width / height;
      camera.fov = view.fov;
      camera.position.copy(controller.computePosition());
      camera.lookAt(controller.computeLookAt());
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [onDegraded]);

  /* --- Redimensionado --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const observer = new ResizeObserver(() => requestFrame());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [requestFrame]);

  if (failed !== null) {
    return (
      <div className={className} role="alert">
        <p className="model-scene__failed">{failed}</p>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label={ariaLabel}
      role="img"
      tabIndex={0}
      style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
    />
  );
}
