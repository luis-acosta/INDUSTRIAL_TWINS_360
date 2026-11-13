/**
 * Edición de la geometría de un marcador (etapa 02: D01–D11, D15).
 *
 * El esquema admite seis formas; cambiar entre ellas y editar sus vértices es
 * donde se pierde trabajo del autor, así que las reglas viven aquí y no en la
 * pantalla:
 *
 *  - **Cambiar de forma conserva lo que se pueda y avisa de lo que no.** Un
 *    polígono de veinte vértices convertido en icono no puede guardar el
 *    contorno; lo que sí puede es colocar el icono en su centro, en lugar de
 *    dejarlo en el origen de la panorámica a media escena de distancia.
 *  - **Un polígono no baja de tres vértices.** Con dos no encierra nada y el
 *    visor no podría dibujarlo ni detectar la pulsación; el esquema lo
 *    rechazaría al guardar, que es el peor momento para enterarse.
 *  - **Una imagen proyectada necesita cuatro esquinas con área.** Cuatro
 *    puntos alineados no definen una proyección, y el resultado sería una
 *    imagen invisible sin ningún mensaje de error.
 *  - **La costura de la panorámica es real.** `u = 0` y `u = 1` son el mismo
 *    meridiano, así que un polígono puede cruzarla legítimamente y moverse un
 *    vértice a través de ella no debe deformarlo.
 */
import {
  hotspotGeometrySchema,
  type HotspotGeometry,
  type HotspotShape,
} from './hotspot';
import { sphericalToUv, uvToSpherical, type Spherical, type Uv } from './coordinates';
import { domainError, err, ok, type Result } from './result';
import type { Uuid } from './identity';

/* ------------------------------------------------------------------ *
 * Centro de una geometría
 * ------------------------------------------------------------------ */

/**
 * Punto representativo de la geometría, en UV.
 *
 * Es lo que se conserva al cambiar de forma: sin él, convertir un polígono en
 * icono dejaría el icono en una esquina de la panorámica y el autor tendría
 * que volver a buscarlo.
 */
export function geometryCenterUv(geometry: HotspotGeometry, anchor: Spherical): Uv {
  switch (geometry.shape) {
    case 'polygon':
      return centroid(geometry.points);
    case 'projectedImage':
      return centroid(geometry.corners);
    default:
      return sphericalToUv(anchor);
  }
}

/**
 * Centro de un conjunto de puntos UV, teniendo en cuenta la costura.
 *
 * La media aritmética de `u` falla cuando el contorno cruza `u = 0`: un
 * polígono con vértices en 0,98 y 0,02 tiene su centro en la costura, no en
 * 0,5, que es el punto diametralmente opuesto. La media circular lo resuelve.
 */
export function centroid(points: readonly Uv[]): Uv {
  if (points.length === 0) return { u: 0.5, v: 0.5 };

  let x = 0;
  let y = 0;
  let v = 0;

  for (const point of points) {
    const angle = point.u * Math.PI * 2;
    x += Math.cos(angle);
    y += Math.sin(angle);
    v += point.v;
  }

  const mean = Math.atan2(y / points.length, x / points.length);
  const u = ((mean / (Math.PI * 2)) % 1 + 1) % 1;

  return { u, v: v / points.length };
}

/* ------------------------------------------------------------------ *
 * Cambio de forma
 * ------------------------------------------------------------------ */

/** Lo que se pierde al cambiar de forma, para poder decirlo antes. */
export interface ShapeChangePlan {
  readonly from: HotspotShape;
  readonly to: HotspotShape;
  /** Geometría resultante, ya válida. */
  readonly geometry: HotspotGeometry;
  /** Qué deja de existir, en palabras del autor. */
  readonly losses: readonly string[];
  /** La nueva forma exige un medio que hay que elegir. */
  readonly needsMedia: boolean;
}

const LOSS_BY_SHAPE: Readonly<Record<HotspotShape, string>> = {
  icon: 'el icono y su tamaño',
  text: 'el texto y su anchura',
  polygon: 'el contorno y sus vértices',
  projectedImage: 'las cuatro esquinas de la imagen',
  webframe: 'la dirección web y su tamaño',
  model: 'el modelo y su escala',
};

/**
 * Plan de cambio de forma.
 *
 * `mediaId` se usa cuando la forma de destino exige un medio: una imagen
 * proyectada o un modelo sin medio no se pueden representar, y el esquema los
 * rechaza. Si no se da uno, el plan lo pide en lugar de inventar un
 * identificador que apuntaría a nada.
 */
export function planShapeChange(
  geometry: HotspotGeometry,
  to: HotspotShape,
  anchor: Spherical,
  mediaId: Uuid | null = null,
): Result<ShapeChangePlan> {
  if (geometry.shape === to) {
    return ok({ from: to, to, geometry, losses: [], needsMedia: false });
  }

  const center = geometryCenterUv(geometry, anchor);
  const losses = [LOSS_BY_SHAPE[geometry.shape]];

  switch (to) {
    case 'icon':
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({ shape: 'icon', mediaId }),
        losses,
        needsMedia: false,
      });

    case 'text':
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({ shape: 'text', template: 'Texto del marcador' }),
        losses,
        needsMedia: false,
      });

    case 'polygon':
      // Un cuadrado alrededor del centro: un polígono vacío no existe y pedir
      // al autor que coloque tres vértices antes de ver nada es peor que
      // darle uno que pueda mover.
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({
          shape: 'polygon',
          points: squareAround(center, 0.04),
        }),
        losses,
        needsMedia: false,
      });

    case 'projectedImage': {
      if (mediaId === null) {
        return err(
          domainError('VALIDATION_FAILED', 'Una imagen proyectada necesita una imagen', {
            recovery: 'Elija la imagen antes de cambiar la forma del marcador.',
          }),
        );
      }
      const square = squareAround(center, 0.06);
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({
          shape: 'projectedImage',
          mediaId,
          corners: [square[0], square[1], square[2], square[3]],
        }),
        losses,
        needsMedia: false,
      });
    }

    case 'webframe':
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({
          shape: 'webframe',
          url: 'https://ejemplo.invalid/',
        }),
        losses,
        needsMedia: false,
      });

    case 'model': {
      if (mediaId === null) {
        return err(
          domainError('VALIDATION_FAILED', 'Un marcador de modelo necesita un archivo 3D', {
            recovery: 'Elija el modelo antes de cambiar la forma del marcador.',
          }),
        );
      }
      return ok({
        from: geometry.shape,
        to,
        geometry: hotspotGeometrySchema.parse({ shape: 'model', mediaId }),
        losses,
        needsMedia: false,
      });
    }

    default: {
      const exhaustive: never = to;
      throw new Error(`Forma de marcador no contemplada: ${String(exhaustive)}`);
    }
  }
}

/** Formas que exigen elegir un medio antes de poder usarse. */
export const shapeNeedsMedia = (shape: HotspotShape): boolean =>
  shape === 'projectedImage' || shape === 'model';

/** Cuadrado centrado en un punto, en orden SI, SD, ID, II. */
function squareAround(center: Uv, half: number): [Uv, Uv, Uv, Uv] {
  const left = wrapU(center.u - half);
  const right = wrapU(center.u + half);
  const top = clamp01(center.v - half);
  const bottom = clamp01(center.v + half);

  return [
    { u: left, v: top },
    { u: right, v: top },
    { u: right, v: bottom },
    { u: left, v: bottom },
  ];
}

/* ------------------------------------------------------------------ *
 * Vértices de un polígono (D03, D11)
 * ------------------------------------------------------------------ */

/**
 * Inserta un vértice en el lado más cercano al punto dado.
 *
 * Añadir siempre al final produce contornos cruzados: el vértice nuevo une el
 * último con el primero y el polígono se dobla sobre sí mismo. Insertarlo en
 * el lado más próximo es lo que hace cualquier editor de contornos y lo que el
 * autor espera al pulsar sobre una arista.
 */
export function insertVertex(points: readonly Uv[], point: Uv): Uv[] {
  if (points.length < 2) return [...points, point];

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Uv;
    const b = points[(i + 1) % points.length] as Uv;
    const distance = distanceToSegment(point, a, b);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i + 1;
    }
  }

  return [...points.slice(0, bestIndex), point, ...points.slice(bestIndex)];
}

/** Mueve un vértice. Fuera de rango, el contorno se devuelve intacto. */
export function moveVertex(points: readonly Uv[], index: number, to: Uv): Uv[] {
  if (index < 0 || index >= points.length) return [...points];
  return points.map((point, i) => (i === index ? { u: wrapU(to.u), v: clamp01(to.v) } : point));
}

/**
 * Quita un vértice, salvo que sea el tercero.
 *
 * Con dos vértices el polígono no encierra nada: el visor no lo dibujaría ni
 * detectaría la pulsación, y el esquema lo rechazaría al guardar. Se devuelve
 * un error con el motivo en lugar de dejar que falle después.
 */
export function removeVertex(points: readonly Uv[], index: number): Result<Uv[]> {
  if (index < 0 || index >= points.length) {
    return err(domainError('NOT_FOUND', 'Ese vértice no existe'));
  }

  if (points.length <= 3) {
    return err(
      domainError('VALIDATION_FAILED', 'Un polígono necesita al menos tres vértices', {
        recovery: 'Mueva los vértices existentes o cambie la forma del marcador.',
      }),
    );
  }

  return ok(points.filter((_, i) => i !== index));
}

/** Invierte el contorno: la zona activa pasa a ser todo lo de fuera (D11). */
export function invertPolygon(geometry: HotspotGeometry): HotspotGeometry {
  if (geometry.shape !== 'polygon') return geometry;
  return { ...geometry, inverted: !geometry.inverted };
}

/** Problema de un contorno que el autor debería ver antes de publicar. */
export interface PolygonProblem {
  readonly message: string;
  readonly severity: 'blocking' | 'advisory';
}

/**
 * Revisa un contorno.
 *
 * El área nula y los vértices alineados son dos cosas distintas, y confundirlas
 * da un mensaje falso. Un contorno en forma de lazo —dos lóbulos simétricos—
 * tiene área con signo **cero** porque los lóbulos se cancelan, y sus vértices
 * no están alineados en absoluto: decirle al autor que lo están lo mandaría a
 * buscar un problema que no existe. Por eso la alineación se comprueba por sí
 * misma y el área sólo bloquea cuando el contorno no se cruza.
 *
 * El cruce consigo mismo es un aviso, no un bloqueo: el visor lo dibuja, pero
 * qué queda dentro y qué fuera depende de la regla de relleno y el autor casi
 * nunca quiere eso.
 */
export function validatePolygon(points: readonly Uv[]): PolygonProblem[] {
  const problems: PolygonProblem[] = [];

  if (points.length < 3) {
    problems.push({ message: 'Necesita al menos tres vértices', severity: 'blocking' });
    return problems;
  }

  if (isCollinear(points)) {
    problems.push({
      message: 'Los vértices están alineados: el marcador no se podría pulsar',
      severity: 'blocking',
    });
    return problems;
  }

  const crossed = hasSelfIntersection(points);

  if (crossed) {
    problems.push({ message: 'El contorno se cruza consigo mismo', severity: 'advisory' });
  } else if (Math.abs(signedArea(points)) < 1e-6) {
    // Sin cruces, un área nula sólo puede venir de un contorno degenerado:
    // vértices repetidos o una astilla sin superficie que pulsar.
    problems.push({
      message: 'El contorno no encierra superficie: el marcador no se podría pulsar',
      severity: 'blocking',
    });
  }

  return problems;
}

/**
 * Todos los vértices sobre una misma recta.
 *
 * Se mide con el producto cruzado respecto a los dos primeros vértices
 * distintos, sobre `u` desenrollado para que la costura no invente una
 * desviación donde no la hay.
 */
export function isCollinear(points: readonly Uv[]): boolean {
  if (points.length < 3) return true;

  const reference = points[0] as Uv;
  const base = unwrapped(reference, reference);

  // Primer vértice que no coincide con el de referencia: define la recta.
  let direction: Point2 | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const candidate = unwrapped(points[i] as Uv, reference);
    if (Math.hypot(candidate.x - base.x, candidate.y - base.y) > 1e-9) {
      direction = candidate;
      break;
    }
  }

  // Todos los vértices en el mismo punto: no hay recta, pero tampoco área.
  if (direction === null) return true;

  for (const point of points) {
    const p = unwrapped(point, reference);
    if (Math.abs(cross(base, direction, p)) > 1e-9) return false;
  }

  return true;
}

export const canSavePolygon = (problems: readonly PolygonProblem[]): boolean =>
  !problems.some((problem) => problem.severity === 'blocking');

/** Área con signo del contorno; el signo indica el sentido de giro. */
export function signedArea(points: readonly Uv[]): number {
  let total = 0;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Uv;
    const b = points[(i + 1) % points.length] as Uv;
    // Se trabaja sobre `u` desenrollado respecto al primer vértice para que un
    // contorno que cruza la costura no produzca un área enorme y falsa.
    total += unwrapU(a.u, points[0]!.u) * b.v - unwrapU(b.u, points[0]!.u) * a.v;
  }

  return total / 2;
}

function hasSelfIntersection(points: readonly Uv[]): boolean {
  const n = points.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Los lados contiguos comparten un vértice: tocarse ahí no es cruzarse.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const a1 = unwrapped(points[i] as Uv, points[0] as Uv);
      const a2 = unwrapped(points[(i + 1) % n] as Uv, points[0] as Uv);
      const b1 = unwrapped(points[j] as Uv, points[0] as Uv);
      const b2 = unwrapped(points[(j + 1) % n] as Uv, points[0] as Uv);
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Esquinas de una imagen proyectada (D05)
 * ------------------------------------------------------------------ */

export type Corners = readonly [Uv, Uv, Uv, Uv];

export const CORNER_LABELS: readonly string[] = [
  'superior izquierda',
  'superior derecha',
  'inferior derecha',
  'inferior izquierda',
];

/**
 * Mueve una esquina, rechazando el resultado si deja la imagen sin área.
 *
 * Cuatro puntos alineados no definen una proyección: la imagen desaparecería
 * sin que nada lo explicase.
 */
export function moveCorner(corners: Corners, index: number, to: Uv): Result<Corners> {
  if (index < 0 || index > 3) {
    return err(domainError('NOT_FOUND', 'Esa esquina no existe'));
  }

  const next = corners.map((corner, i) =>
    i === index ? { u: wrapU(to.u), v: clamp01(to.v) } : corner,
  ) as unknown as Corners;

  if (Math.abs(signedArea(next)) < 1e-6) {
    return err(
      domainError('VALIDATION_FAILED', 'Las cuatro esquinas quedarían alineadas', {
        recovery: 'La imagen proyectada necesita cuatro esquinas que encierren superficie.',
      }),
    );
  }

  return ok(next);
}

/** Devuelve las esquinas a un rectángulo centrado en el mismo punto. */
export function resetCorners(corners: Corners): Corners {
  const center = centroid(corners);
  return squareAround(center, 0.06);
}

/* ------------------------------------------------------------------ *
 * Transformación en tres ejes (D08, D09)
 * ------------------------------------------------------------------ */

export const AXIS_LABELS = {
  roll: 'Giro en el plano de la vista',
  tilt: 'Inclinación',
  spin: 'Giro sobre su eje vertical',
} as const;

export type Axis = keyof typeof AXIS_LABELS;

/**
 * Si la rotación de un eje se va a notar.
 *
 * Un marcador «de frente» (billboard) siempre mira al observador, así que
 * inclinarlo o girarlo sobre su eje vertical no cambia nada de lo que se ve.
 * Ofrecer esos controles sin decirlo deja al autor moviendo mandos que no
 * hacen nada y concluyendo que la aplicación está rota.
 */
export function axisAffectsRender(axis: Axis, projection: string): boolean {
  if (projection === 'billboard') return axis === 'roll';
  return true;
}

/* Grados y radianes ya se convierten en `coordinates`: la interfaz habla en
   grados y el modelo guarda radianes, y duplicar la conversión aquí abriría la
   puerta a dos definiciones que se separan. */

/* ------------------------------------------------------------------ *
 * Iconos animados (D15)
 * ------------------------------------------------------------------ */

/**
 * Si un medio sirve como icono animado.
 *
 * APNG viaja dentro de un `image/png`: el mime no lo distingue de una imagen
 * fija, así que se mira el nombre, que es lo que el autor reconoce. El GIF se
 * admite por lo mismo que existe el requisito —un icono que late llama la
 * atención— aunque su paleta sea pobre.
 */
export function isAnimatedIconCandidate(media: {
  readonly mime: string;
  readonly originalName: string;
}): boolean {
  if (media.mime === 'image/apng') return true;
  if (media.mime === 'image/gif') return true;
  return media.mime === 'image/png' && /\.apng$/i.test(media.originalName);
}

/* ------------------------------------------------------------------ *
 * Conversión de coordenadas para la pantalla
 * ------------------------------------------------------------------ */

/** Punto UV del ancla, para dibujar el vértice sobre la panorámica. */
export const anchorUv = (anchor: Spherical): Uv => sphericalToUv(anchor);

/** Ancla esférica de un punto UV, al arrastrar sobre la panorámica. */
export const uvAnchor = (uv: Uv): Spherical => uvToSpherical(uv);

/* ------------------------------------------------------------------ *
 * Utilidades internas
 * ------------------------------------------------------------------ */

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** Envuelve `u` al rango [0,1): la costura de la panorámica es continua. */
const wrapU = (u: number): number => ((u % 1) + 1) % 1;

/**
 * `u` expresado en el entorno continuo de una referencia.
 *
 * Con referencia 0,98 y valor 0,02, devuelve 1,02: así la distancia entre
 * ambos es 0,04 y no 0,96, que es lo que haría pensar que están en lados
 * opuestos de la panorámica.
 */
function unwrapU(u: number, reference: number): number {
  const delta = u - reference;
  if (delta > 0.5) return u - 1;
  if (delta < -0.5) return u + 1;
  return u;
}

interface Point2 {
  readonly x: number;
  readonly y: number;
}

const unwrapped = (point: Uv, reference: Uv): Point2 => ({
  x: unwrapU(point.u, reference.u),
  y: point.v,
});

function distanceToSegment(point: Uv, a: Uv, b: Uv): number {
  const p = unwrapped(point, a);
  const pa = unwrapped(a, a);
  const pb = unwrapped(b, a);

  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.hypot(p.x - pa.x, p.y - pa.y);

  const t = Math.min(Math.max(((p.x - pa.x) * dx + (p.y - pa.y) * dy) / lengthSq, 0), 1);
  return Math.hypot(p.x - (pa.x + t * dx), p.y - (pa.y + t * dy));
}

const cross = (o: Point2, a: Point2, b: Point2): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function segmentsCross(a1: Point2, a2: Point2, b1: Point2, b2: Point2): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);

  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
