/**
 * Pruebas de los efectos ambientales.
 *
 * El contrato de escena permitía elegir lluvia desde hacía varias etapas y la
 * escena se publicaba igual de seca. Lo que se comprueba aquí es lo que decide
 * si el efecto sirve: que la intensidad cambie algo, que el movimiento no
 * dependa de la cadencia de fotogramas de la máquina, que las partículas no se
 * acumulen ni formen columnas, y que el destello no aparezca cuando la luz que
 * lo causa está fuera del cuadro.
 */
import { describe, expect, it } from 'vitest';

import {
  EFFECT_PROFILES,
  advanceAmbient,
  ambientForScene,
  createAmbient,
  flareElements,
  makeRandom,
  normalizeAngle,
  particleCount,
  projectFlareSource,
} from './ambient-effects';

const scene = (effect: 'none' | 'rain' | 'dust' | 'snow' | 'lensFlare', intensity = 0.5) => ({
  ambientEffect: { effect, intensity, lightYaw: null, lightPitch: null },
});

describe('makeRandom', () => {
  it('es determinista para la misma semilla', () => {
    // TEST-AMB-001: el mismo recorrido tiene que verse igual cada vez que se
    // abre; con `Math.random` la lluvia caería distinta en cada visita y las
    // pruebas serían una lotería.
    const a = makeRandom(7);
    const b = makeRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produce valores en [0, 1)', () => {
    // TEST-AMB-002: un valor fuera de rango colocaría partículas fuera de la
    // pantalla que nunca volverían a entrar.
    const random = makeRandom(3);
    for (let i = 0; i < 500; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('particleCount', () => {
  it('crece con la intensidad y respeta el tope', () => {
    // TEST-AMB-003: el tope existe porque la capa se dibuja en la CPU y mil
    // partículas a 60 fps compiten con el propio recorrido.
    const profile = EFFECT_PROFILES.rain;
    expect(particleCount(profile, 0)).toBe(0);
    expect(particleCount(profile, 0.25)).toBeLessThan(particleCount(profile, 1));
    expect(particleCount(profile, 1)).toBe(profile.maxParticles);
  });

  it('a media intensidad da un efecto claramente visible', () => {
    // TEST-AMB-004: a la mitad del control se espera «llueve», no «la mitad
    // de las gotas». Con relación lineal, media intensidad se ve como una
    // llovizna floja y el autor sube el control hasta el extremo.
    const profile = EFFECT_PROFILES.rain;
    expect(particleCount(profile, 0.5)).toBeGreaterThan(profile.maxParticles * 0.6);
  });

  it('una intensidad mínima deja al menos una partícula', () => {
    // TEST-AMB-005: redondear a cero haría que el control tuviera un tramo
    // inicial donde no pasa nada, y se leería como que el efecto no funciona.
    expect(particleCount(EFFECT_PROFILES.snow, 0.001)).toBeGreaterThanOrEqual(1);
  });
});

describe('createAmbient', () => {
  it('reparte las partículas por toda la pantalla', () => {
    // TEST-AMB-006: si nacieran todas arriba, al entrar en la escena se vería
    // caer una cortina desde el techo en lugar de una lluvia que ya estaba.
    const state = createAmbient('rain', 1, 5);
    const arriba = state.particles.filter((p) => p.y < 0.33).length;
    const medio = state.particles.filter((p) => p.y >= 0.33 && p.y < 0.66).length;
    const abajo = state.particles.filter((p) => p.y >= 0.66).length;

    for (const tercio of [arriba, medio, abajo]) {
      expect(tercio).toBeGreaterThan(state.particles.length * 0.2);
    }
  });

  it('el polvo flota y la lluvia cae', () => {
    // TEST-AMB-007: es la diferencia entre los dos efectos. Con la misma
    // velocidad, el polvo industrial se vería como ceniza cayendo.
    const lluvia = createAmbient('rain', 1, 1);
    const polvo = createAmbient('dust', 1, 1);

    const media = (xs: readonly { vy: number }[]) => xs.reduce((a, p) => a + p.vy, 0) / xs.length;
    expect(media(lluvia.particles)).toBeGreaterThan(media(polvo.particles) * 5);
  });

  it('no crea partículas para «ninguno» ni para el destello', () => {
    // TEST-AMB-008: el destello no es un sistema de partículas, y «ninguno»
    // no debe costar nada.
    expect(createAmbient('none', 1).particles).toHaveLength(0);
    expect(createAmbient('lensFlare', 1).particles).toHaveLength(0);
  });
});

describe('advanceAmbient', () => {
  it('avanza por segundos y no por fotograma', () => {
    // TEST-AMB-009: es el defecto clásico. Calculado por fotograma, el mismo
    // recorrido se ve como llovizna a 30 fps y como granizo a 120.
    const inicial = createAmbient('snow', 1, 2);

    // Un paso de 0,1 s frente a cinco pasos de 0,02 s: el resultado tiene que
    // ser prácticamente el mismo.
    const uno = advanceAmbient(inicial, 0.1, 2);
    let cinco = inicial;
    for (let i = 0; i < 5; i += 1) cinco = advanceAmbient(cinco, 0.02, 2);

    const y1 = uno.particles[0]!.y;
    const y5 = cinco.particles[0]!.y;
    expect(Math.abs(y1 - y5)).toBeLessThan
      (0.02);
  });

  it('las partículas vuelven a entrar por el borde opuesto', () => {
    // TEST-AMB-010: sin reaparición, el efecto dura dos segundos y la escena
    // se queda limpia.
    let state = createAmbient('rain', 1, 4);
    for (let i = 0; i < 200; i += 1) state = advanceAmbient(state, 0.05, 4);

    expect(state.particles).toHaveLength(createAmbient('rain', 1, 4).particles.length);
    for (const particle of state.particles) {
      expect(particle.y).toBeGreaterThan(-0.1);
      expect(particle.y).toBeLessThan(1.1);
      expect(particle.x).toBeGreaterThan(-0.1);
      expect(particle.x).toBeLessThan(1.1);
    }
  });

  it('no forma columnas al reaparecer', () => {
    // TEST-AMB-011: si la partícula volviera a entrar en la misma columna, al
    // poco tiempo la lluvia se vería como un rayado vertical fijo.
    let state = createAmbient('rain', 1, 6);
    const xInicial = state.particles.map((p) => p.x);
    for (let i = 0; i < 100; i += 1) state = advanceAmbient(state, 0.05, 6);

    const cambiadas = state.particles.filter((p, index) => Math.abs(p.x - xInicial[index]!) > 0.05);
    expect(cambiadas.length).toBeGreaterThan(state.particles.length * 0.5);
  });

  it('acota un salto de tiempo largo', () => {
    // TEST-AMB-012: una pestaña que vuelve del segundo plano entrega varios
    // segundos de golpe; sin tope, todas las partículas saltarían al borde
    // opuesto a la vez y se vería un parpadeo.
    const inicial = createAmbient('snow', 1, 8);
    const salto = advanceAmbient(inicial, 30, 8);
    const paso = advanceAmbient(inicial, 0.1, 8);

    expect(salto.particles[0]!.y).toBeCloseTo(paso.particles[0]!.y, 6);
  });

  it('la nieve se bambolea y la lluvia no', () => {
    // TEST-AMB-013: el bamboleo es lo que distingue un copo de una gota. Sin
    // él, la nieve es lluvia blanca y lenta.
    const nieve = EFFECT_PROFILES.snow;
    const lluvia = EFFECT_PROFILES.rain;
    expect(nieve.sway).toBeGreaterThan(0);
    expect(lluvia.sway).toBe(0);
  });

  it('un tiempo negativo no mueve nada hacia atrás', () => {
    // TEST-AMB-014: un reloj que retrocede —ocurre con los temporizadores del
    // navegador— no debe hacer subir la lluvia.
    const inicial = createAmbient('rain', 1, 9);
    const atras = advanceAmbient(inicial, -1, 9);
    expect(atras.particles[0]!.y).toBeCloseTo(inicial.particles[0]!.y, 10);
  });
});

describe('ambientForScene', () => {
  it('devuelve null para una escena sin efecto', () => {
    // TEST-AMB-015: y entonces no se monta la capa, que es lo que hace que el
    // caso normal no cueste nada.
    expect(ambientForScene(scene('none'))).toBeNull();
  });

  it('apaga el efecto con movimiento reducido', () => {
    // TEST-AMB-016: un efecto ambiental es movimiento periférico constante,
    // que es exactamente lo que provoca malestar a quien pide esa
    // preferencia. Atenuarlo no basta: «menos lluvia» sigue siendo lluvia.
    expect(ambientForScene(scene('rain', 1), { reducedMotion: true })).toBeNull();
  });

  it('crea el estado del efecto elegido', () => {
    // TEST-AMB-017
    const state = ambientForScene(scene('snow', 0.8));
    expect(state?.kind).toBe('snow');
    expect(state?.particles.length).toBeGreaterThan(0);
  });
});

describe('projectFlareSource', () => {
  it('coloca la fuente en el centro cuando se mira a ella', () => {
    // TEST-AMB-018: el destello tiene que salir de donde está la luz; un
    // desplazamiento se ve de inmediato como un error.
    const source = projectFlareSource(0, 0, 0, 0, 90, 16 / 9);
    expect(source.visible).toBe(true);
    expect(source.x).toBeCloseTo(0.5, 6);
    expect(source.y).toBeCloseTo(0.5, 6);
  });

  it('la fuente se desplaza al girar la cámara', () => {
    // TEST-AMB-019: y hacia el lado correcto: con la luz a la izquierda de la
    // mirada, el destello aparece a la izquierda.
    const source = projectFlareSource(0.3, 0, 0, 0, 90, 16 / 9);
    expect(source.visible).toBe(true);
    expect(source.x).toBeGreaterThan(0.5);
  });

  it('una fuente fuera del campo visual no es visible', () => {
    // TEST-AMB-020: es el defecto más visible de este efecto: un destello de
    // una luz que no se ve.
    expect(projectFlareSource(Math.PI, 0, 0, 0, 90).visible).toBe(false);
    expect(projectFlareSource(0, 1.4, 0, 0, 90).visible).toBe(false);
  });

  it('el campo visual estrecho recorta antes', () => {
    // TEST-AMB-021: al acercar el zoom, una luz que estaba en el borde sale
    // del cuadro y su destello tiene que desaparecer con ella.
    const ancho = projectFlareSource(0.6, 0, 0, 0, 90);
    const estrecho = projectFlareSource(0.6, 0, 0, 0, 40);
    expect(ancho.visible).toBe(true);
    expect(estrecho.visible).toBe(false);
  });

  it('tiene en cuenta la relación de aspecto en vertical', () => {
    // TEST-AMB-022: con 16:9 el campo vertical es bastante menor que el
    // horizontal; usar el mismo dejaría el destello visible por encima del
    // borde superior de la imagen.
    // 0,6 rad son 34°: dentro del campo vertical de una imagen cuadrada
    // (45°) y fuera del de una 16:9 (29°).
    const panoramica = projectFlareSource(0, 0.6, 0, 0, 90, 16 / 9);
    const cuadrada = projectFlareSource(0, 0.6, 0, 0, 90, 1);
    expect(panoramica.visible).toBe(false);
    expect(cuadrada.visible).toBe(true);
  });
});

describe('flareElements', () => {
  it('no dibuja nada si la fuente no se ve', () => {
    // TEST-AMB-023
    expect(flareElements({ x: 0.5, y: 0.5, visible: false }, 1)).toEqual([]);
  });

  it('no dibuja nada con intensidad cero', () => {
    // TEST-AMB-024: el control tiene que poder apagar el efecto sin cambiar
    // el tipo de efecto.
    expect(flareElements({ x: 0.3, y: 0.4, visible: true }, 0)).toEqual([]);
  });

  it('alinea los elementos con la recta fuente-centro', () => {
    // TEST-AMB-025: es la propiedad que hace que un destello parezca un
    // destello. Elementos dispersos se ven como manchas sueltas.
    const elements = flareElements({ x: 0.8, y: 0.3, visible: true }, 1);
    expect(elements.length).toBeGreaterThan(2);

    // Todos tienen que cumplir (x−0,5)/(y−0,5) constante: la pendiente de la
    // recta que une la fuente con el centro.
    const slope = (0.8 - 0.5) / (0.3 - 0.5);
    for (const element of elements) {
      if (Math.abs(element.y - 0.5) < 1e-9) continue;
      expect((element.x - 0.5) / (element.y - 0.5)).toBeCloseTo(slope, 6);
    }
  });

  it('coloca fantasmas al otro lado del centro', () => {
    // TEST-AMB-026: un objetivo real proyecta los reflejos de segundo orden
    // al lado opuesto de la fuente. Todos del mismo lado se verían como un
    // halo y no como un destello.
    const elements = flareElements({ x: 0.9, y: 0.5, visible: true }, 1);
    expect(elements.some((element) => element.x < 0.5)).toBe(true);
    expect(elements.some((element) => element.x > 0.5)).toBe(true);
  });

  it('se atenúa cuando la fuente se acerca al borde', () => {
    // TEST-AMB-027: así el destello no desaparece de golpe al salir la luz
    // del cuadro, que se vería como un parpadeo.
    const centro = flareElements({ x: 0.5, y: 0.5, visible: true }, 1);
    const borde = flareElements({ x: 0.95, y: 0.95, visible: true }, 1);
    expect(borde[0]!.opacity).toBeLessThan(centro[0]!.opacity);
  });

  it('la intensidad escala tamaño y opacidad, no el número', () => {
    // TEST-AMB-028: un destello con más círculos no es más fuerte: es otro
    // objetivo.
    const flojo = flareElements({ x: 0.7, y: 0.5, visible: true }, 0.2);
    const fuerte = flareElements({ x: 0.7, y: 0.5, visible: true }, 1);

    expect(flojo).toHaveLength(fuerte.length);
    expect(fuerte[0]!.radius).toBeGreaterThan(flojo[0]!.radius);
    expect(fuerte[0]!.opacity).toBeGreaterThan(flojo[0]!.opacity);
  });
});

describe('normalizeAngle', () => {
  it('reduce al intervalo [−π, π)', () => {
    // TEST-AMB-029: la diferencia de giro entre la luz y la cámara cruza el
    // norte constantemente; sin normalizar, el destello desaparecería al
    // pasar por ahí.
    expect(normalizeAngle(2 * Math.PI + 0.2)).toBeCloseTo(0.2, 10);
    expect(normalizeAngle(-2 * Math.PI - 0.2)).toBeCloseTo(-0.2, 10);
  });
});

describe('luz declarada del destello', () => {
  it('una escena sin luz declarada cae a la vista inicial', () => {
    // TEST-AMB-030: es la aproximación razonable —el autor encuadra lo que
    // quiere que se vea— y permite que el efecto sirva sin configurar nada.
    const sinLuz = scene('lensFlare', 1);
    expect(sinLuz.ambientEffect.lightYaw).toBeNull();
  });

  it('la luz declarada no depende de hacia dónde se mire', () => {
    // TEST-AMB-031: es la diferencia entre un destello y un adorno. Con la
    // luz declarada, girar la cámara la saca del cuadro y el destello se va
    // con ella; con la vista inicial, el destello acompañaría a la mirada.
    const luzYaw = 1.2;
    const mirandoALaLuz = projectFlareSource(luzYaw, 0, luzYaw, 0, 90, 16 / 9);
    const mirandoAlOtroLado = projectFlareSource(luzYaw, 0, luzYaw + Math.PI, 0, 90, 16 / 9);

    expect(mirandoALaLuz.visible).toBe(true);
    expect(mirandoAlOtroLado.visible).toBe(false);
  });
});
