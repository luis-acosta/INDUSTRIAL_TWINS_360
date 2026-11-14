/**
 * Pruebas del plan de publicación de imágenes (V01, V02).
 *
 * Existen por una promesa que no se cumplía: el editor dejaba elegir formato,
 * calidad, lado máximo y teselado, y la publicación copiaba los originales tal
 * cual. Lo que se vigila aquí es que el plan diga la verdad sobre lo que va a
 * pasar, incluido cuando no se puede hacer lo pedido.
 */
import { describe, expect, it } from 'vitest';
import {
  ENCODABLE_FORMATS,
  estimateBytes,
  MAX_TILES_PER_IMAGE,
  MIN_TILED_EDGE_PX,
  planImage,
  planImages,
  planTiles,
  scaledSize,
  totalTileCount,
} from './publish-plan';
import { PUBLISH_PROFILES, publishQualitySchema, type PublishQuality } from './media';
import { makeMedia } from './testing';

const quality = (over: Partial<PublishQuality> = {}): PublishQuality =>
  publishQualitySchema.parse({ ...over });

const panorama = (over = {}) =>
  makeMedia(80, {
    kind: 'image',
    mime: 'image/jpeg',
    relativePath: 'media/panoramas/sala.jpg',
    width: 12_000,
    height: 6_000,
    byteSize: 24_000_000,
    ...over,
  });

describe('scaledSize', () => {
  it('TEST-PUP-001 respeta el lado máximo y la relación de aspecto', () => {
    // Una panorámica equirrectangular deformada no se puede proyectar.
    const size = scaledSize(panorama(), 8_192);
    expect(size).toEqual({ width: 8_192, height: 4_096 });
  });

  it('TEST-PUP-002 no agranda una imagen pequeña', () => {
    const size = scaledSize(panorama({ width: 2_000, height: 1_000 }), 8_192);
    expect(size).toEqual({ width: 2_000, height: 1_000 });
  });

  it('TEST-PUP-003 cero significa no reescalar', () => {
    expect(scaledSize(panorama(), 0)).toEqual({ width: 12_000, height: 6_000 });
  });

  it('TEST-PUP-004 sin dimensiones conocidas no se decide un tamaño', () => {
    expect(scaledSize(panorama({ width: null, height: null }), 4_096)).toBeNull();
  });
});

describe('planTiles', () => {
  it('TEST-PUP-005 el nivel cero cubre la imagen entera', () => {
    const tiles = planTiles('media/p/sala', { width: 1_024, height: 512 }, 512, '.webp');
    const level0 = tiles.filter((tile) => tile.level === 0);

    expect(level0).toHaveLength(2);
    expect(level0.map((tile) => tile.relativePath)).toEqual([
      'media/p/sala/l0/0_0.webp',
      'media/p/sala/l0/0_1.webp',
    ]);
  });

  it('TEST-PUP-006 los niveles bajan hasta caber en una tesela', () => {
    const tiles = planTiles('p', { width: 2_048, height: 1_024 }, 512, '.webp');
    const levels = [...new Set(tiles.map((tile) => tile.level))];

    expect(levels).toEqual([0, 1, 2]);
    expect(tiles.filter((tile) => tile.level === 2)).toHaveLength(1);
  });

  it('TEST-PUP-007 la última tesela de cada fila se recorta, no se desborda', () => {
    // Una tesela que pide píxeles que no existen hace fallar al codificador.
    const tiles = planTiles('p', { width: 700, height: 300 }, 512, '.webp');
    const last = tiles.find((tile) => tile.level === 0 && tile.column === 1);

    expect(last?.sourceWidth).toBe(188);
    expect(last?.sourceHeight).toBe(300);
  });

  it('TEST-PUP-008 un valor absurdo de tesela no genera teselas sin fin', () => {
    // 30.000 px con teselas de 64 daría ciento diez mil archivos en el primer
    // nivel: no es una publicación lenta, es una que no termina.
    // Se cuenta antes de construir: contar es aritmética, construir son cien
    // mil objetos que se comen la memoria.
    expect(totalTileCount({ width: 30_000, height: 15_000 }, 64)).toBeGreaterThan(
      MAX_TILES_PER_IMAGE,
    );
    expect(planTiles('p', { width: 30_000, height: 15_000 }, 64, '.webp')).toEqual([]);
  });

  it('TEST-PUP-008b pasado el tope se publica sin teselar y se dice', () => {
    const plan = planImage(
      panorama({ width: 30_000, height: 15_000 }),
      quality({ tiled: true, tileSizePx: 256, maxEdgePx: 0 }),
    );

    expect(plan.tiles).toEqual([]);
    expect(plan.note).toContain('sin teselar');
  });
});

describe('planImage', () => {
  it('TEST-PUP-009 una panorámica grande se reescala, recodifica y tesela', () => {
    const plan = planImage(panorama(), quality({ format: 'webp', maxEdgePx: 8_192, tiled: true }));

    expect(plan.action).toBe('encode');
    expect(plan.format).toBe('webp');
    expect(plan.width).toBe(8_192);
    expect(plan.relativePath).toBe('media/panoramas/sala.webp');
    expect(plan.tiles.length).toBeGreaterThan(0);
    // WebP aquí es sin pérdida, y se dice: prometer «ligero» y entregar
    // «exacto y más grande» sería descubrirlo al subir el paquete.
    expect(plan.note).toContain('sin pérdida');
  });

  it('TEST-PUP-009b en JPEG no sobra ninguna advertencia', () => {
    const plan = planImage(panorama(), quality({ format: 'jpeg', maxEdgePx: 8_192, tiled: true }));

    expect(plan.action).toBe('encode');
    expect(plan.relativePath).toBe('media/panoramas/sala.jpg');
    expect(plan.note).toBeNull();
  });

  it('TEST-PUP-009c el perfil compacto estima menos que el original', () => {
    // El defecto que esto cierra: «compacto» era WebP con calidad 72, y el
    // codificador es sin pérdida, así que publicaba paquetes más grandes que
    // el original. Exactamente lo contrario de lo que promete.
    const media = panorama();
    const plan = planImage(media, PUBLISH_PROFILES.compact);

    expect(plan.format).toBe('jpeg');
    expect(estimateBytes(media, plan)).toBeLessThan(media.byteSize);
  });

  it('TEST-PUP-009d el perfil de fidelidad es exacto, aunque pese más', () => {
    const media = panorama();
    const plan = planImage(media, PUBLISH_PROFILES.fidelity);

    expect(plan.format).toBe('webp');
    expect(plan.width).toBe(media.width);
    expect(estimateBytes(media, plan)).toBeGreaterThan(media.byteSize);
  });

  it('TEST-PUP-010 AVIF se pide, se publica WebP y se dice', () => {
    // Antes aceptar la elección y entregar otra cosa en silencio.
    const plan = planImage(panorama(), quality({ format: 'avif' }));

    expect(plan.format).toBe('webp');
    expect(plan.note).toContain('AVIF');
    expect(ENCODABLE_FORMATS).not.toContain('avif');
  });

  it('TEST-PUP-011 PNG ignora la calidad, porque es sin pérdida', () => {
    const plan = planImage(panorama(), quality({ format: 'png', quality: 40 }));
    expect(plan.quality).toBe(100);
  });

  it('TEST-PUP-012 una imagen pequeña no se tesela', () => {
    // La pirámide no compensa: son más peticiones para la misma imagen.
    const plan = planImage(
      panorama({ width: 1_600, height: 800 }),
      quality({ tiled: true, includeFallback: false }),
    );

    expect(plan.tiles).toEqual([]);
    expect(MIN_TILED_EDGE_PX).toBeGreaterThan(1_600);
  });

  it('TEST-PUP-013 si no hay nada que mejorar se copia, no se recodifica', () => {
    // Recodificar para dejarlo igual sólo le quita calidad.
    const plan = planImage(
      panorama({ mime: 'image/webp', relativePath: 'media/p/sala.webp', width: 1_200, height: 600 }),
      quality({ format: 'webp', tiled: true, includeFallback: false, maxEdgePx: 8_192 }),
    );

    expect(plan.action).toBe('copy');
    expect(plan.relativePath).toBe('media/p/sala.webp');
  });

  it('TEST-PUP-014 el respaldo JPEG se planifica para los formatos modernos', () => {
    const plan = planImage(panorama(), quality({ format: 'webp', includeFallback: true }));

    expect(plan.fallback?.relativePath).toBe('media/panoramas/sala.jpg');
    // La calidad del respaldo se acota: su razón de ser es compatibilidad, no
    // fidelidad, y duplicar el peso del paquete por él sería absurdo.
    expect(plan.fallback?.quality).toBeLessThanOrEqual(85);
  });

  it('TEST-PUP-015 publicando ya en JPEG no se añade un respaldo JPEG', () => {
    const plan = planImage(panorama(), quality({ format: 'jpeg', includeFallback: true }));
    expect(plan.fallback).toBeNull();
  });

  it('TEST-PUP-016 lo que no es una imagen se copia y se dice por qué', () => {
    const plan = planImage(
      makeMedia(81, { kind: 'model', mime: 'model/gltf-binary', relativePath: 'media/m/u.glb' }),
      quality(),
    );

    expect(plan.action).toBe('copy');
    expect(plan.note).toBe('no es una imagen');
  });

  it('TEST-PUP-017 sin dimensiones conocidas se recodifica sin reescalar', () => {
    const plan = planImage(panorama({ width: null, height: null }), quality({ maxEdgePx: 4_096 }));

    expect(plan.action).toBe('encode');
    expect(plan.width).toBeNull();
    expect(plan.tiles).toEqual([]);
  });

  it('TEST-PUP-018 los tres perfiles producen planes distintos', () => {
    const small = planImage(panorama(), PUBLISH_PROFILES.compact);
    const balanced = planImage(panorama(), PUBLISH_PROFILES.balanced);
    const fidelity = planImage(panorama(), PUBLISH_PROFILES.fidelity);

    expect(estimateBytes(panorama(), small)).toBeLessThan(estimateBytes(panorama(), balanced));
    expect(estimateBytes(panorama(), balanced)).toBeLessThanOrEqual(
      estimateBytes(panorama(), fidelity),
    );
  });
});

describe('planImages', () => {
  it('TEST-PUP-019 conserva el orden del proyecto', () => {
    const a = panorama({ relativePath: 'media/a.jpg' });
    const b = makeMedia(82, { kind: 'image', mime: 'image/png', relativePath: 'media/b.png' });

    const plans = planImages([a, b], quality());
    expect(plans.map((plan) => plan.mediaId)).toEqual([a.id, b.id]);
  });
});

describe('estimateBytes', () => {
  it('TEST-PUP-020 reescalar y recodificar estima menos peso', () => {
    const media = panorama();
    const plan = planImage(media, quality({ format: 'webp', maxEdgePx: 4_096 }));

    expect(estimateBytes(media, plan)).toBeLessThan(media.byteSize);
  });

  it('TEST-PUP-021 copiar estima exactamente lo que ocupa', () => {
    // Sin inventar: si no se toca, el peso se conoce.
    const media = panorama({ mime: 'image/webp', relativePath: 'media/p.webp', width: 900, height: 450 });
    const plan = planImage(media, quality({ format: 'webp', includeFallback: false }));

    expect(estimateBytes(media, plan)).toBe(media.byteSize);
  });

  it('TEST-PUP-022 PNG puede pesar más que el original, y se estima así', () => {
    // Un PNG de una fotografía es mayor que su JPEG: el autor tiene que poder
    // verlo antes de publicar cuatro gigabytes.
    const media = panorama();
    const plan = planImage(media, quality({ format: 'png' }));

    expect(estimateBytes(media, plan)).toBeGreaterThan(media.byteSize * 0.5);
  });
});
