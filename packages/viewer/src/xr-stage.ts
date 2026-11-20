/**
 * Escena inmersiva: lo que se dibuja dentro del visor (N01, N02, N03).
 *
 * Es la única pieza de la etapa 13 que depende de Three, y está separada por
 * eso: la aritmética de paneles, la entrada de los mandos y el ciclo de vida
 * de la sesión se prueban sin cargar un contexto gráfico, y aquí queda sólo lo
 * que no se puede probar sin uno.
 *
 * Decisiones que gobiernan el módulo:
 *
 * - **La cámara no se toca.** Dentro de una sesión, la pose la fija el visor;
 *   escribir en la cámara produce el tirón que se siente en el estómago. El
 *   giro del mando se aplica rotando el mundo, que es el grupo que contiene la
 *   esfera y los paneles.
 * - **Un panel es geometría.** Un rectángulo con una textura pintada en un
 *   lienzo, porque el navegador no compone DOM sobre la imagen del visor.
 * - **La textura se repinta sólo cuando cambia.** Subir un lienzo de 1024×666
 *   a la GPU en cada fotograma consume el presupuesto de un visor autónomo que
 *   tiene que sostener 72 fps.
 */
import {
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';

import type { VrPanelPlacement } from './webxr';
import type { PanelAnchor, PanelFrame } from './xr-panel';
import { panelFrame } from './xr-panel';
import { PANEL_TEXTURE_HEIGHT, PANEL_TEXTURE_WIDTH } from './xr-skin-panel';

/** Lienzo donde se pinta un panel, con su textura asociada. */
export interface PanelSurface {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** Marca la textura para subirla en el próximo fotograma. */
  invalidate(): void;
  dispose(): void;
}

/**
 * Crea la superficie de un panel.
 *
 * El plano se crea de 1×1 y se escala después: así un cambio de tamaño del
 * panel (N04) no reconstruye la geometría, que es una asignación de memoria en
 * la GPU por cada ajuste del control deslizante del editor.
 */
export function createPanelSurface(
  document: Document,
  width = PANEL_TEXTURE_WIDTH,
  height = PANEL_TEXTURE_HEIGHT,
): PanelSurface {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // Sin mipmaps: el panel se mira de frente y a distancia fija, de modo que
  // la cadena de mipmaps sería memoria gastada en niveles que no se usan.
  texture.generateMipmaps = false;

  const material = new MeshBasicMaterial({ map: texture, transparent: false, depthTest: true });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  // Los paneles se dibujan después de la panorámica, que está a 500 m: sin
  // esto, el orden de dibujado depende del orden de inserción.
  mesh.renderOrder = 10;

  return {
    canvas,
    texture,
    mesh,
    invalidate() {
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
      material.dispose();
      mesh.geometry.dispose();
    },
  };
}

/**
 * Coloca la malla de un panel según su marco.
 *
 * El marco lo calcula `xr-panel.ts` sin Three; aquí sólo se traduce a la
 * transformación del objeto. Mantener el cálculo fuera es lo que permite
 * probarlo, y mantener la traducción aquí es lo que evita duplicarla.
 */
export function placePanelMesh(mesh: Object3D, frame: PanelFrame): void {
  mesh.position.set(frame.center[0], frame.center[1], frame.center[2]);
  mesh.scale.set(Math.hypot(...frame.right) * 2, Math.hypot(...frame.up) * 2, 1);
  // El plano de Three mira a +Z; orientarlo hacia el observador es mirar al
  // punto que está a un metro en el sentido de la normal.
  mesh.lookAt(
    frame.center[0] + frame.normal[0],
    frame.center[1] + frame.normal[1],
    frame.center[2] + frame.normal[2],
  );
}

/** Puntero del mando: una línea corta que indica a dónde se apunta. */
export interface XrPointer {
  readonly object: Object3D;
  /** Coloca el puntero en el origen y la dirección dados. */
  aim(origin: readonly [number, number, number], direction: readonly [number, number, number], lengthM: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Crea el puntero.
 *
 * Es un cilindro muy fino y no una línea porque las líneas de un píxel se
 * pierden con el filtrado del visor; a dos metros, un cilindro de 3 mm se ve y
 * una línea no.
 */
export function createPointer(): XrPointer {
  const geometry = new PlaneGeometry(0.003, 1);
  const material = new MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.8 });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 20;

  return {
    object: mesh,
    aim(origin, direction, lengthM) {
      const end = new Vector3(
        origin[0] + direction[0] * lengthM,
        origin[1] + direction[1] * lengthM,
        origin[2] + direction[2] * lengthM,
      );
      const middle = new Vector3(
        (origin[0] + end.x) / 2,
        (origin[1] + end.y) / 2,
        (origin[2] + end.z) / 2,
      );
      mesh.position.copy(middle);
      mesh.scale.set(1, lengthM, 1);
      mesh.lookAt(new Vector3(origin[0], origin[1], origin[2]));
      // El plano se alarga en Y; hay que girarlo para que su eje largo
      // coincida con el del rayo después de orientarlo.
      mesh.rotateX(Math.PI / 2);
    },
    setVisible(visible) {
      mesh.visible = visible;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Mundo inmersivo: el grupo que se gira con el mando.
 *
 * Girar el mundo y no la cámara es lo que hace que el giro por pasos no
 * produzca malestar: la pose de la cabeza sigue siendo la que mide el visor, y
 * lo que rota es la escena. Es también lo que hace que un panel anclado al
 * mundo gire con él y uno anclado a la mirada no.
 */
export class XrWorld {
  /** Contiene la panorámica o el modelo: gira con el mando. */
  readonly scenery = new Group();
  /** Contiene los paneles anclados al espacio de la sesión. */
  readonly overlay = new Group();
  private yaw = 0;

  constructor() {
    this.scenery.name = 'it360-xr-scenery';
    this.overlay.name = 'it360-xr-overlay';
  }

  /** Giro acumulado del mando, en radianes. */
  get yawOffset(): number {
    return this.yaw;
  }

  /**
   * Aplica el giro acumulado.
   *
   * Se aplica al decorado y no al grupo de paneles: los paneles ya se colocan
   * respecto a la mirada o al mundo por su propio ancla, y girarlos aquí
   * además los movería dos veces.
   */
  setYawOffset(yaw: number): void {
    this.yaw = yaw;
    this.scenery.rotation.y = yaw;
  }

  /** Añade los grupos a la escena que se dibuja. */
  attachTo(parent: Object3D): void {
    parent.add(this.scenery);
    parent.add(this.overlay);
  }

  detach(): void {
    this.scenery.removeFromParent();
    this.overlay.removeFromParent();
  }
}

/**
 * Coloca un panel dentro del mundo inmersivo.
 *
 * Reúne las tres piezas que viven en módulos distintos a propósito: el ancla
 * (estado), el marco (aritmética) y la malla (Three).
 */
export function syncPanel(
  surface: PanelSurface,
  placement: VrPanelPlacement,
  anchor: PanelAnchor,
): PanelFrame {
  const frame = panelFrame(placement, anchor);
  placePanelMesh(surface.mesh, frame);
  return frame;
}
