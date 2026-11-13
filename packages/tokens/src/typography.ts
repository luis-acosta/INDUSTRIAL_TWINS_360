/**
 * Tipografía.
 *
 * Dos familias, elegidas por razones funcionales y no estéticas:
 *
 *  - **IBM Plex Sans** para interfaz. Fue diseñada para producto técnico:
 *    altura de x generosa, formas abiertas y numerales legibles a 11–12 px,
 *    que es el tamaño real de una barra de propiedades densa.
 *  - **IBM Plex Mono** para TAG industrial, valores de telemetría, timestamps,
 *    hashes y coordenadas. El ancho fijo evita que una cifra que cambia cada
 *    segundo desplace la etiqueta que tiene al lado, y hace comparables dos
 *    TAG escritos uno debajo del otro.
 *
 * Ambas se empaquetan localmente (`packages/ui/assets/fonts`) porque la
 * aplicación debe funcionar sin Internet (etapa 10, S05). No se permite
 * `@import` a un CDN de fuentes en ningún punto del producto.
 *
 * La escala es modular con razón 1.125 (segunda mayor) desde una base de
 * 13 px, truncada a medios píxeles. Una razón más agresiva produce saltos
 * demasiado grandes para una herramienta con mucha jerarquía en poco espacio.
 */

export const fontFamily = {
  sans: "'IBM Plex Sans', 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', 'Cascadia Mono', 'Consolas', 'SF Mono', ui-monospace, monospace",
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Escala tipográfica en px (base 13, razón 1.125). */
export const fontSize = {
  '2xs': 10,
  xs: 11,
  sm: 12,
  base: 13,
  md: 14.5,
  lg: 16.5,
  xl: 18.5,
  '2xl': 21,
  '3xl': 23.5,
  '4xl': 26.5,
  '5xl': 30,
} as const;

export const lineHeight = {
  tight: 1.2,
  snug: 1.35,
  normal: 1.5,
  relaxed: 1.65,
} as const;

/** Interletraje: negativo en titulares, positivo en versalitas pequeñas. */
export const letterSpacing = {
  tighter: '-0.02em',
  tight: '-0.01em',
  normal: '0',
  wide: '0.02em',
  wider: '0.06em',
  caps: '0.08em',
} as const;

export interface TextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: number;
  readonly letterSpacing: string;
  readonly textTransform?: 'uppercase';
}

/**
 * Estilos de texto con nombre de uso. Los componentes referencian estos
 * nombres, no tamaños sueltos, para que la jerarquía sea una decisión del
 * sistema y no de cada pantalla.
 */
export const textStyles = {
  /** Título de página o de diálogo modal. */
  displayMd: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tighter,
  },
  /** Encabezado de sección principal. */
  headingLg: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Encabezado de panel. */
  headingMd: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.tight,
  },
  /** Encabezado de subsección o tarjeta. */
  headingSm: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.normal,
  },
  /** Cuerpo por defecto de la interfaz. */
  body: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.base,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.normal,
    letterSpacing: letterSpacing.normal,
  },
  /** Cuerpo en texto largo: manual, descripción de activo. */
  bodyRelaxed: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.md,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.relaxed,
    letterSpacing: letterSpacing.normal,
  },
  /** Etiqueta de control de formulario. */
  label: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.normal,
  },
  /** Texto auxiliar, ayuda y pie de campo. */
  caption: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.normal,
  },
  /** Rótulo de grupo en versalitas: cabeceras de panel lateral. */
  overline: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize['2xs'],
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.caps,
    textTransform: 'uppercase',
  },
  /** TAG industrial, identificadores y rutas. */
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.normal,
  },
  /** TAG destacado en ficha de activo. */
  monoStrong: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.snug,
    letterSpacing: letterSpacing.normal,
  },
  /** Lectura numérica grande de instrumento. */
  readout: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize['4xl'],
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Lectura numérica compacta en lista de variables. */
  readoutSm: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.normal,
  },
} as const satisfies Record<string, TextStyle>;

export type TextStyleName = keyof typeof textStyles;
