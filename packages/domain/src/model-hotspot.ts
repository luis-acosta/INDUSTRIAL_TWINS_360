/**
 * Marcadores sobre un modelo 3D (L05–L07).
 *
 * Un marcador de panorámica se guarda como un par de ángulos y eso basta: la
 * cámara está en el centro de una esfera y no se mueve de ahí. Sobre un modelo
 * no vale: el visitante orbita, la pieza puede estar animada y el marcador
 * tiene que quedarse pegado a su superficie.
 *
 * De ahí las tres decisiones de este módulo.
 *
 * **La posición se guarda en el espacio local de la pieza**, no en el del
 * modelo. Si una válvula gira con una animación, su marcador gira con ella;
 * guardado en coordenadas del modelo se quedaría flotando en el aire donde la
 * válvula estaba.
 *
 * **Se guarda también la normal de la superficie.** Sin ella el marcador se
 * dibuja de cara a la cámara y atraviesa la chapa cuando se orbita por detrás.
 * Con ella se puede orientar contra la pieza y, además, saber si el visitante
 * lo está viendo por el lado bueno.
 *
 * **Enlazar panorámica y modelo es un marcador, no un campo nuevo** (L05). La
 * acción de ir a otra escena ya existe y ya está probada; lo que faltaba era
 * poder colocarla sobre una pieza. Un campo «panorámica asociada» habría sido
 * un segundo mecanismo de navegación que mantener.
 */

import { z } from 'zod';
import { anchorSchema, type Anchor, type Hotspot } from './hotspot';
import type { Scene } from './scene';

export type ModelSurfaceAnchor = Extract<Anchor, { space: 'modelSurface' }>;

export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Longitud de un vector. */
export const vectorLength = (v: Vector3Like): number =>
  Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

/**
 * Normaliza un vector.
 *
 * Un vector nulo devuelve el eje Y en lugar de `NaN`: ocurre cuando una malla
 * trae una cara degenerada, y un marcador mal orientado es mejor que una
 * escena con geometría inválida que el renderizador descarta en silencio.
 */
export function normalizeVector(v: Vector3Like): Vector3Like {
  const length = vectorLength(v);
  if (!Number.isFinite(length) || length < 1e-9) return { x: 0, y: 1, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export const dotProduct = (a: Vector3Like, b: Vector3Like): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

/** Ancla sobre la superficie de una pieza, lista para guardar. */
export function createModelSurfaceAnchor(
  nodeName: string,
  localPosition: Vector3Like,
  normal: Vector3Like,
): ModelSurfaceAnchor {
  const parsed = anchorSchema.parse({
    space: 'modelSurface',
    nodeName,
    localPosition: {
      x: localPosition.x,
      y: localPosition.y,
      z: localPosition.z,
    },
    normal: normalizeVector(normal),
  });

  // El esquema es una unión; se estrecha aquí para no obligar a cada llamante.
  if (parsed.space !== 'modelSurface') {
    throw new Error('el ancla construida debería ser de superficie de modelo');
  }
  return parsed;
}

/**
 * `true` si el visitante ve la cara en la que está el marcador.
 *
 * Se compara la normal con la dirección desde el marcador hacia la cámara: si
 * apuntan a lados opuestos, el marcador está en la cara de atrás de la chapa y
 * el visitante lo está viendo desde dentro de la pieza.
 *
 * El umbral no es cero sino un poco negativo. Un marcador sobre una superficie
 * casi paralela a la vista desaparecería y reaparecería con cada grado de giro,
 * y un parpadeo así en una inspección se lee como un fallo del visor.
 */
export const FACING_THRESHOLD = -0.12;

export function isFacingCamera(
  normalWorld: Vector3Like,
  pointWorld: Vector3Like,
  cameraWorld: Vector3Like,
): boolean {
  const toCamera = normalizeVector({
    x: cameraWorld.x - pointWorld.x,
    y: cameraWorld.y - pointWorld.y,
    z: cameraWorld.z - pointWorld.z,
  });

  return dotProduct(normalizeVector(normalWorld), toCamera) > FACING_THRESHOLD;
}

/**
 * Escala aparente del marcador según la distancia.
 *
 * Un marcador de tamaño fijo en píxeles es ilegible de cerca —tapa la pieza que
 * señala— y invisible de lejos. Se escala con la distancia pero con topes: sin
 * ellos, acercarse a una válvula llenaría la pantalla con su icono.
 */
export function stickerScale(
  distance: number,
  options: { readonly reference?: number; readonly min?: number; readonly max?: number } = {},
): number {
  const reference = options.reference ?? 8;
  const min = options.min ?? 0.45;
  const max = options.max ?? 1.6;

  if (!Number.isFinite(distance) || distance <= 0) return max;
  return Math.min(Math.max(reference / distance, min), max);
}

/* ------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------ */

export interface ModelHotspotProblem {
  readonly sceneId: string;
  readonly hotspotId: string;
  readonly message: string
  readonly severity: 'blocking' | 'warning';
}

export interface ModelRefs {
  /** Nombres de malla del modelo de cada escena, por identificador de escena. */
  readonly meshNames: ReadonlyMap<string, readonly string[]>;
}

/**
 * Problemas de los marcadores adheridos a un modelo.
 *
 * Dos casos importan y los dos se descubren tarde si no se avisan: un marcador
 * de superficie en una escena que no es de modelo —no hay dónde pegarlo— y uno
 * que apunta a una pieza que el modelo ya no tiene, porque el autor reexportó
 * el CAD y la malla cambió de nombre. El segundo es el frecuente.
 */
export function validateModelHotspots(
  scenes: readonly Scene[],
  refs: ModelRefs,
): ModelHotspotProblem[] {
  const problems: ModelHotspotProblem[] = [];

  for (const scene of scenes) {
    for (const hotspot of scene.hotspots) {
      if (hotspot.anchor.space !== 'modelSurface') continue;

      if (scene.kind !== 'model') {
        problems.push({
          sceneId: scene.id,
          hotspotId: hotspot.id,
          message: `«${hotspot.name}» está pegado a una pieza, pero «${scene.title}» no es una escena de modelo.`,
          severity: 'blocking',
        });
        continue;
      }

      const names = refs.meshNames.get(scene.id);
      // Sin lista de mallas no se puede juzgar: puede que el modelo aún no se
      // haya abierto en esta sesión. Callar es mejor que acusar en falso.
      if (names === undefined || names.length === 0) continue;

      if (!names.includes(hotspot.anchor.nodeName)) {
        problems.push({
          sceneId: scene.id,
          hotspotId: hotspot.id,
          message: `«${hotspot.name}» apunta a la pieza «${hotspot.anchor.nodeName}», que el modelo de «${scene.title}» ya no tiene.`,
          severity: 'blocking',
        });
      }
    }
  }

  return problems;
}

export const canPublishModelHotspots = (problems: readonly ModelHotspotProblem[]): boolean =>
  !problems.some((problem) => problem.severity === 'blocking');

/**
 * Marcadores de un modelo que llevan a una panorámica (L05).
 *
 * Se reconocen por su acción, no por un campo propio: así un marcador que
 * lleva a otra escena desde un modelo y uno que lo hace desde una panorámica
 * son la misma cosa, y el ejecutor de acciones no necesita saber de dónde
 * viene.
 */
export function panoramaLinksOf(scene: Scene): { hotspot: Hotspot; sceneId: string }[] {
  const links: { hotspot: Hotspot; sceneId: string }[] = [];

  for (const hotspot of scene.hotspots) {
    if (hotspot.anchor.space !== 'modelSurface') continue;
    for (const action of hotspot.actions) {
      if (action.config.type === 'goToScene') {
        links.push({ hotspot, sceneId: action.config.sceneId });
        break;
      }
    }
  }

  return links;
}

/** Esquema del par de coordenadas de pantalla que usa la capa de marcadores. */
export const screenPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  /** Profundidad normalizada; sirve para ordenar y para descartar lo de atrás. */
  depth: z.number().finite(),
});

export type ScreenPoint = z.infer<typeof screenPointSchema>;
