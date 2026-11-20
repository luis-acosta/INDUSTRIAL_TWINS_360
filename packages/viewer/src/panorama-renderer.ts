/**
 * Renderizador panorámico sobre Three.js.
 *
 * Decisiones que conviene dejar escritas:
 *
 *  - **Esfera invertida, no cubo.** Se proyecta la equirectangular sobre una
 *    esfera con las caras hacia dentro. Es una malla, una textura y ninguna
 *    costura visible; un cubemap exigiría seis texturas y un paso de
 *    conversión que no aporta nada a esta resolución.
 *  - **Un solo lienzo WebGL.** Crear un contexto por escena agota el límite
 *    del navegador (unos dieciséis) en un recorrido mediano y provoca que el
 *    más antiguo se pierda sin aviso.
 *  - **Dibujo bajo demanda.** No hay bucle permanente: se dibuja cuando algo
 *    cambia. Una escena estática a 60 fps mantiene la GPU ocupada sin
 *    producir nada.
 *  - **Degradación explícita.** Si WebGL no está disponible, el visor lo dice
 *    y muestra la panorámica como imagen plana desplazable. El plan exige
 *    «fallback de GPU», y una pantalla negra no lo es.
 */
import {
  degToRad,
  FULL_COVERAGE,
  radToDeg,
  sphericalToVector,
  type CameraView,
  type PanoramaCoverage,
  type Uv,
} from '@it360/domain';
import {
  BackSide,
  Color,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';

export interface RendererCapabilities {
  readonly webgl: boolean;
  readonly webgl2: boolean;
  readonly maxTextureSize: number;
  /** `true` si el contexto se creó sobre una GPU de software. */
  readonly softwareFallback: boolean;
  readonly renderer: string;
}

/**
 * Detecta las capacidades gráficas antes de intentar crear el visor.
 *
 * Se consulta `WEBGL_debug_renderer_info` cuando está disponible para avisar
 * de que se está sobre un renderizador de software: en ese caso una
 * panorámica 8K se mueve a tirones, y es mejor decirlo que dejar al usuario
 * pensando que la aplicación va lenta.
 */
export function detectCapabilities(): RendererCapabilities {
  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  const gl = gl2 ?? canvas.getContext('webgl');

  if (gl === null) {
    return { webgl: false, webgl2: false, maxTextureSize: 0, softwareFallback: true, renderer: 'ninguno' };
  }

  let rendererName = 'desconocido';
  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo !== null) {
      rendererName = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
    }
  } catch {
    // Algunos navegadores bloquean la extensión por privacidad.
  }

  const software = /swiftshader|software|llvmpipe|microsoft basic render/i.test(rendererName);

  return {
    webgl: true,
    webgl2: gl2 !== null,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048,
    softwareFallback: software,
    renderer: rendererName,
  };
}

export interface PanoramaRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Relación de píxeles. Se acota para no reventar equipos con pantalla 4K. */
  readonly maxPixelRatio?: number;
  readonly backgroundColor?: string;
}

export interface PickResult {
  /** Dirección en el espacio de la escena. */
  readonly yaw: number;
  readonly pitch: number;
  /** Coordenada de textura equivalente. */
  readonly uv: Uv;
}

/**
 * Segmentación de la esfera.
 *
 * 64×48 es el punto en que dejan de verse facetas en el horizonte con un FOV
 * de 30°, que es el zoom más cercano habitual. Subir a 128×96 cuadruplica los
 * triángulos sin diferencia perceptible.
 */
const SPHERE_SEGMENTS_H = 64;
const SPHERE_SEGMENTS_V = 48;
const SPHERE_RADIUS = 500;

export class PanoramaRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly sphere: Mesh<SphereGeometry, MeshBasicMaterial>;
  private texture: Texture | null = null;
  private coverage: PanoramaCoverage = FULL_COVERAGE;
  private disposed = false;

  constructor(private readonly options: PanoramaRendererOptions) {
    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: false,
      alpha: false,
      // El búfer se conserva para poder exportar fotogramas (S07) sin volver
      // a dibujar la escena entera en el momento de la captura.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(new Color(options.backgroundColor ?? '#05070A'), 1);
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(75, 1, 0.1, 1200);

    const geometry = new SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS_H, SPHERE_SEGMENTS_V);
    // Invertir en X deja las caras mirando hacia dentro sin desactivar el
    // descarte de caras traseras, que seguimos queriendo para el resto.
    geometry.scale(-1, 1, 1);

    const material = new MeshBasicMaterial({ color: 0x1a1f28, side: BackSide });
    this.sphere = new Mesh(geometry, material);
    this.scene.add(this.sphere);
  }

  /** Ajusta el lienzo al tamaño del contenedor. */
  resize(width: number, height: number): void {
    if (this.disposed) return;
    const w = Math.max(Math.floor(width), 1);
    const h = Math.max(Math.floor(height), 1);
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, this.options.maxPixelRatio ?? 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Cambia la textura panorámica.
   *
   * La textura anterior se libera explícitamente. Sin eso, un recorrido de
   * sesenta escenas acumula sesenta texturas de 8K en memoria de GPU y la
   * pestaña acaba cerrándose sola.
   */
  setTexture(texture: Texture | null, coverage: PanoramaCoverage = FULL_COVERAGE): void {
    if (this.disposed) return;

    if (this.texture !== null && this.texture !== texture) {
      this.texture.dispose();
    }

    this.texture = texture;
    this.coverage = coverage;

    if (texture !== null) {
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      this.applyCoverageMapping(texture, coverage);
    }

    this.sphere.material.map = texture;
    this.sphere.material.color.set(texture === null ? 0x1a1f28 : 0xffffff);
    this.sphere.material.needsUpdate = true;
  }

  /**
   * Ajusta el mapeo de la textura a una cobertura parcial.
   *
   * Una panorámica que sólo cubre 120° debe ocupar 120° de la esfera y no
   * estirarse sobre los 360°. Se consigue con el desplazamiento y la
   * repetición de la textura, que es exactamente para lo que existen.
   */
  private applyCoverageMapping(texture: Texture, coverage: PanoramaCoverage): void {
    const hFraction = Math.min(coverage.horizontalDeg / 360, 1);
    const vFraction = Math.min(coverage.verticalDeg / 180, 1);

    texture.repeat.set(1 / hFraction, 1 / vFraction);
    texture.offset.set(
      0.5 - 0.5 / hFraction + coverage.centerYaw / (2 * Math.PI) / hFraction,
      0.5 - 0.5 / vFraction - coverage.centerPitch / Math.PI / vFraction,
    );
    texture.needsUpdate = true;
  }

  /**
   * Puente al gestor XR del renderizador (etapa 13).
   *
   * Se expone el gestor en lugar del renderizador entero para que la sesión
   * inmersiva no pueda tocar nada más: `XrSessionController` necesita
   * habilitar XR, fijar el espacio de referencia, entregar la sesión y tomar
   * el bucle de fotogramas, y ninguna otra cosa.
   */
  get xrBridge(): {
    enabled: boolean;
    setReferenceSpaceType(type: XRReferenceSpaceType): void;
    setSession(session: XRSession | null): Promise<void>;
    setAnimationLoop(callback: ((time: number, frame?: XRFrame) => void) | null): void;
  } {
    const renderer = this.renderer;
    return {
      get enabled(): boolean {
        return renderer.xr.enabled;
      },
      set enabled(value: boolean) {
        renderer.xr.enabled = value;
      },
      setReferenceSpaceType(type) {
        renderer.xr.setReferenceSpaceType(type);
      },
      async setSession(session) {
        await renderer.xr.setSession(session as never);
      },
      setAnimationLoop(callback) {
        renderer.setAnimationLoop(callback === null ? null : (time, frame) => callback(time, frame));
      },
    };
  }

  /**
   * Objetos propios de la sesión inmersiva, añadidos a la escena que se dibuja.
   *
   * La panorámica de la escena plana ya está en esa escena: la sesión no
   * duplica la esfera, la hereda. Lo que añade son los paneles y el puntero.
   */
  attachXrObjects(object: Object3D): void {
    if (this.disposed) return;
    this.scene.add(object);
  }

  detachXrObjects(object: Object3D): void {
    this.scene.remove(object);
  }

  /**
   * Dibuja un fotograma inmersivo.
   *
   * Sin `view`: la pose y la proyección de cada ojo las fija el visor a través
   * del gestor XR, y escribir en la cámara desde aquí produciría el tirón que
   * en VR se siente en el estómago. Es la diferencia esencial con `render`.
   */
  renderXr(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Giro aplicado al decorado por el mando (N11). */
  setSceneryYaw(yaw: number): void {
    if (this.disposed) return;
    this.sphere.rotation.y = yaw;
  }

  /** Orienta la cámara y dibuja un fotograma. */
  render(view: CameraView): void {
    if (this.disposed) return;
    this.camera.fov = view.fov;
    this.camera.updateProjectionMatrix();

    const direction = sphericalToVector({ yaw: view.yaw, pitch: view.pitch });
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(new Vector3(direction.x, direction.y, direction.z));

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Convierte una posición del lienzo en dirección de la escena.
   *
   * Es la base de todo el picking: colocar un marcador donde el usuario hace
   * clic, saber qué polígono hay bajo el puntero, anclar una nota.
   */
  pick(clientX: number, clientY: number, view: CameraView): PickResult {
    const rect = this.options.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ny = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);

    const fovRad = degToRad(view.fov);
    const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
    const tanHalf = Math.tan(fovRad / 2);

    // Dirección en el espacio de cámara, con la convención del dominio
    // (mirada hacia -Z).
    const camDir = new Vector3(nx * tanHalf * aspect, ny * tanHalf, -1).normalize();

    const forward = sphericalToVector({ yaw: view.yaw, pitch: view.pitch });
    const f = new Vector3(forward.x, forward.y, forward.z);
    const up = new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(f, up).normalize();
    const trueUp = new Vector3().crossVectors(right, f).normalize();

    const world = new Vector3()
      .addScaledVector(right, camDir.x)
      .addScaledVector(trueUp, camDir.y)
      .addScaledVector(f, -camDir.z)
      .normalize();

    const yaw = Math.atan2(world.x, -world.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, world.y)));

    return {
      yaw,
      pitch,
      uv: {
        u: (yaw + Math.PI) / (2 * Math.PI),
        v: 0.5 - pitch / Math.PI,
      },
    };
  }

  /**
   * Proyecta una dirección a coordenadas del lienzo.
   *
   * Devuelve `null` si el punto queda detrás de la cámara, para que el visor
   * no dibuje marcadores de la espalda del observador como si estuvieran
   * delante, que es el artefacto más llamativo de un visor 360 mal hecho.
   */
  project(
    yaw: number,
    pitch: number,
    view: CameraView,
    viewportWidth: number,
    viewportHeight: number,
  ): { x: number; y: number; scale: number } | null {
    const target = sphericalToVector({ yaw, pitch });
    const forward = sphericalToVector({ yaw: view.yaw, pitch: view.pitch });

    const f = new Vector3(forward.x, forward.y, forward.z);
    const t = new Vector3(target.x, target.y, target.z);

    const dot = f.dot(t);
    if (dot <= 0.001) return null;

    const right = new Vector3().crossVectors(f, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, f).normalize();

    const fovRad = degToRad(view.fov);
    const tanHalf = Math.tan(fovRad / 2);
    const aspect = Math.max(viewportWidth, 1) / Math.max(viewportHeight, 1);

    const x = t.dot(right) / dot / (tanHalf * aspect);
    const y = t.dot(up) / dot / tanHalf;

    // Fuera del cuadro con margen: el marcador se descarta, pero el margen
    // evita que parpadee justo en el borde al girar.
    if (Math.abs(x) > 1.6 || Math.abs(y) > 1.6) return null;

    return {
      x: ((x + 1) / 2) * viewportWidth,
      y: ((1 - y) / 2) * viewportHeight,
      // La escala compensa el zoom: un marcador adherido a la escena crece al
      // acercarse, uno flotante mantiene su tamaño.
      scale: 75 / Math.max(view.fov, 1),
    };
  }

  /** Captura el fotograma actual como PNG en base64 (S07). */
  captureFrame(): string {
    return this.options.canvas.toDataURL('image/png');
  }

  get info(): { triangles: number; calls: number; textures: number } {
    return {
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      textures: this.renderer.info.memory.textures,
    };
  }

  get currentCoverage(): PanoramaCoverage {
    return this.coverage;
  }

  /** FOV horizontal efectivo, en grados. Lo usa el radar del plano. */
  horizontalFovDeg(view: CameraView): number {
    const vertical = degToRad(view.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    return radToDeg(horizontal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture?.dispose();
    this.sphere.geometry.dispose();
    this.sphere.material.dispose();
    this.renderer.dispose();
  }
}
