/**
 * Operaciones de edición del árbol de una interfaz (F01–F04, F07, Y06).
 *
 * El `skin.ts` vecino define qué es una interfaz y la valida; el
 * `skin-layout.ts` de `@it360/viewer` la dibuja. Aquí viven las operaciones que
 * la cambian, que son la mitad que faltaba: hasta ahora una interfaz se podía
 * describir y mostrar, pero no construir.
 *
 * El árbol es recursivo e inmutable, y eso concentra casi todo el riesgo de
 * esta capa en tres sitios:
 *
 * 1. **Mover un nodo dentro de su propia descendencia** destruye el árbol: el
 *    subárbol movido deja de ser alcanzable desde la raíz y, con él,
 *    desaparecen los componentes que contenía. Se rechaza antes de tocar nada.
 * 2. **Mover y reordenar a la vez** es donde se cuelan los errores de índice.
 *    Sacar el nodo de su sitio cambia la posición de destino cuando origen y
 *    destino son el mismo contenedor, así que la inserción se calcula sobre la
 *    lista ya sin el nodo, no sobre la original.
 * 3. **Duplicar o pegar sin renovar identificadores** produce dos nodos con el
 *    mismo `id`. El visor los trataría como uno solo: ocultar el primero
 *    ocultaría el segundo, y las acciones apuntarían al que encontrara antes.
 *
 * Cada operación devuelve un árbol nuevo o un `Result` con el motivo. Ninguna
 * modifica lo que recibe.
 */
import {
  boxSchema,
  componentConfigSchema,
  CONTAINER_KINDS,
  findSkinNode,
  MAX_SKIN_DEPTH,
  skinNodePath,
  skinNodeSchema,
  skinStyleSchema,
  walkSkin,
  type ComponentConfig,
  type ComponentKind,
  type Skin,
  type SkinNode,
} from './skin';
import type { Action } from './action';
import { domainError, err, ok, type Result } from './result';
import { newUuid } from './identity';

/* ------------------------------------------------------------------ *
 * Identificadores
 * ------------------------------------------------------------------ */

/**
 * Identificador de nodo.
 *
 * Corto y sin guiones porque aparece en los selectores de acciones que el
 * autor lee y escribe; un UUID completo haría ilegible «ocultar
 * 4f3c…-9a1b-…». La colisión se descarta comprobando contra el árbol, no
 * confiando en la longitud.
 */
export function newNodeId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `n${newUuid().replace(/-/g, '').slice(0, 8)}`;
    if (!existing.has(candidate)) return candidate;
  }
  // Inalcanzable con 8 hexadecimales y árboles de este tamaño, pero devolver
  // un duplicado silencioso sería peor que un identificador largo.
  return `n${newUuid()}`;
}

/** Todos los identificadores que usa un árbol. */
export function collectIds(nodes: readonly SkinNode[]): Set<string> {
  const ids = new Set<string>();
  for (const { node } of walkSkin(nodes)) ids.add(node.id);
  return ids;
}

/* ------------------------------------------------------------------ *
 * Recorrido auxiliar
 * ------------------------------------------------------------------ */

const isContainer = (kind: ComponentKind): boolean => CONTAINER_KINDS.includes(kind);

/** `true` si `candidateId` está dentro del subárbol de `nodeId`, o es él. */
export function isWithin(
  nodes: readonly SkinNode[],
  nodeId: string,
  candidateId: string,
): boolean {
  const node = findSkinNode(nodes, nodeId);
  if (node === null) return false;
  if (nodeId === candidateId) return true;
  return findSkinNode(node.children, candidateId) !== null;
}

/** Profundidad del subárbol, contando el propio nodo como 1. */
export function subtreeDepth(node: SkinNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(subtreeDepth));
}

/** Profundidad a la que está un contenedor, con la raíz en 0. */
export function depthOf(nodes: readonly SkinNode[], parentId: string | null): number {
  if (parentId === null) return 0;
  const path = skinNodePath(nodes, parentId);
  return path === null ? 0 : path.length;
}

/**
 * Aplica una función a la lista de hijos de un contenedor.
 *
 * `parentId` a `null` significa la raíz. Es el único punto donde se reescribe
 * el árbol, para que todas las operaciones compartan el mismo recorrido y no
 * haya tres versiones ligeramente distintas de «bajar hasta el padre».
 */
function mapChildren(
  nodes: readonly SkinNode[],
  parentId: string | null,
  transform: (children: readonly SkinNode[]) => readonly SkinNode[],
): readonly SkinNode[] {
  if (parentId === null) return transform(nodes);

  return nodes.map((node) => {
    if (node.id === parentId) return { ...node, children: transform(node.children) };
    if (node.children.length === 0) return node;
    return { ...node, children: mapChildren(node.children, parentId, transform) };
  });
}

/** Quita un nodo del árbol y lo devuelve junto al árbol sin él. */
function extract(
  nodes: readonly SkinNode[],
  nodeId: string,
): { readonly tree: readonly SkinNode[]; readonly node: SkinNode | null } {
  let found: SkinNode | null = null;

  const strip = (list: readonly SkinNode[]): readonly SkinNode[] =>
    list
      .filter((node) => {
        if (node.id !== nodeId) return true;
        found = node;
        return false;
      })
      .map((node) => (node.children.length === 0 ? node : { ...node, children: strip(node.children) }));

  const tree = strip(nodes);
  return { tree, node: found };
}

/* ------------------------------------------------------------------ *
 * Insertar
 * ------------------------------------------------------------------ */

export interface InsertOptions {
  /** Contenedor de destino; `null` es la raíz. */
  readonly parentId: string | null;
  /** Posición entre los hijos; al final si se omite o excede. */
  readonly index?: number;
}

/**
 * Inserta un nodo en el árbol.
 *
 * Comprueba que el destino sea un contenedor de verdad. Meter un botón dentro
 * de una imagen produciría un hijo que el visor no dibuja nunca: el nodo
 * existiría en el archivo, el autor lo vería en el árbol del editor y no
 * aparecería en el recorrido publicado, que es la peor clase de fallo porque
 * no da ninguna señal.
 */
export function insertNode(
  skin: Skin,
  node: SkinNode,
  options: InsertOptions,
): Result<Skin> {
  const existing = collectIds(skin.root);
  if (existing.has(node.id)) {
    return err(
      domainError('CONFLICT', `Ya hay un componente con el identificador «${node.id}»`, {
        path: 'root',
      }),
    );
  }

  if (options.parentId !== null) {
    const parent = findSkinNode(skin.root, options.parentId);
    if (parent === null) {
      return err(
        domainError('NOT_FOUND', 'El contenedor de destino ya no está en la interfaz', {
          path: 'root',
        }),
      );
    }
    if (!isContainer(parent.config.kind)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `«${parent.name}» no es un contenedor, así que no puede tener componentes dentro`,
          {
            path: 'root',
            recovery: 'Elija un contenedor, unas pestañas o un carrusel como destino.',
          },
        ),
      );
    }

    const depth = depthOf(skin.root, options.parentId) + subtreeDepth(node);
    if (depth > MAX_SKIN_DEPTH) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Anidar ahí pasaría de ${MAX_SKIN_DEPTH} niveles de profundidad`,
          { path: 'root', recovery: 'Saque el componente a un contenedor más cercano a la raíz.' },
        ),
      );
    }
  }

  const root = mapChildren(skin.root, options.parentId, (children) => {
    const at = clampIndex(options.index, children.length);
    return [...children.slice(0, at), node, ...children.slice(at)];
  });

  return ok({ ...skin, root: [...root] });
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

/* ------------------------------------------------------------------ *
 * Mover
 * ------------------------------------------------------------------ */

/**
 * Mueve un nodo a otro contenedor, o a otra posición dentro del suyo.
 *
 * El caso que hay que resistir es mover un contenedor dentro de sí mismo o de
 * su propia descendencia: el subárbol movido deja de ser alcanzable desde la
 * raíz y los componentes que llevaba dentro desaparecen del archivo sin aviso.
 */
export function moveNode(
  skin: Skin,
  nodeId: string,
  options: InsertOptions,
): Result<Skin> {
  const node = findSkinNode(skin.root, nodeId);
  if (node === null) {
    return err(domainError('NOT_FOUND', 'Ese componente ya no está en la interfaz', { path: 'root' }));
  }

  if (node.locked) {
    return err(
      domainError('CONFLICT', `«${node.name}» está bloqueado`, {
        path: 'root',
        recovery: 'Desbloquéelo en el árbol de componentes antes de moverlo.',
      }),
    );
  }

  if (options.parentId !== null) {
    if (isWithin(skin.root, nodeId, options.parentId)) {
      return err(
        domainError(
          'CONFLICT',
          'Un contenedor no puede meterse dentro de sí mismo ni de lo que contiene',
          { path: 'root' },
        ),
      );
    }

    const parent = findSkinNode(skin.root, options.parentId);
    if (parent === null) {
      return err(
        domainError('NOT_FOUND', 'El contenedor de destino ya no está en la interfaz', {
          path: 'root',
        }),
      );
    }
    if (!isContainer(parent.config.kind)) {
      return err(
        domainError('VALIDATION_FAILED', `«${parent.name}» no es un contenedor`, {
          path: 'root',
          recovery: 'Elija un contenedor, unas pestañas o un carrusel como destino.',
        }),
      );
    }
  }

  // El índice se aplica sobre el árbol **ya sin el nodo**: si origen y destino
  // son el mismo contenedor, quitarlo corre una posición todo lo que venía
  // detrás, y usar el índice original lo dejaría un sitio más allá del pedido.
  const { tree, node: removed } = extract(skin.root, nodeId);
  if (removed === null) {
    return err(domainError('NOT_FOUND', 'Ese componente ya no está en la interfaz', { path: 'root' }));
  }

  if (options.parentId !== null) {
    const depth = depthOf(tree, options.parentId) + subtreeDepth(removed);
    if (depth > MAX_SKIN_DEPTH) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Anidar ahí pasaría de ${MAX_SKIN_DEPTH} niveles de profundidad`,
          { path: 'root' },
        ),
      );
    }
  }

  const root = mapChildren(tree, options.parentId, (children) => {
    const at = clampIndex(options.index, children.length);
    return [...children.slice(0, at), removed, ...children.slice(at)];
  });

  return ok({ ...skin, root: [...root] });
}

/* ------------------------------------------------------------------ *
 * Eliminar
 * ------------------------------------------------------------------ */

export interface RemovalImpact {
  readonly node: SkinNode;
  /** Componentes que desaparecen con él, el propio incluido. */
  readonly total: number;
  /** Nodos de la interfaz cuyas acciones apuntan a alguno de los borrados. */
  readonly referencedBy: readonly string[];
}

/**
 * Qué se lleva por delante borrar un nodo.
 *
 * Se calcula aparte de borrar para poder enseñarlo antes. Borrar un contenedor
 * con seis componentes dentro es una decisión distinta de borrar un botón, y
 * presentarlas igual hace que se tomen igual.
 */
export function removalImpact(skin: Skin, nodeId: string): RemovalImpact | null {
  const node = findSkinNode(skin.root, nodeId);
  if (node === null) return null;

  const doomed = new Set<string>([node.id]);
  for (const entry of walkSkin(node.children)) doomed.add(entry.node.id);

  const referencedBy: string[] = [];
  for (const { node: candidate } of walkSkin(skin.root)) {
    if (doomed.has(candidate.id)) continue;
    const targets = candidate.actions.flatMap((action) => [...actionTargets(action)]);
    if (targets.some((target) => doomed.has(target))) referencedBy.push(candidate.name);
  }

  return { node, total: doomed.size, referencedBy };
}

/**
 * Identificadores de componente a los que apunta una acción.
 *
 * Sólo las acciones que nombran componentes: mostrar, ocultar y alternar. Una
 * acción de navegación nombra una escena, no un nodo, y contarla aquí
 * produciría avisos falsos al borrar.
 */
export function actionTargets(action: Action): readonly string[] {
  const config = action.config;
  if (
    config.type === 'showElement' ||
    config.type === 'hideElement' ||
    config.type === 'toggleElement'
  ) {
    return config.elementIds;
  }
  return [];
}

/** Elimina un nodo y todo lo que contiene. */
export function removeNode(skin: Skin, nodeId: string): Result<Skin> {
  const node = findSkinNode(skin.root, nodeId);
  if (node === null) {
    return err(domainError('NOT_FOUND', 'Ese componente ya no está en la interfaz', { path: 'root' }));
  }
  if (node.locked) {
    return err(
      domainError('CONFLICT', `«${node.name}» está bloqueado`, {
        path: 'root',
        recovery: 'Desbloquéelo en el árbol de componentes antes de eliminarlo.',
      }),
    );
  }

  const { tree } = extract(skin.root, nodeId);
  return ok({ ...skin, root: [...tree] });
}

/* ------------------------------------------------------------------ *
 * Duplicar, copiar y pegar (Y06)
 * ------------------------------------------------------------------ */

/**
 * Renueva los identificadores de un subárbol.
 *
 * Devuelve también la correspondencia entre los viejos y los nuevos, para
 * poder reescribir las acciones internas: un botón que ocultaba a su hermano
 * debe seguir ocultando a la copia de su hermano, y no al original.
 */
export function reidentify(
  node: SkinNode,
  taken: ReadonlySet<string>,
): { readonly node: SkinNode; readonly mapping: ReadonlyMap<string, string> } {
  const used = new Set(taken);
  const mapping = new Map<string, string>();

  const rename = (current: SkinNode): SkinNode => {
    const id = newNodeId(used);
    used.add(id);
    mapping.set(current.id, id);
    return { ...current, id, children: current.children.map(rename) };
  };

  const renamed = rename(node);

  // Segunda pasada: las acciones sólo se pueden reescribir cuando ya se conoce
  // el mapa completo, porque un nodo puede apuntar a otro que viene después.
  const rewire = (current: SkinNode): SkinNode => ({
    ...current,
    actions: current.actions.map((action) => {
      const config = action.config;
      if (
        config.type !== 'showElement' &&
        config.type !== 'hideElement' &&
        config.type !== 'toggleElement'
      ) {
        return action;
      }
      // Un identificador que no esté en el mapa apunta fuera de la copia: se
      // deja como estaba, porque sigue siendo válido en la interfaz destino.
      return {
        ...action,
        config: {
          ...config,
          elementIds: config.elementIds.map((target) => mapping.get(target) ?? target),
        },
      };
    }),
    children: current.children.map(rewire),
  });

  return { node: rewire(renamed), mapping };
}

/**
 * Duplica un nodo junto al original.
 *
 * El nombre recibe un sufijo porque dos componentes con el mismo nombre en el
 * árbol del editor son indistinguibles, y el autor acabaría editando el que no
 * era.
 */
export function duplicateNode(skin: Skin, nodeId: string): Result<Skin> {
  const node = findSkinNode(skin.root, nodeId);
  if (node === null) {
    return err(domainError('NOT_FOUND', 'Ese componente ya no está en la interfaz', { path: 'root' }));
  }

  const path = skinNodePath(skin.root, nodeId);
  const parentId = path === null || path.length <= 1 ? null : (path[path.length - 2] ?? null);

  const siblings = parentId === null ? skin.root : (findSkinNode(skin.root, parentId)?.children ?? []);
  const index = siblings.findIndex((sibling) => sibling.id === nodeId);

  const { node: copy } = reidentify(node, collectIds(skin.root));
  return insertNode(skin, { ...copy, name: nextCopyName(node.name, collectNames(skin.root)) }, {
    parentId,
    index: index < 0 ? undefined : index + 1,
  });
}

function collectNames(nodes: readonly SkinNode[]): Set<string> {
  const names = new Set<string>();
  for (const { node } of walkSkin(nodes)) names.add(node.name);
  return names;
}

/** «Botón» → «Botón (copia)» → «Botón (copia 2)». */
export function nextCopyName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/\s*\(copia(?:\s+\d+)?\)$/u, '');
  const first = `${base} (copia)`;
  if (!taken.has(first)) return first;

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (copia ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (copia ${newUuid().slice(0, 4)})`;
}

/** Lo que guarda el portapapeles del editor. */
export interface SkinClipboard {
  readonly node: SkinNode;
  /** Interfaz de la que se copió, para avisar al pegar en otra. */
  readonly fromSkinId: string;
}

export function copyNode(skin: Skin, nodeId: string): SkinClipboard | null {
  const node = findSkinNode(skin.root, nodeId);
  return node === null ? null : { node, fromSkinId: skin.id };
}

/**
 * Pega el contenido del portapapeles.
 *
 * Los identificadores se renuevan siempre, también al pegar en otra interfaz:
 * dos nodos con el mismo `id` harían que ocultar uno ocultara el otro, y las
 * acciones apuntarían al que el visor encontrase primero.
 */
export function pasteNode(
  skin: Skin,
  clipboard: SkinClipboard,
  options: InsertOptions,
): Result<Skin> {
  const { node } = reidentify(clipboard.node, collectIds(skin.root));
  const name = collectNames(skin.root).has(node.name)
    ? nextCopyName(node.name, collectNames(skin.root))
    : node.name;

  return insertNode(skin, { ...node, name }, options);
}

/* ------------------------------------------------------------------ *
 * Modificar un nodo
 * ------------------------------------------------------------------ */

/** Reemplaza un nodo conservando su posición en el árbol. */
export function updateNode(
  skin: Skin,
  nodeId: string,
  patch: (node: SkinNode) => SkinNode,
): Result<Skin> {
  let touched = false;

  const apply = (list: readonly SkinNode[]): readonly SkinNode[] =>
    list.map((node) => {
      if (node.id === nodeId) {
        touched = true;
        // El identificador y los hijos no se tocan desde aquí: cambiarlos
        // exige las comprobaciones de `moveNode` e `insertNode`.
        const next = patch(node);
        return { ...next, id: node.id, children: node.children };
      }
      return node.children.length === 0 ? node : { ...node, children: apply(node.children) };
    });

  const root = apply(skin.root);
  if (!touched) {
    return err(domainError('NOT_FOUND', 'Ese componente ya no está en la interfaz', { path: 'root' }));
  }
  return ok({ ...skin, root: [...root] });
}

/* ------------------------------------------------------------------ *
 * Componentes nuevos
 * ------------------------------------------------------------------ */

/**
 * Configuración inicial de cada tipo de componente.
 *
 * Se obtiene **del propio esquema**, parseando `{ kind }` y dejando que los
 * valores por defecto declarados en `skin.ts` rellenen el resto. Escribir aquí
 * una copia a mano de esos campos garantizaba que las dos listas se separaran
 * en la primera vez que alguien añadiera una propiedad al esquema, y el
 * síntoma habría sido un componente nuevo con un campo sin valor que el visor
 * no sabría dibujar.
 *
 * Sólo se dan explícitamente los campos que el esquema exige sin valor por
 * defecto, y hay una prueba que comprueba que no haya más.
 */
export function defaultConfig(kind: ComponentKind): ComponentConfig {
  const seed: Record<string, unknown> = { kind };

  if (kind === 'tabs') {
    // Unas pestañas sin ninguna pestaña no se pueden dibujar; se crea la
    // primera para que el componente nazca utilizable.
    seed['tabs'] = [{ id: 'tab1', label: 'Pestaña 1' }];
  }
  if (kind === 'webframe') {
    // `example.invalid` está reservado por la RFC 2606 justamente para esto:
    // nunca resuelve, así que un «contenido web» que el autor olvide
    // configurar falla a la vista en lugar de cargar un sitio ajeno.
    seed['url'] = 'https://example.invalid/';
  }

  const parsed = componentConfigSchema.safeParse(seed);
  if (parsed.success) return parsed.data;

  // Inalcanzable mientras la prueba de arriba pase. Si el esquema cambia y
  // añade un campo obligatorio, es mejor fallar aquí con el motivo que
  // devolver una configuración que el visor no pueda dibujar.
  throw new Error(
    `No hay configuración inicial válida para «${kind}»: ${parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ')}`,
  );
}

export interface NewNodeOptions {
  readonly kind: ComponentKind;
  readonly name?: string;
  readonly x?: number;
  readonly y?: number;
  readonly taken: ReadonlySet<string>;
}

/**
 * Crea un componente con valores de partida razonables.
 *
 * La caja y el estilo salen de sus propios esquemas, por lo mismo que la
 * configuración: una copia a mano de esos campos se separaría del esquema en
 * cuanto alguien añadiera una propiedad, y el síntoma sería un componente
 * nuevo con un campo ausente que el visor no sabe dibujar.
 *
 * Sobre los valores por defecto sí se decide aquí lo poco que es una decisión
 * de producto: un contenedor nace con tamaño y relleno suficientes para que se
 * le pueda soltar algo dentro, y lo demás nace del tamaño mínimo utilizable.
 */
export function createNode(options: NewNodeOptions): SkinNode {
  const kind = options.kind;
  const container = isContainer(kind);

  const box = boxSchema.parse({
    anchor: 'topLeft',
    offsetX: options.x ?? 24,
    offsetY: options.y ?? 24,
    width: container ? 320 : 160,
    height: container ? 200 : 40,
    padding: container ? 12 : 0,
  });

  const style = skinStyleSchema.parse({});

  return skinNodeSchema.parse({
    id: newNodeId(options.taken),
    name: options.name ?? COMPONENT_DEFAULT_NAMES[kind],
    config: defaultConfig(kind),
    box,
    style,
  });
}

const COMPONENT_DEFAULT_NAMES: Readonly<Record<ComponentKind, string>> = {
  container: 'Contenedor',
  button: 'Botón',
  image: 'Imagen',
  text: 'Texto',
  dropdown: 'Menú',
  tabs: 'Pestañas',
  progressBar: 'Progreso',
  thumbnailList: 'Miniaturas',
  carousel: 'Carrusel',
  planView: 'Plano',
  assetPanel: 'Ficha de activo',
  telemetryPanel: 'Panel de proceso',
  notesPanel: 'Notas',
  quizCard: 'Pregunta',
  scoreBoard: 'Puntuación',
  timer: 'Temporizador',
  webframe: 'Contenido web',
  spacer: 'Separador',
};

export { COMPONENT_DEFAULT_NAMES };
