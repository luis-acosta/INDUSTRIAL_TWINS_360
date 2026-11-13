/**
 * Plantillas de interfaz y biblioteca de componentes (F02, F04).
 *
 * Una plantilla es un punto de partida, no un tema: al aplicarla se crea una
 * interfaz propia del proyecto que el autor puede cambiar entera. Es
 * deliberado que no quede ningún vínculo vivo con la plantilla —nada de
 * «actualizar desde la plantilla»—, porque una interfaz que cambia sola cuando
 * se actualiza el producto rompería recorridos que el cliente ya tiene
 * publicados y revisados.
 *
 * `templateId` se guarda sólo como procedencia: sirve para saber de dónde
 * salió y para no ofrecer dos veces la misma, nunca para sobrescribir nada.
 *
 * La biblioteca de componentes (F04) guarda subárboles con nombre dentro del
 * propio proyecto. Van en el proyecto y no en la aplicación porque un «panel de
 * cabecera de PDI» pertenece al cliente, se guarda con su archivo y viaja con
 * él; guardarlo en la instalación lo perdería al cambiar de equipo y lo haría
 * invisible para el resto del equipo.
 */
import { skinSchema, type Skin, type SkinNode } from './skin';
import { createNode, insertNode, reidentify, collectIds, type InsertOptions } from './skin-editing';
import { newUuid, type Uuid } from './identity';
import { ok, type Result } from './result';

/* ------------------------------------------------------------------ *
 * Plantillas
 * ------------------------------------------------------------------ */

export interface SkinTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Para qué sirve y qué conviene cambiar después. */
  readonly guidance: string;
  readonly layoutMode: Skin['layoutMode'];
  /** Construye el árbol. Recibe el conjunto de identificadores ya usados. */
  readonly build: (taken: Set<string>) => readonly SkinNode[];
}

/** Crea un nodo y registra su identificador, para encadenar sin repetir. */
function node(
  taken: Set<string>,
  kind: Parameters<typeof createNode>[0]['kind'],
  name: string,
  box: Partial<SkinNode['box']> = {},
  children: readonly SkinNode[] = [],
): SkinNode {
  const created = createNode({ kind, name, taken });
  taken.add(created.id);
  return { ...created, box: { ...created.box, ...box }, children };
}

export const SKIN_TEMPLATES: readonly SkinTemplate[] = [
  {
    id: 'minima',
    name: 'Mínima',
    description: 'Sólo la navegación entre escenas, abajo.',
    guidance:
      'El punto de partida más neutro: una tira de miniaturas al pie y nada más encima de la panorámica. Útil cuando el recorrido se explica solo.',
    layoutMode: 'fluid',
    build: (taken) => [
      node(taken, 'thumbnailList', 'Miniaturas', {
        anchor: 'bottom',
        offsetY: 16,
        widthPercent: 0.8,
        height: 96,
      }),
    ],
  },
  {
    id: 'recorrido-industrial',
    name: 'Recorrido industrial',
    description: 'Cabecera con título, plano a un lado y panel de proceso.',
    guidance:
      'Pensada para una visita de planta: el plano sitúa al visitante, el panel de proceso muestra las variables de la escena y la cabecera lleva el logotipo del cliente. Cambie la imagen de la cabecera por el logotipo y elija qué variables muestra el panel.',
    layoutMode: 'fluid',
    build: (taken) => [
      node(
        taken,
        'container',
        'Cabecera',
        { anchor: 'top', offsetY: 0, widthPercent: 1, height: 56, padding: 12 },
        [
          node(taken, 'image', 'Logotipo', { width: 120, height: 32 }),
          node(taken, 'text', 'Título del recorrido', { width: 420, height: 32 }),
        ],
      ),
      node(taken, 'planView', 'Plano', {
        anchor: 'bottomLeft',
        offsetX: 16,
        offsetY: 16,
        width: 260,
        height: 220,
      }),
      node(taken, 'telemetryPanel', 'Proceso', {
        anchor: 'right',
        offsetX: 16,
        width: 280,
        heightPercent: 0.6,
      }),
      node(taken, 'thumbnailList', 'Miniaturas', {
        anchor: 'bottom',
        offsetY: 16,
        widthPercent: 0.6,
        height: 88,
      }),
    ],
  },
  {
    id: 'formacion',
    name: 'Formación',
    description: 'Progreso, puntuación y tarjeta de pregunta.',
    guidance:
      'Para recorridos con evaluación: barra de progreso arriba, puntuación y tiempo a la vista, y una tarjeta de pregunta centrada. Asigne el cuestionario a la tarjeta y decida si el tiempo se cuenta hacia arriba o atrás.',
    layoutMode: 'fluid',
    build: (taken) => [
      node(taken, 'progressBar', 'Progreso', {
        anchor: 'top',
        offsetY: 0,
        widthPercent: 1,
        height: 6,
      }),
      node(
        taken,
        'container',
        'Marcador',
        { anchor: 'topRight', offsetX: 16, offsetY: 16, width: 220, height: 72, padding: 10 },
        [
          node(taken, 'scoreBoard', 'Puntuación', { width: 120, height: 48 }),
          node(taken, 'timer', 'Tiempo', { width: 72, height: 48 }),
        ],
      ),
      node(taken, 'quizCard', 'Pregunta', {
        anchor: 'center',
        width: 520,
        height: 320,
      }),
    ],
  },
  {
    id: 'inspeccion',
    name: 'Inspección',
    description: 'Ficha del activo y notas, para recorrer anotando.',
    guidance:
      'Para quien recorre la planta levantando observaciones: la ficha del activo a un lado y el panel de notas al otro, con alta habilitada. Compruebe que el panel de notas permite crear antes de publicar.',
    layoutMode: 'fluid',
    build: (taken) => [
      node(taken, 'assetPanel', 'Ficha del activo', {
        anchor: 'left',
        offsetX: 16,
        width: 300,
        heightPercent: 0.7,
      }),
      node(taken, 'notesPanel', 'Notas', {
        anchor: 'right',
        offsetX: 16,
        width: 300,
        heightPercent: 0.7,
      }),
      node(taken, 'thumbnailList', 'Miniaturas', {
        anchor: 'bottom',
        offsetY: 16,
        widthPercent: 0.5,
        height: 80,
      }),
    ],
  },
];

/** Plantilla por identificador. */
export function findTemplate(id: string): SkinTemplate | null {
  return SKIN_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * Crea una interfaz del proyecto a partir de una plantilla.
 *
 * Lo que sale es una interfaz propia y completa: no queda ningún vínculo vivo
 * con la plantilla, porque una interfaz que cambiara sola al actualizar el
 * producto rompería recorridos ya publicados y revisados por el cliente.
 */
export function skinFromTemplate(
  template: SkinTemplate,
  options: { readonly name?: string; readonly now: string },
): Skin {
  return skinSchema.parse({
    id: newUuid(),
    name: options.name ?? template.name,
    description: template.description,
    layoutMode: template.layoutMode,
    root: template.build(new Set<string>()),
    templateId: template.id,
    createdAt: options.now,
    updatedAt: options.now,
  });
}

/** Interfaz vacía, para empezar de cero. */
export function emptySkin(name: string, now: string): Skin {
  return skinSchema.parse({
    id: newUuid(),
    name,
    root: [],
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ *
 * Biblioteca de componentes (F04)
 * ------------------------------------------------------------------ */

/**
 * Componente guardado para reutilizar.
 *
 * Se modela como una interfaz con un único nodo en la raíz, y no como un tipo
 * nuevo, para que viaje en el archivo del proyecto sin cambiar su esquema y
 * para que un proyecto guardado con esta versión siga abriéndose en una
 * anterior: allí aparecerá como una interfaz más, que es exactamente lo que
 * es.
 */
export const COMPONENT_LIBRARY_PREFIX = 'componente:';

/** `true` si esa interfaz es en realidad un componente guardado. */
export function isSavedComponent(skin: Skin): boolean {
  return skin.name.startsWith(COMPONENT_LIBRARY_PREFIX);
}

/** Nombre visible de un componente guardado. */
export function savedComponentName(skin: Skin): string {
  return skin.name.slice(COMPONENT_LIBRARY_PREFIX.length);
}

/** Interfaces del proyecto que son interfaces de verdad, no componentes. */
export function realSkins(skins: readonly Skin[]): readonly Skin[] {
  return skins.filter((skin) => !isSavedComponent(skin));
}

/** Componentes guardados del proyecto. */
export function savedComponents(skins: readonly Skin[]): readonly Skin[] {
  return skins.filter(isSavedComponent);
}

/**
 * Guarda un subárbol en la biblioteca.
 *
 * Los identificadores se renuevan ya al guardar, y no sólo al insertar: el
 * componente guardado no debe compartir identificadores con la interfaz de la
 * que salió, porque insertarlo de vuelta en ella produciría duplicados.
 */
export function saveComponent(
  node: SkinNode,
  name: string,
  now: string,
): Skin {
  const { node: clean } = reidentify(node, new Set<string>());
  return skinSchema.parse({
    id: newUuid(),
    name: `${COMPONENT_LIBRARY_PREFIX}${name.trim()}`,
    description: `Componente guardado el ${now.slice(0, 10)}.`,
    root: [clean],
    createdAt: now,
    updatedAt: now,
  });
}

/** Inserta un componente de la biblioteca en una interfaz. */
export function insertSavedComponent(
  skin: Skin,
  component: Skin,
  options: InsertOptions,
): Result<Skin> {
  const source = component.root[0];
  if (source === undefined) {
    return ok(skin);
  }

  const { node: copy } = reidentify(source, collectIds(skin.root));
  return insertNode(skin, { ...copy, name: savedComponentName(component) }, options);
}

/** Identificador del proyecto al que pertenece una interfaz, para los avisos. */
export type SkinId = Uuid;
