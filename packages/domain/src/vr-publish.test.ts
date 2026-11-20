/**
 * Pruebas del juego de panorámicas para visor inmersivo (N12).
 *
 * Los perfiles por clase de dispositivo existían y sólo servían para avisar en
 * el editor: la publicación entregaba las mismas imágenes para la pantalla y
 * para las gafas. Lo que se fija aquí es el plan de las copias reducidas, y
 * sobre todo cuándo **no** hay que escribir ninguna: una copia que no reduce
 * nada duplica el paquete y no mejora nada, y una entrada de manifiesto que
 * apunte a un archivo inexistente deja la escena en negro dentro del visor,
 * que es el peor sitio posible para un error.
 */
import { describe, expect, it } from 'vitest';

import { panoramaMetadataSchema, publishQualitySchema } from './media';
import {
  VR_MAX_PANORAMA_EDGE_PX,
  pathForVrProfile,
  planVrVariants,
  vrPanoramaMediaIds,
  vrVariantMap,
  vrVariantPath,
} from './vr-publish';
import { makeMedia, makeScene, testUuid } from './testing';

const PROJECT = testUuid(1);

/** Panorámica con las dimensiones indicadas. */
function pano(n: number, width: number, height: number, overrides = {}) {
  return makeMedia(n, {
    kind: 'image',
    mime: 'image/jpeg',
    relativePath: `media/escena-${n}.jpg`,
    width,
    height,
    panorama: panoramaMetadataSchema.parse({
      coverage: { horizontalDeg: 360, verticalDeg: 180, centerYaw: 0, centerPitch: 0 },
      equirectangular: true,
    }),
    ...overrides,
  });
}

const QUALITY = publishQualitySchema.parse({});

describe('vrPanoramaMediaIds', () => {
  it('toma los panoramas de las escenas publicadas', () => {
    // TEST-VRP-001: la sesión inmersiva recorre el mismo recorrido que la
    // pantalla, así que cualquier escena publicada puede acabar en las gafas.
    const scenes = [
      makeScene(10, PROJECT, { kind: 'panorama', mediaId: testUuid(80) }),
      makeScene(11, PROJECT, { kind: 'panorama', mediaId: testUuid(81) }),
    ];

    expect([...vrPanoramaMediaIds(scenes)]).toEqual([testUuid(80), testUuid(81)]);
  });

  it('deja fuera las escenas no publicables y las de modelo', () => {
    // TEST-VRP-002: reducir el panorama de una escena que no se publica es
    // peso que nadie descarga, y una escena de modelo no carga entorno.
    const scenes = [
      makeScene(12, PROJECT, {
        kind: 'panorama',
        mediaId: testUuid(82),
        excludedFromPublish: true,
      }),
      makeScene(13, PROJECT, { kind: 'model', mediaId: testUuid(83) }),
      makeScene(14, PROJECT, { kind: 'panorama', mediaId: null }),
    ];

    expect([...vrPanoramaMediaIds(scenes)]).toEqual([]);
  });
});

describe('planVrVariants', () => {
  const scenes = [makeScene(10, PROJECT, { kind: 'panorama', mediaId: testUuid(80) })];

  it('reduce la panorámica que no cabe en el tope del perfil', () => {
    // TEST-VRP-003: 12.000 px no es una textura que un visor autónomo admita;
    // el controlador la reduciría él mismo con un filtro peor, después de
    // haberla descargado entera.
    const plan = planVrVariants([pano(80, 12000, 6000)], scenes, QUALITY, 'standalone');

    expect(plan.variants).toHaveLength(1);
    const variant = plan.variants[0]!;
    expect(variant.maxEdgePx).toBe(VR_MAX_PANORAMA_EDGE_PX.standalone);
    expect(variant.width).toBe(4096);
    expect(variant.height).toBe(2048);
    expect(variant.relativePath).toBe('media/vr/standalone/escena-80.jpg');
  });

  it('no escribe copia cuando la imagen ya cabe', () => {
    // TEST-VRP-004: es la regla que evita el defecto de esta clase de
    // función. Una copia idéntica duplica el peso del paquete y no mejora
    // nada; el visor carga entonces la ruta plana.
    const plan = planVrVariants([pano(80, 4096, 2048)], scenes, QUALITY, 'standalone');

    expect(plan.variants).toEqual([]);
    expect(plan.skipped).toEqual([{ mediaId: testUuid(80), reason: 'cabe' }]);
    expect(plan.note).toMatch(/caben en 4096/);
  });

  it('el perfil conectado admite el doble de lado', () => {
    // TEST-VRP-005: una imagen de 8192 px cabe en un visor conectado a un PC
    // y no en uno autónomo. Si los dos perfiles dieran lo mismo, tenerlos dos
    // no significaría nada.
    const media = [pano(80, 8192, 4096)];

    expect(planVrVariants(media, scenes, QUALITY, 'tethered').variants).toEqual([]);
    expect(planVrVariants(media, scenes, QUALITY, 'standalone').variants).toHaveLength(1);
  });

  it('conserva la proporción al reducir una panorámica parcial', () => {
    // TEST-VRP-006: una panorámica de cobertura parcial no es 2:1. Si se
    // forzara esa proporción, la imagen saldría estirada dentro del visor.
    const plan = planVrVariants([pano(80, 9000, 9000)], scenes, QUALITY, 'standalone');

    const variant = plan.variants[0]!;
    expect(variant.width).toBe(4096);
    expect(variant.height).toBe(4096);
  });

  it('no planifica nada sin dimensiones conocidas y lo dice', () => {
    // TEST-VRP-007: sin dimensiones no se puede saber si hay que reducir, y
    // reducir a ciegas podría agrandar la imagen, que es justo lo que el
    // codificador tiene prohibido hacer. Se publica entera y se avisa.
    const plan = planVrVariants(
      [pano(80, 12000, 6000), pano(81, null as unknown as number, null as unknown as number)],
      [
        ...scenes,
        makeScene(11, PROJECT, { kind: 'panorama', mediaId: testUuid(81) }),
      ],
      QUALITY,
      'standalone',
    );

    expect(plan.variants.map((v) => v.mediaId)).toEqual([testUuid(80)]);
    expect(plan.skipped).toContainEqual({ mediaId: testUuid(81), reason: 'sinDimensiones' });
    expect(plan.note).toMatch(/no se conocen sus dimensiones/);
  });

  it('ignora lo que no es panorama de una escena', () => {
    // TEST-VRP-008: la imagen de un plano, un documento o un audio no se
    // cargan como entorno; una copia reducida de ellos no la lee nadie.
    const plan = planVrVariants(
      [pano(80, 12000, 6000), pano(85, 12000, 6000)],
      scenes,
      QUALITY,
      'standalone',
    );

    expect(plan.variants.map((v) => v.mediaId)).toEqual([testUuid(80)]);
    expect(plan.skipped).toContainEqual({ mediaId: testUuid(85), reason: 'noEsEscena' });
  });

  it('sin escenas panorámicas no hay juego que preparar', () => {
    // TEST-VRP-009: un recorrido de sólo modelos no necesita panorámicas
    // reducidas, y el aviso tiene que decir eso y no «todas caben».
    const plan = planVrVariants(
      [pano(80, 12000, 6000)],
      [makeScene(13, PROJECT, { kind: 'model', mediaId: testUuid(83) })],
      QUALITY,
      'standalone',
    );

    expect(plan.variants).toEqual([]);
    expect(plan.note).toMatch(/ninguna escena panorámica/i);
  });

  it('hereda formato y calidad de los ajustes del proyecto', () => {
    // TEST-VRP-010: la variante es la misma imagen más pequeña. Codificarla
    // con otra calidad sería una decisión que el autor no ha tomado.
    const quality = publishQualitySchema.parse({ quality: 70 });
    const plan = planVrVariants([pano(80, 12000, 6000)], scenes, quality, 'standalone');

    expect(plan.variants[0]!.quality).toBe(70);
    expect(plan.variants[0]!.mime).toBe('image/jpeg');
  });
});

describe('rutas y mapa del manifiesto', () => {
  it('la variante va en una carpeta por perfil junto a su original', () => {
    // TEST-VRP-011: quien abra el paquete tiene que ver de qué imagen es cada
    // copia sin leer el manifiesto.
    expect(vrVariantPath('media/escena-1.jpg', 'standalone')).toBe(
      'media/vr/standalone/escena-1.jpg',
    );
    expect(vrVariantPath('escena-1.jpg', 'tethered')).toBe('vr/tethered/escena-1.jpg');
  });

  it('el mapa reúne los dos perfiles del mismo medio', () => {
    // TEST-VRP-012: el visor resuelve con una sola consulta por escena.
    const scenes = [makeScene(10, PROJECT, { kind: 'panorama', mediaId: testUuid(80) })];
    const media = [pano(80, 16000, 8000)];
    const map = vrVariantMap([
      planVrVariants(media, scenes, QUALITY, 'standalone'),
      planVrVariants(media, scenes, QUALITY, 'tethered'),
    ]);

    expect(map[testUuid(80)]).toEqual({
      standalone: 'media/vr/standalone/escena-80.jpg',
      tethered: 'media/vr/tethered/escena-80.jpg',
    });
  });

  it('sin variante se devuelve la ruta plana, no una inventada', () => {
    // TEST-VRP-013: devolver `null` o una ruta construida a mano dejaría la
    // escena en negro dentro de las gafas. La ruta plana siempre existe.
    const map = { [testUuid(80)]: { standalone: 'media/vr/standalone/a.jpg' } };

    expect(pathForVrProfile(map, testUuid(80), 'standalone', 'media/a.jpg')).toBe(
      'media/vr/standalone/a.jpg',
    );
    expect(pathForVrProfile(map, testUuid(80), 'tethered', 'media/a.jpg')).toBe('media/a.jpg');
    expect(pathForVrProfile(map, testUuid(99), 'standalone', 'media/b.jpg')).toBe('media/b.jpg');
  });
});
