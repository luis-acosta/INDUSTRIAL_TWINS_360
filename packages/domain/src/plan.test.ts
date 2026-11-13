/**
 * Pruebas de planos, zonas y radar (G01–G05).
 *
 * El rumbo es lo que persiguen casi todas. Hay tres sistemas de referencia en
 * juego —el yaw de la cámara, el norte de la escena y el norte del plano, más
 * la orientación propia de cada punto— y confundirlos deja el radar apuntando
 * al sitio equivocado. Eso es peor que no tener radar: el visitante se fía de
 * él y se desorienta.
 */
import { describe, expect, it } from 'vitest';
import {
  canPublishPlans,
  clampPlanPoint,
  createPlan,
  createPlanMarker,
  groupPlansByFloor,
  horizontalFov,
  markerForScene,
  normalizeAngle,
  planBearing,
  planBearingDegrees,
  planForScene,
  radarCone,
  radarConePoints,
  scenesWithoutMarker,
  validatePlans,
} from './plan';
import { planMarkerSchema, planSchema, type Plan, type PlanMarker } from './scene';
import { testUuid } from './testing';
import type { CameraView } from './coordinates';

const view = (yawDeg: number, fov = 75): CameraView => ({
  yaw: (yawDeg * Math.PI) / 180,
  pitch: 0,
  fov,
});

function makePlan(n: number, over: Record<string, unknown> = {}): Plan {
  return planSchema.parse({
    id: testUuid(n),
    name: `Plano ${n}`,
    mediaId: testUuid(100 + n),
    ...over,
  });
}

function makeMarker(n: number, planId: string, sceneId: string, over: Record<string, unknown> = {}): PlanMarker {
  return planMarkerSchema.parse({
    id: testUuid(200 + n),
    planId,
    sceneId,
    position: { x: 0.5, y: 0.5 },
    ...over,
  });
}

/* ------------------------------------------------------------------ *
 * Ángulos
 * ------------------------------------------------------------------ */

describe('normalizeAngle', () => {
  it('TEST-PLN-001 lleva cualquier ángulo al intervalo de una vuelta', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 6);
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 6);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Rumbo
 * ------------------------------------------------------------------ */

describe('planBearing', () => {
  it('TEST-PLN-002 sin desvíos, el rumbo es el yaw', () => {
    const plan = makePlan(1);
    expect(planBearingDegrees(view(90), plan)).toBe(90);
  });

  it('TEST-PLN-003 el norte del plano gira el rumbo en sentido contrario', () => {
    // Si la imagen del plano está girada 90°, lo que la cámara ve al frente
    // aparece 90° antes sobre el plano.
    const plan = makePlan(1, { orientation: { northRad: Math.PI / 2, sceneNorthOffsetRad: 0 } });
    expect(planBearingDegrees(view(90), plan)).toBe(0);
  });

  it('TEST-PLN-004 el norte de la escena suma', () => {
    const plan = makePlan(1, { orientation: { northRad: 0, sceneNorthOffsetRad: Math.PI / 2 } });
    expect(planBearingDegrees(view(0), plan)).toBe(90);
  });

  it('TEST-PLN-005 la orientación propia del punto también suma', () => {
    // Dos panorámicas tomadas en la misma sala pueden tener el cero del yaw
    // mirando a lados distintos; sin esto, una de las dos apunta mal.
    const plan = makePlan(1);
    const marker = makeMarker(1, plan.id, testUuid(50), { headingRad: Math.PI });

    expect(planBearingDegrees(view(0), plan, marker)).toBe(180);
  });

  it('TEST-PLN-006 los tres desvíos se combinan', () => {
    const plan = makePlan(1, {
      orientation: { northRad: Math.PI / 2, sceneNorthOffsetRad: Math.PI / 4 },
    });
    const marker = makeMarker(1, plan.id, testUuid(50), { headingRad: Math.PI / 4 });

    // 90 (yaw) + 45 (punto) + 45 (escena) − 90 (plano) = 90
    expect(planBearingDegrees(view(90), plan, marker)).toBe(90);
  });

  it('TEST-PLN-007 el rumbo nunca sale del círculo', () => {
    const plan = makePlan(1, { orientation: { northRad: Math.PI, sceneNorthOffsetRad: 0 } });
    const bearing = planBearing(view(0), plan);

    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(Math.PI * 2);
  });
});

/* ------------------------------------------------------------------ *
 * Radar
 * ------------------------------------------------------------------ */

describe('radarCone', () => {
  it('TEST-PLN-008 el cono se centra en el rumbo', () => {
    const plan = makePlan(1, { radarApertureDeg: 60 });
    const cone = radarCone(view(90, 90), plan);

    expect(cone.bearingDeg).toBeCloseTo(90, 4);
    expect(cone.startDeg).toBeCloseTo(60, 4);
    expect(cone.endDeg).toBeCloseTo(120, 4);
  });

  it('TEST-PLN-009 la apertura se acota al campo de visión real', () => {
    // Un cono de 60° mientras el visitante tiene el zoom muy metido diría que
    // ve mucho más de lo que ve. El tope es el campo **horizontal**: 10°
    // verticales son unos 17,7° horizontales a 16:9.
    const plan = makePlan(1, { radarApertureDeg: 60 });
    expect(radarCone(view(0, 10), plan).apertureDeg).toBeCloseTo(17.73, 1);
  });

  it('TEST-PLN-010 con el campo de visión amplio manda la apertura del autor', () => {
    const plan = makePlan(1, { radarApertureDeg: 45 });
    expect(radarCone(view(0, 110), plan).apertureDeg).toBe(45);
  });

  it('TEST-PLN-010b el tope usa el campo horizontal y no el vertical', () => {
    // El `fov` de la cámara es vertical. Compararlo tal cual estrecharía el
    // cono casi a la mitad en una ventana apaisada, y el visitante se fía.
    const plan = makePlan(1, { radarApertureDeg: 180 });
    const cone = radarCone(view(0, 75), plan);

    expect(cone.apertureDeg).toBeGreaterThan(100);
    expect(cone.apertureDeg).toBeCloseTo(horizontalFov(75, 16 / 9), 4);
  });

  it('TEST-PLN-010c en una ventana apaisada se ve más ancho que en una cuadrada', () => {
    const plan = makePlan(1, { radarApertureDeg: 180 });

    expect(radarCone(view(0, 75), plan, null, 21 / 9).apertureDeg).toBeGreaterThan(
      radarCone(view(0, 75), plan, null, 1).apertureDeg,
    );
    // Cuadrada: el horizontal coincide con el vertical.
    expect(radarCone(view(0, 75), plan, null, 1).apertureDeg).toBeCloseTo(75, 4);
  });

  it('TEST-PLN-010d una relación de aspecto imposible no rompe el cono', () => {
    const plan = makePlan(1, { radarApertureDeg: 180 });
    expect(radarCone(view(0, 75), plan, null, 0).apertureDeg).toBeCloseTo(75, 4);
    expect(radarCone(view(0, 75), plan, null, Number.NaN).apertureDeg).toBeCloseTo(75, 4);
  });

  it('TEST-PLN-011 el cono parte del punto y cero apunta hacia arriba', () => {
    // En la imagen del plano, «arriba» es el norte del plano: el cono con
    // rumbo cero debe subir, no ir hacia la derecha.
    const plan = makePlan(1, { radarApertureDeg: 10 });
    const points = radarConePoints(radarCone(view(0, 10), plan), { x: 0.5, y: 0.5 }, 0.2, 2);

    expect(points[0]).toEqual({ x: 0.5, y: 0.5 });
    const tip = points[Math.floor(points.length / 2)];
    expect(tip?.y).toBeLessThan(0.5);
    expect(tip?.x).toBeCloseTo(0.5, 2);
  });

  it('TEST-PLN-012 con rumbo 90 el cono va hacia la derecha', () => {
    const plan = makePlan(1, { radarApertureDeg: 10 });
    const points = radarConePoints(radarCone(view(90, 10), plan), { x: 0.5, y: 0.5 }, 0.2, 2);

    const tip = points[Math.floor(points.length / 2)];
    expect(tip?.x).toBeGreaterThan(0.5);
    expect(tip?.y).toBeCloseTo(0.5, 2);
  });

  it('TEST-PLN-013 el número de segmentos no baja de dos', () => {
    const plan = makePlan(1);
    const points = radarConePoints(radarCone(view(0), plan), { x: 0.5, y: 0.5 }, 0.2, 0);
    expect(points.length).toBeGreaterThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ *
 * Zonas y pisos
 * ------------------------------------------------------------------ */

describe('groupPlansByFloor', () => {
  it('TEST-PLN-014 agrupa por zona respetando el orden declarado', () => {
    // «Planta baja» antes que «Planta 1»: ningún orden alfabético acierta.
    const plans = [
      makePlan(1, { name: 'Planta 1', floor: 'Planta 1', floorOrder: 2 }),
      makePlan(2, { name: 'Planta baja', floor: 'Planta baja', floorOrder: 1 }),
    ];

    expect(groupPlansByFloor(plans).map((g) => g.floor)).toEqual(['Planta baja', 'Planta 1']);
  });

  it('TEST-PLN-015 varios planos en la misma zona quedan juntos y ordenados', () => {
    const plans = [
      makePlan(1, { name: 'Este', floor: 'Nave', floorOrder: 2 }),
      makePlan(2, { name: 'Oeste', floor: 'Nave', floorOrder: 1 }),
    ];

    const groups = groupPlansByFloor(plans);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.plans.map((p) => p.name)).toEqual(['Oeste', 'Este']);
  });

  it('TEST-PLN-016 los planos sin zona quedan al final', () => {
    // Son los de un proyecto sin organizar y no deben desplazar a los que sí
    // lo están.
    const plans = [
      makePlan(1, { floor: '', floorOrder: 0 }),
      makePlan(2, { floor: 'Planta baja', floorOrder: 5 }),
    ];

    expect(groupPlansByFloor(plans).map((g) => g.floor)).toEqual(['Planta baja', '']);
  });

  it('TEST-PLN-017 sin planos no hay grupos', () => {
    expect(groupPlansByFloor([])).toEqual([]);
  });
});

describe('planForScene', () => {
  const plans = [
    makePlan(1, { floor: 'Planta baja', floorOrder: 1 }),
    makePlan(2, { floor: 'Planta 1', floorOrder: 2 }),
  ];

  it('TEST-PLN-018 devuelve el plano donde está la escena', () => {
    const markers = [makeMarker(1, plans[1]!.id, testUuid(50))];
    expect(planForScene(plans, markers, testUuid(50))?.id).toBe(plans[1]!.id);
  });

  it('TEST-PLN-019 una escena en dos planos devuelve el primero por orden de zona', () => {
    // Una pasarela que cruza dos zonas: el visitante espera el de la zona en
    // la que está, que es la primera del orden.
    const markers = [
      makeMarker(1, plans[1]!.id, testUuid(50)),
      makeMarker(2, plans[0]!.id, testUuid(50)),
    ];
    expect(planForScene(plans, markers, testUuid(50))?.id).toBe(plans[0]!.id);
  });

  it('TEST-PLN-020 una escena sin punto no tiene plano', () => {
    expect(planForScene(plans, [], testUuid(50))).toBeNull();
  });

  it('TEST-PLN-021 el punto de una escena en un plano se localiza', () => {
    const markers = [makeMarker(1, plans[0]!.id, testUuid(50))];
    expect(markerForScene(markers, plans[0]!.id, testUuid(50))?.id).toBe(markers[0]!.id);
    expect(markerForScene(markers, plans[1]!.id, testUuid(50))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Revisión
 * ------------------------------------------------------------------ */

describe('validatePlans', () => {
  const scene = testUuid(50);

  const options = (over: Record<string, unknown> = {}) => ({
    sceneIds: new Set<string>([scene]),
    mediaIds: new Set<string>([testUuid(101)]),
    ...over,
  });

  it('TEST-PLN-022 un plano con imagen y puntos no tiene problemas', () => {
    const plan = makePlan(1);
    const markers = [makeMarker(1, plan.id, scene)];

    expect(validatePlans([plan], markers, options())).toEqual([]);
  });

  it('TEST-PLN-023 un plano sin su imagen impide publicar', () => {
    const plan = makePlan(1);
    const problems = validatePlans([plan], [makeMarker(1, plan.id, scene)], options({ mediaIds: new Set() }));

    expect(canPublishPlans(problems)).toBe(false);
    expect(problems[0]?.message).toContain('no tiene su imagen');
  });

  it('TEST-PLN-024 un plano sin puntos avisa pero no bloquea', () => {
    // Un plano de referencia, sólo para mirar, es un uso legítimo.
    const problems = validatePlans([makePlan(1)], [], options());

    expect(canPublishPlans(problems)).toBe(true);
    expect(problems[0]?.message).toContain('ningún punto navegable');
  });

  it('TEST-PLN-025 un punto hacia una escena borrada impide publicar', () => {
    const plan = makePlan(1);
    const markers = [makeMarker(1, plan.id, testUuid(999))];
    const problems = validatePlans([plan], markers, options());

    expect(canPublishPlans(problems)).toBe(false);
    expect(problems.some((p) => p.message.includes('ya no existe'))).toBe(true);
  });

  it('TEST-PLN-026 los puntos de un plano borrado se señalan aparte', () => {
    // No se ven en ninguna pantalla de plano, así que nadie los corregiría.
    const problems = validatePlans([], [makeMarker(1, testUuid(900), scene)], options());

    expect(problems.some((p) => p.planId === null && p.message.includes('ya no existe'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Colocar puntos
 * ------------------------------------------------------------------ */

describe('colocación', () => {
  it('TEST-PLN-027 una posición fuera del plano se acota', () => {
    expect(clampPlanPoint({ x: 1.4, y: -0.2 })).toEqual({ x: 1, y: 0 });
  });

  it('TEST-PLN-028 una posición dentro no se toca', () => {
    expect(clampPlanPoint({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
  });

  it('TEST-PLN-029 enumera las escenas que aún no tienen punto', () => {
    // Sin esta lista hay que comparar a mano cuarenta escenas con los puntos
    // ya colocados.
    const plan = makePlan(1);
    const markers = [makeMarker(1, plan.id, testUuid(50))];

    expect(scenesWithoutMarker([testUuid(50), testUuid(51)], markers)).toEqual([testUuid(51)]);
  });

  it('TEST-PLN-030 con todas colocadas la lista está vacía', () => {
    const plan = makePlan(1);
    const markers = [makeMarker(1, plan.id, testUuid(50))];
    expect(scenesWithoutMarker([testUuid(50)], markers)).toEqual([]);
  });
});

describe('createPlan / createPlanMarker', () => {
  it('TEST-PLN-031 el plano nuevo trae los valores por omisión del esquema', () => {
    const plan = createPlan(testUuid(80), 'Planta 1');

    expect(plan.name).toBe('Planta 1');
    expect(plan.mediaId).toBe(testUuid(80));
    expect(plan.showRadar).toBe(true);
    expect(plan.radarApertureDeg).toBe(60);
    expect(plan.orientation).toEqual({ northRad: 0, sceneNorthOffsetRad: 0 });
    expect(plan.id).not.toBe(createPlan(testUuid(80), 'Planta 1').id);
  });

  it('TEST-PLN-032 el punto nuevo se acota al plano', () => {
    // Un clic en el borde de la imagen puede dar 1.02 por el redondeo del
    // rectángulo; un punto fuera del plano no se dibuja y parece perdido.
    const marker = createPlanMarker(testUuid(81), testUuid(10), { x: 1.4, y: -0.2 });

    expect(marker.position).toEqual({ x: 1, y: 0 });
    expect(marker.label).toBe('');
    expect(marker.headingRad).toBe(0);
  });
});
