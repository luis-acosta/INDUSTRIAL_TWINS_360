/**
 * Pruebas de los mandos del visor.
 *
 * Se escriben como secuencias de fotogramas porque los dos defectos que
 * importan sólo existen en el tiempo: la acción que se repite mientras el
 * botón sigue pulsado y el giro que se dispara solo con la palanca en reposo.
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_INPUT_MEMORY,
  TURN_DEADZONE,
  THUMBSTICK_AXES,
  XR_BUTTON,
  rayFromPoseMatrix,
  readXrInput,
  type XrInputSnapshot,
} from './xr-input';

/** Mando derecho con los botones y ejes indicados. */
function pad(options: {
  readonly buttons?: readonly number[];
  readonly x?: number;
  readonly handedness?: 'left' | 'right';
}): XrInputSnapshot {
  const pressed = new Set(options.buttons ?? []);
  const axes = [0, 0, 0, 0];
  axes[THUMBSTICK_AXES.x] = options.x ?? 0;
  return {
    handedness: options.handedness ?? 'right',
    buttons: Array.from({ length: 6 }, (_unused, index) => pressed.has(index)),
    axes,
  };
}

describe('readXrInput', () => {
  it('emite «select» en el flanco de subida del gatillo', () => {
    // TEST-XRI-001: sin detección de flanco, una pulsación de un cuarto de
    // segundo son veinte acciones y el visitante activa veinte marcadores.
    const first = readXrInput([pad({ buttons: [XR_BUTTON.trigger] })]);
    expect(first.actions).toEqual(['select']);

    const held = readXrInput([pad({ buttons: [XR_BUTTON.trigger] })], first.memory);
    expect(held.actions).toEqual([]);

    const released = readXrInput([pad({})], held.memory);
    expect(released.actions).toEqual([]);

    const again = readXrInput([pad({ buttons: [XR_BUTTON.trigger] })], released.memory);
    expect(again.actions).toEqual(['select']);
  });

  it('gira una vez por cruce de la zona muerta', () => {
    // TEST-XRI-002: el giro por pasos es la decisión de comodidad del módulo.
    // Si mantener la palanca girase en continuo, esa decisión se perdería.
    const frames = [
      pad({ x: -1 }),
      pad({ x: -1 }),
      pad({ x: -0.9 }),
      pad({ x: 0 }),
      pad({ x: -1 }),
    ];
    let memory = EMPTY_INPUT_MEMORY;
    const emitted: string[][] = [];
    for (const frame of frames) {
      const reading = readXrInput([frame], memory);
      memory = reading.memory;
      emitted.push([...reading.actions]);
    }

    expect(emitted).toEqual([['rotateLeft'], [], [], [], ['rotateLeft']]);
  });

  it('ignora la palanca dentro de la zona muerta', () => {
    // TEST-XRI-003: una palanca en reposo marca décimas. Sin zona muerta la
    // escena gira sola, que es el fallo que más desorienta en VR.
    const reading = readXrInput([pad({ x: TURN_DEADZONE - 0.01 })]);
    expect(reading.actions).toEqual([]);
  });

  it('distingue el sentido del giro', () => {
    // TEST-XRI-004: invertir el signo haría girar al contrario de la palanca,
    // y en VR eso se nota de inmediato como un error de orientación.
    expect(readXrInput([pad({ x: 1 })]).actions).toEqual(['rotateRight']);
    expect(readXrInput([pad({ x: -1 })]).actions).toEqual(['rotateLeft']);
  });

  it('asigna cada botón a su acción', () => {
    // TEST-XRI-005: el reparto es el del perfil «xr-standard», que es lo que
    // espera quien ya ha usado otro recorrido en el mismo visor.
    const reading = readXrInput([
      pad({ buttons: [XR_BUTTON.primary, XR_BUTTON.secondary, XR_BUTTON.thumbstick] }),
    ]);
    expect(new Set(reading.actions)).toEqual(new Set(['menu', 'exit', 'teleport']));
  });

  it('recuerda la mano que usó el gatillo', () => {
    // TEST-XRI-006: el puntero se dibuja en una sola mano. Dibujarlo en las
    // dos llena la escena de rayos; dibujarlo en la que no se usa deja al
    // visitante apuntando sin ver a dónde.
    const left = readXrInput([pad({ handedness: 'left', buttons: [XR_BUTTON.trigger] })]);
    expect(left.activeHand).toBe('left');

    const neither = readXrInput([pad({ handedness: 'right' })], left.memory, left.activeHand);
    expect(neither.activeHand).toBe('left');

    const right = readXrInput(
      [pad({ handedness: 'right', buttons: [XR_BUTTON.trigger] })],
      neither.memory,
      neither.activeHand,
    );
    expect(right.activeHand).toBe('right');
  });

  it('lleva la cuenta de cada mano por separado', () => {
    // TEST-XRI-007: con una sola memoria compartida, pulsar con la izquierda
    // mientras la derecha está quieta borraría el estado de la derecha y el
    // siguiente fotograma emitiría una acción fantasma.
    const first = readXrInput([
      pad({ handedness: 'left', buttons: [XR_BUTTON.trigger] }),
      pad({ handedness: 'right', buttons: [XR_BUTTON.trigger] }),
    ]);
    expect(first.actions).toEqual(['select', 'select']);

    const second = readXrInput(
      [
        pad({ handedness: 'left', buttons: [XR_BUTTON.trigger] }),
        pad({ handedness: 'right', buttons: [XR_BUTTON.trigger] }),
      ],
      first.memory,
    );
    expect(second.actions).toEqual([]);
  });

  it('tolera un mando con menos botones de los previstos', () => {
    // TEST-XRI-008: un visor sin palanca ni botones secundarios sólo publica
    // el gatillo. Leer fuera del array no debe producir acciones inventadas.
    const minimal: XrInputSnapshot = { handedness: 'right', buttons: [true], axes: [] };
    expect(readXrInput([minimal]).actions).toEqual(['select']);
  });
});

describe('rayFromPoseMatrix', () => {
  it('extrae origen y dirección de apuntado', () => {
    // TEST-XRI-009: WebXR y Three comparten la convención de que el mando
    // apunta hacia −Z de su sistema local. Equivocar el signo deja el puntero
    // apuntando a la espalda del visitante.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 1.2, -0.3, 1];
    const ray = rayFromPoseMatrix(identity);

    expect(ray.origin).toEqual([0.1, 1.2, -0.3]);
    expect(ray.direction).toEqual([0, 0, -1]);
  });

  it('normaliza la dirección', () => {
    // TEST-XRI-010: una matriz con escala daría un vector no unitario, y la
    // distancia del corte con el panel saldría escalada por ese factor.
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const ray = rayFromPoseMatrix(scaled);
    expect(Math.hypot(...ray.direction)).toBeCloseTo(1, 10);
  });

  it('devuelve una dirección utilizable ante una matriz degenerada', () => {
    // TEST-XRI-011: un fotograma sin pose válida puede traer ceros. Devolver
    // NaN propagaría el fallo hasta la geometría del puntero.
    const zeros = new Float32Array(16);
    const ray = rayFromPoseMatrix(zeros);
    expect(ray.direction).toEqual([0, 0, -1]);
  });
});
