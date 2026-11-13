/**
 * Pruebas del radar del minimapa.
 *
 * Los casos están elegidos para que un error de signo o una corrección
 * olvidada falle: con un plano orientado al norte y la cámara al frente el
 * cono tiene que apuntar hacia arriba, y en cuanto el plano o la captura
 * están girados el resultado deja de coincidir con el azimut crudo.
 */
import { describe, expect, it } from 'vitest';
import {
  coneAperture,
  conePath,
  horizontalFovDeg,
  normalizeDeg,
  radarBearingDeg,
  sameBearing,
} from './minimap-math';

const NORTH_UP = { northRad: 0, sceneNorthOffsetRad: 0 };

describe('radarBearingDeg', () => {
  // TEST-MMP-001
  it('con plano al norte y cámara al frente, el cono apunta hacia arriba', () => {
    expect(radarBearingDeg(0, NORTH_UP)).toBe(0);
  });

  // TEST-MMP-002
  it('girar la cámara 90° a la derecha lleva el cono a la derecha del plano', () => {
    expect(sameBearing(radarBearingDeg(Math.PI / 2, NORTH_UP), 90)).toBe(true);
  });

  // TEST-MMP-003
  it('un plano dibujado con el norte a la derecha gira el cono en sentido contrario', () => {
    // El plano está girado 90°: lo que geográficamente es norte se dibuja a la
    // derecha, así que una cámara mirando al norte debe dibujarse apuntando
    // a la izquierda de la imagen, es decir 270°.
    const plan = { northRad: Math.PI / 2, sceneNorthOffsetRad: 0 };
    expect(sameBearing(radarBearingDeg(0, plan), 270)).toBe(true);
  });

  // TEST-MMP-004
  it('la corrección de la captura se suma al azimut', () => {
    // La panorámica se capturó con su centro mirando al este: azimut 0 es, en
    // realidad, rumbo 90.
    const plan = { northRad: 0, sceneNorthOffsetRad: Math.PI / 2 };
    expect(sameBearing(radarBearingDeg(0, plan), 90)).toBe(true);
  });

  // TEST-MMP-005
  it('las dos correcciones juntas se cancelan cuando son iguales', () => {
    const plan = { northRad: Math.PI / 4, sceneNorthOffsetRad: Math.PI / 4 };
    expect(sameBearing(radarBearingDeg(0, plan), 0)).toBe(true);
  });

  // TEST-MMP-006
  it('un azimut negativo o mayor que una vuelta se normaliza', () => {
    expect(sameBearing(radarBearingDeg(-Math.PI / 2, NORTH_UP), 270)).toBe(true);
    expect(sameBearing(radarBearingDeg(Math.PI * 2.5, NORTH_UP), 90)).toBe(true);
  });
});

describe('conePath', () => {
  // TEST-MMP-007
  it('dibuja un sector que empieza en el centro', () => {
    const path = conePath(0, 60, 40);
    expect(path.startsWith('M0,0 L')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
  });

  // TEST-MMP-008
  it('coloca los extremos a media apertura del rumbo', () => {
    // Con rumbo 0 y apertura 90, los extremos están a -45° y +45°, que son
    // simétricos respecto del eje vertical: misma altura, abscisas opuestas.
    const path = conePath(0, 90, 100);
    const points = [...path.matchAll(/(-?\d+\.\d\d),(-?\d+\.\d\d)/g)]
      .slice(0, 2)
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));

    expect(points).toHaveLength(2);
    const [first, second] = points as [{ x: number; y: number }, { x: number; y: number }];
    expect(first.x).toBeCloseTo(-second.x, 1);
    expect(first.y).toBeCloseTo(second.y, 1);
  });

  // TEST-MMP-009
  it('usa el arco largo cuando la apertura pasa de media vuelta', () => {
    expect(conePath(0, 200, 40)).toContain(' 0 1 1 ');
    expect(conePath(0, 100, 40)).toContain(' 0 0 1 ');
  });

  // TEST-MMP-010
  it('una apertura completa se dibuja como círculo y no como sector degenerado', () => {
    // Con 360° los dos extremos del sector coinciden y un solo arco queda
    // indefinido: el navegador dibujaría una línea o nada.
    const path = conePath(0, 360, 40);
    expect(path).not.toContain('M0,0');
    expect([...path.matchAll(/A/g)]).toHaveLength(2);
  });
});

describe('coneAperture y horizontalFovDeg', () => {
  // TEST-MMP-011
  it('la apertura sigue al campo de visión real, no a un valor fijo', () => {
    expect(coneAperture(30, 60)).toBe(30);
    expect(coneAperture(110, 60)).toBe(110);
  });

  // TEST-MMP-012
  it('un campo de visión imposible cae al valor declarado', () => {
    expect(coneAperture(0, 65)).toBe(65);
    expect(coneAperture(Number.NaN, 65)).toBe(65);
  });

  // TEST-MMP-013
  it('nunca deja el cono por debajo de ocho grados', () => {
    // Con zoom extremo el cono sería una línea invisible y el operador
    // perdería la referencia de hacia dónde mira.
    expect(coneAperture(2, 60)).toBe(8);
  });

  // TEST-MMP-014
  it('el campo horizontal es más ancho que el vertical en una ventana apaisada', () => {
    const horizontal = horizontalFovDeg(75, 16 / 9);
    expect(horizontal).toBeGreaterThan(75);
    expect(horizontal).toBeLessThan(180);
  });

  // TEST-MMP-015
  it('con ventana cuadrada el horizontal coincide con el vertical', () => {
    expect(horizontalFovDeg(75, 1)).toBeCloseTo(75, 6);
  });

  // TEST-MMP-016
  it('una relación de aspecto inválida devuelve el vertical sin inventar nada', () => {
    expect(horizontalFovDeg(75, 0)).toBe(75);
    expect(horizontalFovDeg(75, Number.NaN)).toBe(75);
  });
});

describe('normalizeDeg', () => {
  // TEST-MMP-017
  it('lleva cualquier ángulo a [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-1)).toBe(359);
    expect(normalizeDeg(725)).toBe(5);
  });
});
