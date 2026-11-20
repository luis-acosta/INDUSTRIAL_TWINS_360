/**
 * Pruebas del pintado de la capa ambiental.
 *
 * El lienzo se sustituye por uno que registra las operaciones: lo que importa
 * comprobar es qué forma tiene cada efecto —la lluvia se traza como raya, la
 * nieve como círculo—, que la opacidad de cada partícula se respete y que el
 * destello no pinte nada cuando su fuente no se ve. El aspecto final sobre una
 * panorámica real no lo puede juzgar una prueba automática.
 */
import { describe, expect, it } from 'vitest';

import { createAmbient, type AmbientState } from './ambient-effects';
import { paintAmbient, paintFlare, type AmbientPainter } from './AmbientLayer';

interface Op {
  readonly kind: 'line' | 'arc';
  readonly alpha: number;
  readonly from?: readonly [number, number];
  readonly to?: readonly [number, number];
  readonly center?: readonly [number, number];
  readonly radius?: number;
}

function recorder(): AmbientPainter & { readonly ops: Op[] } {
  const ops: Op[] = [];
  let from: [number, number] = [0, 0];
  let to: [number, number] = [0, 0];
  return {
    ops,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo(x, y) {
      from = [x, y];
    },
    lineTo(x, y) {
      to = [x, y];
    },
    stroke() {
      ops.push({ kind: 'line', alpha: this.globalAlpha, from, to });
    },
    arc(x, y, r) {
      from = [x, y];
      to = [r, r];
    },
    fill() {
      ops.push({ kind: 'arc', alpha: this.globalAlpha, center: from, radius: to[0] });
    },
  };
}

const WIDTH = 1280;
const HEIGHT = 720;

describe('paintAmbient', () => {
  it('traza la lluvia como rayas y no como puntos', () => {
    // TEST-AML-001: una gota a la velocidad a la que cae se registra como una
    // raya, en la retina y en el sensor de una cámara. Dibujarla redonda da el
    // aspecto de burbujas flotando.
    const ctx = recorder();
    paintAmbient(ctx, createAmbient('rain', 0.5, 1), WIDTH, HEIGHT);

    expect(ctx.ops.length).toBeGreaterThan(10);
    expect(ctx.ops.every((op) => op.kind === 'line')).toBe(true);
  });

  it('dibuja la nieve y el polvo como círculos', () => {
    // TEST-AML-002: un copo y una partícula de polvo no tienen dirección
    // apreciable; trazarlos como raya los convertiría en lluvia.
    for (const kind of ['snow', 'dust'] as const) {
      const ctx = recorder();
      paintAmbient(ctx, createAmbient(kind, 0.5, 1), WIDTH, HEIGHT);
      expect(ctx.ops.every((op) => op.kind === 'arc')).toBe(true);
    }
  });

  it('la raya de lluvia sigue la dirección de la gota', () => {
    // TEST-AML-003: así, con deriva horizontal, la lluvia se inclina sola en
    // lugar de caer recta con las gotas moviéndose en diagonal.
    const ctx = recorder();
    const state = createAmbient('rain', 1, 3);
    paintAmbient(ctx, state, WIDTH, HEIGHT);

    const particle = state.particles[0]!;
    const op = ctx.ops[0]!;
    const dx = op.to![0] - op.from![0];
    const dy = op.to![1] - op.from![1];
    // La raya apunta hacia abajo porque la gota cae, y su inclinación tiene el
    // signo de la deriva de esa gota.
    expect(dy).toBeGreaterThan(0);
    expect(Math.sign(dx)).toBe(Math.sign(particle.vx));
  });

  it('respeta la opacidad de cada partícula', () => {
    // TEST-AML-004: la variación de opacidad es lo que da profundidad. Con
    // todas iguales, el efecto se ve como una trama plana pegada al cristal.
    const ctx = recorder();
    paintAmbient(ctx, createAmbient('snow', 1, 4), WIDTH, HEIGHT);

    const alphas = new Set(ctx.ops.map((op) => Math.round(op.alpha * 100)));
    expect(alphas.size).toBeGreaterThan(5);
    for (const op of ctx.ops) {
      expect(op.alpha).toBeGreaterThan(0);
      expect(op.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('escala a las dimensiones del lienzo', () => {
    // TEST-AML-005: las partículas viven en coordenadas 0..1 y el lienzo
    // cambia de tamaño con la ventana. Sin escalar, el efecto se quedaría en
    // la esquina superior izquierda.
    const ctx = recorder();
    paintAmbient(ctx, createAmbient('snow', 1, 5), WIDTH, HEIGHT);

    const xs = ctx.ops.map((op) => op.center![0]);
    expect(Math.max(...xs)).toBeGreaterThan(WIDTH * 0.5);
    expect(Math.min(...xs)).toBeLessThan(WIDTH * 0.5);
  });

  it('no pinta nada para «ninguno» ni para el destello', () => {
    // TEST-AML-006: el caso normal no debe costar nada, y el destello lo
    // pinta su propia función.
    for (const kind of ['none', 'lensFlare'] as const) {
      const ctx = recorder();
      paintAmbient(ctx, createAmbient(kind, 1, 1), WIDTH, HEIGHT);
      expect(ctx.ops).toEqual([]);
    }
  });

  it('deja la opacidad del lienzo como la encontró', () => {
    // TEST-AML-007: la capa comparte el contexto con lo que se dibuje después.
    // Dejar la opacidad a 0,2 haría que lo siguiente saliera translúcido, y el
    // síntoma aparecería lejos de la causa.
    const ctx = recorder();
    paintAmbient(ctx, createAmbient('rain', 1, 1), WIDTH, HEIGHT);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('un estado sin partículas no pinta', () => {
    // TEST-AML-008: ocurre con intensidad cero, y pintar el fondo igualmente
    // dejaría un velo sobre la escena.
    const empty: AmbientState = { kind: 'rain', intensity: 0, particles: [], elapsed: 0 };
    const ctx = recorder();
    paintAmbient(ctx, empty, WIDTH, HEIGHT);
    expect(ctx.ops).toEqual([]);
  });
});

describe('paintFlare', () => {
  it('pinta los elementos del destello', () => {
    // TEST-AML-009
    const ctx = recorder();
    paintFlare(ctx, { x: 0.7, y: 0.4, visible: true }, 1, WIDTH, HEIGHT);

    expect(ctx.ops.length).toBeGreaterThan(2);
    expect(ctx.ops.every((op) => op.kind === 'arc')).toBe(true);
  });

  it('no pinta nada si la fuente no se ve', () => {
    // TEST-AML-010: un destello de una luz que no está en el cuadro es el
    // defecto más visible de este efecto.
    const ctx = recorder();
    paintFlare(ctx, { x: 0.5, y: 0.5, visible: false }, 1, WIDTH, HEIGHT);
    expect(ctx.ops).toEqual([]);
  });

  it('escala el radio con la dimensión menor del lienzo', () => {
    // TEST-AML-011: con la mayor, en una ventana muy ancha los círculos
    // saldrían por arriba y por abajo.
    const estrecho = recorder();
    paintFlare(estrecho, { x: 0.6, y: 0.5, visible: true }, 1, 400, 1000);
    for (const op of estrecho.ops) {
      expect(op.radius!).toBeLessThan(400);
    }
  });
});
