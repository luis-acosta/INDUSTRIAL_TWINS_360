/**
 * Marcadores interactivos (etapa 02, grupo D).
 *
 * Un hotspot es un ancla más una geometría más un estilo más acciones. La
 * separación importa: el ancla dice *dónde*, la geometría *qué forma tiene*,
 * el estilo *cómo se ve* y las acciones *qué hace*. Así se puede cambiar el
 * icono de ochenta marcadores sin tocar sus posiciones, y mover un marcador
 * sin perder su configuración.
 */
import { z } from 'zod';
import { newUuid, uuidSchema } from './identity';
import { actionSchema, type ActionEvent } from './action';
import { transform3dSchema, uvSchema } from './coordinates';

/* ------------------------------------------------------------------ *
 * Anclaje
 * ------------------------------------------------------------------ */

/**
 * Dónde vive un marcador.
 *
 *  - `spherical`: dirección en la panorámica. Es el caso normal.
 *  - `modelSurface`: adherido a una malla del modelo 3D (L07). Se guarda el
 *    nombre del nodo y la posición local, no la posición de mundo, para que
 *    el marcador siga al componente si el modelo se reorganiza.
 *  - `screen`: fijo en pantalla, no en la escena. Es el modo «flotante» de
 *    D07 y el que usan los paneles de interfaz.
 *  - `plan`: punto sobre un plano o mapa (G02).
 */
export const anchorSchema = z.discriminatedUnion('space', [
  z.object({
    space: z.literal('spherical'),
    yaw: z.number().finite(),
    pitch: z.number().finite(),
  }),
  z.object({
    space: z.literal('modelSurface'),
    nodeName: z.string().min(1).max(255),
    localPosition: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    }),
    /** Normal de la superficie: orienta el sticker contra la malla. */
    normal: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    }),
  }),
  z.object({
    space: z.literal('screen'),
    /** Posición normalizada en el viewport. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    anchorPoint: z
      .enum(['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'])
      .default('center'),
  }),
  z.object({
    space: z.literal('plan'),
    planId: uuidSchema,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
]);

export type Anchor = z.infer<typeof anchorSchema>;
export type AnchorSpace = Anchor['space'];

/* ------------------------------------------------------------------ *
 * Geometría
 * ------------------------------------------------------------------ */

/**
 * Modo de proyección del marcador (D07).
 *
 *  - `billboard`: siempre de frente al observador. Legible desde cualquier
 *    ángulo; es lo que se quiere para un icono o una etiqueta.
 *  - `sticker`: pegado a la escena, se deforma con la perspectiva. Es lo que
 *    se quiere para señalar una superficie concreta (una placa, un rótulo
 *    sobre una tubería), porque el marcador «pertenece» al sitio.
 *  - `floating`: fijo en pantalla, ignora la cámara.
 */
export const projectionModeSchema = z.enum(['billboard', 'sticker', 'floating']);
export type ProjectionMode = z.infer<typeof projectionModeSchema>;

export const hotspotGeometrySchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('icon'),
    /** Medio de la imagen o icono propio (D01). APNG admitido (D15). */
    mediaId: uuidSchema.nullable().default(null),
    /** Icono del catálogo interno cuando no hay medio propio. */
    builtinIcon: z.string().max(64).default('marker'),
    /** Tamaño en píxeles a distancia nominal. */
    sizePx: z.number().int().min(8).max(512).default(40),
  }),
  z.object({
    shape: z.literal('text'),
    /** Admite variables `{{...}}` (F09). */
    template: z.string().max(2000),
    maxWidthPx: z.number().int().min(40).max(1200).default(240),
  }),
  z.object({
    shape: z.literal('polygon'),
    /**
     * Vértices en UV de la panorámica (D03). Mínimo tres.
     * `inverted` implementa «invertir polígono» (D11): la zona activa pasa a
     * ser todo lo que queda fuera del contorno.
     */
    points: z.array(uvSchema).min(3),
    inverted: z.boolean().default(false),
  }),
  z.object({
    shape: z.literal('projectedImage'),
    /** Imagen proyectada ajustada al panorama (D05). */
    mediaId: uuidSchema,
    /** Esquinas en UV, en orden: superior izquierda, SD, ID, II. */
    corners: z.tuple([uvSchema, uvSchema, uvSchema, uvSchema]),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    shape: z.literal('webframe'),
    /** Contenido web embebido como marcador (D06). */
    url: z.string().url(),
    widthPx: z.number().int().min(80).max(4096).default(640),
    heightPx: z.number().int().min(60).max(4096).default(400),
  }),
  z.object({
    shape: z.literal('model'),
    /** Pequeño modelo 3D usado como marcador en la escena. */
    mediaId: uuidSchema,
    sizeScale: z.number().gt(0).max(100).default(1),
  }),
]);

export type HotspotGeometry = z.infer<typeof hotspotGeometrySchema>;
export type HotspotShape = HotspotGeometry['shape'];

/* ------------------------------------------------------------------ *
 * Estilo
 * ------------------------------------------------------------------ */

export const hotspotStyleSchema = z.object({
  /** Referencia a un token del sistema de diseño, no un color literal. */
  colorToken: z
    .enum(['accent', 'nominal', 'warning', 'alarm', 'info', 'experimental', 'neutral'])
    .default('accent'),
  /** Color propio en hex, sólo cuando el autor lo fija expresamente. */
  colorOverride: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  opacity: z.number().min(0).max(1).default(1),
  /** Pulso de atención. Se desactiva por defecto: moverse llama la atención
   * y una escena con treinta marcadores pulsando es ilegible. */
  pulse: z.boolean().default(false),
  /** Mostrar etiqueta permanente junto al marcador. */
  showLabel: z.boolean().default(false),
  labelTemplate: z.string().max(500).default(''),
  /** Escala al pasar el puntero. */
  hoverScale: z.number().min(1).max(3).default(1.15),
  transform: transform3dSchema.default({ scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 }),
  projection: projectionModeSchema.default('billboard'),
});

export type HotspotStyle = z.infer<typeof hotspotStyleSchema>;

/* ------------------------------------------------------------------ *
 * Visibilidad por dispositivo (D14, N06, N07)
 * ------------------------------------------------------------------ */

export const deviceVisibilitySchema = z.object({
  desktop: z.boolean().default(true),
  tablet: z.boolean().default(true),
  mobile: z.boolean().default(true),
  vr: z.boolean().default(true),
});

export type DeviceVisibility = z.infer<typeof deviceVisibilitySchema>;

export const ALL_DEVICES: DeviceVisibility = { desktop: true, tablet: true, mobile: true, vr: true };

export const deviceKindSchema = z.enum(['desktop', 'tablet', 'mobile', 'vr']);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const isVisibleOn = (v: DeviceVisibility, device: DeviceKind): boolean => v[device];

/**
 * Política de precarga (D14).
 *
 * `eager` descarga el recurso del marcador al entrar en la escena; `lazy`
 * espera a la interacción. En un recorrido de planta con cincuenta
 * marcadores por escena, precargarlo todo satura la red del cliente y
 * retrasa la primera imagen, que es lo único que el visitante está
 * esperando.
 */
export const preloadPolicySchema = z.enum(['eager', 'lazy', 'onHover']);
export type PreloadPolicy = z.infer<typeof preloadPolicySchema>;

/* ------------------------------------------------------------------ *
 * Hotspot
 * ------------------------------------------------------------------ */

export const hotspotSchema = z.object({
  id: uuidSchema,
  sceneId: uuidSchema,
  /** Nombre para el autor: aparece en el árbol y en la búsqueda (Y08). */
  name: z.string().min(1).max(200).default('Marcador'),
  anchor: anchorSchema,
  geometry: hotspotGeometrySchema,
  style: hotspotStyleSchema,
  actions: z.array(actionSchema).default([]),
  /** Activo industrial vinculado, si el marcador representa un equipo. */
  assetId: uuidSchema.nullable().default(null),
  visibility: deviceVisibilitySchema.default(ALL_DEVICES),
  preload: preloadPolicySchema.default('lazy'),
  /** Bloqueado para edición (D12): se ve y se puede activar, no se mueve. */
  locked: z.boolean().default(false),
  /** Oculto en el editor sin afectar al recorrido publicado. */
  hiddenInEditor: z.boolean().default(false),
  /** Etiquetas de organización del editor (Y08). */
  tags: z.array(z.string().max(48)).default([]),
  /**
   * Marcador creado por la conexión automática y no revisado todavía (C05).
   * Es la pieza que hace honesto el requisito: la propuesta se guarda, se
   * distingue y no se publica hasta que una persona la confirma.
   */
  autoGenerated: z.boolean().default(false),
  autoConfidence: z.number().min(0).max(1).nullable().default(null),
  reviewed: z.boolean().default(true),
  order: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Hotspot = z.infer<typeof hotspotSchema>;

/** Eventos admitidos por cada forma de marcador. */
export function supportedEvents(shape: HotspotShape): readonly ActionEvent[] {
  const base: ActionEvent[] = ['click', 'hover', 'hoverOut', 'focusEnter', 'focusExit'];
  switch (shape) {
    case 'webframe':
      // Un iframe captura el puntero: hover y foco dentro del marco no
      // llegan al visor, así que ofrecerlos sería prometer algo que no pasa.
      return ['click'];
    case 'projectedImage':
      return base;
    case 'polygon':
      return base;
    default:
      return base;
  }
}

/** `true` si el marcador conduce a otra escena. */
export function isNavigationHotspot(hotspot: Hotspot): boolean {
  return hotspot.actions.some((a) => a.config.type === 'goToScene');
}

/** Escena destino del marcador, si navega a una sola. */
export function navigationTarget(hotspot: Hotspot): string | null {
  for (const action of hotspot.actions) {
    if (action.config.type === 'goToScene') return action.config.sceneId;
  }
  return null;
}

/**
 * Marcadores que no deben publicarse.
 *
 * Una propuesta automática sin revisar es una hipótesis, no una conexión. Si
 * se publicara, el visitante acabaría en una escena que el autor nunca
 * verificó, y es exactamente el fallo que el requisito C05 invita a cometer.
 */
export function isPublishable(hotspot: Hotspot): boolean {
  if (hotspot.autoGenerated && !hotspot.reviewed) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Creación
 * ------------------------------------------------------------------ */

export interface NewHotspotOptions {
  readonly sceneId: string;
  readonly anchor: Anchor;
  readonly name?: string;
  readonly order?: number;
  readonly now: string;
  /** Geometría distinta del icono por omisión. */
  readonly geometry?: Hotspot['geometry'];
}

/**
 * Marcador nuevo con los valores de partida del esquema.
 *
 * Existe porque sin ella cada sitio que crea un marcador escribía los
 * veintitantos campos a mano y los afirmaba con un `as Hotspot`. Dos copias
 * así se separan en cuanto el esquema gana un campo, y el síntoma es un
 * marcador que el visor no sabe dibujar en una sola de las dos vías de
 * creación: el defecto más difícil de encontrar que puede dar esta estructura.
 */
export function createHotspot(options: NewHotspotOptions): Hotspot {
  return hotspotSchema.parse({
    id: newUuid(),
    sceneId: options.sceneId,
    name: options.name ?? 'Marcador',
    anchor: options.anchor,
    geometry: options.geometry ?? { shape: 'icon', mediaId: null, builtinIcon: 'marker', sizePx: 40 },
    style: {},
    order: options.order ?? 0,
    // Creado a mano, así que revisado: la marca de revisión existe para
    // distinguir lo que propuso la conexión automática (C05).
    reviewed: true,
    createdAt: options.now,
    updatedAt: options.now,
  });
}
