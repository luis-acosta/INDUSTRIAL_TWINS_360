/**
 * Capa 2 del sistema de diseño: tokens semánticos.
 *
 * Cada token nombra un ROL, no un color. Los componentes consumen
 * exclusivamente esta capa (a través de variables CSS `--it-*`), de forma que
 * un cambio de tema no toca ni una línea de componente.
 *
 * Reglas aplicadas:
 *  - Jerarquía de superficie en 4 niveles (canvas → surface → raised → overlay).
 *    Un panel nunca se distingue por sombra pesada, sino por nivel y hairline.
 *  - El acento cromático se reserva a interacción (`accent.*`) y el color
 *    restante a estado de proceso (`status.*`). Nada decorativo.
 *  - Los estados de telemetría son tokens propios (`telemetry.*`) porque la
 *    etapa 07 exige distinguir fresco / obsoleto / ausente / error sin
 *    ambigüedad, y esa distinción no puede depender del criterio del
 *    desarrollador de turno.
 */
import { neutral, cyan, green, amber, red, blue, violet } from './palette';

export type ThemeName = 'dark' | 'light';

export interface SemanticColors {
  /** Fondos, de más profundo a más elevado. */
  readonly surface: {
    readonly canvas: string;
    readonly base: string;
    readonly raised: string;
    readonly overlay: string;
    readonly sunken: string;
    readonly inverse: string;
  };
  /** Bordes y separadores. */
  readonly border: {
    /** Separador apenas perceptible entre filas de una lista densa. */
    readonly subtle: string;
    /** Borde de panel y divisor estructural. Decorativo: exento de 1.4.11. */
    readonly default: string;
    /** Divisor enfatizado entre regiones del armazón. */
    readonly strong: string;
    /**
     * Límite de un control interactivo (campo, selector, casilla). Es el
     * único indicador de los bordes del control, así que WCAG 1.4.11 exige
     * 3:1 contra la superficie que lo contiene. Verificado en pruebas.
     */
    readonly control: string;
    readonly focus: string;
  };
  /** Texto e iconografía. */
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    readonly tertiary: string;
    readonly disabled: string;
    readonly inverse: string;
    readonly onAccent: string;
  };
  /** Acento de interacción. */
  readonly accent: {
    readonly default: string;
    readonly hover: string;
    readonly active: string;
    readonly subtle: string;
    readonly muted: string;
    readonly onSurface: string;
  };
  /** Estado de proceso y de sistema. */
  readonly status: {
    readonly nominal: string;
    readonly nominalSurface: string;
    readonly warning: string;
    readonly warningSurface: string;
    readonly alarm: string;
    readonly alarmSurface: string;
    readonly info: string;
    readonly infoSurface: string;
    readonly experimental: string;
    readonly experimentalSurface: string;
  };
  /** Calidad del dato de telemetría (etapa 07, X12). */
  readonly telemetry: {
    readonly fresh: string;
    readonly stale: string;
    readonly missing: string;
    readonly error: string;
    readonly cached: string;
  };
  /** Lienzo de edición 360/3D. */
  readonly canvas: {
    readonly hotspot: string;
    readonly hotspotSelected: string;
    readonly hotspotLocked: string;
    readonly polygonFill: string;
    readonly polygonStroke: string;
    readonly handle: string;
    readonly guide: string;
    readonly radarCone: string;
  };
}

const alpha = (hex: string, a: number): string => {
  const n = Math.round(Math.min(Math.max(a, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${n}`;
};

export const darkColors: SemanticColors = {
  surface: {
    canvas: neutral[25],
    base: neutral[50],
    raised: neutral[75],
    overlay: neutral[100],
    sunken: neutral[0],
    inverse: neutral[900],
  },
  border: {
    subtle: neutral[100],
    default: neutral[150],
    strong: neutral[200],
    control: neutral[400],
    focus: cyan[400],
  },
  text: {
    primary: neutral[850],
    secondary: neutral[600],
    tertiary: neutral[400],
    disabled: neutral[300],
    inverse: neutral[50],
    onAccent: neutral[0],
  },
  accent: {
    default: cyan[500],
    hover: cyan[400],
    active: cyan[600],
    subtle: alpha(cyan[500], 0.16),
    muted: alpha(cyan[500], 0.08),
    onSurface: cyan[300],
  },
  status: {
    nominal: green[400],
    nominalSurface: alpha(green[500], 0.14),
    warning: amber[400],
    warningSurface: alpha(amber[500], 0.14),
    alarm: red[400],
    alarmSurface: alpha(red[500], 0.16),
    info: blue[300],
    infoSurface: alpha(blue[500], 0.16),
    experimental: violet[300],
    experimentalSurface: alpha(violet[500], 0.16),
  },
  telemetry: {
    fresh: green[400],
    stale: amber[400],
    // Un dato ausente se muestra atenuado, pero sigue siendo texto que el
    // operador debe poder leer: neutral[400] no alcanzaba AA sobre superficie
    // elevada (3.71:1), por lo que se usa neutral[500].
    missing: neutral[500],
    // red[400] se queda en 4.40:1 sobre superficie elevada, que es donde vive
    // el panel de instrumentos; un paso más claro lo deja por encima de AA.
    error: red[300],
    cached: violet[300],
  },
  canvas: {
    hotspot: cyan[400],
    hotspotSelected: amber[300],
    hotspotLocked: neutral[500],
    polygonFill: alpha(cyan[400], 0.18),
    polygonStroke: cyan[300],
    handle: neutral[900],
    guide: alpha(cyan[300], 0.35),
    radarCone: alpha(cyan[400], 0.28),
  },
};

export const lightColors: SemanticColors = {
  surface: {
    canvas: neutral[900],
    base: neutral[1000],
    raised: neutral[950],
    overlay: neutral[1000],
    sunken: neutral[850],
    inverse: neutral[50],
  },
  border: {
    subtle: neutral[800],
    default: neutral[700],
    strong: neutral[600],
    control: neutral[400],
    focus: cyan[700],
  },
  text: {
    primary: neutral[25],
    secondary: neutral[300],
    tertiary: neutral[400],
    disabled: neutral[500],
    inverse: neutral[950],
    onAccent: neutral[1000],
  },
  accent: {
    // En tema claro el acento lleva texto blanco encima (botón primario).
    // cyan[600] daba 4.10:1 con blanco, por debajo de AA, de modo que el
    // acento del tema claro arranca un paso más oscuro.
    default: cyan[700],
    hover: cyan[600],
    active: cyan[800],
    subtle: alpha(cyan[700], 0.12),
    muted: alpha(cyan[700], 0.06),
    onSurface: cyan[700],
  },
  status: {
    nominal: green[700],
    nominalSurface: alpha(green[500], 0.12),
    warning: amber[700],
    warningSurface: alpha(amber[500], 0.16),
    alarm: red[600],
    alarmSurface: alpha(red[500], 0.1),
    info: blue[600],
    infoSurface: alpha(blue[500], 0.1),
    experimental: violet[600],
    experimentalSurface: alpha(violet[500], 0.1),
  },
  telemetry: {
    fresh: green[700],
    stale: amber[700],
    missing: neutral[300],
    error: red[700],
    cached: violet[600],
  },
  canvas: {
    hotspot: cyan[600],
    hotspotSelected: amber[600],
    hotspotLocked: neutral[400],
    polygonFill: alpha(cyan[600], 0.16),
    polygonStroke: cyan[700],
    handle: neutral[25],
    guide: alpha(cyan[700], 0.3),
    radarCone: alpha(cyan[600], 0.24),
  },
};

export const themes: Record<ThemeName, SemanticColors> = {
  dark: darkColors,
  light: lightColors,
};
