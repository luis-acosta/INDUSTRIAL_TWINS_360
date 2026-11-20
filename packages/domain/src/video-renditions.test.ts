/**
 * Pruebas de la elección de versión de vídeo (V04).
 *
 * El caso que esto resuelve: un vídeo de proceso en 4K pesa cientos de
 * megabytes y en una tableta de planta con red compartida no empieza a
 * reproducirse. El proyecto puede llevar varias versiones y hasta ahora se
 * entregaba siempre la principal, de modo que tenerlas no servía de nada.
 *
 * Lo que se fija aquí, por orden de importancia:
 *
 *  1. Que el ahorro de datos y una red lenta manden sobre el criterio de
 *     calidad: son peticiones explícitas o condiciones medidas, y pasar por
 *     encima de ellas es decidir por el visitante.
 *  2. Que la ausencia de información —`navigator.connection` no existe en todos
 *     los navegadores— no se trate como red lenta.
 *  3. Que un proyecto con una sola versión siga entregándola, sin inventar
 *     escalones.
 */
import { describe, expect, it } from 'vitest';

import {
  MIN_RENDITION_HEIGHT_PX,
  readSelectionContext,
  renditionLadder,
  renditionWarnings,
  selectRendition,
  type SelectionContext,
  type VideoRendition,
} from './video-renditions';
import { makeMedia, testUuid } from './testing';

/** Vídeo con la altura indicada. */
function video(n: number, heightPx: number, overrides = {}) {
  return makeMedia(n, {
    kind: 'video',
    mime: 'video/mp4',
    relativePath: `media/video-${heightPx}.mp4`,
    originalName: `arranque-${heightPx}p.mp4`,
    width: Math.round((heightPx * 16) / 9),
    height: heightPx,
    durationS: 92,
    ...overrides,
  });
}

const MASTER = video(70, 2160);
const V1080 = video(71, 1080);
const V720 = video(72, 720);
const V360 = video(73, 360);

const LADDER: VideoRendition[] = [
  { mediaId: V720.id, heightPx: 720 },
  { mediaId: V360.id, heightPx: 360 },
  { mediaId: V1080.id, heightPx: 1080 },
];

const BY_ID = new Map([MASTER, V1080, V720, V360].map((m) => [m.id, m]));

function context(overrides: Partial<SelectionContext> = {}): SelectionContext {
  return {
    device: 'desktop',
    viewportHeightPx: 900,
    saveData: false,
    effectiveType: null,
    ...overrides,
  };
}

describe('renditionLadder', () => {
  it('ordena de menor a mayor e incluye el principal como escalón más alto', () => {
    // TEST-VRN-001: el autor añade las versiones en el orden en que las
    // exporta. Elegir «la primera que cabe» sobre una lista sin ordenar daría
    // resultados distintos para el mismo proyecto según cómo se guardó.
    const ladder = renditionLadder(MASTER, LADDER, BY_ID);

    expect(ladder.map((step) => step.heightPx)).toEqual([360, 720, 1080, 2160]);
    expect(ladder.at(-1)?.media.id).toBe(MASTER.id);
  });

  it('descarta las que no están, las que no son vídeo y las diminutas', () => {
    // TEST-VRN-002: una referencia rota no puede convertirse en un escalón, o
    // el visor pediría un archivo que el paquete no lleva.
    const notVideo = makeMedia(74, { kind: 'image', mime: 'image/jpeg' });
    const ladder = renditionLadder(
      MASTER,
      [
        { mediaId: testUuid(99), heightPx: 480 },
        { mediaId: notVideo.id, heightPx: 480 },
        { mediaId: V360.id, heightPx: MIN_RENDITION_HEIGHT_PX - 1 },
      ],
      new Map([...BY_ID, [notVideo.id, notVideo]]),
    );

    expect(ladder.map((step) => step.heightPx)).toEqual([2160]);
  });
});

describe('selectRendition', () => {
  it('en escritorio elige la que cubre la pantalla, no la mayor', () => {
    // TEST-VRN-003: un vídeo con el doble de altura que su hueco no se ve
    // mejor —la pantalla no tiene píxeles donde ponerlo— y cuesta el doble de
    // descarga.
    const chosen = selectRendition(MASTER, LADDER, BY_ID, context({ viewportHeightPx: 600 }));

    expect(chosen.id).toBe(V1080.id);
  });

  it('en móvil no pasa de 720p aunque la pantalla sea densa', () => {
    // TEST-VRN-004: el techo por dispositivo es el que evita el caso real de
    // un teléfono de gama media que decodifica a saltos.
    const chosen = selectRendition(
      MASTER,
      LADDER,
      BY_ID,
      context({ device: 'mobile', viewportHeightPx: 900 }),
    );

    expect(chosen.id).toBe(V720.id);
  });

  it('el ahorro de datos manda sobre la calidad', () => {
    // TEST-VRN-005: es una petición explícita del visitante. Darle la versión
    // buena «porque su pantalla puede» es gastarle sus datos.
    const chosen = selectRendition(
      MASTER,
      LADDER,
      BY_ID,
      context({ device: 'desktop', viewportHeightPx: 1400, saveData: true }),
    );

    expect(chosen.id).toBe(V360.id);
  });

  it('una red lenta baja al escalón más bajo', () => {
    // TEST-VRN-006: en una red 3G compartida de planta, un 1080p no arranca.
    expect(
      selectRendition(MASTER, LADDER, BY_ID, context({ effectiveType: '3g' })).id,
    ).toBe(V360.id);
    expect(
      selectRendition(MASTER, LADDER, BY_ID, context({ effectiveType: 'slow-2g' })).id,
    ).toBe(V360.id);
  });

  it('no saber la red no es tenerla lenta', () => {
    // TEST-VRN-007: `navigator.connection` no existe en todos los navegadores.
    // Suponer lo peor entregaría un vídeo borroso a quien tiene fibra, y el
    // visitante no tendría forma de pedir el bueno.
    const chosen = selectRendition(
      MASTER,
      LADDER,
      BY_ID,
      context({ effectiveType: null, viewportHeightPx: 1400 }),
    );

    expect(chosen.id).toBe(MASTER.id);
  });

  it('en el visor inmersivo no pasa de 1080p', () => {
    // TEST-VRN-008: el vídeo va a una textura de panel; más allá de 1080 no se
    // distingue y cuesta presupuesto de fotograma que hace falta para sostener
    // los 72 fps.
    const chosen = selectRendition(
      MASTER,
      LADDER,
      BY_ID,
      context({ device: 'vr', viewportHeightPx: 2000 }),
    );

    expect(chosen.id).toBe(V1080.id);
  });

  it('sin versiones entrega el vídeo principal', () => {
    // TEST-VRN-009: es el caso normal de un vídeo pequeño. No hay nada que
    // elegir y no se debe inventar un escalón que no existe.
    expect(selectRendition(MASTER, [], new Map(), context()).id).toBe(MASTER.id);
  });

  it('si ninguna llega al techo, la mayor disponible', () => {
    // TEST-VRN-010: es lo mejor que hay. Devolver la más baja porque «ninguna
    // cumple» dejaría un vídeo borroso en una pantalla grande.
    const chosen = selectRendition(
      V720,
      [{ mediaId: V360.id, heightPx: 360 }],
      BY_ID,
      context({ viewportHeightPx: 1400 }),
    );

    expect(chosen.id).toBe(V720.id);
  });
});

describe('readSelectionContext', () => {
  it('lee el ahorro de datos y el tipo de red cuando el navegador los da', () => {
    // TEST-VRN-011
    const nav = {
      connection: { saveData: true, effectiveType: '4g' },
    } as unknown as Navigator;

    expect(readSelectionContext(nav, 'tablet', 800)).toEqual({
      device: 'tablet',
      viewportHeightPx: 800,
      saveData: true,
      effectiveType: '4g',
    });
  });

  it('sin `connection` no inventa nada', () => {
    // TEST-VRN-012: la ausencia es «no sé», y el selector ya sabe qué hacer
    // con eso. Rellenarlo aquí con un valor plausible escondería el caso.
    expect(readSelectionContext({} as Navigator, 'desktop', 1080)).toEqual({
      device: 'desktop',
      viewportHeightPx: 1080,
      saveData: false,
      effectiveType: null,
    });
  });
});

describe('renditionWarnings', () => {
  it('pide la versión que falta, con la resolución concreta', () => {
    // TEST-VRN-013: «exporte una versión de 720p» se puede hacer; «el vídeo es
    // grande» no.
    const warnings = renditionWarnings(MASTER, [], BY_ID);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/720p/);
  });

  it('calla cuando ya hay escalera', () => {
    // TEST-VRN-014: un aviso que aparece cuando no hay nada que hacer enseña a
    // ignorar los avisos.
    expect(renditionWarnings(MASTER, LADDER, BY_ID)).toEqual([]);
  });

  it('avisa de una versión que no dura lo mismo', () => {
    // TEST-VRN-015: una versión que no es el mismo vídeo cambia lo que se ve
    // según el dispositivo, y eso no se descubre hasta que alguien lo abre en
    // el dispositivo equivocado. Es el fallo más difícil de encontrar de todos
    // los de esta función.
    const other = video(75, 720, { durationS: 40, originalName: 'otro-720p.mp4' });
    const warnings = renditionWarnings(
      MASTER,
      [{ mediaId: other.id, heightPx: 720 }],
      new Map([...BY_ID, [other.id, other]]),
    );

    expect(warnings.some((w) => /no parecen el mismo vídeo/.test(w))).toBe(true);
  });

  it('avisa de una versión ausente de la biblioteca', () => {
    // TEST-VRN-016: se publica sin ella y se dice; callarlo dejaría al autor
    // creyendo que la entrega está optimizada cuando no lo está.
    const warnings = renditionWarnings(MASTER, [{ mediaId: testUuid(99), heightPx: 720 }], BY_ID);

    expect(warnings.some((w) => /no está en la biblioteca/.test(w))).toBe(true);
  });
});
