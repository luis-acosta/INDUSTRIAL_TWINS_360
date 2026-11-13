/**
 * Motor de acciones declarativas (etapa 03, grupo J; etapa 02, D13).
 *
 * Una acción es dato, no código: `{ type: 'goToScene', config: {...} }`. Esa
 * decisión recorre todo el producto. Porque las acciones son datos:
 *
 *  - el recorrido publicado se puede servir como archivos estáticos y seguir
 *    funcionando, sin un intérprete propio embarcado;
 *  - un proyecto importado de un tercero no puede ejecutar nada que el motor
 *    no reconozca, y lo que no reconoce lo ignora con un aviso;
 *  - deshacer y rehacer operan sobre estructuras comparables.
 *
 * El único tipo que ejecuta código arbitrario es `runScript` (J09), y está
 * desactivado por defecto y aislado. El resto del motor es cerrado.
 */
import { z } from 'zod';
import { uuidSchema } from './identity';
import { cameraViewSchema } from './coordinates';

/**
 * Eventos que pueden desencadenar acciones.
 *
 * `focus` es el disparo por mirada central sostenida: el visitante centra el
 * marcador en la pantalla y, tras un retardo, se activa. Es el único modo de
 * interacción que funciona igual en escritorio y en VR sin mandos (D13, N07).
 */
export const actionEventSchema = z.enum([
  'click',
  'hover',
  'hoverOut',
  'focusEnter',
  'focusExit',
  'sceneEnter',
  'sceneExit',
  'mediaEnd',
  'windowClose',
  'timer',
  'idle',
  'tourStart',
  'tourEnd',
  'waypointReached',
  'quizCompleted',
  'scoreThreshold',
  'projectStart',
]);

export type ActionEvent = z.infer<typeof actionEventSchema>;

/* ------------------------------------------------------------------ *
 * Expresiones de variable (F09, J10)
 * ------------------------------------------------------------------ */

/**
 * Variables del recorrido referenciables desde texto dinámico.
 *
 * El conjunto es cerrado: `{{scene.title}}`, `{{score.seguridad}}`,
 * `{{time.elapsed}}`. Una plantilla con una variable desconocida se muestra
 * literal y registra un aviso, en lugar de quedar vacía: así el autor ve el
 * error en la propia vista en vez de encontrarse un hueco en blanco.
 */
export const VARIABLE_NAMESPACES = ['project', 'scene', 'asset', 'score', 'time', 'quiz', 'user'] as const;

export type VariableNamespace = (typeof VARIABLE_NAMESPACES)[number];

const VARIABLE_PATTERN = /\{\{\s*([a-z]+)\.([a-zA-Z0-9_\-]+)\s*\}\}/g;

export interface VariableReference {
  readonly namespace: VariableNamespace;
  readonly key: string;
  readonly raw: string;
}

/** Extrae las referencias a variables de una plantilla de texto. */
export function extractVariables(template: string): VariableReference[] {
  const found: VariableReference[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const namespace = match[1] as VariableNamespace;
    const key = match[2];
    if (key === undefined) continue;
    if (!(VARIABLE_NAMESPACES as readonly string[]).includes(namespace)) continue;
    found.push({ namespace, key, raw: match[0] });
  }
  return found;
}

export type VariableResolver = (ref: VariableReference) => string | undefined;

/**
 * Sustituye las variables de una plantilla.
 *
 * Sin interpretación ni aritmética: una plantilla de texto no es un lenguaje.
 * Si hiciera falta calcular, el valor se calcula en el motor de puntuación y
 * se expone como variable ya resuelta.
 */
export function renderTemplate(
  template: string,
  resolve: VariableResolver,
): { text: string; unresolved: VariableReference[] } {
  const unresolved: VariableReference[] = [];
  const text = template.replace(VARIABLE_PATTERN, (raw, ns: string, key: string) => {
    if (!(VARIABLE_NAMESPACES as readonly string[]).includes(ns)) return raw;
    const ref: VariableReference = { namespace: ns as VariableNamespace, key, raw };
    const value = resolve(ref);
    if (value === undefined) {
      unresolved.push(ref);
      return raw;
    }
    return value;
  });
  return { text, unresolved };
}

/* ------------------------------------------------------------------ *
 * Tipos de acción
 * ------------------------------------------------------------------ */

const transitionSchema = z.object({
  kind: z.enum(['cut', 'fade', 'zoomThrough', 'dolly3d']).default('fade'),
  durationMs: z.number().int().min(0).max(5000).default(700),
  /**
   * Usa geometría 3D de fondo durante la transición cuando existe (C10).
   * Si no hay geometría, el motor degrada a `fade` sin avisar al visitante:
   * es una mejora visual, no una función que deba poder fallar.
   */
  useGeometry: z.boolean().default(false),
});

export type Transition = z.infer<typeof transitionSchema>;

/** Dirección de ajuste de la cámara al llegar a una escena (C11). */
export const entryModeSchema = z.enum([
  /** Mantiene el yaw actual: da continuidad al desplazamiento. */
  'keepOrientation',
  /** Vista inicial configurada en la escena destino. */
  'initialView',
  /** Mira hacia el hotspot de vuelta: «entrada inteligente». */
  'smart',
  /** Vista explícita definida en la propia acción. */
  'custom',
]);

export type EntryMode = z.infer<typeof entryModeSchema>;

/**
 * Catálogo de acciones. Cada entrada declara su configuración con Zod, de
 * modo que un proyecto con una acción mal formada se detecta al abrir y no
 * al pulsar el marcador que la contiene.
 */
export const actionConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goToScene'),
    sceneId: uuidSchema,
    entryMode: entryModeSchema.default('smart'),
    customView: cameraViewSchema.optional(),
    transition: transitionSchema.default({ kind: 'fade', durationMs: 700, useGeometry: false }),
  }),
  z.object({
    type: z.literal('lookAt'),
    view: cameraViewSchema,
    durationMs: z.number().int().min(0).max(10_000).default(800),
  }),
  z.object({
    type: z.literal('openInfoWindow'),
    /** Identificador del panel de información a mostrar. */
    windowId: uuidSchema,
    modal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('openMedia'),
    mediaId: uuidSchema,
    /** Álbum: varios medios navegables en la misma ventana (E03). */
    albumMediaIds: z.array(uuidSchema).default([]),
    autoplay: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('openDocument'),
    documentId: uuidSchema,
    /** Página inicial para PDF (E05). */
    page: z.number().int().positive().default(1),
  }),
  z.object({
    type: z.literal('downloadFile'),
    mediaId: uuidSchema,
    /** Nombre sugerido al guardar; se sanea antes de usarlo. */
    suggestedName: z.string().max(255).optional(),
  }),
  z.object({
    type: z.literal('openUrl'),
    url: z.string().url(),
    /** Abrir en el navegador del sistema en vez de dentro de la aplicación. */
    external: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('openWebframe'),
    url: z.string().url(),
    width: z.number().int().positive().max(4096).default(960),
    height: z.number().int().positive().max(4096).default(600),
    /**
     * Permitir recurso a pantalla completa dentro del marco. El resto de
     * permisos del iframe permanece denegado: el contrato de datos exige no
     * prometer compatibilidad universal, y conceder permisos amplios a una
     * página de tercero no es algo que el autor pueda evaluar.
     */
    allowFullscreen: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('showElement'),
    elementIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('hideElement'),
    elementIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('toggleElement'),
    elementIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('setVariable'),
    namespace: z.enum(['score', 'quiz']),
    key: z.string().min(1).max(64),
    operation: z.enum(['set', 'add', 'subtract']).default('set'),
    value: z.number().finite(),
  }),
  z.object({
    type: z.literal('startTour'),
    tourId: uuidSchema,
    fromWaypointIndex: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal('stopTour'),
  }),
  z.object({
    type: z.literal('startQuiz'),
    quizId: uuidSchema,
  }),
  z.object({
    type: z.literal('showAsset'),
    assetId: uuidSchema,
    /** Abrir directamente la pestaña de telemetría de la ficha. */
    tab: z.enum(['overview', 'attributes', 'documents', 'telemetry', 'notes']).default('overview'),
  }),
  z.object({
    type: z.literal('createNote'),
    /** Preselecciona categoría al abrir el formulario de nota. */
    category: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('showPlan'),
    planId: uuidSchema,
  }),
  z.object({
    type: z.literal('setVisualEffect'),
    effect: z.enum(['none', 'rain', 'dust', 'snow', 'lensFlare', 'motionBlur']),
    intensity: z.number().min(0).max(1).default(0.5),
  }),
  z.object({
    type: z.literal('playMedia'),
    mediaId: uuidSchema,
    loop: z.boolean().default(false),
    volume: z.number().min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('pauseMedia'),
    mediaId: uuidSchema.optional(),
  }),
  z.object({
    type: z.literal('wait'),
    durationMs: z.number().int().min(0).max(600_000),
  }),
  z.object({
    type: z.literal('enterVr'),
  }),
  z.object({
    type: z.literal('exitVr'),
  }),
  z.object({
    type: z.literal('modelPlayAnimation'),
    modelSceneId: uuidSchema,
    animationName: z.string().min(1),
    loop: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('modelSetVisibility'),
    modelSceneId: uuidSchema,
    nodeNames: z.array(z.string().min(1)).min(1),
    visible: z.boolean(),
  }),
  /**
   * Código JavaScript del autor (J09).
   *
   * Riesgo alto declarado en la arquitectura. El dominio sólo lo representa;
   * la política de ejecución vive en `scripting.ts` y el valor por defecto es
   * no ejecutar. Guardarlo como dato permite que un proyecto con scripts se
   * abra, se audite y se publique sin ellos.
   */
  z.object({
    type: z.literal('runScript'),
    source: z.string().max(64 * 1024),
    /** Motivo declarado por el autor; se muestra al administrador al aprobar. */
    purpose: z.string().max(500).default(''),
  }),
]);

export type ActionConfig = z.infer<typeof actionConfigSchema>;
export type ActionType = ActionConfig['type'];

export const ACTION_TYPES: readonly ActionType[] = actionConfigSchema.options.map(
  (option) => option.shape.type.value,
);

export const actionSchema = z.object({
  id: uuidSchema,
  event: actionEventSchema,
  config: actionConfigSchema,
  /** Orden de ejecución dentro del mismo evento. */
  order: z.number().int().nonnegative().default(0),
  /** Retardo antes de ejecutar, en ms. Base de los temporizadores (J04). */
  delayMs: z.number().int().min(0).max(600_000).default(0),
  /**
   * Retardo de mirada sostenida para `focusEnter`, en ms. Un disparo
   * instantáneo al centrar haría imposible cruzar la escena sin activar todo
   * lo que queda en el camino.
   */
  focusDwellMs: z.number().int().min(0).max(10_000).default(1200),
  /** Ejecutar una sola vez por sesión. */
  once: z.boolean().default(false),
  /** Condición de puntuación que debe cumplirse para ejecutar (J08, O08). */
  requiresScore: z
    .object({
      key: z.string().min(1).max(64),
      comparison: z.enum(['gte', 'lte', 'eq']),
      value: z.number().finite(),
    })
    .nullable()
    .default(null),
  enabled: z.boolean().default(true),
});

export type Action = z.infer<typeof actionSchema>;

/**
 * Acciones que modifican el estado persistente del recorrido y por tanto no
 * pueden ejecutarse en el visor publicado de solo lectura.
 */
export const MUTATING_ACTION_TYPES: readonly ActionType[] = ['createNote'];

/** Acciones que requieren red y deben degradar de forma visible sin conexión. */
export const NETWORK_ACTION_TYPES: readonly ActionType[] = [
  'openUrl',
  'openWebframe',
];

/** Acciones sin efecto fuera de una sesión de VR. */
export const VR_ONLY_ACTION_TYPES: readonly ActionType[] = ['exitVr'];

export const isMutatingAction = (type: ActionType): boolean =>
  MUTATING_ACTION_TYPES.includes(type);

export const requiresNetwork = (type: ActionType): boolean => NETWORK_ACTION_TYPES.includes(type);

/** Ordena las acciones de un evento de forma estable y determinista. */
export function sortActions(actions: readonly Action[]): Action[] {
  return [...actions].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.delayMs !== b.delayMs) return a.delayMs - b.delayMs;
    return a.id.localeCompare(b.id);
  });
}
