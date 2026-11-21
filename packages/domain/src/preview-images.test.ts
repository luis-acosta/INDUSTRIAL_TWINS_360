/**
 * Pruebas de las vistas previas de las panorámicas (S08).
 *
 * Qué se está arreglando, dicho en lo que se siente: una panorámica de planta
 * pesa entre ocho y veinte megabytes, y hasta que llega entera la escena está
 * en negro. En la red de una oficina son dos segundos; en la de una planta, con
 * el teléfono en el mismo punto de acceso que los terminales de mantenimiento,
 * son quince o veinte, y eso ocurre en **cada** cambio de escena.
 *
 * Y la regla que esta clase de función suele incumplir: no se escribe una copia
 * que no aporta. Dos archivos iguales en el paquete cuestan al autor y no le dan
 * nada.
 */
import { describe, expect, it } from 'vitest';

import {
  PREVIEW_MAX_EDGE_PX,
  PREVIEW_QUALITY,
  planPreviews,
  previewFor,
  previewPath,
} from './preview-images';
import { makeMedia, makeScene, testUuid } from './testing';

const PROJECT = testUuid(1);

function pano(n: number, width: number | null, height: number | null) {
  return makeMedia(n, {
    kind: 'image',
    mime: 'image/jpeg',
    relativePath: `media/escena-${n}.jpg`,
    width,
    height,
  });
}

describe('previewPath', () => {
  it('va en su carpeta, junto al original y siempre en JPEG', () => {
    // TEST-PRV-001: JPEG porque todo navegador lo decodifica rápido; en una
    // imagen de 1024 px la ventaja de WebP no compensa arrastrar dos rutas de
    // decodificación distintas para el primer segundo de cada escena.
    expect(previewPath('media/escena-1.webp')).toBe('media/preview/escena-1.jpg');
    expect(previewPath('escena-1.jpg')).toBe('preview/escena-1.jpg');
  });
});

describe('planPreviews', () => {
  const scenes = [makeScene(10, PROJECT, { kind: 'panorama', mediaId: testUuid(80) })];

  it('planifica la vista previa de una panorámica grande', () => {
    // TEST-PRV-002
    const plan = planPreviews([pano(80, 12000, 6000)], scenes);

    expect(plan.previews).toHaveLength(1);
    const preview = plan.previews[0]!;
    expect(preview.width).toBe(PREVIEW_MAX_EDGE_PX);
    expect(preview.height).toBe(PREVIEW_MAX_EDGE_PX / 2);
    expect(preview.quality).toBe(PREVIEW_QUALITY);
    expect(preview.relativePath).toBe('media/preview/escena-80.jpg');
  });

  it('no escribe copia de una panorámica que ya es pequeña', () => {
    // TEST-PRV-003: llega en el primer segundo por sí misma, y una copia sería
    // peso en el paquete a cambio de nada.
    const plan = planPreviews([pano(80, 1024, 512)], scenes);

    expect(plan.previews).toEqual([]);
    expect(plan.skipped).toEqual([{ mediaId: testUuid(80), reason: 'cabe' }]);
    expect(plan.note).toMatch(/ya son pequeñas/);
  });

  it('sin dimensiones conocidas lo dice en lugar de reducir a ciegas', () => {
    // TEST-PRV-004: reducir sin saber el tamaño podría agrandar la imagen. La
    // escena cargará como antes: más lenta, no rota, y el autor sabe cuál.
    const plan = planPreviews(
      [pano(80, 12000, 6000), pano(81, null, null)],
      [...scenes, makeScene(11, PROJECT, { kind: 'panorama', mediaId: testUuid(81) })],
    );

    expect(plan.previews.map((entry) => entry.mediaId)).toEqual([testUuid(80)]);
    expect(plan.skipped).toContainEqual({ mediaId: testUuid(81), reason: 'sinDimensiones' });
    expect(plan.note).toMatch(/no se conocen sus dimensiones/);
  });

  it('conserva la proporción de una panorámica parcial', () => {
    // TEST-PRV-005: una panorámica de cobertura parcial no es 2:1, y una vista
    // previa estirada desorienta más que una pantalla en negro.
    const plan = planPreviews([pano(80, 8000, 8000)], scenes);

    expect(plan.previews[0]).toMatchObject({
      width: PREVIEW_MAX_EDGE_PX,
      height: PREVIEW_MAX_EDGE_PX,
    });
  });

  it('sólo de las panorámicas de escenas publicadas', () => {
    // TEST-PRV-006: la imagen de un plano o la foto de una ventana de
    // información no bloquean la entrada a una escena, que es el momento que
    // esto mejora. Y una escena excluida no se abre nunca.
    const plan = planPreviews(
      [pano(80, 12000, 6000), pano(85, 12000, 6000), pano(86, 12000, 6000)],
      [
        ...scenes,
        makeScene(12, PROJECT, {
          kind: 'panorama',
          mediaId: testUuid(85),
          excludedFromPublish: true,
        }),
      ],
    );

    expect(plan.previews.map((entry) => entry.mediaId)).toEqual([testUuid(80)]);
  });

  it('un recorrido sin panorámicas no produce aviso', () => {
    // TEST-PRV-007: un aviso sobre vistas previas en un recorrido de sólo
    // modelos es ruido que enseña a ignorar los avisos.
    const plan = planPreviews([], [makeScene(13, PROJECT, { kind: 'model' })]);

    expect(plan.previews).toEqual([]);
    expect(plan.note).toBeNull();
  });

  it('el tope está donde la escena todavía se reconoce', () => {
    // TEST-PRV-008: 1024 px es lo que hace falta para orientarse al girar.
    // Por debajo, las paredes y los equipos son manchas y la vista previa deja
    // de servir para lo único que tiene que hacer.
    expect(PREVIEW_MAX_EDGE_PX).toBe(1024);
  });
});

describe('previewFor', () => {
  it('devuelve la ruta declarada', () => {
    // TEST-PRV-009
    expect(previewFor({ [testUuid(80)]: 'media/preview/a.jpg' }, testUuid(80))).toBe(
      'media/preview/a.jpg',
    );
  });

  it('sin vista previa devuelve null y no una ruta construida a mano', () => {
    // TEST-PRV-010: es el caso frecuente —una panorámica pequeña no tiene
    // copia—. Una ruta inventada haría que cada escena sin vista previa
    // empezara con un 404, perdiendo justo el tiempo que esto ahorra.
    expect(previewFor({}, testUuid(80))).toBeNull();
    expect(previewFor({ [testUuid(80)]: 'x.jpg' }, null)).toBeNull();
  });
});
