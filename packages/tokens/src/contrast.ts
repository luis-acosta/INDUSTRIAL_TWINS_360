/**
 * Cálculo de contraste WCAG 2.1.
 *
 * Existe para que la accesibilidad del sistema de diseño sea verificable y no
 * una afirmación. `contrast.test.ts` recorre las combinaciones reales de
 * texto sobre superficie en ambos temas y falla si alguna cae por debajo del
 * umbral AA. La etapa 03 pide accesibilidad básica de los controles de
 * edición; esto es la parte que una máquina puede comprobar.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Acepta `#rgb`, `#rrggbb` y `#rrggbbaa`. */
export function parseColor(input: string): Rgb {
  const hex = input.trim().replace(/^#/, '');
  const expand = (s: string): string =>
    s.length === 3 || s.length === 4
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s;
  const full = expand(hex);
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
    throw new Error(`Color no reconocido: ${input}`);
  }
  const num = (i: number): number => parseInt(full.slice(i, i + 2), 16);
  return {
    r: num(0),
    g: num(2),
    b: num(4),
    a: full.length === 8 ? num(6) / 255 : 1,
  };
}

/** Compone un color con alfa sobre un fondo opaco. */
export function flattenOver(fg: Rgb, bg: Rgb): Rgb {
  const mix = (f: number, b: number): number => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Luminancia relativa según WCAG 2.1. */
export function relativeLuminance(color: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Razón de contraste entre 1 y 21. El alfa se compone sobre el fondo. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  if (bg.a < 1) {
    throw new Error('El color de fondo debe ser opaco para calcular contraste');
  }
  const fgRaw = parseColor(foreground);
  const fg = fgRaw.a < 1 ? flattenOver(fgRaw, bg) : fgRaw;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [light, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

/* ------------------------------------------------------------------ *
 * Distancia perceptual
 *
 * La razón de contraste mide luminancia y nada más. Dos colores pueden ser
 * perfectamente distinguibles para el ojo y tener contraste 1.2:1 entre sí
 * (un verde y un ámbar de la misma claridad, por ejemplo), y al revés.
 *
 * La etapa 07 (X12) exige distinguir dato fresco, obsoleto, ausente y error.
 * Para comprobar esa exigencia hace falta distancia perceptual, no contraste,
 * de modo que se implementa CIEDE2000 sobre CIE Lab con iluminante D65.
 * ------------------------------------------------------------------ */

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** sRGB -> CIE XYZ (D65). */
function toXyz(color: Rgb): { x: number; y: number; z: number } {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = lin(color.r);
  const g = lin(color.g);
  const b = lin(color.b);
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  };
}

/** sRGB -> CIE Lab (D65, observador 2°). */
export function toLab(input: string | Rgb): Lab {
  const rgb = typeof input === 'string' ? parseColor(input) : input;
  const { x, y, z } = toXyz(rgb);
  // Blanco de referencia D65.
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * ΔE CIEDE2000. Implementación de la formulación de Sharma, Wu y Dalal (2005),
 * con los factores de ponderación neutros kL = kC = kH = 1.
 *
 * Interpretación práctica: ΔE < 1 es imperceptible, ≈ 2–3 es el umbral de
 * detección fiable, y por encima de 20 los colores se leen como categorías
 * distintas sin necesidad de compararlos uno al lado del otro.
 */
export function deltaE2000(colorA: string | Rgb, colorB: string | Rgb): number {
  const lab1 = toLab(colorA);
  const lab2 = toLab(colorB);

  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const c1 = Math.hypot(lab1.a, lab1.b);
  const c2 = Math.hypot(lab2.a, lab2.b);
  const cBar = (c1 + c2) / 2;

  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));
  const a1p = (1 + g) * lab1.a;
  const a2p = (1 + g) * lab2.a;

  const c1p = Math.hypot(a1p, lab1.b);
  const c2p = Math.hypot(a2p, lab2.b);

  const h1p = c1p === 0 ? 0 : ((Math.atan2(lab1.b, a1p) * deg) + 360) % 360;
  const h2p = c2p === 0 ? 0 : ((Math.atan2(lab2.b, a2p) * deg) + 360) % 360;

  const dLp = lab2.l - lab1.l;
  const dCp = c2p - c1p;

  let dhp: number;
  if (c1p * c2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else {
    dhp = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2);

  const lBarP = (lab1.l + lab2.l) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP: number;
  if (c1p * c2p === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarP = (h1p + h2p) / 2;
  } else {
    hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * rad) +
    0.24 * Math.cos(2 * hBarP * rad) +
    0.32 * Math.cos((3 * hBarP + 6) * rad) -
    0.2 * Math.cos((4 * hBarP - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const rc = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const rt = -rc * Math.sin(2 * dTheta * rad);

  const sl = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;

  return Math.sqrt(
    Math.pow(dLp / sl, 2) +
      Math.pow(dCp / sc, 2) +
      Math.pow(dHp / sh, 2) +
      rt * (dCp / sc) * (dHp / sh),
  );
}

/**
 * Umbral de separación exigido entre dos colores que representan categorías
 * distintas en la misma vista (los cuatro estados de calidad de dato, las
 * series de una gráfica histórica). Se fija en 20 porque por debajo de ese
 * valor la distinción depende de verlos contiguos, y en un panel de
 * instrumentos no siempre lo están.
 */
export const CATEGORICAL_DELTA_E_MIN = 20;

/**
 * Separación mínima admitida entre un color cromático y un neutro de claridad
 * equivalente.
 *
 * Hay una tensión real entre dos exigencias: para cumplir AA sobre fondo
 * oscuro un color debe ser claro, y un color claro y cromático queda
 * perceptualmente cerca de un gris claro. Alcanzar ΔE 20 contra un neutro
 * obligaría a sacrificar contraste o a saturar el color hasta un registro
 * que no corresponde a una herramienta industrial.
 *
 * La resolución adoptada: los cuatro estados que la etapa 07 (X12) exige
 * distinguir —fresco, obsoleto, ausente y error— mantienen ΔE ≥ 20 entre sí.
 * El marcador de procedencia `cached` queda fuera de esa exigencia porque la
 * arquitectura obliga a rotularlo explícitamente como caché y nunca se
 * comunica sólo por color (WCAG 1.4.1); sí se le exige separación plena
 * frente a `fresh`, para que un dato de caché no pueda confundirse con una
 * lectura nominal en vivo.
 */
export const NEUTRAL_VS_CHROMATIC_DELTA_E_MIN = 12;

export type WcagLevel = 'AA' | 'AAA';
export type TextSize = 'normal' | 'large';

/** Umbral exigido por WCAG 2.1 para texto. */
export function requiredRatio(level: WcagLevel, size: TextSize): number {
  if (level === 'AAA') return size === 'large' ? 4.5 : 7;
  return size === 'large' ? 3 : 4.5;
}

export function meetsContrast(
  foreground: string,
  background: string,
  level: WcagLevel = 'AA',
  size: TextSize = 'normal',
): boolean {
  return contrastRatio(foreground, background) >= requiredRatio(level, size);
}

/** Umbral de WCAG 1.4.11 para bordes de control y elementos gráficos. */
export const NON_TEXT_CONTRAST_MIN = 3;
