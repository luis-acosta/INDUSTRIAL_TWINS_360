import { describe, expect, it } from 'vitest';
import {
  actionTargets,
  collectIds,
  copyNode,
  createNode,
  defaultConfig,
  depthOf,
  duplicateNode,
  insertNode,
  isWithin,
  moveNode,
  nextCopyName,
  newNodeId,
  pasteNode,
  reidentify,
  removalImpact,
  removeNode,
  subtreeDepth,
  updateNode,
} from './skin-editing';
import {
  componentConfigSchema,
  componentKindSchema,
  findSkinNode,
  MAX_SKIN_DEPTH,
  skinSchema,
  walkSkin,
  type Skin,
  type SkinNode,
} from './skin';
import { newUuid } from './identity';

const NOW = '2026-07-01T09:00:00.000Z';

/** Interfaz de prueba: raíz → barra (contenedor) → [botón A, botón B]; panel suelto. */
function makeSkin(): Skin {
  const taken = new Set<string>();
  const add = (node: SkinNode): SkinNode => {
    taken.add(node.id);
    return node;
  };

  const botonA = add(createNode({ kind: 'button', name: 'Botón A', taken }));
  const botonB = add(createNode({ kind: 'button', name: 'Botón B', taken }));
  const barra = add(createNode({ kind: 'container', name: 'Barra', taken }));
  const panel = add(createNode({ kind: 'telemetryPanel', name: 'Panel', taken }));

  return skinSchema.parse({
    id: newUuid(),
    name: 'Interfaz de prueba',
    layoutMode: 'fluid',
    root: [{ ...barra, children: [botonA, botonB] }, panel],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const idsOf = (skin: Skin): string[] => [...walkSkin(skin.root)].map((entry) => entry.node.id);
const namesIn = (skin: Skin, parentId: string | null): string[] => {
  const list = parentId === null ? skin.root : (findSkinNode(skin.root, parentId)?.children ?? []);
  return list.map((node) => node.name);
};
const byName = (skin: Skin, name: string): SkinNode => {
  const found = [...walkSkin(skin.root)].find((entry) => entry.node.name === name);
  if (found === undefined) throw new Error(`No existe «${name}» en la interfaz`);
  return found.node;
};

/* ------------------------------------------------------------------ *
 * Valores de partida derivados del esquema
 * ------------------------------------------------------------------ */

describe('defaultConfig', () => {
  it('TEST-SKE-001 produce una configuración válida para todos los tipos', () => {
    // Si el esquema gana un campo obligatorio, esta prueba cae antes de que un
    // componente nuevo llegue al visor con un campo que no sabe dibujar.
    for (const kind of componentKindSchema.options) {
      const config = defaultConfig(kind);
      expect(componentConfigSchema.safeParse(config).success).toBe(true);
      expect(config.kind).toBe(kind);
    }
  });

  it('TEST-SKE-002 unas pestañas nacen con una pestaña dentro', () => {
    const config = defaultConfig('tabs');
    expect(config.kind === 'tabs' && config.tabs.length).toBe(1);
  });

  it('TEST-SKE-003 el contenido web nace con una dirección que nunca resuelve', () => {
    // RFC 2606: `.invalid` está reservado. Un «contenido web» que el autor
    // olvide configurar falla a la vista en lugar de cargar un sitio ajeno.
    const config = defaultConfig('webframe');
    expect(config.kind === 'webframe' && config.url).toContain('example.invalid');
  });
});

describe('createNode', () => {
  it('TEST-SKE-004 crea un nodo que el esquema acepta, para todos los tipos', () => {
    for (const kind of componentKindSchema.options) {
      const node = createNode({ kind, taken: new Set() });
      expect(node.id.length).toBeGreaterThan(0);
      expect(node.children).toEqual([]);
      expect(node.locked).toBe(false);
    }
  });

  it('TEST-SKE-005 no repite un identificador ya usado', () => {
    const taken = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const node = createNode({ kind: 'button', taken });
      taken.add(node.id);
      ids.add(node.id);
    }
    expect(ids.size).toBe(200);
  });

  it('TEST-SKE-006 un contenedor nace con relleno para poder soltarle algo dentro', () => {
    expect(createNode({ kind: 'container', taken: new Set() }).box.padding).toBeGreaterThan(0);
    expect(createNode({ kind: 'button', taken: new Set() }).box.padding).toBe(0);
  });

  it('TEST-SKE-007 coloca el nodo donde se le indica', () => {
    const node = createNode({ kind: 'button', x: 120, y: 80, taken: new Set() });
    expect(node.box.offsetX).toBe(120);
    expect(node.box.offsetY).toBe(80);
  });
});

describe('newNodeId', () => {
  it('TEST-SKE-008 evita los identificadores ya tomados', () => {
    const taken = new Set(['n0000001']);
    for (let i = 0; i < 50; i += 1) expect(newNodeId(taken)).not.toBe('n0000001');
  });
});

/* ------------------------------------------------------------------ *
 * Insertar
 * ------------------------------------------------------------------ */

describe('insertNode', () => {
  it('TEST-SKE-009 inserta en la raíz al final por defecto', () => {
    const skin = makeSkin();
    const node = createNode({ kind: 'text', name: 'Aviso', taken: collectIds(skin.root) });

    const result = insertNode(skin, node, { parentId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(namesIn(result.value, null)).toEqual(['Barra', 'Panel', 'Aviso']);
  });

  it('TEST-SKE-010 inserta en la posición indicada', () => {
    const skin = makeSkin();
    const node = createNode({ kind: 'text', name: 'Aviso', taken: collectIds(skin.root) });

    const result = insertNode(skin, node, { parentId: null, index: 0 });
    expect(result.ok && namesIn(result.value, null)).toEqual(['Aviso', 'Barra', 'Panel']);
  });

  it('TEST-SKE-011 un índice fuera de rango no pierde el nodo', () => {
    const skin = makeSkin();
    const node = createNode({ kind: 'text', name: 'Aviso', taken: collectIds(skin.root) });

    const alto = insertNode(skin, node, { parentId: null, index: 99 });
    expect(alto.ok && namesIn(alto.value, null)).toEqual(['Barra', 'Panel', 'Aviso']);

    const bajo = insertNode(skin, node, { parentId: null, index: -5 });
    expect(bajo.ok && namesIn(bajo.value, null)).toEqual(['Aviso', 'Barra', 'Panel']);
  });

  it('TEST-SKE-012 inserta dentro de un contenedor', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const node = createNode({ kind: 'text', name: 'Título', taken: collectIds(skin.root) });

    const result = insertNode(skin, node, { parentId: barra.id, index: 1 });
    expect(result.ok && namesIn(result.value, barra.id)).toEqual(['Botón A', 'Título', 'Botón B']);
  });

  it('TEST-SKE-013 no mete nada dentro de lo que no es un contenedor', () => {
    // El nodo existiría en el archivo, el autor lo vería en el árbol y no
    // aparecería nunca en el recorrido: la peor clase de fallo, el que no da
    // ninguna señal.
    const skin = makeSkin();
    const panel = byName(skin, 'Panel');
    const node = createNode({ kind: 'text', taken: collectIds(skin.root) });

    const result = insertNode(skin, node, { parentId: panel.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no es un contenedor');
  });

  it('TEST-SKE-014 rechaza un identificador repetido', () => {
    const skin = makeSkin();
    const existente = byName(skin, 'Botón A');
    const result = insertNode(skin, { ...existente, name: 'Clon' }, { parentId: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFLICT');
  });

  it('TEST-SKE-015 rechaza un contenedor de destino que ya no existe', () => {
    const skin = makeSkin();
    const node = createNode({ kind: 'text', taken: collectIds(skin.root) });
    expect(insertNode(skin, node, { parentId: 'nofantasma' }).ok).toBe(false);
  });

  it('TEST-SKE-016 no deja pasar del límite de profundidad', () => {
    let skin = makeSkin();
    let parentId: string | null = byName(skin, 'Barra').id;

    for (let depth = 0; depth < MAX_SKIN_DEPTH + 4; depth += 1) {
      const node = createNode({ kind: 'container', name: `C${depth}`, taken: collectIds(skin.root) });
      const result = insertNode(skin, node, { parentId });
      if (!result.ok) {
        expect(result.error.message).toContain('profundidad');
        return;
      }
      skin = result.value;
      parentId = node.id;
    }
    throw new Error('Se esperaba que el límite de profundidad detuviera el anidamiento');
  });

  it('TEST-SKE-017 no modifica la interfaz original', () => {
    const skin = makeSkin();
    const antes = JSON.stringify(skin);
    insertNode(skin, createNode({ kind: 'text', taken: collectIds(skin.root) }), { parentId: null });
    expect(JSON.stringify(skin)).toBe(antes);
  });
});

/* ------------------------------------------------------------------ *
 * Mover
 * ------------------------------------------------------------------ */

describe('moveNode', () => {
  it('TEST-SKE-018 saca un nodo de un contenedor a la raíz', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const botonA = byName(skin, 'Botón A');

    const result = moveNode(skin, botonA.id, { parentId: null, index: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(namesIn(result.value, null)).toEqual(['Botón A', 'Barra', 'Panel']);
    expect(namesIn(result.value, barra.id)).toEqual(['Botón B']);
  });

  it('TEST-SKE-019 mete un nodo de la raíz en un contenedor', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const panel = byName(skin, 'Panel');

    const result = moveNode(skin, panel.id, { parentId: barra.id, index: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(namesIn(result.value, null)).toEqual(['Barra']);
    expect(namesIn(result.value, barra.id)).toEqual(['Panel', 'Botón A', 'Botón B']);
  });

  it('TEST-SKE-020 reordena dentro del mismo contenedor sin desplazarse de más', () => {
    // Aquí se cuelan los errores de índice: quitar el nodo corre una posición
    // todo lo que venía detrás, así que el índice se aplica sobre la lista ya
    // sin él.
    const taken = new Set<string>();
    const a = createNode({ kind: 'button', name: 'A', taken });
    taken.add(a.id);
    const b = createNode({ kind: 'button', name: 'B', taken });
    taken.add(b.id);
    const c = createNode({ kind: 'button', name: 'C', taken });
    taken.add(c.id);

    const skin = skinSchema.parse({
      id: newUuid(),
      name: 'Orden',
      root: [a, b, c],
      createdAt: NOW,
      updatedAt: NOW,
    });

    // A al final.
    const alFinal = moveNode(skin, a.id, { parentId: null, index: 2 });
    expect(alFinal.ok && namesIn(alFinal.value, null)).toEqual(['B', 'C', 'A']);

    // C al principio.
    const alPrincipio = moveNode(skin, c.id, { parentId: null, index: 0 });
    expect(alPrincipio.ok && namesIn(alPrincipio.value, null)).toEqual(['C', 'A', 'B']);

    // B una posición a la derecha.
    const unPaso = moveNode(skin, b.id, { parentId: null, index: 2 });
    expect(unPaso.ok && namesIn(unPaso.value, null)).toEqual(['A', 'C', 'B']);
  });

  it('TEST-SKE-021 mover un nodo a su propia posición no cambia el orden', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const result = moveNode(skin, barra.id, { parentId: null, index: 0 });
    expect(result.ok && namesIn(result.value, null)).toEqual(['Barra', 'Panel']);
  });

  it('TEST-SKE-022 un contenedor no puede meterse dentro de sí mismo', () => {
    // El subárbol movido dejaría de ser alcanzable desde la raíz, y los
    // componentes que llevaba dentro desaparecerían del archivo sin aviso.
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');

    const result = moveNode(skin, barra.id, { parentId: barra.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('dentro de sí mismo');
  });

  it('TEST-SKE-023 un contenedor no puede meterse dentro de su descendencia', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');

    const interior = createNode({ kind: 'container', name: 'Interior', taken: collectIds(skin.root) });
    const conInterior = insertNode(skin, interior, { parentId: barra.id });
    expect(conInterior.ok).toBe(true);
    if (!conInterior.ok) return;

    const result = moveNode(conInterior.value, barra.id, { parentId: interior.id });
    expect(result.ok).toBe(false);

    // Y el árbol sigue entero: nada se perdió en el intento.
    expect(collectIds(conInterior.value.root).size).toBe(5);
  });

  it('TEST-SKE-024 no mueve un nodo bloqueado', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const bloqueada = updateNode(skin, barra.id, (node) => ({ ...node, locked: true }));
    expect(bloqueada.ok).toBe(true);
    if (!bloqueada.ok) return;

    const result = moveNode(bloqueada.value, barra.id, { parentId: null, index: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain('Desbloquéelo');
  });

  it('TEST-SKE-025 no mueve nada dentro de lo que no es contenedor', () => {
    const skin = makeSkin();
    const panel = byName(skin, 'Panel');
    const botonA = byName(skin, 'Botón A');
    expect(moveNode(skin, botonA.id, { parentId: panel.id }).ok).toBe(false);
  });

  it('TEST-SKE-026 no pierde ningún nodo al mover', () => {
    const skin = makeSkin();
    const antes = collectIds(skin.root);
    const result = moveNode(skin, byName(skin, 'Botón A').id, { parentId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectIds(result.value.root)).toEqual(antes);
  });

  it('TEST-SKE-027 informa si el nodo ya no existe', () => {
    expect(moveNode(makeSkin(), 'nofantasma', { parentId: null }).ok).toBe(false);
  });
});

describe('isWithin, subtreeDepth y depthOf', () => {
  it('TEST-SKE-028 isWithin reconoce al propio nodo y a su descendencia', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const botonA = byName(skin, 'Botón A');
    const panel = byName(skin, 'Panel');

    expect(isWithin(skin.root, barra.id, barra.id)).toBe(true);
    expect(isWithin(skin.root, barra.id, botonA.id)).toBe(true);
    expect(isWithin(skin.root, barra.id, panel.id)).toBe(false);
  });

  it('TEST-SKE-029 subtreeDepth cuenta el propio nodo', () => {
    const skin = makeSkin();
    expect(subtreeDepth(byName(skin, 'Botón A'))).toBe(1);
    expect(subtreeDepth(byName(skin, 'Barra'))).toBe(2);
  });

  it('TEST-SKE-030 depthOf sitúa la raíz en cero', () => {
    const skin = makeSkin();
    expect(depthOf(skin.root, null)).toBe(0);
    expect(depthOf(skin.root, byName(skin, 'Barra').id)).toBe(1);
    expect(depthOf(skin.root, byName(skin, 'Botón A').id)).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Eliminar
 * ------------------------------------------------------------------ */

describe('removalImpact y removeNode', () => {
  it('TEST-SKE-031 cuenta lo que se lleva por delante borrar un contenedor', () => {
    // Borrar un contenedor con seis componentes dentro es una decisión
    // distinta de borrar un botón, y presentarlas igual hace que se tomen
    // igual.
    const skin = makeSkin();
    const impacto = removalImpact(skin, byName(skin, 'Barra').id);

    expect(impacto?.total).toBe(3);
    expect(removalImpact(skin, byName(skin, 'Panel').id)?.total).toBe(1);
  });

  it('TEST-SKE-032 avisa de quién quedaría apuntando al vacío', () => {
    const skin = makeSkin();
    const botonB = byName(skin, 'Botón B');

    const conAccion = updateNode(skin, byName(skin, 'Panel').id, (node) => ({
      ...node,
      actions: [
        {
          id: newUuid(),
          event: 'click',
          config: { type: 'hideElement', elementIds: [botonB.id] },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
    }));
    expect(conAccion.ok).toBe(true);
    if (!conAccion.ok) return;

    const impacto = removalImpact(conAccion.value, byName(conAccion.value, 'Barra').id);
    expect(impacto?.referencedBy).toEqual(['Panel']);
  });

  it('TEST-SKE-033 no cuenta como referencia una acción que no nombra componentes', () => {
    const skin = makeSkin();
    const conNavegacion = updateNode(skin, byName(skin, 'Panel').id, (node) => ({
      ...node,
      actions: [
        {
          id: newUuid(),
          event: 'click',
          config: {
            type: 'goToScene',
            sceneId: newUuid(),
            entryMode: 'initialView',
            transition: { kind: 'fade', durationMs: 400, useGeometry: false },
          },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
    }));
    expect(conNavegacion.ok).toBe(true);
    if (!conNavegacion.ok) return;

    expect(removalImpact(conNavegacion.value, byName(skin, 'Barra').id)?.referencedBy).toEqual([]);
  });

  it('TEST-SKE-034 borra el nodo y toda su descendencia', () => {
    const skin = makeSkin();
    const result = removeNode(skin, byName(skin, 'Barra').id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idsOf(result.value)).toEqual([byName(skin, 'Panel').id]);
  });

  it('TEST-SKE-035 no borra un nodo bloqueado', () => {
    const skin = makeSkin();
    const bloqueado = updateNode(skin, byName(skin, 'Panel').id, (node) => ({
      ...node,
      locked: true,
    }));
    expect(bloqueado.ok).toBe(true);
    if (!bloqueado.ok) return;

    expect(removeNode(bloqueado.value, byName(skin, 'Panel').id).ok).toBe(false);
  });

  it('TEST-SKE-036 informa si el nodo ya no existe', () => {
    expect(removeNode(makeSkin(), 'nofantasma').ok).toBe(false);
    expect(removalImpact(makeSkin(), 'nofantasma')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Duplicar, copiar y pegar
 * ------------------------------------------------------------------ */

describe('reidentify', () => {
  it('TEST-SKE-037 renueva todos los identificadores del subárbol', () => {
    // Dos nodos con el mismo identificador harían que ocultar uno ocultara el
    // otro, y las acciones apuntarían al que el visor encontrase primero.
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');
    const { node } = reidentify(barra, collectIds(skin.root));

    const originales = new Set([barra.id, ...barra.children.map((child) => child.id)]);
    for (const { node: copia } of walkSkin([node])) {
      expect(originales.has(copia.id)).toBe(false);
    }
  });

  it('TEST-SKE-038 reescribe las acciones internas para que apunten a la copia', () => {
    // Un botón que ocultaba a su hermano debe seguir ocultando a la copia de
    // su hermano, no al original.
    const skin = makeSkin();
    const botonB = byName(skin, 'Botón B');

    const conAccion = updateNode(skin, byName(skin, 'Botón A').id, (node) => ({
      ...node,
      actions: [
        {
          id: newUuid(),
          event: 'click',
          config: { type: 'toggleElement', elementIds: [botonB.id] },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
    }));
    expect(conAccion.ok).toBe(true);
    if (!conAccion.ok) return;

    const barra = byName(conAccion.value, 'Barra');
    const { node, mapping } = reidentify(barra, collectIds(conAccion.value.root));

    const copiaA = node.children[0];
    const targets = copiaA === undefined ? [] : actionTargets(copiaA.actions[0]!);
    expect(targets).toEqual([mapping.get(botonB.id)]);
    expect(targets[0]).not.toBe(botonB.id);
  });

  it('TEST-SKE-039 deja intactas las acciones que apuntan fuera de la copia', () => {
    const skin = makeSkin();
    const panel = byName(skin, 'Panel');

    const conAccion = updateNode(skin, byName(skin, 'Botón A').id, (node) => ({
      ...node,
      actions: [
        {
          id: newUuid(),
          event: 'click',
          config: { type: 'hideElement', elementIds: [panel.id] },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
    }));
    if (!conAccion.ok) return;

    const { node } = reidentify(byName(conAccion.value, 'Barra'), collectIds(conAccion.value.root));
    expect(actionTargets(node.children[0]!.actions[0]!)).toEqual([panel.id]);
  });
});

describe('duplicateNode', () => {
  it('TEST-SKE-040 coloca la copia justo detrás del original', () => {
    const skin = makeSkin();
    const result = duplicateNode(skin, byName(skin, 'Botón A').id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(namesIn(result.value, byName(skin, 'Barra').id)).toEqual([
      'Botón A',
      'Botón A (copia)',
      'Botón B',
    ]);
  });

  it('TEST-SKE-041 duplica también la descendencia, con identificadores nuevos', () => {
    const skin = makeSkin();
    const result = duplicateNode(skin, byName(skin, 'Barra').id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cuatro nodos originales más tres de la copia.
    expect(idsOf(result.value)).toHaveLength(7);
    expect(new Set(idsOf(result.value)).size).toBe(7);
  });

  it('TEST-SKE-042 duplicar lo que está en la raíz lo deja en la raíz', () => {
    const skin = makeSkin();
    const result = duplicateNode(skin, byName(skin, 'Panel').id);
    expect(result.ok && namesIn(result.value, null)).toEqual(['Barra', 'Panel', 'Panel (copia)']);
  });

  it('TEST-SKE-043 duplicar una copia no encadena sufijos', () => {
    const skin = makeSkin();
    const una = duplicateNode(skin, byName(skin, 'Panel').id);
    expect(una.ok).toBe(true);
    if (!una.ok) return;

    const dos = duplicateNode(una.value, byName(una.value, 'Panel (copia)').id);
    expect(dos.ok && namesIn(dos.value, null)).toEqual([
      'Barra',
      'Panel',
      'Panel (copia)',
      'Panel (copia 2)',
    ]);
  });
});

describe('nextCopyName', () => {
  it('TEST-SKE-044 numera a partir de la segunda copia', () => {
    expect(nextCopyName('Botón', new Set())).toBe('Botón (copia)');
    expect(nextCopyName('Botón', new Set(['Botón (copia)']))).toBe('Botón (copia 2)');
    expect(nextCopyName('Botón (copia)', new Set(['Botón (copia)']))).toBe('Botón (copia 2)');
  });
});

describe('copyNode y pasteNode', () => {
  it('TEST-SKE-045 pega una copia con identificadores nuevos', () => {
    const skin = makeSkin();
    const clipboard = copyNode(skin, byName(skin, 'Botón A').id);
    expect(clipboard).not.toBeNull();
    if (clipboard === null) return;

    const result = pasteNode(skin, clipboard, { parentId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(idsOf(result.value)).toHaveLength(5);
    expect(new Set(idsOf(result.value)).size).toBe(5);
  });

  it('TEST-SKE-046 pegar en otra interfaz también renueva los identificadores', () => {
    const origen = makeSkin();
    const destino = makeSkin();
    const clipboard = copyNode(origen, byName(origen, 'Barra').id);
    if (clipboard === null) return;

    const result = pasteNode(destino, clipboard, { parentId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const idsDestino = new Set(idsOf(result.value));
    expect(idsDestino.size).toBe(7);
    // Ninguno de los nuevos coincide con los de la interfaz de origen.
    for (const id of collectIds(origen.root)) {
      const repetidos = idsOf(result.value).filter((candidate) => candidate === id);
      expect(repetidos.length).toBeLessThanOrEqual(1);
    }
  });

  it('TEST-SKE-047 conserva el nombre si no choca, y lo cambia si choca', () => {
    const skin = makeSkin();
    const clipboard = copyNode(skin, byName(skin, 'Panel').id);
    if (clipboard === null) return;

    const mismo = pasteNode(skin, clipboard, { parentId: null });
    expect(mismo.ok && namesIn(mismo.value, null)).toEqual(['Barra', 'Panel', 'Panel (copia)']);

    const otro = makeSkin();
    const sinPanel = removeNode(otro, byName(otro, 'Panel').id);
    if (!sinPanel.ok) return;
    const pegado = pasteNode(sinPanel.value, clipboard, { parentId: null });
    expect(pegado.ok && namesIn(pegado.value, null)).toEqual(['Barra', 'Panel']);
  });

  it('TEST-SKE-048 copiar algo que no existe devuelve null', () => {
    expect(copyNode(makeSkin(), 'nofantasma')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Modificar
 * ------------------------------------------------------------------ */

describe('updateNode', () => {
  it('TEST-SKE-049 cambia el nodo sin moverlo', () => {
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');

    const result = updateNode(skin, byName(skin, 'Botón A').id, (node) => ({
      ...node,
      name: 'Botón renombrado',
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(namesIn(result.value, barra.id)).toEqual(['Botón renombrado', 'Botón B']);
  });

  it('TEST-SKE-050 no deja cambiar el identificador ni los hijos desde aquí', () => {
    // Cambiarlos exige las comprobaciones de moveNode e insertNode; permitirlo
    // aquí sería una vía lateral para saltárselas.
    const skin = makeSkin();
    const barra = byName(skin, 'Barra');

    const result = updateNode(skin, barra.id, (node) => ({
      ...node,
      id: 'nuevo',
      children: [],
      name: 'Barra editada',
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actualizado = findSkinNode(result.value.root, barra.id);
    expect(actualizado?.name).toBe('Barra editada');
    expect(actualizado?.children).toHaveLength(2);
    expect(findSkinNode(result.value.root, 'nuevo')).toBeNull();
  });

  it('TEST-SKE-051 informa si el nodo ya no existe', () => {
    expect(updateNode(makeSkin(), 'nofantasma', (node) => node).ok).toBe(false);
  });
});
