/**
 * Adaptador de realidad virtual (etapa 13, grupo N).
 *
 * La arquitectura advierte que «VR no soportará automáticamente todas las
 * herramientas del editor web: diseñar subconjunto compatible». Este módulo
 * es ese subconjunto, hecho explícito: una lista de lo que funciona en VR y
 * una detección de capacidades que responde antes de prometer nada.
 *
 * El principio que gobierna el módulo: **nunca ofrecer un botón de VR que no
 * funcione**. Un visitante con unas gafas puestas que pulsa «Entrar en VR» y
 * se queda en negro no vuelve a intentarlo.
 */
import type { ComponentKind, DeviceVisibility, Hotspot } from '@it360/domain';

export interface XrCapabilities {
  /** La API WebXR existe en este navegador. */
  readonly apiAvailable: boolean;
  /** Hay un dispositivo capaz de sesión inmersiva. */
  readonly immersiveVrSupported: boolean;
  /** Soporta realidad aumentada, que este producto no usa pero detecta. */
  readonly immersiveArSupported: boolean;
  /** Motivo por el que no está disponible, para explicárselo al usuario. */
  readonly unavailableReason: string | null;
}

/**
 * Consulta las capacidades de WebXR.
 *
 * `isSessionSupported` puede tardar y puede rechazar; ambas cosas se tratan
 * como «no disponible» con un motivo legible, porque es lo que el usuario
 * necesita saber.
 */
export async function detectXrCapabilities(): Promise<XrCapabilities> {
  const xr = (globalThis.navigator as Navigator & { xr?: XRSystem | undefined }).xr;

  if (xr === undefined) {
    return {
      apiAvailable: false,
      immersiveVrSupported: false,
      immersiveArSupported: false,
      unavailableReason:
        'Este navegador no admite realidad virtual. Use un navegador compatible con WebXR en un equipo con visor conectado.',
    };
  }

  try {
    const [vr, ar] = await Promise.all([
      xr.isSessionSupported('immersive-vr').catch(() => false),
      xr.isSessionSupported('immersive-ar').catch(() => false),
    ]);

    return {
      apiAvailable: true,
      immersiveVrSupported: vr,
      immersiveArSupported: ar,
      unavailableReason: vr
        ? null
        : 'No se ha detectado ningún visor de realidad virtual conectado a este equipo.',
    };
  } catch (cause) {
    return {
      apiAvailable: true,
      immersiveVrSupported: false,
      immersiveArSupported: false,
      unavailableReason: `No se pudo consultar el soporte de realidad virtual: ${String(cause)}`,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Subconjunto compatible
 * ------------------------------------------------------------------ */

/**
 * Componentes de interfaz que tienen equivalente en VR (N03, N06).
 *
 * Los que faltan no están olvidados: un editor de skins o una tabla de datos
 * densa no se manejan con un mando a tres metros de distancia. Declarar la
 * lista evita que un recorrido se publique con una interfaz que en VR
 * aparece vacía.
 */
export const VR_SUPPORTED_COMPONENTS: readonly ComponentKind[] = [
  'container',
  'button',
  'image',
  'text',
  'progressBar',
  'thumbnailList',
  'quizCard',
  'scoreBoard',
  'timer',
  'assetPanel',
  'telemetryPanel',
  'spacer',
];

export const isVrCompatible = (kind: ComponentKind): boolean =>
  VR_SUPPORTED_COMPONENTS.includes(kind);

/** Formas de marcador que se pueden seleccionar con mando o mirada (N07). */
export const VR_SUPPORTED_HOTSPOT_SHAPES = ['icon', 'text', 'polygon', 'model', 'projectedImage'] as const;

/**
 * `true` si el marcador puede usarse en VR.
 *
 * Los webframes quedan fuera: una página web embebida dentro de una sesión
 * inmersiva no recibe los eventos del mando y no hay forma de escribir en
 * ella. Mostrarla sería enseñar algo con lo que no se puede interactuar.
 */
export function isHotspotVrCompatible(hotspot: Hotspot): boolean {
  if (!hotspot.visibility.vr) return false;
  return (VR_SUPPORTED_HOTSPOT_SHAPES as readonly string[]).includes(hotspot.geometry.shape);
}

/* ------------------------------------------------------------------ *
 * Paneles en VR (N04, N05)
 * ------------------------------------------------------------------ */

export type VrPanelMode =
  /** Fijo en el espacio: se queda donde se abrió. */
  | 'worldFixed'
  /** Sigue la mirada con retardo: siempre accesible sin perseguirlo. */
  | 'recentering'
  /** Arrastrable con el mando. */
  | 'draggable'
  /** Modal: bloquea el resto hasta cerrarlo. */
  | 'modal';

export interface VrPanelPlacement {
  readonly mode: VrPanelMode;
  /** Distancia al observador, en metros. */
  readonly distanceM: number;
  /** Anchura del panel, en metros. */
  readonly widthM: number;
  readonly heightM: number;
  /** Desplazamiento angular respecto al centro de la mirada, en radianes. */
  readonly yawOffset: number;
  readonly pitchOffset: number;
}

/**
 * Colocación por defecto de un panel en VR.
 *
 * 1,8 m y 1,2 m de ancho no son cifras arbitrarias: a esa distancia un panel
 * de ese tamaño ocupa unos 37° del campo visual, que es el intervalo en el
 * que el texto se lee sin mover la cabeza y sin que el panel tape la escena.
 * Más cerca fuerza la convergencia ocular y cansa en minutos.
 */
export const DEFAULT_VR_PANEL: VrPanelPlacement = {
  mode: 'recentering',
  distanceM: 1.8,
  widthM: 1.2,
  heightM: 0.78,
  yawOffset: 0,
  pitchOffset: -0.12,
};

/** Tamaño mínimo de texto legible en VR, en metros de altura de carácter. */
export const VR_MIN_TEXT_HEIGHT_M = 0.018;

/**
 * Comprueba que un panel sea legible a su distancia.
 *
 * Un panel diseñado para pantalla y llevado a VR sin ajustar queda con texto
 * de un par de milímetros a dos metros, es decir, ilegible. Esta comprobación
 * lo detecta en el editor en vez de en las gafas.
 */
export function isPanelReadable(placement: VrPanelPlacement, textSizePx: number, panelWidthPx: number): boolean {
  const metersPerPixel = placement.widthM / Math.max(panelWidthPx, 1);
  return textSizePx * metersPerPixel >= VR_MIN_TEXT_HEIGHT_M * (placement.distanceM / 1.8);
}

/* ------------------------------------------------------------------ *
 * Mandos (N11)
 * ------------------------------------------------------------------ */

export type VrInputAction =
  | 'select'
  | 'rotateLeft'
  | 'rotateRight'
  | 'teleport'
  | 'menu'
  | 'exit';

/**
 * Giro por pasos y no continuo.
 *
 * El giro continuo es la causa principal del malestar en VR: el oído interno
 * no registra la rotación que los ojos ven. El giro por pasos de 30° con una
 * transición breve evita el conflicto, y es lo que usan los títulos que se
 * toman en serio la comodidad.
 */
export const SNAP_TURN_RAD = Math.PI / 6;

export interface VrSessionState {
  readonly active: boolean;
  /** Rotación acumulada aplicada por el usuario con el mando. */
  readonly yawOffset: number;
  /** Mano que tiene el puntero activo. */
  readonly activeHand: 'left' | 'right' | null;
}

export const IDLE_VR_SESSION: VrSessionState = {
  active: false,
  yawOffset: 0,
  activeHand: null,
};

/** Aplica una acción del mando al estado de sesión. */
export function applyVrInput(state: VrSessionState, action: VrInputAction): VrSessionState {
  switch (action) {
    case 'rotateLeft':
      return { ...state, yawOffset: state.yawOffset - SNAP_TURN_RAD };
    case 'rotateRight':
      return { ...state, yawOffset: state.yawOffset + SNAP_TURN_RAD };
    case 'exit':
      return IDLE_VR_SESSION;
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Publicación para VR (N12)
 * ------------------------------------------------------------------ */

export interface VrOptimizationProfile {
  readonly name: string;
  /** Resolución máxima de panorámica para este dispositivo. */
  readonly maxPanoramaEdgePx: number;
  readonly targetFps: number;
  /** Número máximo de marcadores visibles a la vez. */
  readonly maxVisibleHotspots: number;
}

/**
 * Perfiles de optimización por clase de dispositivo.
 *
 * Son conservadores a propósito. Un visor autónomo tiene el presupuesto
 * gráfico de un teléfono de gama media y debe sostener 72 fps: cualquier caída
 * se siente en el estómago, no en los ojos.
 */
export const VR_PROFILES: Readonly<Record<string, VrOptimizationProfile>> = {
  standalone: {
    name: 'Visor autónomo',
    maxPanoramaEdgePx: 4096,
    targetFps: 72,
    maxVisibleHotspots: 24,
  },
  tethered: {
    name: 'Visor conectado a PC',
    maxPanoramaEdgePx: 8192,
    targetFps: 90,
    maxVisibleHotspots: 64,
  },
};

/** Claves de perfil, en el mismo orden que `VR_PROFILES`. */
export type VrProfileKey = 'standalone' | 'tethered';

/**
 * Clase de dispositivo a partir del identificador del navegador (N12).
 *
 * WebXR no dice si el visor es autónomo o va conectado a un PC, y la diferencia
 * decide qué panorámica se puede cargar: un visor autónomo no admite una
 * textura de 8192 px. Lo único observable es el navegador, y ahí sí hay señal:
 * los navegadores de los visores autónomos corren sobre Android y se anuncian
 * como tal; un visor conectado se usa desde el navegador de un PC.
 *
 * **La duda se resuelve siempre hacia el lado conservador.** Si el navegador no
 * es reconociblemente de escritorio, se asume autónomo: equivocarse hacia
 * «autónomo» cuesta nitidez en un PC que podía con más, y equivocarse hacia
 * «conectado» deja la escena en negro o a tirones en el visor, que es el sitio
 * donde un fallo se siente físicamente.
 */
export function vrDeviceClass(userAgent: string): VrProfileKey {
  const ua = userAgent.toLowerCase();

  // Android primero: un visor autónomo lo lleva y además dice «windows nt» en
  // ningún caso, pero algunos navegadores de visor incluyen «linux».
  if (ua.includes('android') || ua.includes('quest') || ua.includes('pico')) {
    return 'standalone';
  }

  const desktop =
    ua.includes('windows nt') ||
    ua.includes('macintosh') ||
    ua.includes('mac os x') ||
    (ua.includes('linux') && !ua.includes('mobile'));

  return desktop ? 'tethered' : 'standalone';
}

/** Avisos de compatibilidad de una escena para VR, para mostrar en el editor. */
export function vrCompatibilityWarnings(
  hotspots: readonly Hotspot[],
  components: readonly ComponentKind[],
  profile: VrOptimizationProfile,
): string[] {
  const warnings: string[] = [];

  const incompatible = hotspots.filter((h) => h.visibility.vr && !isHotspotVrCompatible(h));
  if (incompatible.length > 0) {
    warnings.push(
      `${incompatible.length} marcador(es) están marcados como visibles en VR pero su tipo no es compatible: ${incompatible
        .slice(0, 3)
        .map((h) => h.name)
        .join(', ')}`,
    );
  }

  const visibleInVr = hotspots.filter((h) => h.visibility.vr).length;
  if (visibleInVr > profile.maxVisibleHotspots) {
    warnings.push(
      `La escena tiene ${visibleInVr} marcadores visibles en VR; el perfil «${profile.name}» recomienda no superar ${profile.maxVisibleHotspots}.`,
    );
  }

  const unsupportedComponents = components.filter((c) => !isVrCompatible(c));
  if (unsupportedComponents.length > 0) {
    warnings.push(
      `Componentes de interfaz sin equivalente en VR: ${[...new Set(unsupportedComponents)].join(', ')}.`,
    );
  }

  return warnings;
}

/** Visibilidad que excluye VR, para componentes no portables. */
export const DESKTOP_ONLY: DeviceVisibility = {
  desktop: true,
  tablet: true,
  mobile: true,
  vr: false,
};
