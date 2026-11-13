import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_CONTROL,
  FULL_COVERAGE,
  degToRad,
  radToDeg,
  type CameraControl,
  type PanoramaCoverage,
} from '@it360/domain';
import { CameraController } from './camera-controller';

const control = (overrides: Partial<CameraControl> = {}): CameraControl => ({
  ...DEFAULT_CAMERA_CONTROL,
  ...overrides,
});

const make = (
  overrides: Partial<CameraControl> = {},
  coverage: PanoramaCoverage = FULL_COVERAGE,
): CameraController =>
  new CameraController({
    control: control(overrides),
    coverage,
    viewportWidth: 1600,
    viewportHeight: 900,
  });

/**
 * TEST-CAM-001 .. TEST-CAM-018
 * Requisitos: C02 (dirección inicial, velocidad e inercia), C03 (límites de
 * zoom), etapa 01.
 */
describe('orientación inicial', () => {
  it('TEST-CAM-001: arranca en la vista inicial de la escena', () => {
    const controller = make({ initialView: { yaw: 1.2, pitch: -0.3, fov: 70 } });
    const view = controller.getView();
    expect(view.yaw).toBeCloseTo(1.2, 6);
    expect(view.pitch).toBeCloseTo(-0.3, 6);
    expect(view.fov).toBe(70);
  });

  it('TEST-CAM-002: una vista inicial fuera de los límites se acota al arrancar', () => {
    const coverage: PanoramaCoverage = {
      horizontalDeg: 90,
      verticalDeg: 60,
      centerYaw: 0,
      centerPitch: 0,
    };
    const controller = make({ initialView: { yaw: degToRad(80), pitch: 0, fov: 60 } }, coverage);
    expect(Math.abs(radToDeg(controller.getView().yaw))).toBeLessThan(80);
  });
});

describe('arrastre', () => {
  let controller: CameraController;

  beforeEach(() => {
    controller = make();
  });

  it('TEST-CAM-003: arrastrar a la derecha gira la vista a la izquierda', () => {
    // Es la convención de agarrar la imagen y moverla, no la de mover la
    // cámara: invertirla hace que el visor se sienta al revés.
    controller.beginDrag(0);
    controller.drag(100, 0, 16);
    expect(controller.getView().yaw).toBeLessThan(0);
  });

  it('TEST-CAM-004: el mismo arrastre gira menos con el zoom acercado', () => {
    // Sin esta relación, el arrastre es inmanejable al acercar y perezoso al
    // alejar, que es el defecto más común de un visor 360 a medias.
    const wide = make({ initialView: { yaw: 0, pitch: 0, fov: 100 } });
    const narrow = make({ initialView: { yaw: 0, pitch: 0, fov: 30 } });

    wide.beginDrag(0);
    wide.drag(100, 0, 16);
    narrow.beginDrag(0);
    narrow.drag(100, 0, 16);

    expect(Math.abs(narrow.getView().yaw)).toBeLessThan(Math.abs(wide.getView().yaw));
  });

  it('TEST-CAM-005: la velocidad de arrastre configurada escala el movimiento', () => {
    const slow = make({ dragSpeed: 0.5 });
    const fast = make({ dragSpeed: 2 });
    slow.beginDrag(0);
    slow.drag(100, 0, 16);
    fast.beginDrag(0);
    fast.drag(100, 0, 16);
    expect(Math.abs(fast.getView().yaw) / Math.abs(slow.getView().yaw)).toBeCloseTo(4, 1);
  });

  it('TEST-CAM-006: invertir el eje vertical cambia el sentido del pitch', () => {
    const normal = make();
    const inverted = make({ invertPitch: true });
    normal.beginDrag(0);
    normal.drag(0, 50, 16);
    inverted.beginDrag(0);
    inverted.drag(0, 50, 16);
    expect(Math.sign(normal.getView().pitch)).toBe(-Math.sign(inverted.getView().pitch));
  });

  it('TEST-CAM-007: el pitch no sobrepasa el cenit ni el nadir', () => {
    controller.beginDrag(0);
    for (let i = 0; i < 50; i += 1) controller.drag(0, 200, 16 * (i + 1));
    expect(controller.getView().pitch).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);

    controller.beginDrag(1000);
    for (let i = 0; i < 50; i += 1) controller.drag(0, -200, 1000 + 16 * (i + 1));
    expect(controller.getView().pitch).toBeGreaterThanOrEqual(-Math.PI / 2 - 1e-9);
  });
});

describe('inercia (C02)', () => {
  it('TEST-CAM-008: la vista sigue moviéndose tras soltar', () => {
    const controller = make({ inertia: 0.9 });
    controller.beginDrag(0);
    controller.drag(120, 0, 16);
    controller.endDrag();

    const afterRelease = controller.getView().yaw;
    controller.update(16, 32);
    expect(controller.getView().yaw).not.toBeCloseTo(afterRelease, 8);
  });

  it('TEST-CAM-009: la inercia se agota y el movimiento se detiene', () => {
    const controller = make({ inertia: 0.82 });
    controller.beginDrag(0);
    controller.drag(120, 0, 16);
    controller.endDrag();

    let now = 32;
    for (let i = 0; i < 400 && controller.isMoving(); i += 1) {
      controller.update(16, now);
      now += 16;
    }
    expect(controller.isMoving()).toBe(false);
  });

  it('TEST-CAM-010: con inercia 0 la cámara se detiene en seco', () => {
    const controller = make({ inertia: 0 });
    controller.beginDrag(0);
    controller.drag(120, 0, 16);
    const atRelease = controller.getView().yaw;
    controller.endDrag();
    controller.update(16, 32);
    expect(controller.getView().yaw).toBeCloseTo(atRelease, 10);
    expect(controller.isMoving()).toBe(false);
  });

  it('TEST-CAM-011: la frenada no depende de la tasa de fotogramas', () => {
    // A 30 fps la cámara debe recorrer aproximadamente lo mismo que a 60, no
    // frenar el doble de rápido.
    const run = (frameMs: number): number => {
      const controller = make({ inertia: 0.88 });
      controller.beginDrag(0);
      controller.drag(150, 0, 16);
      controller.endDrag();
      const start = controller.getView().yaw;
      let now = 16;
      for (let elapsed = 0; elapsed < 1000; elapsed += frameMs) {
        now += frameMs;
        controller.update(frameMs, now);
      }
      return Math.abs(controller.getView().yaw - start);
    };

    const at60 = run(16.67);
    const at30 = run(33.33);
    expect(Math.abs(at60 - at30) / Math.max(at60, 1e-6)).toBeLessThan(0.12);
  });

  it('TEST-CAM-012: la inercia no empuja contra el tope de una cobertura parcial', () => {
    const coverage: PanoramaCoverage = {
      horizontalDeg: 90,
      verticalDeg: 50,
      centerYaw: 0,
      centerPitch: 0,
    };
    const controller = make({ inertia: 0.95 }, coverage);

    controller.beginDrag(0);
    for (let i = 0; i < 20; i += 1) controller.drag(0, 120, 16 * (i + 1));
    controller.endDrag();

    const atLimit = controller.getView().pitch;
    controller.update(16, 500);
    controller.update(16, 516);
    expect(controller.getView().pitch).toBeCloseTo(atLimit, 9);
  });
});

describe('zoom (C03)', () => {
  it('TEST-CAM-013: el zoom respeta los límites configurados', () => {
    const controller = make({ zoom: { minFovDeg: 40, maxFovDeg: 80 } });
    for (let i = 0; i < 30; i += 1) controller.zoom(0.9, i * 16);
    expect(controller.getView().fov).toBe(40);
    for (let i = 0; i < 60; i += 1) controller.zoom(1.1, 1000 + i * 16);
    expect(controller.getView().fov).toBe(80);
  });

  it('TEST-CAM-014: cambiar los límites reajusta el FOV actual', () => {
    const controller = make({ zoom: { minFovDeg: 30, maxFovDeg: 100 } });
    controller.setView({ fov: 95 });
    controller.setControl(control({ zoom: { minFovDeg: 30, maxFovDeg: 60 } }));
    expect(controller.getView().fov).toBeLessThanOrEqual(60);
  });
});

describe('giro automático', () => {
  it('TEST-CAM-015: arranca sólo tras el tiempo de inactividad configurado', () => {
    const controller = make({ autoRotate: true, autoRotateIdleS: 2, autoRotateSpeed: 0.2 });
    controller.markInteraction(0);

    controller.update(16, 1000);
    const beforeIdle = controller.getView().yaw;
    expect(beforeIdle).toBeCloseTo(0, 9);

    controller.update(16, 3000);
    expect(controller.getView().yaw).not.toBeCloseTo(0, 9);
  });

  it('TEST-CAM-016: cualquier interacción lo detiene', () => {
    const controller = make({ autoRotate: true, autoRotateIdleS: 1, autoRotateSpeed: 0.3 });
    controller.markInteraction(0);
    controller.update(16, 2000);
    const rotated = controller.getView().yaw;

    controller.markInteraction(2000);
    controller.update(16, 2016);
    expect(controller.getView().yaw).toBeCloseTo(rotated, 9);
  });
});

describe('teclado', () => {
  it('TEST-CAM-017: las flechas desplazan un paso fijo', () => {
    const controller = make({ initialView: { yaw: 0, pitch: 0, fov: 75 } });
    controller.nudge('right', 10);
    expect(radToDeg(controller.getView().yaw)).toBeCloseTo(10, 6);
    controller.nudge('up', 10);
    expect(radToDeg(controller.getView().pitch)).toBeCloseTo(10, 6);
  });

  it('TEST-CAM-018: el paso de teclado no depende del zoom', () => {
    // A diferencia del arrastre: el teclado es un desplazamiento declarado,
    // no un gesto sobre la imagen.
    const wide = make({ initialView: { yaw: 0, pitch: 0, fov: 100 } });
    const narrow = make({ initialView: { yaw: 0, pitch: 0, fov: 30 } });
    wide.nudge('right', 5);
    narrow.nudge('right', 5);
    expect(wide.getView().yaw).toBeCloseTo(narrow.getView().yaw, 9);
  });
});

describe('redimensionado', () => {
  it('TEST-CAM-019: cambiar el tamaño conserva la orientación', () => {
    const controller = make();
    controller.setView({ yaw: 1.1, pitch: 0.4 });
    controller.setViewport(800, 450);
    expect(controller.getView().yaw).toBeCloseTo(1.1, 9);
    expect(controller.getView().pitch).toBeCloseTo(0.4, 9);
  });
});
