/**
 * Efectos ambientales de escena: lluvia, polvo, nieve y destellos (V06, V08).
 *
 * El contrato existía en el dominio —`scene.ambientEffect`— y no lo dibujaba
 * nada: el autor podía elegir lluvia y la escena se publicaba igual de seca.
 * Este módulo es la simulación, y está separada del dibujado por la razón de
 * siempre: lo que decide si el efecto se ve bien o se ve mal es el movimiento,
 * y el movimiento se puede comprobar sin un lienzo.
 *
 * **Por qué en dos dimensiones y no partículas en la escena.** Un sistema de
 * partículas en Three daría paralaje, que para lluvia y polvo apenas se nota
 * porque las partículas están «delante de la cámara» por definición. En cambio
 * costaría memoria de GPU en un visor autónomo que tiene que sostener 72 fps,
 * no compondría sobre una escena de modelo sin reordenar el dibujado, y el
 * destello de lente es por naturaleza un efecto de pantalla. La capa 2D sobre
 * el lienzo cuesta casi nada, funciona igual en panorámica y en modelo, y se
 * puede apagar sin tocar el renderizador.
 *
 * **Independencia de la cadencia.** Todo avanza por segundos transcurridos y
 * no por fotograma. Un efecto calculado por fotograma cae en lluvia lenta
 * cuando la máquina va a 30 fps y en granizo cuando va a 120: el mismo
 * recorrido se vería distinto en cada equipo.
 */
import type { Scene } from '@it360/domain';

import { normalizeAngle } from './xr-panel';

export type AmbientEffectKind = Scene['ambientEffect']['effect'];

/** Una partícula de la capa, en coordenadas normalizadas 0..1. */
export interface Particle {
  x: number;
  y: number;
  /** Velocidad en fracciones de pantalla por segundo. */
  vx: number;
  vy: number;
  /** Tamaño relativo: longitud de la gota o radio del copo. */
  size: number;
  opacity: number;
  /** Fase para el bamboleo de la nieve y el parpadeo del polvo. */
  phase: number;
}

export interface AmbientState {
  readonly kind: AmbientEffectKind;
  readonly intensity: number;
  readonly particles: readonly Particle[];
  /** Segundos acumulados, para los efectos que laten. */
  readonly elapsed: number;
}

/**
 * Perfil de cada efecto.
 *
 * Los números salen de cómo se ve cada cosa de verdad, no de un gusto: la
 * lluvia cae rápido y casi recta, el polvo flota y deriva, la nieve cae despacio
 * y se bambolea. `maxParticles` está acotado porque la capa se dibuja en la CPU
 * y mil partículas a 60 fps son sesenta mil operaciones de trazado por segundo,
 * que en un equipo de planta compiten con el propio recorrido.
 */
export interface EffectProfile {
  readonly maxParticles: number;
  /** Velocidad vertical media, en pantallas por segundo. */
  readonly fallSpeed: number;
  /** Dispersión de la velocidad, como fracción de la media. */
  readonly speedSpread: number;
  /** Deriva horizontal media. */
  readonly drift: number;
  readonly sizeMin: number;
  readonly sizeMax: number;
  readonly opacityMin: number;
  readonly opacityMax: number;
  /** Amplitud del bamboleo horizontal, en fracciones de pantalla. */
  readonly sway: number;
}

export const EFFECT_PROFILES: Readonly<Record<Exclude<AmbientEffectKind, 'none' | 'lensFlare'>, EffectProfile>> = {
  rain: {
    maxParticles: 420,
    fallSpeed: 1.6,
    speedSpread: 0.35,
    drift: 0.12,
    sizeMin: 0.02,
    sizeMax: 0.055,
    opacityMin: 0.18,
    opacityMax: 0.42,
    sway: 0,
  },
  dust: {
    maxParticles: 260,
    // El polvo industrial no cae: flota y deriva con la corriente de aire de
    // la nave. Una velocidad vertical apreciable lo convertiría en ceniza.
    fallSpeed: 0.06,
    speedSpread: 0.9,
    drift: 0.22,
    sizeMin: 0.002,
    sizeMax: 0.006,
    opacityMin: 0.1,
    opacityMax: 0.3,
    sway: 0.012,
  },
  snow: {
    maxParticles: 320,
    fallSpeed: 0.22,
    speedSpread: 0.5,
    drift: 0.05,
    sizeMin: 0.004,
    sizeMax: 0.012,
    opacityMin: 0.35,
    opacityMax: 0.85,
    sway: 0.035,
  },
};

/** Generador determinista: el mismo recorrido se ve igual en cada apertura. */
export function makeRandom(seed: number): () => number {
  // Mulberry32: treinta y dos bits, dos líneas y suficiente para esto. Un
  // generador determinista además hace reproducibles las pruebas, que con
  // `Math.random` serían una lotería.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Número de partículas para una intensidad.
 *
 * La relación no es lineal: a intensidad media se espera «llueve», no «la
 * mitad de las gotas». La raíz hace que la mitad del control dé un efecto
 * claramente visible y que el extremo siga teniendo margen.
 */
export function particleCount(profile: EffectProfile, intensity: number): number {
  const clamped = clamp01(intensity);
  if (clamped === 0) return 0;
  return Math.max(1, Math.round(profile.maxParticles * Math.sqrt(clamped)));
}

/**
 * Crea el estado inicial.
 *
 * Las partículas nacen repartidas por toda la pantalla y no en el borde
 * superior: si nacieran arriba, al entrar en la escena se vería caer una
 * cortina desde el techo en lugar de una lluvia que ya estaba cayendo.
 */
export function createAmbient(
  kind: AmbientEffectKind,
  intensity: number,
  seed = 1,
): AmbientState {
  if (kind === 'none' || kind === 'lensFlare') {
    return { kind, intensity: clamp01(intensity), particles: [], elapsed: 0 };
  }

  const profile = EFFECT_PROFILES[kind];
  const random = makeRandom(seed);
  const count = particleCount(profile, intensity);
  const particles: Particle[] = [];

  for (let i = 0; i < count; i += 1) {
    particles.push(spawn(profile, random, true));
  }

  return { kind, intensity: clamp01(intensity), particles, elapsed: 0 };
}

/**
 * Avanza la simulación.
 *
 * `dtSeconds` se acota: una pestaña que vuelve del segundo plano entrega un
 * salto de varios segundos, y sin tope todas las partículas aparecerían de
 * golpe en el borde opuesto, que se ve como un parpadeo.
 */
export function advanceAmbient(state: AmbientState, dtSeconds: number, seed = 1): AmbientState {
  if (state.kind === 'none' || state.kind === 'lensFlare' || state.particles.length === 0) {
    return { ...state, elapsed: state.elapsed + Math.max(dtSeconds, 0) };
  }

  const dt = Math.min(Math.max(dtSeconds, 0), 0.1);
  const profile = EFFECT_PROFILES[state.kind];
  const random = makeRandom(seed + Math.floor(state.elapsed * 1000));
  const elapsed = state.elapsed + dt;

  const particles = state.particles.map((particle) => {
    const sway = profile.sway === 0 ? 0 : Math.sin(elapsed * 1.7 + particle.phase) * profile.sway;
    let x = particle.x + (particle.vx + sway) * dt;
    let y = particle.y + particle.vy * dt;

    // Reaparición por los bordes: la partícula que sale por abajo vuelve por
    // arriba con posición horizontal nueva, de modo que no se forman columnas.
    if (y > 1.05) {
      y -= 1.1;
      x = random();
    } else if (y < -0.05) {
      y += 1.1;
      x = random();
    }
    if (x > 1.05) x -= 1.1;
    else if (x < -0.05) x += 1.1;

    return { ...particle, x, y };
  });

  return { ...state, particles, elapsed };
}

/**
 * Estado para una escena, respetando la preferencia de movimiento reducido.
 *
 * Con movimiento reducido el efecto no se atenúa: se apaga. Un efecto
 * ambiental es movimiento periférico constante, que es exactamente lo que
 * provoca malestar a quien pide esa preferencia, y «menos lluvia» sigue siendo
 * lluvia. La escena se ve entera sin él.
 */
export function ambientForScene(
  scene: Pick<Scene, 'ambientEffect'>,
  options: { readonly reducedMotion?: boolean; readonly seed?: number } = {},
): AmbientState | null {
  const { effect, intensity } = scene.ambientEffect;
  if (effect === 'none') return null;
  if (options.reducedMotion === true) return null;
  return createAmbient(effect, intensity, options.seed ?? 1);
}

/* ------------------------------------------------------------------ *
 * Destello de lente (V08)
 * ------------------------------------------------------------------ */

/**
 * Destello en pantalla.
 *
 * No es un sistema de partículas: es el reflejo de una fuente de luz brillante
 * en los elementos de un objetivo, y en pantalla se ve como una serie de
 * círculos alineados entre la fuente y el centro de la imagen. Eso es lo que
 * se calcula aquí.
 */
export interface FlareElement {
  /** Posición en coordenadas de pantalla 0..1. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly opacity: number;
}

/** Dirección de la fuente de luz, en coordenadas de pantalla. */
export interface FlareSource {
  readonly x: number;
  readonly y: number;
  /** `false` cuando la fuente queda fuera del campo visual. */
  readonly visible: boolean;
}

/**
 * Elementos del destello para una fuente dada.
 *
 * Los elementos se reparten a lo largo de la recta fuente-centro y más allá,
 * que es cómo se comporta un objetivo real: el reflejo aparece al otro lado del
 * centro de la imagen. La intensidad escala el tamaño y la opacidad, no el
 * número: un destello con más círculos no es más fuerte, es otro objetivo.
 */
export function flareElements(source: FlareSource, intensity: number): readonly FlareElement[] {
  if (!source.visible) return [];
  const strength = clamp01(intensity);
  if (strength === 0) return [];

  // Distancia de la fuente al centro: cuanto más al borde, más marcado es el
  // destello en un objetivo real, hasta desaparecer al salir del cuadro.
  const dx = source.x - 0.5;
  const dy = source.y - 0.5;
  const distance = Math.hypot(dx, dy);
  const falloff = Math.max(0, 1 - distance * 1.2);

  // Los elementos se colocan en la recta que pasa por la fuente y el centro:
  // posición = centro − t · (fuente − centro). Con t negativo el elemento
  // queda del lado de la fuente —el halo que la envuelve— y con t positivo al
  // otro lado del centro, que es donde un objetivo real proyecta los
  // fantasmas. t = 1 es el punto simétrico exacto de la fuente.
  const positions = [-0.2, 0.25, 0.6, 0.95, 1.3];
  const radii = [0.09, 0.03, 0.05, 0.02, 0.07];

  return positions.map((t, index) => ({
    x: 0.5 - dx * t,
    y: 0.5 - dy * t,
    radius: radii[index]! * (0.6 + strength * 0.8),
    // El primero es el halo de la propia fuente y por eso es más intenso que
    // los fantasmas, que son reflejos de segundo orden.
    opacity: strength * falloff * (index === 0 ? 0.5 : 0.28),
  }));
}

/**
 * Proyecta la fuente de luz de la escena a coordenadas de pantalla.
 *
 * La fuente se expresa como dirección en la esfera —el sol de la panorámica— y
 * se compara con la dirección de la cámara. Cuando el ángulo entre las dos
 * pasa de medio campo visual, la fuente está fuera del cuadro y no hay
 * destello: un destello de una luz que no se ve es el defecto más visible de
 * este efecto.
 */
export function projectFlareSource(
  sourceYaw: number,
  sourcePitch: number,
  viewYaw: number,
  viewPitch: number,
  horizontalFovDeg: number,
  aspect = 16 / 9,
): FlareSource {
  const halfH = (horizontalFovDeg * Math.PI) / 360;
  const halfV = Math.atan(Math.tan(halfH) / Math.max(aspect, 0.1));

  const dYaw = normalizeAngle(sourceYaw - viewYaw);
  const dPitch = sourcePitch - viewPitch;

  if (Math.abs(dYaw) > halfH || Math.abs(dPitch) > halfV) {
    return { x: 0.5, y: 0.5, visible: false };
  }

  // Proyección tangente: es la que corresponde a una cámara de perspectiva, y
  // la lineal desplazaría el destello respecto a la luz al acercarse al borde.
  const x = 0.5 + Math.tan(dYaw) / (2 * Math.tan(halfH));
  const y = 0.5 - Math.tan(dPitch) / (2 * Math.tan(halfV));
  return { x, y, visible: true };
}

/**
 * Ángulo equivalente en [−π, π).
 *
 * Se reexporta la de `xr-panel.ts` en lugar de tener dos: la diferencia de
 * giro entre la luz y la cámara cruza el norte constantemente, y dos
 * implementaciones de lo mismo acaban divergiendo justo en ese caso.
 */
export { normalizeAngle };

/* ------------------------------------------------------------------ *
 * Interno
 * ------------------------------------------------------------------ */

function spawn(profile: EffectProfile, random: () => number, anywhere: boolean): Particle {
  const speed = profile.fallSpeed * (1 + (random() - 0.5) * 2 * profile.speedSpread);
  return {
    x: random(),
    y: anywhere ? random() : -0.05,
    vx: (random() - 0.5) * 2 * profile.drift,
    vy: speed,
    size: profile.sizeMin + random() * (profile.sizeMax - profile.sizeMin),
    opacity: profile.opacityMin + random() * (profile.opacityMax - profile.opacityMin),
    phase: random() * Math.PI * 2,
  };
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/* ------------------------------------------------------------------ *
 * Desenfoque de movimiento (V07)
 * ------------------------------------------------------------------ */

/**
 * Velocidad angular, en radianes por segundo, a la que el desenfoque llega a su
 * máximo.
 *
 * Es aproximadamente la velocidad de un giro rápido con el ratón. Por debajo,
 * desenfocar un barrido lento sólo produciría una imagen sucia: el desenfoque
 * tiene que acompañar al movimiento que el ojo ya no sigue, no sustituir al que
 * sí sigue.
 */
export const MOTION_BLUR_FULL_RAD_PER_S = 3.2;

/**
 * Velocidad por debajo de la cual no hay desenfoque.
 *
 * La mano no se queda quieta del todo sobre un ratón ni sobre una pantalla
 * táctil. Sin umbral, la imagen quedaría permanentemente algo sucia y nadie
 * sabría por qué; con él, parada es parada.
 */
export const MOTION_BLUR_THRESHOLD_RAD_PER_S = 0.25;

/** Opacidad máxima de la acumulación: por encima, la imagen deja de leerse. */
export const MOTION_BLUR_MAX_MIX = 0.55;

/**
 * Cuánto desenfoque corresponde a este movimiento.
 *
 * Devuelve la proporción del fotograma anterior que se mezcla con el actual,
 * entre 0 —imagen limpia— y `MOTION_BLUR_MAX_MIX`.
 *
 * Tres reglas, y las tres existen por un fallo concreto:
 *
 *  - **Con movimiento reducido, cero.** El desenfoque de movimiento es énfasis
 *    del movimiento: es justo lo que esa preferencia pide no hacer.
 *  - **Por debajo del umbral, cero**, no «un poco». Si no, la imagen parada
 *    queda permanentemente algo sucia, y eso se lee como un panorama mal
 *    publicado.
 *  - **Acotado por arriba.** Una mezcla cercana a uno deja la imagen
 *    irreconocible y, al parar, tarda segundos en volver a verse: el visitante
 *    cree que el visor se ha colgado.
 */
export function motionBlurMix(
  angularSpeedRadPerS: number,
  intensity: number,
  options: { readonly reducedMotion?: boolean } = {},
): number {
  if (options.reducedMotion === true) return 0;

  const speed = Math.abs(angularSpeedRadPerS);
  if (!Number.isFinite(speed) || speed <= MOTION_BLUR_THRESHOLD_RAD_PER_S) return 0;

  const span = MOTION_BLUR_FULL_RAD_PER_S - MOTION_BLUR_THRESHOLD_RAD_PER_S;
  const fraction = Math.min(1, (speed - MOTION_BLUR_THRESHOLD_RAD_PER_S) / span);

  return fraction * MOTION_BLUR_MAX_MIX * clamp01(intensity);
}

/**
 * Velocidad angular entre dos vistas.
 *
 * Se compone el giro horizontal y el vertical, y el horizontal se corrige por
 * el coseno del cabeceo: cerca del cenit, un gran cambio de yaw mueve muy poco
 * la imagen —los meridianos se juntan—, y sin la corrección el desenfoque se
 * dispararía al mirar hacia arriba sin que nada se moviera en pantalla.
 */
export function angularSpeed(
  from: { readonly yaw: number; readonly pitch: number },
  to: { readonly yaw: number; readonly pitch: number },
  dtSeconds: number,
): number {
  if (dtSeconds <= 0) return 0;

  // Diferencia de yaw por el camino corto: de 350° a 10° son 20°, no 340°.
  let dYaw = to.yaw - from.yaw;
  while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
  while (dYaw < -Math.PI) dYaw += 2 * Math.PI;

  const meanPitch = (from.pitch + to.pitch) / 2;
  const horizontal = dYaw * Math.cos(meanPitch);
  const vertical = to.pitch - from.pitch;

  return Math.hypot(horizontal, vertical) / dtSeconds;
}
