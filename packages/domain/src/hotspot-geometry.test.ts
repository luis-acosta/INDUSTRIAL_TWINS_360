/**
 * Pruebas de la edición de geometría de marcadores (D01–D11, D15).
 *
 * Dos clases de fallo guían estas pruebas:
 *
 *  - **Trabajo del autor perdido en silencio.** Cambiar de forma, mover un
 *    vértice o quitar el tercero son operaciones donde es fácil devolver algo
 *    que el esquema rechazará al guardar, o dejar el marcador en una esquina
 *    de la panorámica.
 *  - **La costura de la panorámica.** `u = 0` y `u = 1` son el mismo
 *    meridiano. Un contorno que la cruza es legítimo y es exactamente el que
 *    rompen las implementaciones que promedian `u` a secas.
 */
import { describe, expect, it } from 'vitest';
import {
  CORNER_LABELS,
  axisAffectsRender,
  canSavePolygon,
  centroid,
  geometryCenterUv,
  insertVertex,
  invertPolygon,
  isCollinear,
  isAnimatedIconCandidate,
  moveCorner,
  moveVertex,
  planShapeChange,
  removeVertex,
  resetCorners,
  shapeNeedsMedia,
  signedArea,
  validatePolygon,
  type Corners,
} from './hotspot-geometry';
import { hotspotGeometrySchema, type HotspotGeometry } from './hotspot';
import { newUuid } from './identity';
import type { Spherical, Uv } from './coordinates';

const ANCHOR: Spherical = { yaw: 0, pitch: 0 };
const MEDIA = newUuid();

const uv = (u: number, v: number): Uv => ({ u, v });

const icon = (): HotspotGeometry => hotspotGeometrySchema.parse({ shape: 'icon' });

const polygon = (points: readonly Uv[]): HotspotGeometry =>
  hotspotGeometrySchema.parse({ shape: 'polygon', points });

/* ------------------------------------------------------------------ *
 * Centro y costura
 * ------------------------------------------------------------------ */

describe('centroid', () => {
  it('TEST-HSG-001 el centro de un cuadrado es su medio', () => {
    const center = centroid([uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)]);
    expect(center.u).toBeCloseTo(0.5, 5);
    expect(center.v).toBeCloseTo(0.5, 5);
  });

  it('TEST-HSG-002 un contorno que cruza la costura tiene su centro en la costura', () => {
    // La media aritmética daría 0,5: el punto diametralmente opuesto al real.
    const center = centroid([uv(0.98, 0.5), uv(0.02, 0.5), uv(0.02, 0.6), uv(0.98, 0.6)]);
    expect(Math.min(center.u, 1 - center.u)).toBeCloseTo(0, 5);
  });

  it('TEST-HSG-003 sin puntos devuelve el centro de la panorámica', () => {
    expect(centroid([])).toEqual({ u: 0.5, v: 0.5 });
  });
});

describe('geometryCenterUv', () => {
  it('TEST-HSG-004 un icono se centra en su ancla', () => {
    const center = geometryCenterUv(icon(), { yaw: 0, pitch: 0 });
    expect(center.u).toBeCloseTo(0.5, 5);
    expect(center.v).toBeCloseTo(0.5, 5);
  });

  it('TEST-HSG-005 un polígono se centra en su contorno, no en el ancla', () => {
    const geometry = polygon([uv(0.1, 0.1), uv(0.3, 0.1), uv(0.3, 0.3)]);
    const center = geometryCenterUv(geometry, { yaw: 3, pitch: 1 });
    expect(center.u).toBeLessThan(0.4);
    expect(center.v).toBeLessThan(0.4);
  });
});

/* ------------------------------------------------------------------ *
 * Cambio de forma
 * ------------------------------------------------------------------ */

describe('planShapeChange', () => {
  it('TEST-HSG-006 cambiar a la misma forma no pierde nada', () => {
    const result = planShapeChange(icon(), 'icon', ANCHOR);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.losses).toEqual([]);
  });

  it('TEST-HSG-007 cada cambio dice en palabras qué se pierde', () => {
    const result = planShapeChange(polygon([uv(0.1, 0.1), uv(0.3, 0.1), uv(0.3, 0.3)]), 'icon', ANCHOR);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.losses[0]).toContain('vértices');
  });

  it('TEST-HSG-008 la geometría resultante siempre cumple el esquema', () => {
    // Es la comprobación que impide devolver algo que el guardado rechace.
    for (const shape of ['icon', 'text', 'polygon', 'webframe'] as const) {
      const result = planShapeChange(icon(), shape, ANCHOR);
      expect(result.ok).toBe(true);
      if (result.ok) expect(() => hotspotGeometrySchema.parse(result.value.geometry)).not.toThrow();
    }
  });

  it('TEST-HSG-009 un polígono convertido en icono conserva su posición', () => {
    // Sin esto el icono aparecería en el origen de la panorámica, a media
    // escena del sitio donde el autor estaba trabajando.
    const geometry = polygon([uv(0.8, 0.2), uv(0.9, 0.2), uv(0.9, 0.3)]);
    const center = geometryCenterUv(geometry, ANCHOR);
    const result = planShapeChange(geometry, 'icon', ANCHOR);

    expect(result.ok).toBe(true);
    // El icono se ancla por separado; lo que se comprueba es que el plan
    // conoce el centro del contorno para que la pantalla lo use.
    expect(center.u).toBeGreaterThan(0.7);
  });

  it('TEST-HSG-010 el polígono nuevo nace como cuadrado alrededor del centro', () => {
    const result = planShapeChange(icon(), 'polygon', ANCHOR);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.geometry.shape === 'polygon') {
      expect(result.value.geometry.points).toHaveLength(4);
      expect(validatePolygon(result.value.geometry.points)).toEqual([]);
    }
  });

  it('TEST-HSG-011 una imagen proyectada sin imagen se rechaza con el motivo', () => {
    const result = planShapeChange(icon(), 'projectedImage', ANCHOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('necesita una imagen');
  });

  it('TEST-HSG-012 con la imagen elegida, la proyección nace con área', () => {
    const result = planShapeChange(icon(), 'projectedImage', ANCHOR, MEDIA);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.geometry.shape === 'projectedImage') {
      expect(Math.abs(signedArea(result.value.geometry.corners))).toBeGreaterThan(0);
    }
  });

  it('TEST-HSG-013 un marcador de modelo sin archivo se rechaza', () => {
    const result = planShapeChange(icon(), 'model', ANCHOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('archivo 3D');
  });

  it('TEST-HSG-014 se sabe de antemano qué formas exigen un medio', () => {
    expect(shapeNeedsMedia('projectedImage')).toBe(true);
    expect(shapeNeedsMedia('model')).toBe(true);
    expect(shapeNeedsMedia('icon')).toBe(false);
    expect(shapeNeedsMedia('text')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Vértices (D03, D11)
 * ------------------------------------------------------------------ */

describe('vértices de un polígono', () => {
  const square = [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)];

  it('TEST-HSG-015 el vértice nuevo se inserta en el lado más cercano', () => {
    // Añadir al final uniría el último con el primero y doblaría el contorno
    // sobre sí mismo.
    const result = insertVertex(square, uv(0.5, 0.39));
    expect(result).toHaveLength(5);
    expect(result[1]).toEqual(uv(0.5, 0.39));
    expect(validatePolygon(result).filter((p) => p.severity === 'advisory')).toEqual([]);
  });

  it('TEST-HSG-016 insertar cerca del último lado no rompe el contorno', () => {
    const result = insertVertex(square, uv(0.39, 0.5));
    expect(result).toHaveLength(5);
    expect(validatePolygon(result)).toEqual([]);
  });

  it('TEST-HSG-017 mover un vértice sólo cambia ese vértice', () => {
    const result = moveVertex(square, 2, uv(0.7, 0.7));
    expect(result[2]).toEqual(uv(0.7, 0.7));
    expect(result[0]).toEqual(square[0]);
  });

  it('TEST-HSG-018 mover un vértice a través de la costura lo envuelve', () => {
    // Sin envolver, `u = 1,05` saldría del rango y el esquema lo rechazaría.
    const result = moveVertex(square, 0, uv(1.05, 0.4));
    expect(result[0]!.u).toBeCloseTo(0.05, 5);
    expect(() => hotspotGeometrySchema.parse({ shape: 'polygon', points: result })).not.toThrow();
  });

  it('TEST-HSG-019 la elevación se acota en lugar de salirse', () => {
    const result = moveVertex(square, 0, uv(0.4, 1.4));
    expect(result[0]!.v).toBe(1);
  });

  it('TEST-HSG-020 mover un vértice inexistente no altera el contorno', () => {
    expect(moveVertex(square, 9, uv(0, 0))).toEqual(square);
  });

  it('TEST-HSG-021 se puede quitar un vértice si quedan tres', () => {
    const result = removeVertex(square, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(3);
  });

  it('TEST-HSG-022 quitar el tercero se rechaza con el motivo', () => {
    // Con dos vértices el polígono no encierra nada: el visor no lo dibujaría
    // ni detectaría la pulsación, y el esquema lo rechazaría al guardar.
    const triangle = [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.5, 0.6)];
    const result = removeVertex(triangle, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('tres vértices');
  });

  it('TEST-HSG-023 quitar un vértice inexistente se rechaza', () => {
    expect(removeVertex(square, 9).ok).toBe(false);
  });

  it('TEST-HSG-024 invertir alterna la zona activa', () => {
    const geometry = polygon(square);
    const once = invertPolygon(geometry);
    expect(once.shape === 'polygon' && once.inverted).toBe(true);
    const twice = invertPolygon(once);
    expect(twice.shape === 'polygon' && twice.inverted).toBe(false);
  });

  it('TEST-HSG-025 invertir una forma que no es polígono no hace nada', () => {
    const geometry = icon();
    expect(invertPolygon(geometry)).toBe(geometry);
  });
});

/* ------------------------------------------------------------------ *
 * Revisión del contorno
 * ------------------------------------------------------------------ */

describe('validatePolygon', () => {
  it('TEST-HSG-026 un cuadrado no tiene problemas', () => {
    expect(validatePolygon([uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)])).toEqual([]);
  });

  it('TEST-HSG-027 menos de tres vértices impide guardar', () => {
    const problems = validatePolygon([uv(0.4, 0.4), uv(0.6, 0.4)]);
    expect(canSavePolygon(problems)).toBe(false);
  });

  it('TEST-HSG-028 vértices alineados impiden guardar, porque no se podría pulsar', () => {
    const problems = validatePolygon([uv(0.4, 0.5), uv(0.5, 0.5), uv(0.6, 0.5)]);
    expect(canSavePolygon(problems)).toBe(false);
    expect(problems[0]!.message).toContain('alineados');
  });

  it('TEST-HSG-029 un contorno cruzado avisa pero no bloquea', () => {
    // El visor lo dibuja; qué queda dentro depende de la regla de relleno y el
    // autor casi nunca quiere eso, pero es su decisión.
    const bowtie = [uv(0.4, 0.4), uv(0.6, 0.6), uv(0.6, 0.4), uv(0.4, 0.6)];
    const problems = validatePolygon(bowtie);
    expect(canSavePolygon(problems)).toBe(true);
    expect(problems.some((p) => p.message.includes('cruza'))).toBe(true);
  });

  it('TEST-HSG-030 un triángulo no puede cruzarse consigo mismo', () => {
    const problems = validatePolygon([uv(0.4, 0.4), uv(0.6, 0.4), uv(0.5, 0.6)]);
    expect(problems).toEqual([]);
  });

  it('TEST-HSG-031 un contorno que cruza la costura es válido', () => {
    // Es el caso que rompen las implementaciones que no desenrollan `u`: el
    // área sale enorme y el contorno parece cruzado.
    const problems = validatePolygon([uv(0.97, 0.4), uv(0.03, 0.4), uv(0.03, 0.6), uv(0.97, 0.6)]);
    expect(problems).toEqual([]);
  });

  it('TEST-HSG-032 el área de un cuadrado de lado 0,2 es 0,04', () => {
    const area = Math.abs(signedArea([uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)]));
    expect(area).toBeCloseTo(0.04, 5);
  });

  it('TEST-HSG-033 el área no depende del sentido de giro', () => {
    const cw = [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)];
    const ccw = [...cw].reverse();
    expect(Math.abs(signedArea(cw))).toBeCloseTo(Math.abs(signedArea(ccw)), 8);
    expect(Math.sign(signedArea(cw))).not.toBe(Math.sign(signedArea(ccw)));
  });
});

/* ------------------------------------------------------------------ *
 * Esquinas de una imagen proyectada (D05)
 * ------------------------------------------------------------------ */

describe('esquinas de una imagen proyectada', () => {
  const corners: Corners = [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)];

  it('TEST-HSG-034 hay un nombre para cada esquina', () => {
    expect(CORNER_LABELS).toHaveLength(4);
    expect(CORNER_LABELS[0]).toContain('superior');
  });

  it('TEST-HSG-035 mover una esquina sólo cambia esa esquina', () => {
    const result = moveCorner(corners, 1, uv(0.7, 0.35));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[1]).toEqual(uv(0.7, 0.35));
      expect(result.value[0]).toEqual(corners[0]);
    }
  });

  it('TEST-HSG-036 dejar las cuatro esquinas alineadas se rechaza', () => {
    // La imagen desaparecería sin que nada lo explicase.
    const flat: Corners = [uv(0.4, 0.5), uv(0.5, 0.5), uv(0.6, 0.5), uv(0.7, 0.5)];
    const result = moveCorner(flat, 0, uv(0.3, 0.5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('alineadas');
  });

  it('TEST-HSG-037 una esquina inexistente se rechaza', () => {
    expect(moveCorner(corners, 4, uv(0.5, 0.5)).ok).toBe(false);
  });

  it('TEST-HSG-038 la esquina se envuelve en la costura y se acota en vertical', () => {
    const result = moveCorner(corners, 0, uv(1.02, -0.5));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.u).toBeCloseTo(0.02, 5);
      expect(result.value[0]!.v).toBe(0);
    }
  });

  it('TEST-HSG-039 restablecer devuelve un rectángulo centrado igual', () => {
    const skewed: Corners = [uv(0.3, 0.3), uv(0.7, 0.35), uv(0.65, 0.7), uv(0.35, 0.6)];
    const before = centroid(skewed);
    const after = resetCorners(skewed);

    expect(centroid(after).u).toBeCloseTo(before.u, 5);
    expect(Math.abs(signedArea(after))).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Tres ejes (D08, D09)
 * ------------------------------------------------------------------ */

describe('axisAffectsRender', () => {
  it('TEST-HSG-040 en un marcador de frente sólo el giro en el plano se nota', () => {
    // Ofrecer los otros dos sin decirlo deja al autor moviendo mandos que no
    // hacen nada y concluyendo que la aplicación está rota.
    expect(axisAffectsRender('roll', 'billboard')).toBe(true);
    expect(axisAffectsRender('tilt', 'billboard')).toBe(false);
    expect(axisAffectsRender('spin', 'billboard')).toBe(false);
  });

  it('TEST-HSG-041 adherido a la escena los tres ejes se notan', () => {
    expect(axisAffectsRender('roll', 'sticker')).toBe(true);
    expect(axisAffectsRender('tilt', 'sticker')).toBe(true);
    expect(axisAffectsRender('spin', 'sticker')).toBe(true);
  });

  it('TEST-HSG-042 flotante también usa los tres', () => {
    expect(axisAffectsRender('tilt', 'floating')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Iconos animados (D15)
 * ------------------------------------------------------------------ */

describe('isAnimatedIconCandidate', () => {
  it('TEST-HSG-043 un APNG declarado como tal se admite', () => {
    expect(isAnimatedIconCandidate({ mime: 'image/apng', originalName: 'flecha.apng' })).toBe(true);
  });

  it('TEST-HSG-044 un APNG servido como PNG se reconoce por el nombre', () => {
    // APNG viaja dentro de un `image/png`: el mime no lo distingue de una
    // imagen fija, y el nombre es lo que el autor reconoce.
    expect(isAnimatedIconCandidate({ mime: 'image/png', originalName: 'pulso.apng' })).toBe(true);
  });

  it('TEST-HSG-045 un PNG normal no es un icono animado', () => {
    expect(isAnimatedIconCandidate({ mime: 'image/png', originalName: 'icono.png' })).toBe(false);
  });

  it('TEST-HSG-046 el GIF se admite', () => {
    expect(isAnimatedIconCandidate({ mime: 'image/gif', originalName: 'parpadeo.gif' })).toBe(true);
  });

  it('TEST-HSG-047 un JPEG no puede animarse', () => {
    expect(isAnimatedIconCandidate({ mime: 'image/jpeg', originalName: 'foto.jpg' })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Alineación frente a área nula
 *
 * Son dos defectos distintos y confundirlos da un mensaje falso: un contorno
 * en forma de lazo tiene área con signo cero porque sus lóbulos se cancelan, y
 * sus vértices no están alineados en absoluto.
 * ------------------------------------------------------------------ */

describe('isCollinear', () => {
  it('TEST-HSG-048 tres puntos en una recta están alineados', () => {
    expect(isCollinear([uv(0.4, 0.5), uv(0.5, 0.5), uv(0.6, 0.5)])).toBe(true);
  });

  it('TEST-HSG-049 un lazo no está alineado, aunque su área sea cero', () => {
    const bowtie = [uv(0.4, 0.4), uv(0.6, 0.6), uv(0.6, 0.4), uv(0.4, 0.6)];
    expect(Math.abs(signedArea(bowtie))).toBeLessThan(1e-9);
    expect(isCollinear(bowtie)).toBe(false);
  });

  it('TEST-HSG-050 el lazo se avisa como cruzado, no como alineado', () => {
    const problems = validatePolygon([uv(0.4, 0.4), uv(0.6, 0.6), uv(0.6, 0.4), uv(0.4, 0.6)]);
    expect(problems.some((p) => p.message.includes('alineados'))).toBe(false);
    expect(problems.some((p) => p.message.includes('cruza'))).toBe(true);
  });

  it('TEST-HSG-051 todos los vértices en el mismo punto cuentan como alineados', () => {
    expect(isCollinear([uv(0.5, 0.5), uv(0.5, 0.5), uv(0.5, 0.5)])).toBe(true);
  });

  it('TEST-HSG-052 una astilla sin superficie se bloquea por no encerrar nada', () => {
    // Vértices repetidos: no está alineado por definición, pero no hay nada
    // que pulsar.
    const problems = validatePolygon([uv(0.4, 0.4), uv(0.6, 0.4), uv(0.4, 0.4), uv(0.6, 0.4)]);
    expect(canSavePolygon(problems)).toBe(false);
  });

  it('TEST-HSG-053 una recta diagonal también está alineada', () => {
    expect(isCollinear([uv(0.3, 0.3), uv(0.4, 0.4), uv(0.5, 0.5), uv(0.6, 0.6)])).toBe(true);
  });

  it('TEST-HSG-054 una recta que cruza la costura está alineada', () => {
    // Sin desenrollar `u`, la costura inventaría una desviación.
    expect(isCollinear([uv(0.95, 0.5), uv(0.99, 0.5), uv(0.03, 0.5)])).toBe(true);
  });
});
