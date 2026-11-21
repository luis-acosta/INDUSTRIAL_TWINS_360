/**
 * Pruebas de las calcomanías sobre la superficie (L07).
 *
 * Lo que faltaba de L07 era esto: el marcador seguía a su pieza y se escondía
 * detrás de la geometría, pero se dibujaba de pie frente a la cámara, así que
 * en una válvula vista de lado flotaba al aire y el visitante no sabía a qué
 * pieza se refería.
 *
 * La geometría se prueba con `Vector3` y `Quaternion` de verdad, sin WebGL: lo
 * que puede estar mal aquí es la orientación, y una orientación equivocada no
 * se ve en una captura de pantalla —se ve al girar, cuando la calcomanía se
 * desvía de la superficie—.
 *
 * Los dos casos que hunden esta función son degenerados: una normal opuesta al
 * plano sin girar, donde el giro entre dos vectores opuestos no es único, y una
 * normal de longitud cero, que llega en modelos exportados a mala hora.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import {
  DECAL_OFFSET_FRACTION,
  DECAL_SIZE_FRACTION,
  decalTransform,
} from './model-hotspots';
import { modelSizeFor, resolveColor } from './hotspot-decals';

/** Dirección a la que apunta el plano después de aplicar el giro. */
function facing(normal: Vector3): Vector3 {
  const transform = decalTransform(new Vector3(0, 0, 0), normal, 10);
  return new Vector3(0, 0, 1).applyQuaternion(transform.quaternion);
}

describe('decalTransform', () => {
  it('tumba el plano sobre la superficie', () => {
    // TEST-DCL-001: es la función entera. El plano sin girar mira a +Z; tras
    // el giro tiene que mirar a donde mira la superficie.
    const normal = new Vector3(1, 0, 0);

    expect(facing(normal).angleTo(normal)).toBeLessThan(1e-6);
  });

  it('funciona con una normal oblicua', () => {
    // TEST-DCL-002: el caso normal en una planta. Casi ninguna superficie útil
    // es perpendicular a un eje.
    const normal = new Vector3(0.3, 0.8, -0.5).normalize();

    expect(facing(normal).angleTo(normal)).toBeLessThan(1e-6);
  });

  it('funciona con la normal opuesta al plano sin girar', () => {
    // TEST-DCL-003: el caso degenerado clásico. Entre dos vectores opuestos
    // hay infinitos ejes de giro válidos, y una implementación que no lo trate
    // deja el giro indefinido: la calcomanía aparece de canto —invisible— o
    // girada de una forma distinta en cada versión de la biblioteca.
    const normal = new Vector3(0, 0, -1);

    expect(facing(normal).angleTo(normal)).toBeLessThan(1e-6);
  });

  it('una normal de longitud cero no deja el giro indefinido', () => {
    // TEST-DCL-004: llega en modelos exportados a mala hora, con caras de área
    // cero. Sin esto, el plano sale de canto y el punto de interés desaparece
    // de la escena sin explicación.
    const transform = decalTransform(new Vector3(1, 2, 3), new Vector3(0, 0, 0), 10);

    expect(Number.isFinite(transform.quaternion.x)).toBe(true);
    expect(Number.isFinite(transform.position.x)).toBe(true);
  });

  it('separa la calcomanía de la superficie en la dirección de la normal', () => {
    // TEST-DCL-005: sin separación, calcomanía y superficie comparten plano y
    // la tarjeta gráfica no puede decidir cuál está delante: aparece el
    // parpadeo de franjas que se ve al girar.
    const point = new Vector3(0, 0, 0);
    const normal = new Vector3(0, 1, 0);

    const transform = decalTransform(point, normal, 10);

    expect(transform.position.y).toBeCloseTo(10 * DECAL_OFFSET_FRACTION, 9);
    expect(transform.position.x).toBeCloseTo(0, 9);
  });

  it('la separación y el tamaño escalan con el modelo', () => {
    // TEST-DCL-006: los modelos de planta llegan en metros, en milímetros y en
    // pulgadas. Una separación fija en unidades del mundo quedaría invisible en
    // uno y a un palmo en otro, y el tamaño igual.
    const pequeno = decalTransform(new Vector3(), new Vector3(0, 1, 0), 1);
    const grande = decalTransform(new Vector3(), new Vector3(0, 1, 0), 1000);

    expect(grande.size / pequeno.size).toBeCloseTo(1000, 6);
    expect(grande.position.y / pequeno.position.y).toBeCloseTo(1000, 6);
    expect(pequeno.size).toBeCloseTo(DECAL_SIZE_FRACTION, 9);
  });

  it('un modelo de tamaño cero no produce una división por cero', () => {
    // TEST-DCL-007: un modelo vacío o con una sola geometría degenerada tiene
    // esfera envolvente de radio cero; un tamaño cero daría una calcomanía de
    // tamaño cero y, peor, un NaN si se usara como divisor en algún sitio.
    const transform = decalTransform(new Vector3(), new Vector3(0, 1, 0), 0);

    expect(transform.size).toBeGreaterThan(0);
    expect(Number.isFinite(transform.position.y)).toBe(true);
  });

  it('no modifica los vectores que recibe', () => {
    // TEST-DCL-008: el punto y la normal vienen del cálculo del anclaje y se
    // reutilizan para el marcador del DOM. Modificarlos aquí movería el
    // marcador a la posición desplazada de la calcomanía, y los dos dejarían de
    // coincidir.
    const point = new Vector3(1, 2, 3);
    const normal = new Vector3(0, 5, 0);

    decalTransform(point, normal, 10);

    expect(point.toArray()).toEqual([1, 2, 3]);
    expect(normal.toArray()).toEqual([0, 5, 0]);
  });
});

describe('modelSizeFor', () => {
  it('usa el diámetro de la esfera envolvente', () => {
    // TEST-DCL-009: y no la altura. Un modelo de tubería es largo y bajo: con
    // la altura, sus calcomanías saldrían diminutas.
    expect(modelSizeFor({ radius: 5 })).toBe(10);
  });

  it('sin modelo devuelve una unidad y no cero', () => {
    // TEST-DCL-010: cero propagaría tamaños cero y separaciones cero.
    expect(modelSizeFor(null)).toBe(1);
  });
});

describe('resolveColor', () => {
  it('deja pasar un color concreto', () => {
    // TEST-DCL-011
    expect(resolveColor('#ff8800')).toBe('#ff8800');
  });

  it('resuelve una variable del sistema de diseño', () => {
    // TEST-DCL-012: los marcadores del DOM se pintan con variables CSS y Three
    // no sabe leerlas. Resolverlas es lo que mantiene la calcomanía y su
    // marcador del mismo color, incluido el acento de la marca del cliente,
    // que se inyecta en el documento en tiempo de ejecución.
    document.documentElement.style.setProperty('--prueba-color', '#123456');

    expect(resolveColor('var(--prueba-color)')).toBe('#123456');
  });

  it('una variable que no existe cae en la reserva', () => {
    // TEST-DCL-013: un color sin resolver llega a Three como texto inválido;
    // `Color` lo rechaza y pinta de blanco, y una calcomanía blanca sobre una
    // pieza clara es una calcomanía invisible.
    expect(resolveColor('var(--no-existe)', '#4ec4d2')).toBe('#4ec4d2');
  });

  it('una cadena vacía cae en la reserva', () => {
    // TEST-DCL-014: ocurre cuando el punto de interés no declara color.
    expect(resolveColor('', '#4ec4d2')).toBe('#4ec4d2');
  });
});
