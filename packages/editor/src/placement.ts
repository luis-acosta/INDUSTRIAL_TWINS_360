/**
 * Colocación y edición de marcadores.
 *
 * Toda la aritmética de colocar, mover y ajustar marcadores vive aquí y no en
 * los componentes de React. El motivo es que es justo el código donde un error
 * no se ve: un marcador colocado medio grado a la izquierda parece bien en la
 * pantalla del autor y aparece sobre la tubería equivocada en la del cliente.
 * Separado, se comprueba con casos concretos.
 *
 * Convenios de coordenadas, que es donde está la dificultad:
 *
 *  - `yaw` crece hacia la derecha del observador, en radianes, y se normaliza
 *    a (-π, π].
 *  - `pitch` es positivo hacia arriba y se limita a [-π/2, π/2].
 *  - La cobertura de la panorámica puede ser parcial (una foto de 120° no es
 *    una esfera completa), y colocar fuera de la zona cubierta produce un
 *    marcador que flota sobre el vacío.
 */
import {
  angularDistance,
  clamp,
  clampPitch,
  degToRad,
  radToDeg,
  sphericalToVector,
  vectorToSpherical,
  wrapYaw,
  type Anchor,
  type PanoramaCoverage,
  type Spherical,
} from '@it360/domain';

/**
 * Punto en la esfera.
 *
 * Es el `Spherical` del dominio, con otro nombre local porque en el editor se
 * habla de «puntos» y no de coordenadas. La aritmética esférica —distancia
 * angular, conversión a vector— se reutiliza del dominio en lugar de
 * reescribirse: dos implementaciones de la misma fórmula divergen en el primer
 * ajuste y el síntoma aparece en el visor, no aquí.
 */
export type SphericalPoint = Spherical;

/* ------------------------------------------------------------------ *
 * Ajuste a guías
 * ------------------------------------------------------------------ */

export interface SnapSettings {
  /** Ajustar al horizonte cuando se está cerca, en grados. `0` desactiva. */
  readonly horizonToleranceDeg: number;
  /** Rejilla de azimut en grados. `0` desactiva. */
  readonly yawStepDeg: number;
  /** Rejilla de elevación en grados. `0` desactiva. */
  readonly pitchStepDeg: number;
}

export const DEFAULT_SNAP: SnapSettings = {
  // Tres grados: suficiente para que el ajuste ocurra cuando el autor quiere
  // alinear al horizonte, y poco para que no le robe el control cuando está
  // colocando un marcador deliberadamente algo por encima.
  horizonToleranceDeg: 3,
  yawStepDeg: 0,
  pitchStepDeg: 0,
};

/**
 * Ajusta un punto a las guías activas.
 *
 * El ajuste al horizonte tiene prioridad sobre la rejilla de elevación: si las
 * dos están activas y compiten, el autor que activó el ajuste al horizonte
 * quiere el horizonte, no el múltiplo de cinco grados más cercano.
 */
export function snapPoint(point: SphericalPoint, snap: SnapSettings = DEFAULT_SNAP): SphericalPoint {
  let { yaw, pitch } = point;

  if (snap.yawStepDeg > 0) {
    const step = degToRad(snap.yawStepDeg);
    yaw = Math.round(yaw / step) * step;
  }

  if (snap.horizonToleranceDeg > 0 && Math.abs(radToDeg(pitch)) <= snap.horizonToleranceDeg) {
    pitch = 0;
  } else if (snap.pitchStepDeg > 0) {
    const step = degToRad(snap.pitchStepDeg);
    pitch = Math.round(pitch / step) * step;
  }

  return { yaw: wrapYaw(yaw), pitch: clampPitch(pitch) };
}

/* ------------------------------------------------------------------ *
 * Límites de cobertura
 * ------------------------------------------------------------------ */

/** `true` si el punto cae dentro de la zona cubierta por la imagen. */
export function isWithinCoverage(point: SphericalPoint, coverage: PanoramaCoverage): boolean {
  const halfH = degToRad(coverage.horizontalDeg) / 2;
  const halfV = degToRad(coverage.verticalDeg) / 2;

  const dPitch = point.pitch - degToRad(coverage.centerPitch);
  if (Math.abs(dPitch) > halfV + 1e-9) return false;

  // Una cobertura de 360° no tiene límite horizontal: cualquier azimut vale, y
  // comparar contra el centro daría falsos negativos por el salto en ±π.
  if (coverage.horizontalDeg >= 360) return true;

  const dYaw = wrapYaw(point.yaw - degToRad(coverage.centerYaw));
  return Math.abs(dYaw) <= halfH + 1e-9;
}

/**
 * Lleva un punto al interior de la cobertura por el camino más corto.
 *
 * Se recorta en lugar de rechazar: el autor que arrastra un marcador más allá
 * del borde de una foto parcial espera que se quede en el borde, no que vuelva
 * de un salto a donde estaba.
 */
export function clampToCoverage(point: SphericalPoint, coverage: PanoramaCoverage): SphericalPoint {
  const halfV = degToRad(coverage.verticalDeg) / 2;
  const centerPitch = degToRad(coverage.centerPitch);
  const pitch = clamp(point.pitch, centerPitch - halfV, centerPitch + halfV);

  if (coverage.horizontalDeg >= 360) {
    return { yaw: wrapYaw(point.yaw), pitch: clampPitch(pitch) };
  }

  const halfH = degToRad(coverage.horizontalDeg) / 2;
  const centerYaw = degToRad(coverage.centerYaw);
  const offset = clamp(wrapYaw(point.yaw - centerYaw), -halfH, halfH);

  return { yaw: wrapYaw(centerYaw + offset), pitch: clampPitch(pitch) };
}

/* ------------------------------------------------------------------ *
 * Colocación
 * ------------------------------------------------------------------ */

export interface PlacementRequest {
  readonly point: SphericalPoint;
  readonly coverage: PanoramaCoverage;
  readonly snap?: SnapSettings;
  /** Marcadores existentes, para avisar de solapamiento. */
  readonly existing?: readonly Anchor[];
  /** Separación mínima deseable entre marcadores, en grados. */
  readonly minSeparationDeg?: number;
}

export interface PlacementResult {
  readonly anchor: Anchor;
  /** El punto pedido caía fuera de la imagen y se recortó. */
  readonly clamped: boolean;
  /** Identificadores de marcadores demasiado cerca, si se pidió comprobar. */
  readonly crowdedByDeg: number | null;
}

/**
 * Calcula el anclaje de un marcador nuevo.
 *
 * Devuelve información además del anclaje —si hubo recorte, si queda
 * amontonado— porque la interfaz debe poder avisar sin tener que repetir la
 * aritmética para averiguarlo.
 */
export function placeHotspot(request: PlacementRequest): PlacementResult {
  const snapped = snapPoint(request.point, request.snap ?? DEFAULT_SNAP);
  const inside = isWithinCoverage(snapped, request.coverage);
  const final = inside ? snapped : clampToCoverage(snapped, request.coverage);

  let crowdedByDeg: number | null = null;
  const minSeparation = request.minSeparationDeg ?? 0;

  if (minSeparation > 0 && request.existing !== undefined) {
    for (const anchor of request.existing) {
      if (anchor.space !== 'spherical') continue;
      const separation = radToDeg(angularDistance(final, anchor));
      if (separation < minSeparation && (crowdedByDeg === null || separation < crowdedByDeg)) {
        crowdedByDeg = separation;
      }
    }
  }

  return {
    anchor: { space: 'spherical', yaw: final.yaw, pitch: final.pitch },
    clamped: !inside,
    crowdedByDeg,
  };
}

/* ------------------------------------------------------------------ *
 * Arrastre
 * ------------------------------------------------------------------ */

export interface DragState {
  readonly start: SphericalPoint;
  readonly anchorStart: SphericalPoint;
}

/**
 * Nueva posición de un marcador que se arrastra.
 *
 * El desplazamiento se calcula en la esfera y no en píxeles de pantalla: a
 * medio camino del cenit, el mismo desplazamiento en píxeles equivale a muchos
 * más grados de azimut, y un marcador arrastrado allí se iría disparado.
 */
export function dragHotspot(
  drag: DragState,
  current: SphericalPoint,
  coverage: PanoramaCoverage,
  snap: SnapSettings = DEFAULT_SNAP,
): PlacementResult {
  const deltaYaw = wrapYaw(current.yaw - drag.start.yaw);
  const deltaPitch = current.pitch - drag.start.pitch;

  return placeHotspot({
    point: {
      yaw: wrapYaw(drag.anchorStart.yaw + deltaYaw),
      pitch: clampPitch(drag.anchorStart.pitch + deltaPitch),
    },
    coverage,
    snap,
  });
}

/* ------------------------------------------------------------------ *
 * Polígonos
 * ------------------------------------------------------------------ */

/**
 * Inserta un vértice en el segmento más cercano al punto pedido.
 *
 * Añadirlo siempre al final produce polígonos cruzados en cuanto el autor
 * quiere afinar un lado ya dibujado, que es lo normal al marcar el contorno de
 * un equipo.
 */
export function insertPolygonPoint(
  points: readonly SphericalPoint[],
  point: SphericalPoint,
): readonly SphericalPoint[] {
  if (points.length < 2) return [...points, point];

  let bestIndex = points.length;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;

    // Distancia al punto medio del segmento: una aproximación suficiente para
    // decidir dónde insertar, y sin la trigonometría de la distancia exacta a
    // un arco de círculo máximo, que aquí no aporta nada.
    const middle = {
      yaw: wrapYaw(a.yaw + wrapYaw(b.yaw - a.yaw) / 2),
      pitch: (a.pitch + b.pitch) / 2,
    };
    const distance = angularDistance(point, middle);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i + 1;
    }
  }

  return [...points.slice(0, bestIndex), point, ...points.slice(bestIndex)];
}

/**
 * Comprueba si un polígono es válido para publicar.
 *
 * Un polígono de menos de tres vértices no encierra nada, y uno con vértices
 * duplicados consecutivos produce artefactos de triangulación al dibujarse.
 */
export function validatePolygon(points: readonly SphericalPoint[]): {
  readonly valid: boolean;
  readonly reason: string | null;
} {
  if (points.length < 3) {
    return { valid: false, reason: 'Un polígono necesita al menos tres vértices.' };
  }

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    if (angularDistance(a, b) < degToRad(0.05)) {
      return {
        valid: false,
        reason: `Los vértices ${i + 1} y ${((i + 1) % points.length) + 1} están en el mismo punto.`,
      };
    }
  }

  return { valid: true, reason: null };
}

/**
 * Centro aproximado de un polígono esférico.
 *
 * Se promedian los vectores unitarios y se normaliza el resultado, en lugar de
 * promediar ángulos: el promedio de 179° y -179° es 0° con ángulos, y 180° con
 * vectores, que es el correcto.
 */
export function polygonCenter(points: readonly SphericalPoint[]): SphericalPoint {
  if (points.length === 0) return { yaw: 0, pitch: 0 };

  let x = 0;
  let y = 0;
  let z = 0;

  for (const point of points) {
    const vector = sphericalToVector(point);
    x += vector.x;
    y += vector.y;
    z += vector.z;
  }

  const length = Math.hypot(x, y, z);
  // Vértices diametralmente opuestos se cancelan y no hay centro definido.
  // Devolver el origen sería inventar una dirección; se devuelve el primer
  // vértice, que al menos está en el polígono.
  if (length < 1e-9) return points[0] ?? { yaw: 0, pitch: 0 };

  return vectorToSpherical({ x: x / length, y: y / length, z: z / length });
}
