/**
 * Espaciado, radios, elevación, movimiento y z-index.
 *
 * El espaciado usa una base de 4 px. Toda la interfaz se alinea a esa
 * retícula, lo que permite que un panel de propiedades con 30 filas no
 * acumule desalineaciones de un píxel.
 */

/** Escala de espaciado en px, base 4. */
export const space = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
} as const;

/**
 * Radios contenidos. Una herramienta industrial con esquinas muy redondeadas
 * se lee como software de consumo; 3–6 px mantiene el carácter técnico sin
 * resultar duro.
 */
export const radius = {
  none: 0,
  xs: 2,
  sm: 3,
  md: 4,
  lg: 6,
  xl: 10,
  pill: 999,
  circle: '50%',
} as const;

export const borderWidth = {
  hairline: 1,
  thick: 2,
  focus: 2,
} as const;

/**
 * Elevación. En tema oscuro la sombra apenas se percibe, de modo que la
 * jerarquía la aporta el nivel de superficie y el borde; la sombra sólo
 * confirma que algo flota (menú, popover, modal).
 */
export const elevation = {
  none: 'none',
  sm: '0 1px 2px rgba(0, 0, 0, 0.32)',
  md: '0 2px 6px rgba(0, 0, 0, 0.36), 0 1px 2px rgba(0, 0, 0, 0.24)',
  lg: '0 8px 24px rgba(0, 0, 0, 0.44), 0 2px 6px rgba(0, 0, 0, 0.28)',
  xl: '0 20px 48px rgba(0, 0, 0, 0.52), 0 4px 12px rgba(0, 0, 0, 0.32)',
  /** Resalte interior de control hundido (campo de texto en tema oscuro). */
  inset: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
} as const;

/**
 * Movimiento. Duraciones cortas: la interfaz debe sentirse instrumental.
 * Las transiciones del visor 360 tienen su propia escala porque representan
 * desplazamiento físico y no respuesta de control.
 */
export const duration = {
  instant: 0,
  fast: 90,
  normal: 140,
  slow: 220,
  deliberate: 320,
  /** Transición entre escenas del recorrido (etapa 02, C04). */
  sceneTransition: 700,
} as const;

export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0.2, 1)',
  decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Inercia de cámara: entra rápido y frena largo. */
  inertia: 'cubic-bezier(0.17, 0.84, 0.44, 1)',
} as const;

/** Orden de apilado único y documentado: evita la guerra de z-index. */
export const zIndex = {
  base: 0,
  canvasOverlay: 100,
  hotspotLabel: 200,
  stickyHeader: 300,
  dropdown: 400,
  tooltip: 500,
  drawer: 600,
  modal: 700,
  toast: 800,
  commandPalette: 900,
  debugOverlay: 1000,
} as const;

/** Alturas fijas del armazón de la aplicación. */
export const frame = {
  commandBarHeight: 44,
  statusBarHeight: 26,
  railWidth: 48,
  sidebarWidth: 288,
  sidebarMinWidth: 240,
  sidebarMaxWidth: 480,
  inspectorWidth: 320,
  timelineHeight: 180,
  rowHeight: 28,
  rowHeightCompact: 24,
  controlHeight: 28,
  controlHeightLg: 34,
} as const;

/** Puntos de ruptura. 1366×768 es requisito explícito de la etapa 03. */
export const breakpoint = {
  sm: 1024,
  md: 1366,
  lg: 1680,
  xl: 1920,
  '2xl': 2560,
} as const;
