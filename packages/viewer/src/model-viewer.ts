/**
 * Visor de modelos 3D industriales (etapa 08, grupo L y V03/V07).
 *
 * Igual que el panorámico, la parte difícil no es cargar el GLB: es que un
 * modelo de planta de 300 MB con ochocientas mallas siga siendo navegable en
 * un portátil con gráficos integrados. De ahí las tres piezas centrales de
 * este módulo:
 *
 *  - **Resolución adaptativa** (V03): si no se sostiene la tasa objetivo, se
 *    baja la escala de píxel antes que los fotogramas. Un modelo que se mueve
 *    a 50 fps algo borroso es utilizable para inspección; uno nítido a 6 fps
 *    no lo es.
 *  - **Tres modos de cámara** (L02-L04) sobre el mismo estado, de modo que
 *    cambiar de modo no reinicia la posición del observador.
 *  - **Picking por malla** (L06, L07, L12), que es lo que permite anclar un
 *    marcador a un componente y ocultar partes del modelo.
 */
import {
  clamp,
  type CameraBounds,
  type CameraMode,
  type ModelLighting,
} from '@it360/domain';
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type AnimationClip,
  type AnimationAction,
} from 'three';

export interface ModelCameraState {
  /** Punto al que orbita o desde el que mira. */
  readonly target: Vector3;
  /** Distancia al objetivo, en modo orbital. */
  readonly distance: number;
  /** Azimut en radianes. */
  readonly azimuth: number;
  /** Elevación polar en radianes, medida desde el cenit. */
  readonly polar: number;
  readonly fov: number;
}

export interface ModelPick {
  readonly nodeName: string;
  readonly point: Vector3;
  readonly normal: Vector3;
  readonly distance: number;
}

export interface AdaptiveResolutionState {
  readonly pixelRatio: number;
  readonly measuredFps: number;
  /** `true` si se ha reducido la resolución respecto a la nominal. */
  readonly degraded: boolean;
}

/**
 * Medidor de tasa de fotogramas con histéresis.
 *
 * Sin histéresis, la resolución oscila: baja, el rendimiento mejora, sube,
 * vuelve a caer. El parpadeo resultante es más molesto que la pérdida de
 * nitidez. Por eso bajar es inmediato —el usuario ya está sufriendo— y subir
 * exige varios segundos sostenidos por encima del objetivo.
 */
export class AdaptiveResolution {
  private samples: number[] = [];
  private pixelRatio: number;
  private lastChangeMs = 0;

  constructor(
    private readonly targetFps: number,
    private readonly minPixelRatio: number,
    private readonly maxPixelRatio: number,
  ) {
    this.pixelRatio = maxPixelRatio;
  }

  /** Registra un fotograma y devuelve el estado resultante. */
  sample(deltaMs: number, nowMs: number): AdaptiveResolutionState {
    if (deltaMs > 0) {
      this.samples.push(1000 / deltaMs);
      if (this.samples.length > 30) this.samples.shift();
    }

    const fps = this.samples.length === 0 ? this.targetFps : median(this.samples);

    // Bajar es inmediato: el usuario ya está notando los tirones.
    if (fps < this.targetFps * 0.8 && this.pixelRatio > this.minPixelRatio) {
      if (nowMs - this.lastChangeMs > 500) {
        this.pixelRatio = Math.max(this.pixelRatio * 0.8, this.minPixelRatio);
        this.lastChangeMs = nowMs;
        this.samples = [];
      }
    } else if (fps > this.targetFps * 1.15 && this.pixelRatio < this.maxPixelRatio) {
      // Subir exige estabilidad sostenida para no entrar en oscilación.
      if (nowMs - this.lastChangeMs > 3000) {
        this.pixelRatio = Math.min(this.pixelRatio * 1.15, this.maxPixelRatio);
        this.lastChangeMs = nowMs;
        this.samples = [];
      }
    }

    return {
      pixelRatio: this.pixelRatio,
      measuredFps: fps,
      degraded: this.pixelRatio < this.maxPixelRatio - 0.01,
    };
  }

  reset(): void {
    this.samples = [];
    this.pixelRatio = this.maxPixelRatio;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/* ------------------------------------------------------------------ *
 * Cámara de modelo
 * ------------------------------------------------------------------ */

/**
 * Controlador de cámara para modelos 3D.
 *
 * El estado es el mismo para los tres modos: objetivo, distancia, azimut y
 * elevación. Cambiar de orbital a primera persona no recoloca al observador,
 * sólo cambia qué hace el arrastre y qué significa avanzar. Mantener estados
 * separados por modo haría que cada cambio teletransportara al usuario, que
 * es justo lo que el requisito L11 pide evitar entre modelos y conviene
 * evitar también entre modos.
 */
export class ModelCameraController {
  private state: ModelCameraState;

  constructor(
    initial: ModelCameraState,
    private mode: CameraMode,
    private bounds: CameraBounds,
  ) {
    this.state = this.constrain(initial);
  }

  getState(): ModelCameraState {
    return this.state;
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  setBounds(bounds: CameraBounds): void {
    this.bounds = bounds;
    this.state = this.constrain(this.state);
  }

  setState(state: Partial<ModelCameraState>): void {
    this.state = this.constrain({ ...this.state, ...state });
  }

  private constrain(state: ModelCameraState): ModelCameraState {
    return {
      ...state,
      distance: clamp(state.distance, this.bounds.minDistance, this.bounds.maxDistance),
      polar: clamp(state.polar, this.bounds.minPolarAngle, this.bounds.maxPolarAngle),
      fov: clamp(state.fov, 10, 120),
    };
  }

  /** Arrastre del puntero, en píxeles. */
  rotate(deltaXPx: number, deltaYPx: number, viewportHeight: number): void {
    const speed = (Math.PI * 1.2) / Math.max(viewportHeight, 1);
    this.state = this.constrain({
      ...this.state,
      azimuth: this.state.azimuth - deltaXPx * speed,
      polar: this.state.polar - deltaYPx * speed,
    });
  }

  /** Desplazamiento lateral del objetivo. */
  pan(deltaXPx: number, deltaYPx: number, viewportHeight: number): void {
    const scale = (this.state.distance * 2) / Math.max(viewportHeight, 1);
    const right = new Vector3(Math.cos(this.state.azimuth), 0, -Math.sin(this.state.azimuth));
    const up = new Vector3(0, 1, 0);
    const target = this.state.target
      .clone()
      .addScaledVector(right, -deltaXPx * scale)
      .addScaledVector(up, deltaYPx * scale);
    this.state = this.constrain({ ...this.state, target });
  }

  /** Acercamiento por rueda. En orbital cambia la distancia; en FPV, el FOV. */
  zoom(factor: number): void {
    if (this.mode === 'orbit') {
      this.state = this.constrain({ ...this.state, distance: this.state.distance * factor });
    } else {
      this.state = this.constrain({ ...this.state, fov: this.state.fov * factor });
    }
  }

  /**
   * Desplazamiento en primera persona y Fly Over.
   *
   * En primera persona el movimiento es horizontal: la altura la fija
   * `eyeHeight`, porque un observador que puede volar no transmite la escala
   * del espacio, que es la razón de usar ese modo en una inspección.
   */
  move(forward: number, strafe: number, deltaS: number): void {
    const speed = this.bounds.moveSpeed * deltaS;
    const dir = new Vector3(
      Math.sin(this.state.azimuth) * Math.sin(this.state.polar),
      this.mode === 'flyOver' ? Math.cos(this.state.polar) : 0,
      Math.cos(this.state.azimuth) * Math.sin(this.state.polar),
    ).normalize();

    const right = new Vector3(Math.cos(this.state.azimuth), 0, -Math.sin(this.state.azimuth));

    const target = this.state.target
      .clone()
      .addScaledVector(dir, forward * speed)
      .addScaledVector(right, strafe * speed);

    if (this.mode === 'firstPerson') target.y = this.bounds.eyeHeight;

    this.state = this.constrain({ ...this.state, target });
  }

  /** Posición de la cámara en coordenadas del modelo. */
  computePosition(): Vector3 {
    if (this.mode === 'firstPerson') {
      return this.state.target.clone();
    }
    const sinPolar = Math.sin(this.state.polar);
    return new Vector3(
      this.state.target.x + this.state.distance * sinPolar * Math.sin(this.state.azimuth),
      this.state.target.y + this.state.distance * Math.cos(this.state.polar),
      this.state.target.z + this.state.distance * sinPolar * Math.cos(this.state.azimuth),
    );
  }

  /** Punto al que mira la cámara. */
  computeLookAt(): Vector3 {
    if (this.mode === 'firstPerson') {
      const sinPolar = Math.sin(this.state.polar);
      return this.state.target
        .clone()
        .add(
          new Vector3(
            sinPolar * Math.sin(this.state.azimuth),
            Math.cos(this.state.polar),
            sinPolar * Math.cos(this.state.azimuth),
          ),
        );
    }
    return this.state.target.clone();
  }

  /**
   * Encuadra un objeto completo.
   *
   * La distancia se deduce del radio de la caja envolvente y del FOV, con un
   * margen del 20 %: encuadrar exacto deja el modelo tocando los bordes y
   * parece un error de cálculo.
   */
  frameObject(box: Box3, fovDeg: number): void {
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) / 2;
    const distance = (radius * 1.2) / Math.tan((fovDeg * Math.PI) / 360);
    this.state = this.constrain({
      ...this.state,
      target: center,
      distance,
      fov: fovDeg,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Escena de modelo
 * ------------------------------------------------------------------ */

export interface ModelSceneHandle {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly mixer: AnimationMixer | null;
  readonly animations: readonly AnimationClip[];
  /** Nombres de los nodos con malla, para la lista de componentes (L12). */
  readonly meshNames: readonly string[];
  readonly bounds: Box3;
}

/** Aplica la iluminación declarada en la escena (L09). */
export function applyLighting(scene: Scene, renderer: WebGLRenderer, lighting: ModelLighting): void {
  for (const child of [...scene.children]) {
    if (child instanceof AmbientLight || child instanceof DirectionalLight) scene.remove(child);
  }

  scene.add(new AmbientLight(0xffffff, lighting.ambientIntensity));

  const directional = new DirectionalLight(0xffffff, lighting.directionalIntensity);
  const cosPitch = Math.cos(lighting.directionalPitch);
  directional.position.set(
    cosPitch * Math.sin(lighting.directionalYaw) * 100,
    Math.sin(lighting.directionalPitch) * 100,
    cosPitch * Math.cos(lighting.directionalYaw) * 100,
  );
  directional.castShadow = lighting.shadows;
  if (lighting.shadows) {
    // Un mapa de sombras mayor no mejora nada en una escena industrial con
    // geometría angulosa, y 2048² ya cuesta memoria en GPU integrada.
    directional.shadow.mapSize.set(2048, 2048);
  }
  scene.add(directional);

  renderer.shadowMap.enabled = lighting.shadows;
  renderer.toneMappingExposure = lighting.exposure;
  renderer.outputColorSpace = SRGBColorSpace;

  if (lighting.background.kind === 'color') {
    scene.background = new Color(lighting.background.color);
  } else if (lighting.background.kind === 'token') {
    const tokens: Record<string, number> = { canvas: 0x0b0e13, sunken: 0x05070a, base: 0x11151c };
    scene.background = new Color(tokens[lighting.background.surfaceToken] ?? 0x05070a);
  }
}

/**
 * Localiza la malla bajo el puntero.
 *
 * Devuelve el nombre del nodo y la normal de la superficie, que es lo que
 * necesita un marcador adherido (L07) para orientarse contra la pieza en vez
 * de quedar flotando atravesada.
 */
export function pickMesh(
  scene: Scene,
  camera: PerspectiveCamera,
  normalizedX: number,
  normalizedY: number,
): ModelPick | null {
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(normalizedX, normalizedY), camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  for (const hit of hits) {
    if (!(hit.object instanceof Mesh)) continue;
    if (hit.object.visible === false) continue;

    const normal = hit.face?.normal.clone() ?? new Vector3(0, 1, 0);
    // La normal viene en espacio local; se lleva a mundo para que el sticker
    // quede pegado aunque la malla esté rotada dentro del modelo.
    normal.transformDirection(hit.object.matrixWorld);

    return {
      nodeName: hit.object.name.length > 0 ? hit.object.name : (hit.object.uuid ?? ''),
      point: hit.point.clone(),
      normal,
      distance: hit.distance,
    };
  }
  return null;
}

/** Muestra u oculta nodos por nombre (L12). */
export function setNodeVisibility(
  root: Object3D,
  nodeNames: readonly string[],
  visible: boolean,
): number {
  const targets = new Set(nodeNames);
  let affected = 0;
  root.traverse((child) => {
    if (targets.has(child.name)) {
      child.visible = visible;
      affected += 1;
    }
  });
  return affected;
}

/** Nombres de todas las mallas del modelo, en orden estable. */
export function collectMeshNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((child) => {
    if (child instanceof Mesh && child.name.length > 0) names.push(child.name);
  });
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
}

/**
 * Reproduce una animación del modelo (L10).
 *
 * Devuelve `null` si la animación no existe en lugar de lanzar: un proyecto
 * puede referirse a una animación que el modelo perdió al reexportarse, y eso
 * no debe impedir ver el modelo.
 */
export function playAnimation(
  mixer: AnimationMixer,
  clips: readonly AnimationClip[],
  name: string,
  loop: boolean,
): AnimationAction | null {
  const clip = clips.find((c) => c.name === name);
  if (clip === undefined) return null;

  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(loop ? 2201 : 2200, loop ? Infinity : 1);
  action.clampWhenFinished = !loop;
  action.play();
  return action;
}
