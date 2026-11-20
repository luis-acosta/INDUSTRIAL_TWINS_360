/**
 * Capa de efectos ambientales sobre la escena (V06, V08).
 *
 * Dibuja el estado que simula `ambient-effects.ts` en un lienzo 2D colocado
 * encima del lienzo de la escena. Elegir un lienzo aparte en lugar de pintar
 * dentro del renderizador tiene tres consecuencias buenas: funciona igual sobre
 * una panorámica y sobre un modelo, se puede apagar sin tocar el renderizador,
 * y no gasta memoria de GPU, que es la que escasea en un visor autónomo.
 *
 * La capa no recibe eventos del ratón —`pointer-events: none`— porque está
 * encima de los marcadores: sin eso, una escena con lluvia dejaría de
 * responder a los clics, que es un defecto peor que no tener lluvia.
 */
import { useEffect, useRef, type JSX } from 'react';

import {
  advanceAmbient,
  flareElements,
  projectFlareSource,
  type AmbientState,
  type FlareSource,
} from './ambient-effects';

export interface AmbientLayerProps {
  /** Estado inicial, o `null` para no dibujar nada. */
  readonly state: AmbientState | null;
  /** Fuente de luz en pantalla, para el destello. */
  readonly flareSource?: FlareSource | null;
  readonly className?: string;
}

/** Color de cada efecto. El polvo industrial es cálido, la nieve fría. */
const COLORS = {
  rain: 'rgba(188, 212, 236, 1)',
  dust: 'rgba(214, 196, 160, 1)',
  snow: 'rgba(248, 250, 255, 1)',
  flare: 'rgba(255, 246, 214, 1)',
} as const;

export function AmbientLayer({ state, flareSource = null, className }: AmbientLayerProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // El estado y la fuente cambian en cada fotograma del visor; el bucle los
  // lee de referencias para no reinstalarse con cada cambio, que cortaría la
  // animación en seco cada vez que se gira la cámara.
  const stateRef = useRef(state);
  const sourceRef = useRef(flareSource);
  stateRef.current = state;
  sourceRef.current = flareSource;

  useEffect(() => {
    if (state === null) return undefined;
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;

    let frame: number | null = null;
    let previous: number | null = null;
    let current = state;

    const draw = (now: number): void => {
      const dt = previous === null ? 0 : (now - previous) / 1000;
      previous = now;

      // El tamaño se toma del propio lienzo en cada fotograma: así un cambio
      // de tamaño de la ventana no exige reinstalar el bucle ni deja la capa
      // dibujando en una resolución vieja.
      const { width, height } = canvas;
      if (width === 0 || height === 0) {
        frame = globalThis.requestAnimationFrame(draw);
        return;
      }

      current = advanceAmbient(current, dt);
      ctx.clearRect(0, 0, width, height);
      paintAmbient(ctx, current, width, height);

      const source = sourceRef.current;
      if (source !== null && (current.kind === 'lensFlare' || stateRef.current?.kind === 'lensFlare')) {
        paintFlare(ctx, source, current.intensity, width, height);
      }

      frame = globalThis.requestAnimationFrame(draw);
    };

    frame = globalThis.requestAnimationFrame(draw);
    return () => {
      if (frame !== null) globalThis.cancelAnimationFrame(frame);
    };
    // El efecto se reinstala cuando cambia el tipo o la intensidad, que es
    // cuando hay que rehacer las partículas; no con cada giro de cámara.
  }, [state?.kind, state?.intensity, state === null]);

  if (state === null) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className ?? 'ambient-layer'}
      aria-hidden="true"
      width={1280}
      height={720}
    />
  );
}

/** Lo que la capa necesita de un lienzo 2D. */
export interface AmbientPainter {
  // El tipo admite patrón además de color y degradado porque es lo que
  // declara `CanvasRenderingContext2D`: una interfaz más estrecha obligaría a
  // convertir el contexto real en cada llamada, y una conversión es
  // exactamente donde se cuela un error de tipos que esto quiere evitar.
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
}

/**
 * Pinta las partículas.
 *
 * La lluvia se traza como segmento y no como punto: una gota a la velocidad a
 * la que cae se registra en la retina —y en el sensor de una cámara— como una
 * raya, y dibujarla redonda da el aspecto de burbujas flotando.
 */
export function paintAmbient(
  ctx: AmbientPainter,
  state: AmbientState,
  width: number,
  height: number,
): void {
  if (state.kind === 'none' || state.kind === 'lensFlare') return;

  if (state.kind === 'rain') {
    ctx.strokeStyle = COLORS.rain;
    ctx.lineWidth = Math.max(1, width / 1280);
    for (const particle of state.particles) {
      ctx.globalAlpha = particle.opacity;
      ctx.beginPath();
      ctx.moveTo(particle.x * width, particle.y * height);
      // La raya sigue la dirección real de la gota, de modo que con viento la
      // lluvia se inclina sola.
      const length = particle.size * height;
      const norm = Math.hypot(particle.vx, particle.vy) || 1;
      ctx.lineTo(
        particle.x * width + (particle.vx / norm) * length,
        particle.y * height + (particle.vy / norm) * length,
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return;
  }

  ctx.fillStyle = state.kind === 'snow' ? COLORS.snow : COLORS.dust;
  for (const particle of state.particles) {
    ctx.globalAlpha = particle.opacity;
    ctx.beginPath();
    ctx.arc(particle.x * width, particle.y * height, Math.max(0.5, particle.size * height), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Pinta los elementos del destello. */
export function paintFlare(
  ctx: AmbientPainter,
  source: FlareSource,
  intensity: number,
  width: number,
  height: number,
): void {
  const elements = flareElements(source, intensity);
  ctx.fillStyle = COLORS.flare;
  for (const element of elements) {
    ctx.globalAlpha = element.opacity;
    ctx.beginPath();
    ctx.arc(element.x * width, element.y * height, element.radius * Math.min(width, height), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Reexportado para que quien monta la capa no importe dos módulos. */
export { projectFlareSource };
