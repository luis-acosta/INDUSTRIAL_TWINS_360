/**
 * Pruebas de los marcadores sobre modelo (L05–L07).
 *
 * La que más importa es la de la cara visible: un marcador que se ve a través
 * de la chapa dice que hay algo donde no se puede llegar, y en una inspección
 * eso manda a alguien a dar la vuelta a un equipo para nada.
 */
import { describe, expect, it } from 'vitest';
import {
  canPublishModelHotspots,
  createModelSurfaceAnchor,
  dotProduct,
  isFacingCamera,
  normalizeVector,
  panoramaLinksOf,
  stickerScale,
  validateModelHotspots,
  vectorLength,
} from './model-hotspot';
import { actionSchema } from './action';
import { makeHotspot, makeScene, testUuid } from './testing';
import type { Scene } from './scene';

const PROJECT = testUuid(1);

/** Escena de modelo con los marcadores indicados. */
function modelScene(hotspots: Scene['hotspots'], overrides: Partial<Scene> = {}): Scene {
  return makeScene(10, PROJECT, {
    title: 'Unidad U-200',
    kind: 'model',
    hotspots,
    ...overrides,
  });
}

const surfaceHotspot = (n: number, nodeName = 'valvula_01'): Scene['hotspots'][number] => ({
  ...makeHotspot(n, testUuid(10)),
  name: `Marcador ${n}`,
  anchor: createModelSurfaceAnchor(nodeName, { x: 0.2, y: 1.1, z: -0.4 }, { x: 0, y: 0, z: 1 }),
});

/* ------------------------------------------------------------------ *
 * Vectores
 * ------------------------------------------------------------------ */

describe('vectores', () => {
  it('TEST-MHS-001 la longitud y el producto escalar son los de siempre', () => {
    expect(vectorLength({ x: 3, y: 4, z: 0 })).toBe(5);
    expect(dotProduct({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    expect(dotProduct({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toBe(32);
  });

  it('TEST-MHS-002 normalizar deja longitud uno', () => {
    const n = normalizeVector({ x: 3, y: 4, z: 0 });
    expect(vectorLength(n)).toBeCloseTo(1, 9);
  });

  it('TEST-MHS-003 un vector nulo no produce NaN', () => {
    // Pasa con una cara degenerada del modelo: un marcador mal orientado es
    // mejor que geometría inválida que el renderizador descarta en silencio.
    const n = normalizeVector({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(n.x)).toBe(true);
    expect(vectorLength(n)).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Anclaje
 * ------------------------------------------------------------------ */

describe('createModelSurfaceAnchor', () => {
  it('TEST-MHS-004 guarda la pieza, la posición local y la normal unitaria', () => {
    const anchor = createModelSurfaceAnchor(
      'valvula_01',
      { x: 0.2, y: 1.1, z: -0.4 },
      { x: 0, y: 0, z: 4 },
    );

    expect(anchor.space).toBe('modelSurface');
    expect(anchor.nodeName).toBe('valvula_01');
    expect(anchor.localPosition).toEqual({ x: 0.2, y: 1.1, z: -0.4 });
    // Normalizada: se guarda como dirección, no como longitud.
    expect(anchor.normal).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('TEST-MHS-005 la posición es local a la pieza, no del modelo', () => {
    // Es la decisión que hace que el marcador siga a una válvula animada en
    // lugar de quedarse flotando donde la válvula estaba.
    const anchor = createModelSurfaceAnchor('brazo', { x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(anchor.localPosition.y).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Cara visible
 * ------------------------------------------------------------------ */

describe('isFacingCamera', () => {
  const point = { x: 0, y: 0, z: 0 };

  it('TEST-MHS-006 de frente, se ve', () => {
    expect(isFacingCamera({ x: 0, y: 0, z: 1 }, point, { x: 0, y: 0, z: 10 })).toBe(true);
  });

  it('TEST-MHS-007 por detrás de la chapa, no se ve', () => {
    // Si se viera, diría que hay algo donde no se puede llegar.
    expect(isFacingCamera({ x: 0, y: 0, z: 1 }, point, { x: 0, y: 0, z: -10 })).toBe(false);
  });

  it('TEST-MHS-008 de canto se mantiene visible, para que no parpadee', () => {
    // Una superficie casi paralela a la vista haría aparecer y desaparecer el
    // marcador con cada grado de giro, y eso se lee como un fallo del visor.
    expect(isFacingCamera({ x: 0, y: 0, z: 1 }, point, { x: 10, y: 0, z: 0 })).toBe(true);
    // Un poco por detrás del canto todavía se tolera.
    expect(isFacingCamera({ x: 0, y: 0, z: 1 }, point, { x: 10, y: 0, z: -0.5 })).toBe(true);
    // Claramente por detrás, no.
    expect(isFacingCamera({ x: 0, y: 0, z: 1 }, point, { x: 1, y: 0, z: -5 })).toBe(false);
  });

  it('TEST-MHS-009 la cámara justo encima del marcador no rompe el cálculo', () => {
    expect(typeof isFacingCamera({ x: 0, y: 1, z: 0 }, point, point)).toBe('boolean');
  });
});

/* ------------------------------------------------------------------ *
 * Escala
 * ------------------------------------------------------------------ */

describe('stickerScale', () => {
  it('TEST-MHS-010 crece al acercarse y mengua al alejarse', () => {
    expect(stickerScale(2)).toBeGreaterThan(stickerScale(20));
  });

  it('TEST-MHS-011 tiene topes: ni tapa la pieza ni desaparece', () => {
    expect(stickerScale(0.01)).toBeLessThanOrEqual(1.6);
    expect(stickerScale(10_000)).toBeGreaterThanOrEqual(0.45);
  });

  it('TEST-MHS-012 una distancia imposible da el tope, no NaN', () => {
    expect(stickerScale(Number.NaN)).toBe(1.6);
    expect(stickerScale(-3)).toBe(1.6);
  });
});

/* ------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------ */

describe('validateModelHotspots', () => {
  it('TEST-MHS-013 un marcador pegado a una pieza que existe no da problemas', () => {
    const problems = validateModelHotspots([modelScene([surfaceHotspot(20)])], {
      meshNames: new Map([[testUuid(10), ['valvula_01', 'bomba']]]),
    });

    expect(problems).toEqual([]);
    expect(canPublishModelHotspots(problems)).toBe(true);
  });

  it('TEST-MHS-014 una pieza que el modelo ya no tiene impide publicar', () => {
    // Es el caso frecuente: el autor reexporta el CAD y la malla cambia de
    // nombre. El marcador se queda flotando y nadie se enteraría.
    const problems = validateModelHotspots([modelScene([surfaceHotspot(20, 'valvula_vieja')])], {
      meshNames: new Map([[testUuid(10), ['valvula_01', 'bomba']]]),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('blocking');
    expect(problems[0]?.message).toContain('valvula_vieja');
    expect(canPublishModelHotspots(problems)).toBe(false);
  });

  it('TEST-MHS-015 sin lista de mallas no se acusa en falso', () => {
    // El modelo puede no haberse abierto en esta sesión.
    const problems = validateModelHotspots([modelScene([surfaceHotspot(20)])], {
      meshNames: new Map(),
    });

    expect(problems).toEqual([]);
  });

  it('TEST-MHS-016 un marcador de superficie en una escena que no es de modelo se denuncia', () => {
    const problems = validateModelHotspots(
      [modelScene([surfaceHotspot(20)], { kind: 'panorama' })],
      { meshNames: new Map([[testUuid(10), ['valvula_01']]]) },
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('no es una escena de modelo');
  });

  it('TEST-MHS-017 los marcadores de panorámica no se revisan contra las mallas', () => {
    const problems = validateModelHotspots([makeScene(10, PROJECT, { kind: 'panorama' })], {
      meshNames: new Map([[testUuid(10), []]]),
    });

    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Enlace con panorámicas (L05)
 * ------------------------------------------------------------------ */

describe('panoramaLinksOf', () => {
  it('TEST-MHS-018 reconoce el marcador que lleva a otra escena', () => {
    const hotspot = {
      ...surfaceHotspot(20),
      actions: [
        actionSchema.parse({
          id: testUuid(90),
          event: 'click',
          config: {
            type: 'goToScene',
            sceneId: testUuid(11),
            entryMode: 'smart',
            transition: { kind: 'fade', durationMs: 600, useGeometry: false },
          },
        }),
      ],
    };

    const links = panoramaLinksOf(modelScene([hotspot]));
    expect(links).toHaveLength(1);
    expect(links[0]?.sceneId).toBe(testUuid(11));
  });

  it('TEST-MHS-019 un marcador sin acción de navegación no es un enlace', () => {
    expect(panoramaLinksOf(modelScene([surfaceHotspot(20)]))).toEqual([]);
  });

  it('TEST-MHS-020 un marcador de panorámica no cuenta como enlace del modelo', () => {
    // Lo que se busca son los que están pegados a una pieza: los de la esfera
    // ya los recorre el visor de panorámicas.
    const hotspot = {
      ...makeHotspot(21, testUuid(10)),
      actions: [
        actionSchema.parse({
          id: testUuid(91),
          event: 'click',
          config: {
            type: 'goToScene',
            sceneId: testUuid(11),
            entryMode: 'smart',
            transition: { kind: 'fade', durationMs: 600, useGeometry: false },
          },
        }),
      ],
    };

    expect(panoramaLinksOf(modelScene([hotspot]))).toEqual([]);
  });
});
