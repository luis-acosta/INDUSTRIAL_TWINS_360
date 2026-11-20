/**
 * Pruebas de los espacios de coordenadas compartidos (L11).
 *
 * El campo `coordinateSpaceId` existía desde la etapa 08 y no lo leía nadie:
 * el autor podía declararlo y la vista se reiniciaba igual al cambiar de
 * modelo. Lo que se fija aquí es cuándo la vista se conserva y, sobre todo,
 * cuándo no: conservarla entre dos modelos sin relación dejaría la cámara
 * dentro de una pared, que es peor que reiniciarla.
 */
import { describe, expect, it } from 'vitest';

import { modelSettingsSchema, type Scene } from './scene';
import { sharesCoordinateSpace, scenesInSameSpace, viewForEntering } from './model-space';
import { makeScene, testUuid } from './testing';

const PROJECT = testUuid(1);

function modelScene(index: number, spaceId: string | null, title = `Modelo ${index}`): Scene {
  const base = makeScene(index, PROJECT, { title, kind: 'model' });
  return {
    ...base,
    kind: 'model',
    model: { ...modelSettingsSchema.parse({}), coordinateSpaceId: spaceId },
  };
}

function panorama(index: number): Scene {
  return makeScene(index, PROJECT, { title: `Panorámica ${index}` });
}

const VIEW = { position: [1, 2, 3], target: [0, 0, 0], fov: 50 } as const;

describe('sharesCoordinateSpace', () => {
  it('dos modelos con el mismo espacio son compatibles', () => {
    // TEST-MSP-001: es el caso que esto resuelve: la carcasa cerrada y el
    // despiece interior del mismo equipo.
    expect(sharesCoordinateSpace(modelScene(10, 'u200'), modelScene(11, 'u200'))).toBe(true);
  });

  it('dos modelos con espacios distintos no lo son', () => {
    // TEST-MSP-002: son dos equipos distintos; conservar la vista pondría la
    // cámara a cien metros del segundo.
    expect(sharesCoordinateSpace(modelScene(10, 'u200'), modelScene(11, 'u300'))).toBe(false);
  });

  it('un espacio sin declarar no es compatible con nada, ni consigo mismo', () => {
    // TEST-MSP-003: nulo significa «no lo sé», y tratar dos «no lo sé» como
    // iguales conservaría la vista entre modelos sin relación. Que dos
    // exportaciones compartan origen y escala no se puede deducir del
    // archivo: lo tiene que declarar el autor.
    expect(sharesCoordinateSpace(modelScene(10, null), modelScene(11, null))).toBe(false);
    expect(sharesCoordinateSpace(modelScene(10, 'u200'), modelScene(11, null))).toBe(false);
    expect(sharesCoordinateSpace(modelScene(10, null), modelScene(11, 'u200'))).toBe(false);
  });

  it('una panorámica nunca es compatible', () => {
    // TEST-MSP-004: una vista de modelo —posición, objetivo y campo— no
    // significa nada donde la cámara está en el centro de una esfera.
    expect(sharesCoordinateSpace(modelScene(10, 'u200'), panorama(12))).toBe(false);
    expect(sharesCoordinateSpace(panorama(12), modelScene(10, 'u200'))).toBe(false);
  });

  it('una escena de modelo sin ajustes no es compatible', () => {
    // TEST-MSP-005: ocurre con una escena a medio configurar, y leer un
    // espacio de unos ajustes que no existen sería un fallo en ejecución.
    const incomplete: Scene = { ...modelScene(10, 'u200'), model: null };
    expect(sharesCoordinateSpace(incomplete, modelScene(11, 'u200'))).toBe(false);
  });
});

describe('scenesInSameSpace', () => {
  it('lista las compatibles sin incluirse a sí misma', () => {
    // TEST-MSP-006: el editor lo usa para decir «esta vista se conservará al
    // pasar a…», que es la única forma de que el autor compruebe que declaró
    // bien el espacio: un identificador mal escrito no da ningún error,
    // simplemente no agrupa.
    const scene = modelScene(10, 'u200', 'Carcasa');
    const scenes = [scene, modelScene(11, 'u200', 'Despiece'), modelScene(12, 'u300'), panorama(13)];

    expect(scenesInSameSpace(scene, scenes).map((s) => s.title)).toEqual(['Despiece']);
  });

  it('devuelve lista vacía sin espacio declarado', () => {
    // TEST-MSP-007: y entonces el editor puede decirle al autor que declare
    // uno si quiere agrupar.
    const scene = modelScene(10, null);
    expect(scenesInSameSpace(scene, [scene, modelScene(11, null)])).toEqual([]);
  });
});

describe('viewForEntering', () => {
  it('devuelve la vista conservada cuando el espacio coincide', () => {
    // TEST-MSP-008: manda sobre la vista guardada de la escena. El visitante
    // acaba de colocar la cámara donde le interesa, y devolverle a la que el
    // autor guardó hace meses deshace su trabajo.
    const carried = { spaceId: 'u200', view: VIEW };
    expect(viewForEntering(modelScene(11, 'u200'), carried)).toBe(VIEW);
  });

  it('devuelve undefined cuando el espacio no coincide', () => {
    // TEST-MSP-009: `undefined` y no la vista de la escena, para que quien
    // llama distinga «usa la tuya» de «usa ésta»: la escena sigue decidiendo
    // si encuadra el modelo entero por no tener vista guardada.
    const carried = { spaceId: 'u300', view: VIEW };
    expect(viewForEntering(modelScene(11, 'u200'), carried)).toBeUndefined();
  });

  it('devuelve undefined sin nada conservado', () => {
    // TEST-MSP-010: la primera escena de modelo de la sesión.
    expect(viewForEntering(modelScene(11, 'u200'), null)).toBeUndefined();
  });

  it('devuelve undefined si la escena no declara espacio', () => {
    // TEST-MSP-011: aunque haya una vista conservada de otro modelo.
    expect(viewForEntering(modelScene(11, null), { spaceId: 'u200', view: VIEW })).toBeUndefined();
  });

  it('devuelve undefined en una panorámica', () => {
    // TEST-MSP-012: aplicar una vista de modelo a una panorámica daría una
    // cámara con posición, que en una esfera no tiene sentido.
    expect(viewForEntering(panorama(12), { spaceId: 'u200', view: VIEW })).toBeUndefined();
  });
});
