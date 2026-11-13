/**
 * Pruebas de colocación.
 *
 * Los casos están elegidos donde la aritmética esférica engaña: el salto de
 * ±180°, los polos —donde los meridianos convergen y dos puntos con azimutes
 * muy distintos están juntos— y las panorámicas de cobertura parcial, que son
 * las que llegan cuando el cliente fotografía con un móvil en lugar de una
 * cámara 360.
 */
import { describe, expect, it } from 'vitest';
import { degToRad, radToDeg, type PanoramaCoverage } from '@it360/domain';
import {
  clampToCoverage,
  DEFAULT_SNAP,
  dragHotspot,
  insertPolygonPoint,
  isWithinCoverage,
  placeHotspot,
  polygonCenter,
  snapPoint,
  validatePolygon,
} from './placement';

const FULL: PanoramaCoverage = {
  horizontalDeg: 360,
  verticalDeg: 180,
  centerYaw: 0,
  centerPitch: 0,
};

/** Foto de móvil: 120° de ancho, 90° de alto, mirando al frente. */
const PARTIAL: PanoramaCoverage = {
  horizontalDeg: 120,
  verticalDeg: 90,
  centerYaw: 0,
  centerPitch: 0,
};

describe('snapPoint', () => {
  // TEST-PLC-001
  it('ajusta al horizonte lo que está dentro de la tolerancia', () => {
    const result = snapPoint({ yaw: 0, pitch: degToRad(2) });
    expect(result.pitch).toBe(0);
  });

  // TEST-PLC-002
  it('no toca lo que está fuera de la tolerancia', () => {
    const pitch = degToRad(12);
    expect(snapPoint({ yaw: 0, pitch }).pitch).toBeCloseTo(pitch, 9);
  });

  // TEST-PLC-003
  it('el ajuste al horizonte gana a la rejilla de elevación', () => {
    // Las dos guías compiten por un punto a 2°: la rejilla de 5° lo llevaría
    // a 0° también, pero con tolerancia 3 y rejilla 10 el resultado difiere.
    const result = snapPoint(
      { yaw: 0, pitch: degToRad(2) },
      { horizonToleranceDeg: 3, yawStepDeg: 0, pitchStepDeg: 10 },
    );
    expect(result.pitch).toBe(0);
  });

  // TEST-PLC-004
  it('la rejilla de azimut redondea al múltiplo más cercano', () => {
    const result = snapPoint(
      { yaw: degToRad(47), pitch: 0 },
      { horizonToleranceDeg: 0, yawStepDeg: 15, pitchStepDeg: 0 },
    );
    expect(radToDeg(result.yaw)).toBeCloseTo(45, 6);
  });

  // TEST-PLC-005
  it('normaliza un azimut que da más de una vuelta', () => {
    const result = snapPoint({ yaw: degToRad(540), pitch: 0 }, DEFAULT_SNAP);
    expect(radToDeg(result.yaw)).toBeCloseTo(180, 6);
  });

  // TEST-PLC-006
  it('no deja la elevación fuera de los polos', () => {
    expect(snapPoint({ yaw: 0, pitch: degToRad(120) }).pitch).toBeCloseTo(Math.PI / 2, 9);
    expect(snapPoint({ yaw: 0, pitch: degToRad(-200) }).pitch).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe('isWithinCoverage', () => {
  // TEST-PLC-007
  it('en una esfera completa cualquier dirección está cubierta', () => {
    expect(isWithinCoverage({ yaw: degToRad(179), pitch: degToRad(89) }, FULL)).toBe(true);
    expect(isWithinCoverage({ yaw: degToRad(-179), pitch: 0 }, FULL)).toBe(true);
  });

  // TEST-PLC-008
  it('reconoce lo que queda fuera de una foto parcial', () => {
    expect(isWithinCoverage({ yaw: degToRad(50), pitch: 0 }, PARTIAL)).toBe(true);
    expect(isWithinCoverage({ yaw: degToRad(70), pitch: 0 }, PARTIAL)).toBe(false);
    expect(isWithinCoverage({ yaw: 0, pitch: degToRad(50) }, PARTIAL)).toBe(false);
  });

  // TEST-PLC-009
  it('no se confunde con el salto de ±180° en una cobertura centrada allí', () => {
    // Una foto parcial centrada al sur: el centro está en el salto, y restar
    // azimutes sin normalizar daría «fuera» para puntos que están dentro.
    const south: PanoramaCoverage = { ...PARTIAL, centerYaw: 180 };
    expect(isWithinCoverage({ yaw: degToRad(175), pitch: 0 }, south)).toBe(true);
    expect(isWithinCoverage({ yaw: degToRad(-175), pitch: 0 }, south)).toBe(true);
    expect(isWithinCoverage({ yaw: degToRad(100), pitch: 0 }, south)).toBe(false);
  });
});

describe('clampToCoverage', () => {
  // TEST-PLC-010
  it('lleva al borde, no al centro', () => {
    // Devolverlo al centro haría saltar el marcador lejos de donde el autor
    // soltó el ratón.
    const result = clampToCoverage({ yaw: degToRad(90), pitch: 0 }, PARTIAL);
    expect(radToDeg(result.yaw)).toBeCloseTo(60, 6);
  });

  // TEST-PLC-011
  it('recorta por el lado correcto cuando el centro está en el salto', () => {
    const south: PanoramaCoverage = { ...PARTIAL, centerYaw: 180 };
    const result = clampToCoverage({ yaw: degToRad(0), pitch: 0 }, south);
    // Desde 0°, el borde más cercano de una cobertura centrada en 180° con
    // 120° de ancho está en 120°, no en -120°... y en valor absoluto los dos
    // están a la misma distancia, así que basta comprobar que cae en un borde.
    expect(Math.abs(radToDeg(result.yaw))).toBeCloseTo(120, 6);
  });
});

describe('placeHotspot', () => {
  // TEST-PLC-012
  it('devuelve un anclaje esférico y avisa si hubo recorte', () => {
    const inside = placeHotspot({ point: { yaw: degToRad(10), pitch: 0 }, coverage: PARTIAL });
    expect(inside.anchor.space).toBe('spherical');
    expect(inside.clamped).toBe(false);

    const outside = placeHotspot({ point: { yaw: degToRad(80), pitch: 0 }, coverage: PARTIAL });
    expect(outside.clamped).toBe(true);
  });

  // TEST-PLC-013
  it('avisa cuando el marcador queda amontonado con otro', () => {
    const result = placeHotspot({
      point: { yaw: degToRad(10), pitch: 0 },
      coverage: FULL,
      existing: [{ space: 'spherical', yaw: degToRad(11), pitch: 0 }],
      minSeparationDeg: 5,
    });

    expect(result.crowdedByDeg).not.toBeNull();
    expect(result.crowdedByDeg ?? 0).toBeCloseTo(1, 1);
  });

  // TEST-PLC-014
  it('no avisa de amontonamiento cuando hay sitio', () => {
    const result = placeHotspot({
      point: { yaw: 0, pitch: 0 },
      coverage: FULL,
      existing: [{ space: 'spherical', yaw: degToRad(45), pitch: 0 }],
      minSeparationDeg: 5,
    });
    expect(result.crowdedByDeg).toBeNull();
  });

  // TEST-PLC-015
  it('mide la separación por la esfera y no por la resta de azimutes', () => {
    // Dos puntos cerca del cenit con 90° de diferencia de azimut están, en
    // realidad, a pocos grados uno de otro. Restar azimutes diría 90.
    const result = placeHotspot({
      point: { yaw: 0, pitch: degToRad(88) },
      coverage: FULL,
      existing: [{ space: 'spherical', yaw: degToRad(90), pitch: degToRad(88) }],
      minSeparationDeg: 10,
    });

    expect(result.crowdedByDeg).not.toBeNull();
    expect(result.crowdedByDeg ?? 99).toBeLessThan(5);
  });
});

describe('dragHotspot', () => {
  // TEST-PLC-016
  it('mueve el marcador el mismo desplazamiento que el puntero', () => {
    const result = dragHotspot(
      { start: { yaw: 0, pitch: 0 }, anchorStart: { yaw: degToRad(30), pitch: degToRad(10) } },
      { yaw: degToRad(15), pitch: degToRad(-5) },
      FULL,
    );

    expect(radToDeg(result.anchor.space === 'spherical' ? result.anchor.yaw : 0)).toBeCloseTo(45, 6);
    expect(radToDeg(result.anchor.space === 'spherical' ? result.anchor.pitch : 0)).toBeCloseTo(5, 6);
  });

  // TEST-PLC-017
  it('cruza el salto de ±180° sin dar la vuelta larga', () => {
    const result = dragHotspot(
      { start: { yaw: degToRad(170), pitch: 0 }, anchorStart: { yaw: degToRad(175), pitch: 0 } },
      { yaw: degToRad(-170), pitch: 0 },
      FULL,
    );

    // 20° de desplazamiento desde 175° llevan a -165°, no a 195°.
    expect(radToDeg(result.anchor.space === 'spherical' ? result.anchor.yaw : 0)).toBeCloseTo(-165, 6);
  });
});

describe('polígonos', () => {
  const square = [
    { yaw: degToRad(-10), pitch: degToRad(-10) },
    { yaw: degToRad(10), pitch: degToRad(-10) },
    { yaw: degToRad(10), pitch: degToRad(10) },
    { yaw: degToRad(-10), pitch: degToRad(10) },
  ];

  // TEST-PLC-018
  it('inserta el vértice en el segmento más cercano, no al final', () => {
    // Añadir siempre al final cruza el polígono en cuanto el autor afina un
    // lado ya dibujado, que es lo normal al marcar el contorno de un equipo.
    const point = { yaw: degToRad(0), pitch: degToRad(-11) };
    const result = insertPolygonPoint(square, point);

    expect(result).toHaveLength(5);
    expect(result[1]).toEqual(point);
  });

  // TEST-PLC-019
  it('con menos de dos vértices simplemente añade', () => {
    const point = { yaw: 0, pitch: 0 };
    expect(insertPolygonPoint([], point)).toEqual([point]);
    expect(insertPolygonPoint([square[0] as never], point)).toHaveLength(2);
  });

  // TEST-PLC-020
  it('rechaza un polígono de menos de tres vértices', () => {
    const result = validatePolygon(square.slice(0, 2));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('tres vértices');
  });

  // TEST-PLC-021
  it('rechaza vértices duplicados consecutivos', () => {
    const duplicated = [...square.slice(0, 2), square[1] as never, ...square.slice(2)];
    const result = validatePolygon(duplicated);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('mismo punto');
  });

  // TEST-PLC-022
  it('acepta un polígono razonable', () => {
    expect(validatePolygon(square)).toEqual({ valid: true, reason: null });
  });

  // TEST-PLC-023
  it('el centro de un polígono simétrico cae en su medio', () => {
    const center = polygonCenter(square);
    expect(radToDeg(center.yaw)).toBeCloseTo(0, 6);
    expect(radToDeg(center.pitch)).toBeCloseTo(0, 6);
  });

  // TEST-PLC-024
  it('el centro de un polígono que cruza ±180° no salta al lado opuesto', () => {
    // Promediar ángulos daría 0°, que está justo en el lado contrario de la
    // esfera. Promediando vectores sale 180°, que es el correcto.
    const across = [
      { yaw: degToRad(179), pitch: degToRad(-5) },
      { yaw: degToRad(-179), pitch: degToRad(-5) },
      { yaw: degToRad(-179), pitch: degToRad(5) },
      { yaw: degToRad(179), pitch: degToRad(5) },
    ];

    expect(Math.abs(radToDeg(polygonCenter(across).yaw))).toBeCloseTo(180, 4);
  });

  // TEST-PLC-025
  it('un polígono vacío no inventa un centro', () => {
    expect(polygonCenter([])).toEqual({ yaw: 0, pitch: 0 });
  });
});
