/**
 * Planos, zonas y radar de orientación (G01–G05).
 *
 * El plano es la pieza que convierte un recorrido en algo que se entiende: una
 * planta industrial sin plano es una sucesión de salas que podrían estar en
 * cualquier orden. Lo que el visitante necesita del plano son tres cosas:
 * dónde está, hacia dónde mira y adónde puede ir.
 *
 * El rumbo es la parte delicada. Hay tres sistemas de referencia en juego y
 * confundirlos deja el radar apuntando al sitio equivocado, que es peor que no
 * tenerlo: el visitante se fía y se desorienta.
 *
 *  - El **yaw de la cámara**, en radianes, cero mirando al centro de la
 *    panorámica y creciendo como lo haga el visor.
 *  - El **norte de la escena** (`sceneNorthOffsetRad`): cuánto hay que girar
 *    el yaw para que coincida con el norte real.
 *  - El **norte del plano** (`northRad`): cuánto está girada la imagen del
 *    plano respecto al norte real, porque un plano impreso casi nunca tiene el
 *    norte arriba.
 *
 * Y, por encima de todo, la orientación propia de cada punto del plano
 * (`headingRad`), que recoge que dos panorámicas tomadas en la misma sala
 * pueden tener el cero del yaw mirando a lados distintos.
 */
import { planMarkerSchema, planSchema, type Plan, type PlanMarker } from './scene';
import { newUuid } from './identity';
import type { CameraView } from './coordinates';

/** Normaliza un ángulo al intervalo [0, 2π). */
export const normalizeAngle = (rad: number): number => {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
};

export const radToDegrees = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Rumbo de la vista sobre el plano, en radianes desde el norte del plano.
 *
 * Cero apunta hacia arriba en la imagen del plano, y crece en el sentido de
 * las agujas del reloj, que es como se leen los rumbos.
 */
export function planBearing(
  view: CameraView,
  plan: Plan,
  marker: PlanMarker | null = null,
): number {
  const sceneHeading = marker?.headingRad ?? 0;
  return normalizeAngle(
    view.yaw + sceneHeading + plan.orientation.sceneNorthOffsetRad - plan.orientation.northRad,
  );
}

/** Rumbo en grados enteros, para mostrarlo al visitante. */
export const planBearingDegrees = (
  view: CameraView,
  plan: Plan,
  marker: PlanMarker | null = null,
): number => Math.round(radToDegrees(planBearing(view, plan, marker))) % 360;

/* ------------------------------------------------------------------ *
 * Radar (G04, G05)
 * ------------------------------------------------------------------ */

export interface RadarCone {
  /** Rumbo central, en grados sobre el plano. */
  readonly bearingDeg: number;
  /** Apertura total del cono, en grados. */
  readonly apertureDeg: number;
  /** Borde inicial del cono, en grados. */
  readonly startDeg: number;
  /** Borde final del cono, en grados. */
  readonly endDeg: number;
}

/** Relación de aspecto que se supone cuando no se declara la del visor. */
export const DEFAULT_VIEWPORT_ASPECT = 16 / 9;

/**
 * Campo de visión horizontal a partir del vertical.
 *
 * La cámara declara el vertical, que es lo que usa la proyección en
 * perspectiva; el cono del plano se dibuja sobre el suelo y necesita el
 * horizontal, que en una ventana apaisada es bastante más ancho. Un cono
 * dibujado con el vertical dice que el visitante ve menos de lo que ve.
 */
export function horizontalFov(verticalFovDeg: number, aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return verticalFovDeg;
  const halfVertical = (verticalFovDeg * Math.PI) / 360;
  return (Math.atan(Math.tan(halfVertical) * aspect) * 360) / Math.PI;
}

/**
 * Cono que representa hacia dónde mira el visitante.
 *
 * La apertura la fija el autor, pero se acota al campo de visión real cuando
 * éste es menor: un cono de sesenta grados mientras el visitante tiene el zoom
 * puesto en veinte dice que ve el triple de lo que ve.
 *
 * La comparación se hace contra el campo **horizontal**, no contra el `fov` de
 * la cámara, que es vertical. Compararla con el vertical estrecharía el cono
 * casi a la mitad en una ventana apaisada —75° verticales son unos 110°
 * horizontales a 16:9— y el visitante se fía del cono.
 */
export function radarCone(
  view: CameraView,
  plan: Plan,
  marker: PlanMarker | null = null,
  aspect: number = DEFAULT_VIEWPORT_ASPECT,
): RadarCone {
  const bearingDeg = normalizeAngle(planBearing(view, plan, marker)) * (180 / Math.PI);
  const apertureDeg = Math.min(plan.radarApertureDeg, horizontalFov(view.fov, aspect));
  const half = apertureDeg / 2;

  return {
    bearingDeg,
    apertureDeg,
    startDeg: bearingDeg - half,
    endDeg: bearingDeg + half,
  };
}

/**
 * Puntos del cono en coordenadas del plano, para dibujarlo.
 *
 * Se devuelven en fracción (0-1) del ancho y alto del plano, igual que la
 * posición de los marcadores, de modo que quien dibuje no tenga que conocer el
 * tamaño de la imagen. El arco se aproxima con segmentos: a esta escala, más
 * de una docena no se distinguen de una curva.
 */
export function radarConePoints(
  cone: RadarCone,
  origin: { readonly x: number; readonly y: number },
  radius: number,
  segments = 12,
): { readonly x: number; readonly y: number }[] {
  const points = [origin];
  const steps = Math.max(2, Math.round(segments));

  for (let i = 0; i <= steps; i += 1) {
    const deg = cone.startDeg + ((cone.endDeg - cone.startDeg) * i) / steps;
    // Cero hacia arriba y crecimiento horario: por eso seno para la x y menos
    // coseno para la y, y no al revés.
    const rad = (deg * Math.PI) / 180;
    points.push({ x: origin.x + Math.sin(rad) * radius, y: origin.y - Math.cos(rad) * radius });
  }

  return points;
}

/* ------------------------------------------------------------------ *
 * Zonas y pisos (G03)
 * ------------------------------------------------------------------ */

export interface PlanFloor {
  /** Nombre de la zona o piso; vacío para los planos sin agrupar. */
  readonly floor: string;
  readonly order: number;
  readonly plans: readonly Plan[];
}

/**
 * Agrupa los planos por zona o piso.
 *
 * El orden lo fija `floorOrder` y no el alfabeto: «Planta baja» va antes que
 * «Planta 1» en una planta industrial, y ningún orden alfabético acierta con
 * eso. Los planos sin zona quedan en un grupo sin nombre, al final, porque son
 * los de un proyecto que todavía no está organizado y no deben desplazar a los
 * que sí lo están.
 */
export function groupPlansByFloor(plans: readonly Plan[]): PlanFloor[] {
  const groups = new Map<string, Plan[]>();

  for (const plan of plans) {
    const existing = groups.get(plan.floor);
    if (existing === undefined) groups.set(plan.floor, [plan]);
    else existing.push(plan);
  }

  return [...groups.entries()]
    .map(([floor, grouped]) => ({
      floor,
      order: Math.min(...grouped.map((p) => p.floorOrder)),
      plans: [...grouped].sort((a, b) => a.floorOrder - b.floorOrder || a.name.localeCompare(b.name, 'es')),
    }))
    .sort((a, b) => {
      // Sin nombre, al final.
      if (a.floor === '' && b.floor !== '') return 1;
      if (b.floor === '' && a.floor !== '') return -1;
      return a.order - b.order || a.floor.localeCompare(b.floor, 'es');
    });
}

/**
 * Plano donde está una escena.
 *
 * Una escena puede aparecer en varios planos —una pasarela que cruza dos
 * zonas—; se devuelve el primero por orden de piso, que es el que el visitante
 * espera ver al abrir el plano desde esa escena.
 */
export function planForScene(
  plans: readonly Plan[],
  markers: readonly PlanMarker[],
  sceneId: string,
): Plan | null {
  const planIds = new Set(markers.filter((m) => m.sceneId === sceneId).map((m) => m.planId));
  if (planIds.size === 0) return null;

  for (const group of groupPlansByFloor(plans)) {
    for (const plan of group.plans) {
      if (planIds.has(plan.id)) return plan;
    }
  }

  return null;
}

/** Punto del plano que corresponde a una escena, si lo hay. */
export const markerForScene = (
  markers: readonly PlanMarker[],
  planId: string,
  sceneId: string,
): PlanMarker | null =>
  markers.find((m) => m.planId === planId && m.sceneId === sceneId) ?? null;

/* ------------------------------------------------------------------ *
 * Revisión del plano (G01, G02)
 * ------------------------------------------------------------------ */

export interface PlanProblem {
  readonly planId: string | null;
  readonly message: string;
  readonly severity: 'blocking' | 'advisory';
}

/**
 * Revisa los planos y sus puntos.
 *
 * Un plano sin puntos se muestra igual, pero no lleva a ninguna parte: el
 * visitante lo abre, no puede pulsar nada y concluye que está roto. Es un
 * aviso y no un bloqueo porque un plano de referencia, sólo para mirar, es un
 * uso legítimo.
 */
export function validatePlans(
  plans: readonly Plan[],
  markers: readonly PlanMarker[],
  options: { readonly sceneIds: ReadonlySet<string>; readonly mediaIds: ReadonlySet<string> },
): PlanProblem[] {
  const problems: PlanProblem[] = [];

  for (const plan of plans) {
    if (!options.mediaIds.has(plan.mediaId)) {
      problems.push({
        planId: plan.id,
        message: `El plano «${plan.name}» no tiene su imagen en el proyecto`,
        severity: 'blocking',
      });
    }

    const own = markers.filter((m) => m.planId === plan.id);
    if (own.length === 0) {
      problems.push({
        planId: plan.id,
        message: `El plano «${plan.name}» no tiene ningún punto navegable`,
        severity: 'advisory',
      });
    }

    for (const marker of own) {
      if (!options.sceneIds.has(marker.sceneId)) {
        problems.push({
          planId: plan.id,
          message: `Un punto de «${plan.name}» lleva a una escena que ya no existe`,
          severity: 'blocking',
        });
      }
    }
  }

  // Un punto cuyo plano no existe no se ve en ninguna parte y no se puede
  // corregir desde la pantalla del plano: hay que señalarlo aparte.
  const planIds = new Set(plans.map((p) => p.id));
  const orphans = markers.filter((m) => !planIds.has(m.planId));
  if (orphans.length > 0) {
    problems.push({
      planId: null,
      message: `${orphans.length} punto(s) pertenecen a un plano que ya no existe`,
      severity: 'advisory',
    });
  }

  return problems;
}

export const canPublishPlans = (problems: readonly PlanProblem[]): boolean =>
  !problems.some((problem) => problem.severity === 'blocking');

/* ------------------------------------------------------------------ *
 * Crear planos y puntos (G01, G02)
 * ------------------------------------------------------------------ */

/**
 * Plano nuevo sobre una imagen ya importada.
 *
 * Los valores por omisión se toman del esquema en lugar de escribirse aquí:
 * si mañana el plano gana un campo, esta función no tiene que enterarse.
 */
export function createPlan(
  mediaId: string,
  name: string,
  overrides: Partial<Omit<Plan, 'id' | 'mediaId' | 'name'>> = {},
): Plan {
  return planSchema.parse({ id: newUuid(), mediaId, name, ...overrides });
}

/** Punto navegable de un plano, en la posición indicada. */
export function createPlanMarker(
  planId: string,
  sceneId: string,
  position: { readonly x: number; readonly y: number },
  overrides: Partial<Omit<PlanMarker, 'id' | 'planId' | 'sceneId' | 'position'>> = {},
): PlanMarker {
  return planMarkerSchema.parse({
    id: newUuid(),
    planId,
    sceneId,
    position: clampPlanPoint(position),
    ...overrides,
  });
}

/** Acota una posición al interior del plano. */
export const clampPlanPoint = (point: {
  readonly x: number;
  readonly y: number;
}): { readonly x: number; readonly y: number } => ({
  x: Math.min(Math.max(point.x, 0), 1),
  y: Math.min(Math.max(point.y, 0), 1),
});

/**
 * Escenas que todavía no tienen punto en ningún plano.
 *
 * Es la lista que el autor necesita para terminar el plano: sin ella hay que
 * ir comparando a mano cuarenta escenas con los puntos ya colocados.
 */
export function scenesWithoutMarker(
  sceneIds: readonly string[],
  markers: readonly PlanMarker[],
): string[] {
  const placed = new Set<string>(markers.map((m) => m.sceneId));
  return sceneIds.filter((id) => !placed.has(id));
}
