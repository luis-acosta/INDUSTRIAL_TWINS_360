/**
 * Marcadores de un modelo 3D, proyectados a la pantalla (L06, L07).
 *
 * Los marcadores se dibujan como elementos del DOM encima del lienzo y no como
 * geometría dentro de la escena. Es una decisión con consecuencias que conviene
 * tener escritas: así el marcador tiene texto legible a cualquier distancia,
 * recibe el foco del teclado y lo lee un lector de pantalla, que es lo que un
 * cartel dibujado con triángulos no puede dar. El precio es que hay que
 * proyectarlo a mano cada fotograma y ocuparse de la oclusión, que es lo que
 * hace este módulo.
 *
 * La oclusión importa más de lo que parece. Sin ella, el marcador de una
 * válvula se ve a través del depósito que la tapa, y el visitante cree que está
 * mirando la válvula cuando está mirando el depósito. En una inspección eso es
 * una confusión con consecuencias.
 */
import { Matrix4, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3 } from 'three';
import {
  isFacingCamera,
  stickerScale,
  type ModelSurfaceAnchor,
} from '@it360/domain';

export interface ProjectedHotspot {
  /** Píxeles desde la esquina superior izquierda del lienzo. */
  readonly x: number;
  readonly y: number;
  /** Distancia a la cámara, en unidades del modelo. */
  readonly distance: number;
  /** Factor de escala aparente. */
  readonly scale: number;
  /** `false` si está en la cara de atrás de la superficie. */
  readonly facing: boolean;
  /** `true` si otra geometría lo tapa. */
  readonly occluded: boolean;
}

export interface ProjectOptions {
  readonly width: number;
  readonly height: number;
  /** Comprobar si otra geometría lo tapa. Cuesta un rayo por marcador. */
  readonly testOcclusion?: boolean;
}

/** Margen para no declarar tapado un marcador por su propia superficie. */
const OCCLUSION_SLACK = 0.02;

/**
 * Posición en el mundo de un ancla, siguiendo a su pieza.
 *
 * Devuelve `null` cuando la pieza no está en el modelo: el autor reexportó el
 * CAD y la malla cambió de nombre. No se cae a una posición cualquiera, porque
 * un marcador en el sitio equivocado es peor que un marcador ausente.
 */
export function anchorWorldPosition(
  root: Object3D,
  anchor: ModelSurfaceAnchor,
): { readonly point: Vector3; readonly normal: Vector3 } | null {
  const node = root.getObjectByName(anchor.nodeName);
  if (node === undefined) return null;

  node.updateWorldMatrix(true, false);

  const point = new Vector3(
    anchor.localPosition.x,
    anchor.localPosition.y,
    anchor.localPosition.z,
  ).applyMatrix4(node.matrixWorld);

  const normal = new Vector3(anchor.normal.x, anchor.normal.y, anchor.normal.z);
  normal.transformDirection(node.matrixWorld);

  return { point, normal };
}

/** Pasa un punto del mundo a coordenadas locales de una pieza. */
export function worldToLocal(node: Object3D, world: Vector3): Vector3 {
  node.updateWorldMatrix(true, false);
  const inverse = new Matrix4().copy(node.matrixWorld).invert();
  return world.clone().applyMatrix4(inverse);
}

/**
 * Proyecta un marcador a la pantalla.
 *
 * `null` cuando queda detrás de la cámara: proyectarlo daría una posición
 * especular, y el marcador aparecería en el lado contrario de la pantalla
 * señalando una pieza que está a la espalda del visitante.
 */
export function projectHotspot(
  root: Object3D,
  scene: Scene,
  camera: PerspectiveCamera,
  anchor: ModelSurfaceAnchor,
  options: ProjectOptions,
): ProjectedHotspot | null {
  const placed = anchorWorldPosition(root, anchor);
  if (placed === null) return null;

  const projected = placed.point.clone().project(camera);
  if (projected.z > 1 || projected.z < -1) return null;

  const distance = camera.position.distanceTo(placed.point);

  return {
    x: ((projected.x + 1) / 2) * options.width,
    y: ((1 - projected.y) / 2) * options.height,
    distance,
    scale: stickerScale(distance),
    facing: isFacingCamera(placed.normal, placed.point, camera.position),
    occluded:
      options.testOcclusion === true
        ? isOccluded(scene, camera, placed.point, distance)
        : false,
  };
}

/**
 * `true` si otra geometría tapa el punto.
 *
 * Se lanza un rayo desde la cámara y se compara la primera intersección con la
 * distancia al marcador, con un margen: sin él, la propia superficie en la que
 * está pegado el marcador lo declararía tapado siempre.
 */
export function isOccluded(
  scene: Scene,
  camera: PerspectiveCamera,
  point: Vector3,
  distance: number,
): boolean {
  const direction = point.clone().sub(camera.position).normalize();
  const raycaster = new Raycaster(camera.position.clone(), direction, 0.001, distance);

  const hits = raycaster.intersectObjects(scene.children, true);
  for (const hit of hits) {
    if (hit.object.visible === false) continue;
    if (hit.distance < distance - distance * OCCLUSION_SLACK) return true;
    break;
  }

  return false;
}

/**
 * Marcador bajo el puntero, para pulsar el que está delante.
 *
 * Se devuelve el más cercano a la cámara de entre los que caen bajo el radio
 * indicado. Con dos marcadores superpuestos —frecuente en un modelo denso—,
 * pulsar el de atrás sería desconcertante.
 */
export function hotspotAtPointer(
  projected: readonly { readonly id: string; readonly screen: ProjectedHotspot | null }[],
  pointer: { readonly x: number; readonly y: number },
  radiusPx: number,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of projected) {
    const screen = candidate.screen;
    if (screen === null || !screen.facing || screen.occluded) continue;

    const dx = screen.x - pointer.x;
    const dy = screen.y - pointer.y;
    if (Math.sqrt(dx * dx + dy * dy) > radiusPx) continue;

    if (screen.distance < bestDistance) {
      bestDistance = screen.distance;
      bestId = candidate.id;
    }
  }

  return bestId;
}

/** Coordenadas normalizadas para el trazado de rayos, desde píxeles del lienzo. */
export function normalizedPointer(
  pointer: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
): Vector2 {
  if (size.width <= 0 || size.height <= 0) return new Vector2(0, 0);
  return new Vector2((pointer.x / size.width) * 2 - 1, -(pointer.y / size.height) * 2 + 1);
}
