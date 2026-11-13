import { describe, expect, it } from 'vitest';
import {
  COMPONENT_LIBRARY_PREFIX,
  emptySkin,
  findTemplate,
  insertSavedComponent,
  isSavedComponent,
  realSkins,
  savedComponentName,
  savedComponents,
  saveComponent,
  skinFromTemplate,
  SKIN_TEMPLATES,
} from './skin-templates';
import { collectIds, createNode, insertNode } from './skin-editing';
import { skinSchema, validateSkin, walkSkin, type Skin } from './skin';
import { newUuid } from './identity';

const NOW = '2026-07-15T10:00:00.000Z';

const idsOf = (skin: Skin): string[] => [...walkSkin(skin.root)].map((entry) => entry.node.id);

/* ------------------------------------------------------------------ *
 * Plantillas (F02)
 * ------------------------------------------------------------------ */

describe('SKIN_TEMPLATES', () => {
  it('TEST-SKT-001 toda plantilla produce una interfaz que el esquema acepta', () => {
    for (const template of SKIN_TEMPLATES) {
      const skin = skinFromTemplate(template, { now: NOW });
      expect(skinSchema.safeParse(skin).success).toBe(true);
    }
  });

  it('TEST-SKT-002 toda plantilla produce una interfaz que la validación aprueba', () => {
    // Una plantilla que el producto ofrece y que sale con avisos sería una
    // trampa: el autor empezaría con deberes que no provocó.
    for (const template of SKIN_TEMPLATES) {
      const skin = skinFromTemplate(template, { now: NOW });
      expect(validateSkin(skin), `plantilla ${template.id}`).toEqual([]);
    }
  });

  it('TEST-SKT-003 ninguna plantilla repite identificadores', () => {
    for (const template of SKIN_TEMPLATES) {
      const skin = skinFromTemplate(template, { now: NOW });
      const ids = idsOf(skin);
      expect(new Set(ids).size, `plantilla ${template.id}`).toBe(ids.length);
    }
  });

  it('TEST-SKT-004 dos interfaces de la misma plantilla no comparten identificadores', () => {
    // Si los compartieran, pegar un componente de una en otra produciría
    // duplicados silenciosos.
    const template = SKIN_TEMPLATES[1];
    expect(template).toBeDefined();
    if (template === undefined) return;

    const una = skinFromTemplate(template, { now: NOW });
    const otra = skinFromTemplate(template, { now: NOW });

    expect(una.id).not.toBe(otra.id);
    const comunes = idsOf(una).filter((id) => idsOf(otra).includes(id));
    expect(comunes).toEqual([]);
  });

  it('TEST-SKT-005 cada plantilla explica para qué sirve y qué cambiar después', () => {
    for (const template of SKIN_TEMPLATES) {
      expect(template.name.length, template.id).toBeGreaterThan(0);
      expect(template.description.length, template.id).toBeGreaterThan(10);
      expect(template.guidance.length, template.id).toBeGreaterThan(40);
    }
  });

  it('TEST-SKT-006 los identificadores de plantilla son únicos', () => {
    const ids = SKIN_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('TEST-SKT-007 guarda la procedencia pero no queda vínculo vivo', () => {
    // `templateId` es procedencia, no suscripción: una interfaz que cambiara
    // sola al actualizar el producto rompería recorridos ya publicados.
    const template = SKIN_TEMPLATES[0];
    if (template === undefined) return;

    const skin = skinFromTemplate(template, { now: NOW });
    expect(skin.templateId).toBe(template.id);

    // Editarla no toca la plantilla.
    const node = createNode({ kind: 'text', name: 'Añadido', taken: collectIds(skin.root) });
    const editada = insertNode(skin, node, { parentId: null });
    expect(editada.ok).toBe(true);

    const otra = skinFromTemplate(template, { now: NOW });
    expect(idsOf(otra)).toHaveLength(idsOf(skin).length);
  });

  it('TEST-SKT-008 admite un nombre propio al crearla', () => {
    const template = SKIN_TEMPLATES[0];
    if (template === undefined) return;
    expect(skinFromTemplate(template, { name: 'Visita Ecopetrol', now: NOW }).name).toBe(
      'Visita Ecopetrol',
    );
  });

  it('TEST-SKT-009 findTemplate encuentra por identificador y no inventa', () => {
    expect(findTemplate('minima')?.name).toBe('Mínima');
    expect(findTemplate('no-existe')).toBeNull();
  });
});

describe('emptySkin', () => {
  it('TEST-SKT-010 crea una interfaz vacía y válida, sin procedencia', () => {
    const skin = emptySkin('Desde cero', NOW);
    expect(skin.root).toEqual([]);
    expect(skin.templateId).toBeNull();
    expect(skinSchema.safeParse(skin).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Biblioteca de componentes (F04)
 * ------------------------------------------------------------------ */

function skinConBarra(): Skin {
  const taken = new Set<string>();
  const boton = createNode({ kind: 'button', name: 'Botón', taken });
  taken.add(boton.id);
  const barra = createNode({ kind: 'container', name: 'Barra', taken });

  return skinSchema.parse({
    id: newUuid(),
    name: 'Interfaz',
    root: [{ ...barra, children: [boton] }],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('saveComponent', () => {
  it('TEST-SKT-011 guarda el subárbol con un nombre reconocible', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera de PDI', NOW);
    expect(isSavedComponent(componente)).toBe(true);
    expect(savedComponentName(componente)).toBe('Cabecera de PDI');
    expect(componente.name.startsWith(COMPONENT_LIBRARY_PREFIX)).toBe(true);
    expect(componente.root).toHaveLength(1);
  });

  it('TEST-SKT-012 renueva los identificadores ya al guardar', () => {
    // Si compartiera identificadores con la interfaz de origen, insertarlo de
    // vuelta en ella produciría duplicados.
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera', NOW);
    const comunes = idsOf(componente).filter((id) => idsOf(skin).includes(id));
    expect(comunes).toEqual([]);
  });

  it('TEST-SKT-013 conserva la descendencia del componente', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera', NOW);
    expect(componente.root[0]?.children).toHaveLength(1);
    expect(componente.root[0]?.children[0]?.name).toBe('Botón');
  });

  it('TEST-SKT-014 recorta los espacios del nombre', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;
    expect(savedComponentName(saveComponent(barra, '  Cabecera  ', NOW))).toBe('Cabecera');
  });
});

describe('insertSavedComponent', () => {
  it('TEST-SKT-015 inserta el componente con identificadores nuevos', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera', NOW);
    const result = insertSavedComponent(skin, componente, { parentId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = idsOf(result.value);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('TEST-SKT-016 insertarlo dos veces no repite identificadores', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;
    const componente = saveComponent(barra, 'Cabecera', NOW);

    const una = insertSavedComponent(skin, componente, { parentId: null });
    if (!una.ok) return;
    const dos = insertSavedComponent(una.value, componente, { parentId: null });

    expect(dos.ok).toBe(true);
    if (!dos.ok) return;
    const ids = idsOf(dos.value);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it('TEST-SKT-017 usa el nombre con el que se guardó', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera de PDI', NOW);
    const result = insertSavedComponent(skin, componente, { parentId: null });
    if (!result.ok) return;

    expect(result.value.root.map((n) => n.name)).toContain('Cabecera de PDI');
  });

  it('TEST-SKT-018 un componente vacío no rompe la inserción', () => {
    const skin = skinConBarra();
    const vacio = emptySkin(`${COMPONENT_LIBRARY_PREFIX}Vacío`, NOW);

    const result = insertSavedComponent(skin, vacio, { parentId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.root).toHaveLength(1);
  });

  it('TEST-SKT-019 respeta las reglas de inserción del destino', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;
    const boton = barra.children[0];
    if (boton === undefined) return;

    const componente = saveComponent(barra, 'Cabecera', NOW);
    // Un botón no es contenedor: la inserción se rechaza igual que cualquier
    // otra, sin vía lateral por venir de la biblioteca.
    expect(insertSavedComponent(skin, componente, { parentId: boton.id }).ok).toBe(false);
  });
});

describe('realSkins y savedComponents', () => {
  it('TEST-SKT-020 separa las interfaces de los componentes guardados', () => {
    const skin = skinConBarra();
    const barra = skin.root[0];
    if (barra === undefined) return;

    const componente = saveComponent(barra, 'Cabecera', NOW);
    const todas = [skin, componente];

    expect(realSkins(todas).map((s) => s.name)).toEqual(['Interfaz']);
    expect(savedComponents(todas).map(savedComponentName)).toEqual(['Cabecera']);
  });

  it('TEST-SKT-021 una interfaz normal no se confunde con un componente', () => {
    expect(isSavedComponent(emptySkin('Mi interfaz', NOW))).toBe(false);
  });
});
