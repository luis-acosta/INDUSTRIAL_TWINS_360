/**
 * Interfaz visual del recorrido: skins (etapa 03, grupo F).
 *
 * Un skin es un árbol de componentes declarativo que se superpone al visor.
 * Igual que las acciones, es dato y no código: así el recorrido publicado
 * reconstruye la interfaz a partir del manifiesto, y el editor
 * arrastrar-y-soltar no es más que una forma de editar ese árbol.
 *
 * La disposición es el punto delicado. Un recorrido se verá en 1366×768 y en
 * 4K, y el requisito F05 pide tamaño fijo o adaptable. Se resuelve con dos
 * modos explícitos —`fixed` escala el conjunto, `fluid` recoloca— en vez de
 * con un sistema de reglas de ruptura, que el autor tendría que entender
 * para obtener un resultado predecible.
 */
import { z } from 'zod';
import { actionSchema } from './action';
import { uuidSchema } from './identity';
import { deviceVisibilitySchema, ALL_DEVICES } from './hotspot';

/* ------------------------------------------------------------------ *
 * Disposición
 * ------------------------------------------------------------------ */

export const layoutModeSchema = z.enum(['fixed', 'fluid']);
export type LayoutMode = z.infer<typeof layoutModeSchema>;

/** Punto de anclaje: a qué esquina o borde queda sujeto el componente. */
export const anchorPointSchema = z.enum([
  'topLeft',
  'top',
  'topRight',
  'left',
  'center',
  'right',
  'bottomLeft',
  'bottom',
  'bottomRight',
]);

export type AnchorPoint = z.infer<typeof anchorPointSchema>;

export const boxSchema = z.object({
  anchor: anchorPointSchema.default('topLeft'),
  /** Desplazamiento en px desde el punto de anclaje. */
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
  /** Tamaño en px. `null` = ajustar al contenido. */
  width: z.number().positive().nullable().default(null),
  height: z.number().positive().nullable().default(null),
  /** Tamaño relativo al contenedor, 0-1. Tiene prioridad sobre el absoluto. */
  widthPercent: z.number().min(0).max(1).nullable().default(null),
  heightPercent: z.number().min(0).max(1).nullable().default(null),
  minWidth: z.number().nonnegative().default(0),
  minHeight: z.number().nonnegative().default(0),
  padding: z.number().nonnegative().default(0),
  gap: z.number().nonnegative().default(8),
});

export type Box = z.infer<typeof boxSchema>;

/* ------------------------------------------------------------------ *
 * Estilo (F11, F12)
 * ------------------------------------------------------------------ */

export const skinStyleSchema = z.object({
  /** Fondo: token del sistema, color propio, imagen o nada. */
  background: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({
        kind: z.literal('token'),
        /**
         * Superficie del sistema de diseño.
         *
         * Se llama `surfaceToken` y no `token` porque el manifiesto publicado
         * rechaza cualquier clave llamada `token`: es la guarda que impide que
         * una credencial viaje en el paquete, y vale precisamente por ser
         * ciega. Un nombre genérico aquí la hacía saltar y dejaba sin publicar
         * cualquier proyecto con un fondo del sistema, que es el de partida.
         */
        surfaceToken: z.enum(['canvas', 'base', 'raised', 'overlay', 'accent']),
      }),
      z.object({
        kind: z.literal('color'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        opacity: z.number().min(0).max(1).default(1),
      }),
      z.object({ kind: z.literal('image'), mediaId: uuidSchema, fit: z.enum(['cover', 'contain', 'tile']) }),
    ])
    .default({ kind: 'none' }),
  /**
   * Desenfoque del fondo en px (F11).
   *
   * Es el recurso que permite poner un panel legible encima de una
   * panorámica sin taparla del todo. Tiene coste de GPU, así que se declara
   * por componente y no de forma global.
   */
  backdropBlur: z.number().min(0).max(40).default(0),
  borderRadius: z.number().min(0).max(64).default(4),
  borderWidth: z.number().min(0).max(8).default(0),
  borderColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  shadow: z.enum(['none', 'sm', 'md', 'lg', 'xl']).default('none'),
  opacity: z.number().min(0).max(1).default(1),
  /** Familia tipográfica propia (F12); referencia a un medio de tipo `font`. */
  fontMediaId: uuidSchema.nullable().default(null),
  fontSize: z.number().min(8).max(96).nullable().default(null),
  fontWeight: z.number().int().min(100).max(900).nullable().default(null),
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  textAlign: z.enum(['left', 'center', 'right']).default('left'),
});

export type SkinStyle = z.infer<typeof skinStyleSchema>;

/* ------------------------------------------------------------------ *
 * Componentes
 * ------------------------------------------------------------------ */

/**
 * Catálogo de componentes de interfaz. Cada tipo declara su configuración
 * propia; los campos comunes (caja, estilo, visibilidad, acciones) viven en
 * `skinNodeSchema`.
 */
export const componentKindSchema = z.enum([
  'container',
  'button',
  'image',
  'text',
  'dropdown',
  'tabs',
  'progressBar',
  'thumbnailList',
  'carousel',
  'planView',
  'assetPanel',
  'telemetryPanel',
  'notesPanel',
  'quizCard',
  'scoreBoard',
  'timer',
  'webframe',
  'spacer',
]);

export type ComponentKind = z.infer<typeof componentKindSchema>;

export const COMPONENT_LABELS: Readonly<Record<ComponentKind, string>> = {
  container: 'Contenedor',
  button: 'Botón',
  image: 'Imagen',
  text: 'Texto',
  dropdown: 'Menú desplegable',
  tabs: 'Pestañas',
  progressBar: 'Barra de progreso',
  thumbnailList: 'Lista de miniaturas',
  carousel: 'Carrusel',
  planView: 'Plano',
  assetPanel: 'Ficha de activo',
  telemetryPanel: 'Panel de instrumentos',
  notesPanel: 'Notas',
  quizCard: 'Tarjeta de pregunta',
  scoreBoard: 'Puntuación',
  timer: 'Temporizador',
  webframe: 'Contenido web',
  spacer: 'Separador',
};

/** Componentes que pueden contener hijos (F06). */
export const CONTAINER_KINDS: readonly ComponentKind[] = ['container', 'tabs', 'carousel'];

export const isContainerKind = (kind: ComponentKind): boolean => CONTAINER_KINDS.includes(kind);

export const componentConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    direction: z.enum(['row', 'column', 'free']).default('column'),
    justify: z.enum(['start', 'center', 'end', 'spaceBetween']).default('start'),
    align: z.enum(['start', 'center', 'end', 'stretch']).default('start'),
    scrollable: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('button'),
    /** Admite variables `{{...}}`. */
    label: z.string().max(500).default('Botón'),
    icon: z.string().max(64).default(''),
    variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).default('secondary'),
    /** Imagen propia en vez de botón del sistema (F03). */
    imageMediaId: uuidSchema.nullable().default(null),
    imageHoverMediaId: uuidSchema.nullable().default(null),
    tooltip: z.string().max(300).default(''),
  }),
  z.object({
    kind: z.literal('image'),
    mediaId: uuidSchema.nullable().default(null),
    fit: z.enum(['cover', 'contain', 'fill']).default('contain'),
    alt: z.string().max(300).default(''),
  }),
  z.object({
    kind: z.literal('text'),
    /** Plantilla con variables del recorrido (F09). */
    template: z.string().max(10_000).default(''),
    markdown: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('dropdown'),
    label: z.string().max(200).default('Seleccionar'),
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(200),
          icon: z.string().max(64).default(''),
          actions: z.array(actionSchema).default([]),
        }),
      )
      .default([]),
  }),
  z.object({
    kind: z.literal('tabs'),
    /** Pestañas; cada una muestra los hijos cuyo `tabId` coincide (F08). */
    tabs: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(200),
          icon: z.string().max(64).default(''),
        }),
      )
      .min(1),
    activeTabId: z.string().max(64).nullable().default(null),
  }),
  z.object({
    kind: z.literal('progressBar'),
    /** Qué representa: avance del recorrido, del audio o de la puntuación. */
    source: z.enum(['tour', 'media', 'score', 'quiz']).default('tour'),
    scoreKey: z.string().max(64).default(''),
    showLabel: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('thumbnailList'),
    /** Escenas incluidas; vacío = todas las publicables, en orden. */
    sceneIds: z.array(uuidSchema).default([]),
    orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
    thumbnailSize: z.number().int().min(48).max(320).default(96),
    showTitles: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('carousel'),
    autoAdvanceMs: z.number().int().min(0).max(60_000).default(0),
    loop: z.boolean().default(true),
    showArrows: z.boolean().default(true),
    showDots: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('planView'),
    planId: uuidSchema.nullable().default(null),
    /** Permitir cambiar de piso desde el propio componente (G03). */
    allowFloorSwitch: z.boolean().default(true),
    showRadar: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('assetPanel'),
    /** Activo fijo, o `null` para mostrar el seleccionado en la escena. */
    assetId: uuidSchema.nullable().default(null),
    visibleTabs: z
      .array(z.enum(['overview', 'attributes', 'documents', 'telemetry', 'notes']))
      .default(['overview', 'attributes', 'documents']),
  }),
  z.object({
    kind: z.literal('telemetryPanel'),
    mappingIds: z.array(uuidSchema).default([]),
    layout: z.enum(['list', 'grid', 'gauges']).default('list'),
    showHistory: z.boolean().default(true),
    /** Periodo de refresco en segundos; 0 = sólo al abrir. */
    refreshSeconds: z.number().int().min(0).max(3600).default(30),
  }),
  z.object({
    kind: z.literal('notesPanel'),
    /** Limitar a la escena actual o mostrar todo el proyecto. */
    scope: z.enum(['scene', 'asset', 'project']).default('scene'),
    allowCreate: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('quizCard'),
    quizId: uuidSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal('scoreBoard'),
    /** Puntuaciones mostradas; vacío = todas (O06). */
    scoreKeys: z.array(z.string().max(64)).default([]),
    showTime: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('timer'),
    mode: z.enum(['elapsed', 'countdown']).default('elapsed'),
    durationS: z.number().int().min(1).max(86_400).default(600),
    /** Acciones al agotarse la cuenta atrás. */
    onExpire: z.array(actionSchema).default([]),
  }),
  z.object({
    kind: z.literal('webframe'),
    url: z.string().url(),
    allowFullscreen: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('spacer'),
    flexible: z.boolean().default(true),
  }),
]);

export type ComponentConfig = z.infer<typeof componentConfigSchema>;

export interface SkinNode {
  readonly id: string;
  readonly name: string;
  readonly config: ComponentConfig;
  readonly box: Box;
  readonly style: SkinStyle;
  readonly visibility: z.infer<typeof deviceVisibilitySchema>;
  /** Visible al cargar. `hideElement`/`showElement` lo cambian (J05). */
  readonly initiallyVisible: boolean;
  /** Acciones del componente, por evento. */
  readonly actions: readonly z.infer<typeof actionSchema>[];
  /** Pestaña del contenedor padre a la que pertenece, si el padre es `tabs`. */
  readonly tabId: string | null;
  /** Escenas en las que aparece; vacío = en todas. */
  readonly sceneIds: readonly string[];
  readonly children: readonly SkinNode[];
  /** Bloqueado en el editor para no moverlo por accidente. */
  readonly locked: boolean;
}

/**
 * El árbol es recursivo, así que el esquema se declara con `z.lazy`. El tipo
 * de salida se escribe a mano arriba porque la inferencia de un esquema
 * recursivo no produce un tipo utilizable; la entrada se deja en `unknown`
 * porque los campos con valor por defecto son opcionales al parsear y
 * obligatorios en el resultado, y declarar un único tipo para ambos lados
 * haría que `z.lazy` no encajara.
 */
export const skinNodeSchema: z.ZodType<SkinNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    config: componentConfigSchema,
    box: boxSchema,
    style: skinStyleSchema,
    visibility: deviceVisibilitySchema.default(ALL_DEVICES),
    initiallyVisible: z.boolean().default(true),
    actions: z.array(actionSchema).default([]),
    tabId: z.string().max(64).nullable().default(null),
    sceneIds: z.array(uuidSchema).default([]),
    children: z.array(skinNodeSchema).default([]),
    locked: z.boolean().default(false),
  }),
);

export const skinSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  layoutMode: layoutModeSchema.default('fluid'),
  /** Tamaño de diseño de referencia para el modo `fixed`. */
  designWidth: z.number().int().min(320).max(7680).default(1920),
  designHeight: z.number().int().min(240).max(4320).default(1080),
  root: z.array(skinNodeSchema).default([]),
  /** Skin de plantilla del que deriva, si se creó desde una (F02). */
  templateId: z.string().max(120).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Skin = z.infer<typeof skinSchema>;

/* ------------------------------------------------------------------ *
 * Recorrido del árbol
 * ------------------------------------------------------------------ */

/** Recorre el árbol en profundidad, raíz primero. */
export function* walkSkin(nodes: readonly SkinNode[]): Generator<{ node: SkinNode; depth: number; path: string[] }> {
  function* visit(
    list: readonly SkinNode[],
    depth: number,
    path: string[],
  ): Generator<{ node: SkinNode; depth: number; path: string[] }> {
    for (const node of list) {
      const nextPath = [...path, node.id];
      yield { node, depth, path: nextPath };
      if (node.children.length > 0) yield* visit(node.children, depth + 1, nextPath);
    }
  }
  yield* visit(nodes, 0, []);
}

export function findSkinNode(nodes: readonly SkinNode[], id: string): SkinNode | null {
  for (const { node } of walkSkin(nodes)) {
    if (node.id === id) return node;
  }
  return null;
}

/** Ruta de identificadores desde la raíz hasta el nodo. */
export function skinNodePath(nodes: readonly SkinNode[], id: string): string[] | null {
  for (const { node, path } of walkSkin(nodes)) {
    if (node.id === id) return path;
  }
  return null;
}

export interface SkinProblem {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly message: string;
}

/**
 * Valida un skin.
 *
 * Comprueba lo que el esquema no puede: identificadores únicos en todo el
 * árbol, hijos sólo dentro de contenedores, pestañas referenciadas
 * existentes, y profundidad acotada. El límite de profundidad no es
 * arbitrario: un árbol de cien niveles no es algo que un autor construya a
 * propósito, pero sí algo que produce un bucle al importar, y sin el límite
 * el renderizado desborda la pila.
 */
export const MAX_SKIN_DEPTH = 16;

export function validateSkin(skin: Skin): SkinProblem[] {
  const problems: SkinProblem[] = [];
  const seenIds = new Set<string>();

  for (const { node, depth } of walkSkin(skin.root)) {
    if (seenIds.has(node.id)) {
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        message: `Identificador de componente duplicado: ${node.id}`,
      });
    }
    seenIds.add(node.id);

    if (depth >= MAX_SKIN_DEPTH) {
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        message: `El componente excede la profundidad máxima de ${MAX_SKIN_DEPTH} niveles`,
      });
    }

    if (node.children.length > 0 && !isContainerKind(node.config.kind)) {
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        message: `Un «${COMPONENT_LABELS[node.config.kind]}» no admite componentes dentro`,
      });
    }

    if (node.config.kind === 'tabs') {
      const tabIds = new Set(node.config.tabs.map((t) => t.id));
      for (const child of node.children) {
        if (child.tabId === null) {
          problems.push({
            nodeId: child.id,
            nodeName: child.name,
            message: 'El componente está dentro de unas pestañas pero no tiene pestaña asignada',
          });
        } else if (!tabIds.has(child.tabId)) {
          problems.push({
            nodeId: child.id,
            nodeName: child.name,
            message: `La pestaña «${child.tabId}» no existe en el contenedor`,
          });
        }
      }
      if (node.config.activeTabId !== null && !tabIds.has(node.config.activeTabId)) {
        problems.push({
          nodeId: node.id,
          nodeName: node.name,
          message: 'La pestaña activa por defecto no existe',
        });
      }
    }
  }

  return problems;
}

/** Cuenta componentes del árbol: dato del inspector y de las pruebas. */
export function countSkinNodes(skin: Skin): number {
  let count = 0;
  for (const _ of walkSkin(skin.root)) count += 1;
  return count;
}
