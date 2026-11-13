import { describe, expect, it } from 'vitest';
import {
  angularDistance,
  applyZoom,
  boundingBoxUv,
  clampPitch,
  constrainView,
  degToRad,
  FULL_COVERAGE,
  HALF_PI,
  inferCoverage,
  isClockwiseUv,
  normalizeCameraView,
  pointInPolygonUv,
  radToDeg,
  shortestYawDelta,
  signedAreaUv,
  slerpSpherical,
  sphericalToUv,
  sphericalToVector,
  TWO_PI,
  uvToSpherical,
  vectorToSpherical,
  viewLimits,
  wrapYaw,
  yawToPlanBearing,
} from './coordinates';

/**
 * TEST-COORD-001 .. TEST-COORD-024
 * Requisitos: C02, C03, C11 (etapa 01); D03, D08, D09, D11 (etapa 02);
 * G04, G05 (etapa 04). Contrato de datos: yaw/pitch en radianes, FOV en
 * grados, UV normalizados.
 */
describe('conversión de unidades', () => {
  it('TEST-COORD-001: grados y radianes son inversos', () => {
    for (const deg of [0, 1, 45, 90, 179.5, 360, -90]) {
      expect(radToDeg(degToRad(deg))).toBeCloseTo(deg, 10);
    }
    expect(degToRad(180)).toBeCloseTo(Math.PI, 12);
  });
});

describe('envoltura de yaw', () => {
  it('TEST-COORD-002: deja el intervalo en (-π, π]', () => {
    expect(wrapYaw(0)).toBe(0);
    expect(wrapYaw(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapYaw(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapYaw(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
  });

  it('TEST-COORD-003: girar una vuelta completa devuelve la misma orientación', () => {
    // Si no fuera así, dos vistas idénticas se compararían como distintas y
    // el historial acumularía pasos que no cambian nada.
    for (const base of [0, 0.5, -1.2, 3]) {
      expect(wrapYaw(base + TWO_PI)).toBeCloseTo(wrapYaw(base), 10);
      expect(wrapYaw(base - TWO_PI * 3)).toBeCloseTo(wrapYaw(base), 10);
    }
  });

  it('TEST-COORD-004: un valor no finito se normaliza a 0 en lugar de propagar NaN', () => {
    expect(wrapYaw(Number.NaN)).toBe(0);
    expect(wrapYaw(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPitch(Number.NaN)).toBe(0);
  });

  it('TEST-COORD-005: el pitch se acota y no se envuelve', () => {
    expect(clampPitch(HALF_PI + 1)).toBeCloseTo(HALF_PI, 12);
    expect(clampPitch(-HALF_PI - 1)).toBeCloseTo(-HALF_PI, 12);
    expect(clampPitch(0.3)).toBeCloseTo(0.3, 12);
  });
});

describe('diferencia angular más corta', () => {
  it('TEST-COORD-006: cruza la discontinuidad por el camino corto', () => {
    // 170° -> -170° son 20°, no 340°. Es la base de la transición entre escenas.
    const from = degToRad(170);
    const to = degToRad(-170);
    expect(radToDeg(shortestYawDelta(from, to))).toBeCloseTo(20, 6);
    expect(radToDeg(shortestYawDelta(to, from))).toBeCloseTo(-20, 6);
  });

  it('TEST-COORD-007: la diferencia nunca excede π en valor absoluto', () => {
    for (let a = -7; a <= 7; a += 0.37) {
      for (let b = -7; b <= 7; b += 0.53) {
        expect(Math.abs(shortestYawDelta(a, b))).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

describe('esfera y cartesiano', () => {
  it('TEST-COORD-008: yaw 0 mira hacia -Z, como en el visor', () => {
    const v = sphericalToVector({ yaw: 0, pitch: 0 });
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(-1, 12);
  });

  it('TEST-COORD-009: yaw +90° mira hacia +X', () => {
    const v = sphericalToVector({ yaw: HALF_PI, pitch: 0 });
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });

  it('TEST-COORD-010: el cenit es +Y', () => {
    const v = sphericalToVector({ yaw: 1.3, pitch: HALF_PI });
    expect(v.y).toBeCloseTo(1, 12);
  });

  it('TEST-COORD-011: la ida y vuelta conserva la orientación', () => {
    for (const yaw of [-3, -1.1, 0, 0.7, 2.9]) {
      for (const pitch of [-1.4, -0.3, 0, 0.5, 1.4]) {
        const back = vectorToSpherical(sphericalToVector({ yaw, pitch }));
        expect(back.yaw).toBeCloseTo(wrapYaw(yaw), 9);
        expect(back.pitch).toBeCloseTo(pitch, 9);
      }
    }
  });

  it('TEST-COORD-012: un vector nulo no produce NaN', () => {
    const s = vectorToSpherical({ x: 0, y: 0, z: 0 });
    expect(s.yaw).toBe(0);
    expect(s.pitch).toBe(0);
  });

  it('TEST-COORD-013: la distancia angular coincide con la diferencia en el ecuador', () => {
    const d = angularDistance({ yaw: 0, pitch: 0 }, { yaw: degToRad(90), pitch: 0 });
    expect(radToDeg(d)).toBeCloseTo(90, 6);
    expect(angularDistance({ yaw: 1, pitch: 0.5 }, { yaw: 1, pitch: 0.5 })).toBeCloseTo(0, 9);
  });
});

describe('interpolación esférica', () => {
  it('TEST-COORD-014: los extremos son exactos', () => {
    const a = { yaw: 0.2, pitch: -0.4 };
    const b = { yaw: 2.1, pitch: 0.9 };
    const start = slerpSpherical(a, b, 0);
    const end = slerpSpherical(a, b, 1);
    expect(start.yaw).toBeCloseTo(a.yaw, 8);
    expect(start.pitch).toBeCloseTo(a.pitch, 8);
    expect(end.yaw).toBeCloseTo(b.yaw, 8);
    expect(end.pitch).toBeCloseTo(b.pitch, 8);
  });

  it('TEST-COORD-015: avanza por el arco corto al cruzar ±180°', () => {
    const a = { yaw: degToRad(175), pitch: 0 };
    const b = { yaw: degToRad(-175), pitch: 0 };
    const mid = slerpSpherical(a, b, 0.5);
    // El punto medio debe quedar junto a 180°, no junto a 0°.
    expect(Math.abs(radToDeg(mid.yaw))).toBeGreaterThan(178);
  });

  it('TEST-COORD-016: el recorrido es de velocidad angular constante', () => {
    const a = { yaw: 0, pitch: 0 };
    const b = { yaw: degToRad(120), pitch: degToRad(40) };
    const total = angularDistance(a, b);
    for (const t of [0.25, 0.5, 0.75]) {
      const point = slerpSpherical(a, b, t);
      expect(angularDistance(a, point)).toBeCloseTo(total * t, 6);
    }
  });

  it('TEST-COORD-017: orientaciones coincidentes no producen división por cero', () => {
    const a = { yaw: 1, pitch: 0.2 };
    const result = slerpSpherical(a, { ...a }, 0.5);
    expect(Number.isFinite(result.yaw)).toBe(true);
    expect(Number.isFinite(result.pitch)).toBe(true);
  });
});

describe('equirectangular', () => {
  it('TEST-COORD-018: el centro de la imagen es yaw 0, pitch 0', () => {
    const uv = sphericalToUv({ yaw: 0, pitch: 0 });
    expect(uv.u).toBeCloseTo(0.5, 12);
    expect(uv.v).toBeCloseTo(0.5, 12);
  });

  it('TEST-COORD-019: v=0 es el cenit y v=1 el nadir', () => {
    expect(uvToSpherical({ u: 0.5, v: 0 }).pitch).toBeCloseTo(HALF_PI, 10);
    expect(uvToSpherical({ u: 0.5, v: 1 }).pitch).toBeCloseTo(-HALF_PI, 10);
  });

  it('TEST-COORD-020: la ida y vuelta UV conserva la orientación', () => {
    for (const yaw of [-3, -0.5, 0, 1.7, 3.1]) {
      for (const pitch of [-1.5, -0.2, 0, 0.8, 1.5]) {
        const back = uvToSpherical(sphericalToUv({ yaw, pitch }));
        expect(back.yaw).toBeCloseTo(wrapYaw(yaw), 8);
        expect(back.pitch).toBeCloseTo(clampPitch(pitch), 8);
      }
    }
  });
});

describe('cobertura y límites de cámara', () => {
  it('TEST-COORD-021: una imagen 2:1 se reconoce como esférica completa', () => {
    expect(inferCoverage(8192, 4096)).toEqual(FULL_COVERAGE);
    expect(inferCoverage(4000, 2000).horizontalDeg).toBe(360);
  });

  it('TEST-COORD-022: una panorámica parcial deduce menos cobertura', () => {
    // Imagen de 4096×2048 recortada a la mitad en horizontal: 180°.
    const coverage = inferCoverage(2048, 2048);
    expect(coverage.horizontalDeg).toBeCloseTo(180, 1);
    expect(coverage.verticalDeg).toBeCloseTo(180, 1);
  });

  it('TEST-COORD-023: en cobertura de 360° el yaw gira sin tope', () => {
    const limits = viewLimits(FULL_COVERAGE, 75);
    expect(limits.yawUnbounded).toBe(true);
  });

  it('TEST-COORD-024: en cobertura parcial el tope retrocede con el FOV', () => {
    // Sin esta corrección, acercar el zoom al borde mostraría el vacío que
    // hay más allá de la textura.
    const coverage = { horizontalDeg: 120, verticalDeg: 90, centerYaw: 0, centerPitch: 0 };
    const wide = viewLimits(coverage, 100);
    const narrow = viewLimits(coverage, 20);
    expect(narrow.yawMax).toBeGreaterThan(wide.yawMax);
    expect(radToDeg(narrow.yawMax)).toBeCloseTo(60 - 10, 4);
    expect(radToDeg(wide.yawMax)).toBeCloseTo(60 - 50, 4);
  });

  it('TEST-COORD-025: constrainView mantiene la vista dentro de la cobertura', () => {
    const coverage = { horizontalDeg: 90, verticalDeg: 60, centerYaw: 0, centerPitch: 0 };
    const view = constrainView({ yaw: degToRad(80), pitch: degToRad(50), fov: 60 }, coverage);
    const limits = viewLimits(coverage, 60);
    expect(view.yaw).toBeLessThanOrEqual(limits.yawMax + 1e-9);
    expect(view.pitch).toBeLessThanOrEqual(limits.pitchMax + 1e-9);
  });

  it('TEST-COORD-026: un FOV mayor que la cobertura no invierte los límites', () => {
    const coverage = { horizontalDeg: 30, verticalDeg: 20, centerYaw: 0, centerPitch: 0 };
    const limits = viewLimits(coverage, 120);
    expect(limits.yawMin).toBeLessThanOrEqual(limits.yawMax);
    expect(limits.pitchMin).toBeLessThanOrEqual(limits.pitchMax);
  });
});

describe('límites de zoom (C03)', () => {
  it('TEST-COORD-027: el zoom respeta los límites configurados', () => {
    const limits = { minFovDeg: 40, maxFovDeg: 90 };
    expect(applyZoom(60, 0.5, limits)).toBe(40);
    expect(applyZoom(60, 4, limits)).toBe(90);
    expect(applyZoom(60, 1.25, limits)).toBeCloseTo(75, 6);
  });

  it('TEST-COORD-028: el paso es multiplicativo y por tanto uniforme', () => {
    // Un clic de rueda debe sentirse igual con zoom cercano y lejano.
    const limits = { minFovDeg: 10, maxFovDeg: 120 };
    const step = 1.1;
    expect(applyZoom(20, step, limits) / 20).toBeCloseTo(step, 10);
    expect(applyZoom(100, step, limits) / 100).toBeCloseTo(step, 10);
  });

  it('TEST-COORD-029: normalizeCameraView rellena y acota', () => {
    const view = normalizeCameraView({ yaw: TWO_PI + 0.1, pitch: 5, fov: 500 });
    expect(view.yaw).toBeCloseTo(0.1, 8);
    expect(view.pitch).toBeCloseTo(HALF_PI, 8);
    expect(view.fov).toBe(120);
    expect(normalizeCameraView({})).toEqual({ yaw: 0, pitch: 0, fov: 75 });
  });
});

describe('geometría de polígonos', () => {
  const square = [
    { u: 0.2, v: 0.2 },
    { u: 0.6, v: 0.2 },
    { u: 0.6, v: 0.6 },
    { u: 0.2, v: 0.6 },
  ];

  it('TEST-COORD-030: el área firmada detecta el sentido de recorrido', () => {
    expect(Math.abs(signedAreaUv(square))).toBeCloseTo(0.16, 10);
    expect(signedAreaUv(square)).not.toBe(signedAreaUv([...square].reverse()));
    expect(isClockwiseUv(square)).toBe(!isClockwiseUv([...square].reverse()));
  });

  it('TEST-COORD-031: menos de tres vértices no tienen área', () => {
    expect(signedAreaUv([])).toBe(0);
    expect(signedAreaUv([{ u: 0, v: 0 }, { u: 1, v: 1 }])).toBe(0);
  });

  it('TEST-COORD-032: el punto en polígono acierta dentro y fuera', () => {
    expect(pointInPolygonUv({ u: 0.4, v: 0.4 }, square)).toBe(true);
    expect(pointInPolygonUv({ u: 0.1, v: 0.4 }, square)).toBe(false);
    expect(pointInPolygonUv({ u: 0.9, v: 0.9 }, square)).toBe(false);
  });

  it('TEST-COORD-033: funciona con un polígono cóncavo', () => {
    // Forma de «L»: el punto en la escotadura debe quedar fuera.
    const concave = [
      { u: 0.1, v: 0.1 },
      { u: 0.5, v: 0.1 },
      { u: 0.5, v: 0.3 },
      { u: 0.3, v: 0.3 },
      { u: 0.3, v: 0.5 },
      { u: 0.1, v: 0.5 },
    ];
    expect(pointInPolygonUv({ u: 0.2, v: 0.2 }, concave)).toBe(true);
    expect(pointInPolygonUv({ u: 0.42, v: 0.42 }, concave)).toBe(false);
  });

  it('TEST-COORD-034: el rectángulo envolvente acota el polígono', () => {
    const box = boundingBoxUv(square);
    expect(box).not.toBeNull();
    expect(box?.min).toEqual({ u: 0.2, v: 0.2 });
    expect(box?.max).toEqual({ u: 0.6, v: 0.6 });
    expect(boundingBoxUv([])).toBeNull();
  });
});

describe('radar sobre plano (G04, G05)', () => {
  it('TEST-COORD-035: sin desviaciones el rumbo coincide con el yaw', () => {
    const bearing = yawToPlanBearing(degToRad(45), { northRad: 0, sceneNorthOffsetRad: 0 });
    expect(radToDeg(bearing)).toBeCloseTo(45, 8);
  });

  it('TEST-COORD-036: aplica la orientación declarada del plano y de la escena', () => {
    // Un radar que apunta 40° desviado es peor que no tener radar: induce a
    // error sobre el terreno. Por eso ambas orientaciones son obligatorias.
    const bearing = yawToPlanBearing(degToRad(10), {
      northRad: degToRad(30),
      sceneNorthOffsetRad: degToRad(90),
    });
    expect(radToDeg(bearing)).toBeCloseTo(70, 6);
  });

  it('TEST-COORD-037: el rumbo queda envuelto en (-180°, 180°]', () => {
    const bearing = yawToPlanBearing(degToRad(170), {
      northRad: 0,
      sceneNorthOffsetRad: degToRad(45),
    });
    expect(radToDeg(bearing)).toBeCloseTo(-145, 6);
  });
});
