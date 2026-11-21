/**
 * Calcomanías de los puntos de interés sobre la geometría (L07).
 *
 * Lo que faltaba de L07: el marcador seguía a su pieza, giraba con ella y se
 * escondía cuando quedaba detrás de la geometría, pero se dibujaba **de pie
 * frente a la cámara**, así que no parecía pegado a nada. En una válvula vista
 * de lado, el marcador flotaba al aire y el visitante no sabía a qué pieza se
 * refería.
 *
 * Esto dibuja dentro de la escena un disco tumbado sobre la superficie, en el
 * punto del anclaje y con su orientación. Con eso, mirar la pieza de lado
 * muestra la calcomanía de canto —como una pegatina— en lugar de un rótulo
 * flotando.
 *
 * **El marcador del DOM sigue encima y no se sustituye.** Es la decisión que
 * gobierna este módulo: el texto del punto de interés, su acceso por teclado y
 * su lectura por un lector de pantalla viven en el DOM. Dibujar el texto dentro
 * de la escena lo convertiría en una textura —no se puede seleccionar, no la lee
 * nadie y no se llega con el tabulador—, y perder eso para ganar una sombra no
 * es un cambio que merezca la pena. La calcomanía da el anclaje visual; el
 * marcador, la información.
 */

import {
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Object3D,
  type Vector3,
} from 'three';

import { anchorWorldPosition, decalTransform } from './model-hotspots';

/**
 * Anclaje sobre la superficie, con la forma exacta que guarda el contrato.
 *
 * Se declara aquí en lugar de repetir sus campos: una copia a mano de la forma
 * del anclaje se queda desfasada en cuanto el contrato gane un campo, y el
 * síntoma sería una calcomanía colocada con datos incompletos.
 */
type ModelSurfaceAnchor = Parameters<typeof anchorWorldPosition>[1];

/** Segmentos del disco: a este tamaño en pantalla, 24 ya se ve redondo. */
const SEGMENTS = 24;

/** Opacidad del relleno. El borde va opaco, porque es lo que define la forma. */
const FILL_OPACITY = 0.35;

export interface DecalInput {
  readonly id: string;
  /** Anclaje sobre la superficie del modelo, tal como lo guarda el proyecto. */
  readonly anchor: ModelSurfaceAnchor;
  /** Color del punto de interés, en hexadecimal. */
  readonly color: string;
}

export interface DecalSet {
  readonly group: Group;
  /** Recoloca las calcomanías; se llama cuando el modelo o sus piezas se mueven. */
  update(root: Object3D, modelSize: number): void;
  dispose(): void;
}

/**
 * Crea el grupo de calcomanías de una escena de modelo.
 *
 * Un grupo y no objetos sueltos: así la escena los añade y los quita de una
 * vez, y al cambiar de escena no queda ninguno olvidado dibujándose sobre el
 * modelo siguiente.
 */
export function createDecals(hotspots: readonly DecalInput[]): DecalSet {
  const group = new Group();
  group.name = 'it360-decals';

  const entries = hotspots.map((hotspot) => {
    const color = new Color(hotspot.color);

    const fill = new Mesh(
      new CircleGeometry(0.5, SEGMENTS),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: FILL_OPACITY,
        /* Se dibuja por las dos caras: una calcomanía en la cara interior de
           una carcasa abierta se vería desaparecer al rodearla, y el visitante
           pensaría que el punto de interés se ha perdido. */
        side: DoubleSide,
        /* Con prueba de profundidad: es lo que hace que la geometría la tape
           de verdad, en lugar de aproximarlo con un rayo como hace el marcador
           del DOM. Aquí sale gratis y es exacto. */
        depthTest: true,
        /* Sin escribir profundidad: una calcomanía translúcida que escribiera
           en el búfer taparía lo que está detrás de ella y se vería un agujero
           en la pieza. */
        depthWrite: false,
      }),
    );

    const ring = new Mesh(
      new RingGeometry(0.46, 0.5, SEGMENTS),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: DoubleSide,
        depthTest: true,
        depthWrite: false,
      }),
    );

    const node = new Group();
    node.name = `it360-decal-${hotspot.id}`;
    node.add(fill, ring);
    /* Por encima del modelo en el orden de dibujado: con la misma prioridad,
       el orden depende de cómo el motor ordene la escena y la calcomanía
       parpadearía según el ángulo. */
    fill.renderOrder = 2;
    ring.renderOrder = 3;
    group.add(node);

    return { hotspot, node, fill, ring };
  });

  return {
    group,

    update(root, modelSize) {
      for (const entry of entries) {
        const placed = anchorWorldPosition(root, entry.hotspot.anchor);
        if (placed === null) {
          /* La pieza no está en este modelo —el autor cambió el archivo y el
             anclaje quedó huérfano—. Se oculta en lugar de dibujarla en el
             origen, que es lo que haría al dejarla sin posición: una
             calcomanía en el centro del modelo parece un defecto del modelo. */
          entry.node.visible = false;
          continue;
        }

        const transform = decalTransform(placed.point, placed.normal, modelSize);
        entry.node.visible = true;
        entry.node.position.copy(transform.position);
        entry.node.quaternion.copy(transform.quaternion);
        entry.node.scale.setScalar(transform.size);
      }
    },

    dispose() {
      for (const entry of entries) {
        entry.fill.geometry.dispose();
        entry.fill.material.dispose();
        entry.ring.geometry.dispose();
        entry.ring.material.dispose();
      }
      group.removeFromParent();
      group.clear();
    },
  };
}

/**
 * Tamaño del modelo con el que escalar las calcomanías.
 *
 * Es el diámetro de su esfera envolvente. Se usa eso y no la altura porque un
 * modelo de tubería es largo y bajo: con la altura, sus calcomanías saldrían
 * diminutas.
 */
export function modelSizeFor(bounds: { readonly radius: number } | null): number {
  return bounds === null ? 1 : Math.max(bounds.radius * 2, 1e-6);
}

/** Posición del anclaje en el mundo, para quien sólo necesite el punto. */
export const decalPoint = (
  root: Object3D,
  anchor: DecalInput['anchor'],
): Vector3 | null => anchorWorldPosition(root, anchor)?.point ?? null;

/**
 * Resuelve un color que puede venir como variable CSS.
 *
 * Los marcadores del DOM se pintan con las variables del sistema de diseño
 * —`var(--it-color-status-alarm)`— y Three no sabe leerlas: necesita un color
 * concreto. Resolverlo aquí es lo que mantiene la calcomanía y su marcador del
 * mismo color, incluido el acento de la marca del cliente, que se inyecta en el
 * documento en tiempo de ejecución.
 *
 * Si no se puede resolver —sin documento, o una variable que no existe— se
 * devuelve la reserva. Un color sin resolver llegaría a Three como texto
 * inválido: `Color` lo rechaza con una advertencia y pinta de blanco, y una
 * calcomanía blanca sobre una pieza clara es una calcomanía invisible.
 */
export function resolveColor(
  value: string,
  fallback = '#4ec4d2',
  doc: Document | undefined = globalThis.document,
): string {
  const text = value.trim();
  if (!text.startsWith('var(')) return text.length > 0 ? text : fallback;

  const name = text.slice(4, text.indexOf(')') === -1 ? undefined : text.indexOf(')')).trim();
  if (doc === undefined) return fallback;

  const resolved = globalThis
    .getComputedStyle?.(doc.documentElement)
    ?.getPropertyValue(name)
    ?.trim();

  return resolved !== undefined && resolved.length > 0 ? resolved : fallback;
}
