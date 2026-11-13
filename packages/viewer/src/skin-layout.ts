/**
 * Disposición de la interfaz del recorrido (F05, F06, F08, F11, F12, J05).
 *
 * Convierte el árbol de componentes de un *skin* en posiciones y estilos
 * concretos. Está separado del componente de React por el mismo motivo que el
 * resto de la aritmética de este proyecto: un panel que aparece veinte píxeles
 * desplazado no se ve roto, se ve descuidado, y nadie lo detecta sin medir.
 *
 * Las dos decisiones que gobiernan todo lo demás:
 *
 * **Modo fijo contra modo adaptable (F05).** En modo fijo, el autor diseña para
 * un tamaño de referencia y todo se escala en bloque: lo que quedaba a la
 * izquierda del logotipo sigue ahí en cualquier pantalla. En modo adaptable,
 * las posiciones se interpretan en píxeles reales y los porcentajes respecto
 * al contenedor. El primero conserva la composición y sacrifica el
 * aprovechamiento; el segundo, al contrario. Ninguno es mejor, y por eso el
 * autor elige.
 *
 * **El anclaje es del componente, no de la pantalla.** Un botón anclado abajo
 * a la derecha con desplazamiento (16, 16) está a dieciséis píxeles de la
 * esquina inferior derecha **de su contenedor**. Sin esa regla, meter un botón
 * en un panel lo mandaría a la esquina de la ventana.
 */
import type { AnchorPoint, Box, DeviceKind, Skin, SkinNode, SkinStyle } from '@it360/domain';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Caja resuelta en píxeles, relativa al contenedor. */
export interface ResolvedBox {
  readonly left: number;
  readonly top: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly padding: number;
  readonly gap: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/**
 * Factor de escala del modo fijo.
 *
 * Se usa el menor de los dos cocientes para que el diseño entre completo en la
 * ventana. Con el mayor, parte de la interfaz quedaría fuera de la pantalla, y
 * un botón que no se ve es un botón que no existe.
 */
export function fixedScale(skin: Skin, viewport: Viewport): number {
  if (skin.layoutMode !== 'fixed') return 1;
  if (skin.designWidth <= 0 || skin.designHeight <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;

  return Math.min(viewport.width / skin.designWidth, viewport.height / skin.designHeight);
}

/** Tamaño del área de diseño, en píxeles de pantalla. */
export function designArea(skin: Skin, viewport: Viewport): Viewport {
  if (skin.layoutMode !== 'fixed') return viewport;
  const scale = fixedScale(skin, viewport);
  return { width: skin.designWidth * scale, height: skin.designHeight * scale };
}

const HORIZONTAL: Readonly<Record<AnchorPoint, 0 | 0.5 | 1>> = {
  topLeft: 0,
  top: 0.5,
  topRight: 1,
  left: 0,
  center: 0.5,
  right: 1,
  bottomLeft: 0,
  bottom: 0.5,
  bottomRight: 1,
};

const VERTICAL: Readonly<Record<AnchorPoint, 0 | 0.5 | 1>> = {
  topLeft: 0,
  top: 0,
  topRight: 0,
  left: 0.5,
  center: 0.5,
  right: 0.5,
  bottomLeft: 1,
  bottom: 1,
  bottomRight: 1,
};

/**
 * Resuelve la caja de un componente dentro de su contenedor.
 *
 * El desplazamiento se interpreta **hacia dentro** del contenedor en los
 * bordes derecho e inferior: un botón anclado abajo a la derecha con
 * desplazamiento (16, 16) queda a dieciséis píxeles del borde, no fuera. Si se
 * sumara siempre, el mismo desplazamiento serviría para separar en una esquina
 * y para expulsar en la opuesta, y el autor tendría que usar números negativos
 * en la mitad de los casos.
 */
export function resolveBox(box: Box, container: Viewport): ResolvedBox {
  const width =
    box.widthPercent !== null ? container.width * box.widthPercent : box.width;
  const height =
    box.heightPercent !== null ? container.height * box.heightPercent : box.height;

  const effectiveWidth = Math.max(width ?? 0, box.minWidth);
  const effectiveHeight = Math.max(height ?? 0, box.minHeight);

  const hx = HORIZONTAL[box.anchor];
  const vy = VERTICAL[box.anchor];

  // El signo del desplazamiento se invierte en los bordes finales para que
  // «16 px» signifique siempre «16 px hacia dentro».
  const left = container.width * hx - effectiveWidth * hx + box.offsetX * (hx === 1 ? -1 : 1);
  const top = container.height * vy - effectiveHeight * vy + box.offsetY * (vy === 1 ? -1 : 1);

  return {
    left,
    top,
    width: width === null ? null : Math.max(width, box.minWidth),
    height: height === null ? null : Math.max(height, box.minHeight),
    padding: box.padding,
    gap: box.gap,
    minWidth: box.minWidth,
    minHeight: box.minHeight,
  };
}

/* ------------------------------------------------------------------ *
 * Visibilidad (J05, D14)
 * ------------------------------------------------------------------ */

export interface SkinState {
  /** Componentes ocultados o mostrados en ejecución (J05). */
  readonly hidden: ReadonlySet<string>;
  readonly shown: ReadonlySet<string>;
  /** Pestaña activa de cada contenedor de pestañas (F08). */
  readonly activeTab: ReadonlyMap<string, string>;
  /** Índice activo de cada carrusel (F13). */
  readonly carouselIndex: ReadonlyMap<string, number>;
}

export const EMPTY_SKIN_STATE: SkinState = {
  hidden: new Set<string>(),
  shown: new Set<string>(),
  activeTab: new Map<string, string>(),
  carouselIndex: new Map<string, number>(),
};

export interface VisibilityInput {
  readonly node: SkinNode;
  readonly device: DeviceKind;
  readonly sceneId: string | null;
  readonly state: SkinState;
  /** Pestaña activa del contenedor padre, si el padre es de pestañas. */
  readonly parentActiveTab?: string | null;
}

/**
 * Decide si un componente se dibuja.
 *
 * El orden de las comprobaciones es deliberado: lo que el autor declaró
 * estáticamente —dispositivo, escena, pestaña— tiene prioridad sobre lo que
 * una acción haya hecho en ejecución. Así, `showElement` sobre un componente
 * que el autor excluyó del móvil no lo hace aparecer en el móvil: la acción
 * gobierna el estado, no la declaración.
 */
export function isNodeVisible({
  node,
  device,
  sceneId,
  state,
  parentActiveTab,
}: VisibilityInput): boolean {
  if (!node.visibility[device]) return false;

  // Lista de escenas vacía significa «en todas»: es lo que espera quien pone
  // una barra de navegación y no quiere repetirla escena por escena.
  if (node.sceneIds.length > 0 && (sceneId === null || !node.sceneIds.includes(sceneId))) {
    return false;
  }

  if (parentActiveTab !== undefined && parentActiveTab !== null && node.tabId !== null) {
    if (node.tabId !== parentActiveTab) return false;
  }

  if (state.hidden.has(node.id)) return false;
  if (state.shown.has(node.id)) return true;

  return node.initiallyVisible;
}

/** Aplica `showElement` / `hideElement` / `toggleElement` (J05). */
export function applyVisibilityAction(
  state: SkinState,
  elementIds: readonly string[],
  visible: boolean | 'toggle',
  nodes: readonly SkinNode[],
): SkinState {
  const hidden = new Set(state.hidden);
  const shown = new Set(state.shown);

  for (const id of elementIds) {
    const node = findNode(nodes, id);
    // Un identificador que no corresponde a ningún componente se ignora: la
    // alternativa sería guardar estado para algo que no existe y que nunca se
    // limpiaría.
    if (node === null) continue;

    const currentlyVisible = hidden.has(id)
      ? false
      : shown.has(id)
        ? true
        : node.initiallyVisible;

    const target = visible === 'toggle' ? !currentlyVisible : visible;

    if (target) {
      hidden.delete(id);
      shown.add(id);
    } else {
      shown.delete(id);
      hidden.add(id);
    }
  }

  return { ...state, hidden, shown };
}

function findNode(nodes: readonly SkinNode[], id: string): SkinNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== null) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Pestañas y carruseles (F08, F13)
 * ------------------------------------------------------------------ */

/**
 * Pestaña activa de un contenedor.
 *
 * Si el estado no dice nada, se usa la que el autor marcó por defecto; si
 * tampoco, la primera. Dejar un contenedor de pestañas sin ninguna activa
 * mostraría un marco vacío, que el visitante lee como un error de carga.
 */
export function activeTabOf(
  node: SkinNode,
  state: SkinState,
  fallbackTabs: readonly { readonly id: string }[],
): string | null {
  const stored = state.activeTab.get(node.id);
  if (stored !== undefined && fallbackTabs.some((tab) => tab.id === stored)) return stored;
  return fallbackTabs[0]?.id ?? null;
}

/**
 * Índice activo de un carrusel, acotado y circular.
 *
 * Circular porque un carrusel que se detiene en el último elemento obliga a
 * volver pulsando atrás tantas veces como se avanzó, y nadie lo hace.
 */
export function carouselIndexOf(node: SkinNode, state: SkinState, count: number): number {
  if (count <= 0) return 0;
  const stored = state.carouselIndex.get(node.id) ?? 0;
  return ((stored % count) + count) % count;
}

/* ------------------------------------------------------------------ *
 * Estilos (F11, F12)
 * ------------------------------------------------------------------ */

const SHADOW_TOKENS: Readonly<Record<SkinStyle['shadow'], string>> = {
  none: 'none',
  sm: 'var(--it-elevation-sm)',
  md: 'var(--it-elevation-md)',
  lg: 'var(--it-elevation-lg)',
  xl: 'var(--it-elevation-xl)',
};

const BACKGROUND_TOKENS: Readonly<Record<string, string>> = {
  canvas: 'var(--it-color-surface-canvas)',
  base: 'var(--it-color-surface-base)',
  raised: 'var(--it-color-surface-raised)',
  overlay: 'var(--it-color-surface-overlay)',
  accent: 'var(--it-color-accent-default)',
};

export interface StyleOptions {
  readonly mediaUrls?: ReadonlyMap<string, string>;
  /** Nombre de la familia tipográfica ya registrada para este medio (F12). */
  readonly fontFamily?: (mediaId: string) => string | undefined;
  /** Respeta la preferencia de movimiento y transparencia reducidos. */
  readonly reducedMotion?: boolean;
}

/**
 * Convierte el estilo declarado en propiedades CSS.
 *
 * El desenfoque de fondo se omite con movimiento reducido: tiene coste de GPU
 * y, en equipos sin aceleración, produce exactamente el tirón que esa
 * preferencia pide evitar. El panel sigue siendo legible porque su fondo lleva
 * opacidad propia.
 */
export function styleToCss(
  style: SkinStyle,
  options: StyleOptions = {},
): Record<string, string | number> {
  const css: Record<string, string | number> = {};

  switch (style.background.kind) {
    case 'token':
      css['background'] = BACKGROUND_TOKENS[style.background.token] ?? 'transparent';
      break;
    case 'color':
      css['background'] =
        style.background.opacity >= 1
          ? style.background.color
          : `color-mix(in srgb, ${style.background.color} ${Math.round(style.background.opacity * 100)}%, transparent)`;
      break;
    case 'image': {
      const url = options.mediaUrls?.get(style.background.mediaId);
      if (url !== undefined) {
        css['backgroundImage'] = `url("${url}")`;
        css['backgroundRepeat'] = style.background.fit === 'tile' ? 'repeat' : 'no-repeat';
        css['backgroundSize'] = style.background.fit === 'tile' ? 'auto' : style.background.fit;
        css['backgroundPosition'] = 'center';
      }
      break;
    }
    default:
      break;
  }

  if (style.backdropBlur > 0 && options.reducedMotion !== true) {
    css['backdropFilter'] = `blur(${style.backdropBlur}px)`;
  }

  if (style.borderRadius > 0) css['borderRadius'] = `${style.borderRadius}px`;
  if (style.borderWidth > 0) {
    css['borderStyle'] = 'solid';
    css['borderWidth'] = `${style.borderWidth}px`;
    css['borderColor'] = style.borderColor ?? 'var(--it-color-border-default)';
  }
  if (style.shadow !== 'none') css['boxShadow'] = SHADOW_TOKENS[style.shadow];
  if (style.opacity < 1) css['opacity'] = style.opacity;

  if (style.fontMediaId !== null) {
    const family = options.fontFamily?.(style.fontMediaId);
    // Sin la familia registrada no se escribe nada: poner un nombre que el
    // navegador no conoce haría que el texto cayera a la fuente genérica del
    // sistema, que es peor que la del sistema de diseño.
    if (family !== undefined) css['fontFamily'] = `${family}, var(--it-font-sans)`;
  }
  if (style.fontSize !== null) css['fontSize'] = `${style.fontSize}px`;
  if (style.fontWeight !== null) css['fontWeight'] = style.fontWeight;
  if (style.textColor !== null) css['color'] = style.textColor;
  css['textAlign'] = style.textAlign;

  return css;
}

/* ------------------------------------------------------------------ *
 * Barras de progreso (F10)
 * ------------------------------------------------------------------ */

export type ProgressSource = 'tour' | 'quiz' | 'media' | 'scene' | 'custom';

/**
 * Fracción de progreso, acotada a [0, 1].
 *
 * Un valor fuera de rango dibujaría una barra que sobresale de su marco. Se
 * acota en lugar de rechazar porque el origen puede ser una variable del autor
 * y perder la barra entera por un valor raro es peor que mostrarla al tope.
 */
export function progressFraction(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max(current / total, 0), 1);
}
