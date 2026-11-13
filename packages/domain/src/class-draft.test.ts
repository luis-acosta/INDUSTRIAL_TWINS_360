import { describe, expect, it } from 'vitest';
import {
  affectedAssets,
  canDeleteClass,
  canSaveClass,
  classDraftFrom,
  classDraftToClass,
  eligibleParentClasses,
  emptyClassDraft,
  inheritedAttributes,
  newAttribute,
  validateClassDraft,
  type ClassDraft,
} from './class-draft';
import type { Asset, AssetClass, AttributeDefinition } from './asset';
import { newUuid, type Tag, type Uuid } from './identity';

const NOW = '2026-04-01T09:00:00.000Z';
const PROJECT = newUuid();

function attribute(over: Partial<AttributeDefinition> = {}): AttributeDefinition {
  return {
    key: 'potencia',
    label: 'Potencia',
    type: 'quantity',
    unit: 'kW',
    required: false,
    options: [],
    group: 'Mecánica',
    order: 0,
    helpText: '',
    ...over,
  };
}

function assetClass(code: string, over: Partial<AssetClass> = {}): AssetClass {
  return {
    id: newUuid(),
    code,
    name: code,
    description: '',
    level: 'equipment',
    attributes: [],
    icon: 'equipment',
    parentClassId: null,
    ...over,
  };
}

function asset(tag: string, classId: Uuid, attributes: Asset['attributes'] = {}): Asset {
  return {
    id: newUuid(),
    projectId: PROJECT,
    tag: tag as unknown as Tag,
    name: tag,
    description: '',
    classId,
    level: 'equipment',
    parentId: null,
    attributes,
    revision: 1,
    status: 'published',
    criticality: null,
    manufacturer: '',
    model: '',
    serialNumber: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const draft = (over: Partial<ClassDraft> = {}): ClassDraft => ({
  ...emptyClassDraft(),
  code: 'PUMP_NEW',
  name: 'Bomba nueva',
  ...over,
});

const opts = (
  classes: readonly AssetClass[],
  assets: readonly Asset[] = [],
  previous: AssetClass | null = null,
) => ({ classes, assets, previous });

const fieldsOf = (problems: readonly { field: string }[]): readonly string[] =>
  problems.map((p) => p.field);

/* ------------------------------------------------------------------ *
 * Código, nombre, nivel
 * ------------------------------------------------------------------ */

describe('validateClassDraft — identificación', () => {
  it('TEST-CLS-001 acepta un borrador mínimo válido', () => {
    const problems = validateClassDraft(draft(), opts([]));
    expect(problems).toEqual([]);
    expect(canSaveClass(problems)).toBe(true);
  });

  it('TEST-CLS-002 exige el código y el nombre', () => {
    const problems = validateClassDraft(draft({ code: '', name: '  ' }), opts([]));
    expect(fieldsOf(problems)).toContain('code');
    expect(fieldsOf(problems)).toContain('name');
    expect(canSaveClass(problems)).toBe(false);
  });

  it('TEST-CLS-003 rechaza un código con minúsculas o espacios', () => {
    expect(fieldsOf(validateClassDraft(draft({ code: 'pump_new' }), opts([])))).toContain('code');
    expect(fieldsOf(validateClassDraft(draft({ code: 'PUMP NEW' }), opts([])))).toContain('code');
    expect(fieldsOf(validateClassDraft(draft({ code: '1PUMP' }), opts([])))).toContain('code');
  });

  it('TEST-CLS-004 rechaza un código ya usado y nombra a la clase que lo tiene', () => {
    const existente = assetClass('PUMP_NEW', { name: 'Bomba existente' });
    const problems = validateClassDraft(draft(), opts([existente]));
    expect(problems[0]?.message).toContain('Bomba existente');
  });

  it('TEST-CLS-005 al editar no se queja de su propio código', () => {
    const existente = assetClass('PUMP_NEW');
    const problems = validateClassDraft(classDraftFrom(existente), opts([existente]));
    expect(fieldsOf(problems)).not.toContain('code');
  });
});

/* ------------------------------------------------------------------ *
 * Herencia
 * ------------------------------------------------------------------ */

describe('validateClassDraft — herencia', () => {
  it('TEST-CLS-006 rechaza heredar de sí misma', () => {
    const existente = assetClass('PUMP_NEW');
    const problems = validateClassDraft(
      { ...classDraftFrom(existente), parentClassId: existente.id },
      opts([existente]),
    );
    expect(problems.some((p) => p.message.includes('de sí misma'))).toBe(true);
  });

  it('TEST-CLS-007 rechaza una clase padre que no existe', () => {
    const problems = validateClassDraft(draft({ parentClassId: newUuid() }), opts([]));
    expect(problems.some((p) => p.message.includes('ya no existe'))).toBe(true);
  });

  it('TEST-CLS-008 impide cerrar un ciclo de herencia', () => {
    const base = assetClass('BASE');
    const hija = assetClass('HIJA', { parentClassId: base.id });
    const nieta = assetClass('NIETA', { parentClassId: hija.id });

    const problems = validateClassDraft(
      { ...classDraftFrom(base), parentClassId: nieta.id },
      opts([base, hija, nieta]),
    );
    expect(problems.some((p) => p.message.includes('ciclo'))).toBe(true);
    expect(canSaveClass(problems)).toBe(false);
  });

  it('TEST-CLS-009 eligibleParentClasses excluye la propia descendencia', () => {
    const base = assetClass('BASE');
    const hija = assetClass('HIJA', { parentClassId: base.id });
    const otra = assetClass('OTRA');
    const todas = [base, hija, otra];

    const posibles = eligibleParentClasses(classDraftFrom(base), todas).map((c) => c.code);
    expect(posibles).toContain('OTRA');
    expect(posibles).not.toContain('BASE');
    expect(posibles).not.toContain('HIJA');
  });

  it('TEST-CLS-010 una clase nueva puede heredar de cualquiera', () => {
    const base = assetClass('BASE');
    expect(eligibleParentClasses(draft(), [base])).toHaveLength(1);
  });
});

describe('inheritedAttributes', () => {
  it('TEST-CLS-011 recorre la cadena y dice de qué clase viene cada atributo', () => {
    const abuela = assetClass('ABUELA', { attributes: [attribute({ key: 'peso', label: 'Peso' })] });
    const madre = assetClass('MADRE', {
      parentClassId: abuela.id,
      attributes: [attribute({ key: 'potencia' })],
    });

    const heredados = inheritedAttributes(
      draft({ parentClassId: madre.id }),
      [abuela, madre],
    );

    expect(heredados.map((h) => h.definition.key).sort()).toEqual(['peso', 'potencia']);
    expect(heredados.find((h) => h.definition.key === 'peso')?.fromCode).toBe('ABUELA');
  });

  it('TEST-CLS-012 la clase más cercana gana al redefinir una clave', () => {
    const abuela = assetClass('ABUELA', {
      attributes: [attribute({ key: 'potencia', label: 'Potencia base' })],
    });
    const madre = assetClass('MADRE', {
      parentClassId: abuela.id,
      attributes: [attribute({ key: 'potencia', label: 'Potencia de la madre' })],
    });

    const heredados = inheritedAttributes(draft({ parentClassId: madre.id }), [abuela, madre]);
    expect(heredados).toHaveLength(1);
    expect(heredados[0]?.definition.label).toBe('Potencia de la madre');
  });

  it('TEST-CLS-013 termina aunque la herencia tenga un ciclo', () => {
    // Un archivo editado a mano puede traer un ciclo; sin la guarda, abrir el
    // formulario colgaría la aplicación.
    const a = assetClass('A');
    const b = assetClass('B', { parentClassId: a.id });
    const ciclo = [{ ...a, parentClassId: b.id }, b];

    const heredados = inheritedAttributes(draft({ parentClassId: b.id }), ciclo);
    expect(Array.isArray(heredados)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Atributos
 * ------------------------------------------------------------------ */

describe('validateClassDraft — atributos', () => {
  it('TEST-CLS-014 exige clave y etiqueta en cada atributo', () => {
    const problems = validateClassDraft(
      draft({ attributes: [attribute({ key: '', label: '' })] }),
      opts([]),
    );
    expect(fieldsOf(problems)).toContain('attributes.0.key');
    expect(fieldsOf(problems)).toContain('attributes.0.label');
  });

  it('TEST-CLS-015 rechaza una clave con mayúsculas o guiones', () => {
    expect(
      fieldsOf(validateClassDraft(draft({ attributes: [attribute({ key: 'Potencia' })] }), opts([]))),
    ).toContain('attributes.0.key');
    expect(
      fieldsOf(
        validateClassDraft(draft({ attributes: [attribute({ key: 'potencia-max' })] }), opts([])),
      ),
    ).toContain('attributes.0.key');
  });

  it('TEST-CLS-016 rechaza dos atributos con la misma clave y dice dónde está el otro', () => {
    const problems = validateClassDraft(
      draft({ attributes: [attribute(), attribute({ label: 'Potencia bis' })] }),
      opts([]),
    );
    const dup = problems.find((p) => p.field === 'attributes.1.key');
    expect(dup?.message).toContain('posición 1');
    expect(canSaveClass(problems)).toBe(false);
  });

  it('TEST-CLS-017 una magnitud sin unidad no se guarda', () => {
    // El contrato prohíbe inferir unidades: una presión sin unidad es un dato
    // inservible, y adivinarla es peor que exigirla.
    const problems = validateClassDraft(
      draft({ attributes: [attribute({ type: 'quantity', unit: null })] }),
      opts([]),
    );
    const unidad = problems.find((p) => p.field === 'attributes.0.unit');
    expect(unidad?.severity).toBe('blocking');
    expect(unidad?.message).toContain('no se puede inferir');
  });

  it('TEST-CLS-018 un número sin unidad sí se guarda', () => {
    const problems = validateClassDraft(
      draft({ attributes: [attribute({ key: 'etapas', label: 'Etapas', type: 'number', unit: null })] }),
      opts([]),
    );
    expect(problems).toEqual([]);
  });

  it('TEST-CLS-019 una lista sin valores admitidos no se guarda', () => {
    const problems = validateClassDraft(
      draft({
        attributes: [attribute({ key: 'servicio', label: 'Servicio', type: 'enum', unit: null })],
      }),
      opts([]),
    );
    expect(fieldsOf(problems)).toContain('attributes.0.options');
  });

  it('TEST-CLS-020 avisa, sin bloquear, al redefinir un atributo heredado', () => {
    const base = assetClass('BASE', { attributes: [attribute({ key: 'potencia' })] });
    const problems = validateClassDraft(
      draft({ parentClassId: base.id, attributes: [attribute({ key: 'potencia' })] }),
      opts([base]),
    );
    const aviso = problems.find((p) => p.field === 'attributes.0.key');
    expect(aviso?.severity).toBe('advisory');
    expect(aviso?.message).toContain('BASE');
    expect(canSaveClass(problems)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Consecuencias sobre los activos existentes
 * ------------------------------------------------------------------ */

describe('affectedAssets', () => {
  it('TEST-CLS-021 cuenta también los activos de las clases que heredan', () => {
    // Cambiar un atributo de la clase base afecta a bombas y compresores;
    // contar sólo los directos daría un número tranquilizador y falso.
    const base = assetClass('BASE');
    const bomba = assetClass('BOMBA', { parentClassId: base.id });
    const compresor = assetClass('COMPRESOR', { parentClassId: base.id });
    const ajena = assetClass('AJENA');

    const assets = [
      asset('B-1', bomba.id),
      asset('C-1', compresor.id),
      asset('X-1', base.id),
      asset('A-1', ajena.id),
    ];

    const afectados = affectedAssets(base.id, [base, bomba, compresor, ajena], assets);
    expect(afectados.map((a) => a.tag).sort()).toEqual(['B-1', 'C-1', 'X-1']);
  });
});

describe('validateClassDraft — consecuencias', () => {
  it('TEST-CLS-022 avisa del número exacto de activos al quitar un atributo con datos', () => {
    const clase = assetClass('BOMBA', { attributes: [attribute({ key: 'potencia' })] });
    const assets = [
      asset('P-1', clase.id, { potencia: 75 }),
      asset('P-2', clase.id, { potencia: 90 }),
      asset('P-3', clase.id, {}),
    ];

    const problems = validateClassDraft(
      { ...classDraftFrom(clase), attributes: [] },
      opts([clase], assets, clase),
    );

    const aviso = problems.find((p) => p.field === 'attributes');
    expect(aviso?.severity).toBe('advisory');
    expect(aviso?.message).toContain('2 activo(s)');
    // Se puede guardar: impedirlo sería impedir corregir un error.
    expect(canSaveClass(problems)).toBe(true);
  });

  it('TEST-CLS-023 no avisa si el atributo quitado no tenía datos en ningún activo', () => {
    const clase = assetClass('BOMBA', { attributes: [attribute({ key: 'potencia' })] });
    const assets = [asset('P-1', clase.id, {})];

    const problems = validateClassDraft(
      { ...classDraftFrom(clase), attributes: [] },
      opts([clase], assets, clase),
    );
    expect(problems.filter((p) => p.field === 'attributes')).toEqual([]);
  });

  it('TEST-CLS-024 avisa de cuántos activos quedan incompletos al hacer obligatorio un atributo', () => {
    const clase = assetClass('BOMBA', { attributes: [attribute({ key: 'potencia' })] });
    const assets = [
      asset('P-1', clase.id, { potencia: 75 }),
      asset('P-2', clase.id, {}),
      asset('P-3', clase.id, { potencia: null }),
    ];

    const problems = validateClassDraft(
      { ...classDraftFrom(clase), attributes: [attribute({ key: 'potencia', required: true })] },
      opts([clase], assets, clase),
    );

    const aviso = problems.find((p) => p.field === 'attributes');
    expect(aviso?.message).toContain('2 activo(s)');
    expect(canSaveClass(problems)).toBe(true);
  });

  it('TEST-CLS-025 no repite el aviso si el atributo ya era obligatorio', () => {
    const clase = assetClass('BOMBA', {
      attributes: [attribute({ key: 'potencia', required: true })],
    });
    const assets = [asset('P-2', clase.id, {})];

    const problems = validateClassDraft(
      classDraftFrom(clase),
      opts([clase], assets, clase),
    );
    expect(problems.filter((p) => p.field === 'attributes')).toEqual([]);
  });

  it('TEST-CLS-026 avisa de que cambiar el nivel no mueve los activos existentes', () => {
    const clase = assetClass('BOMBA');
    const assets = [asset('P-1', clase.id)];

    const problems = validateClassDraft(
      { ...classDraftFrom(clase), level: 'component' },
      opts([clase], assets, clase),
    );
    const aviso = problems.find((p) => p.field === 'level');
    expect(aviso?.severity).toBe('advisory');
    expect(aviso?.message).toContain('1 activo(s)');
  });

  it('TEST-CLS-027 una clase nueva no genera avisos de consecuencias', () => {
    const otra = assetClass('OTRA');
    const assets = [asset('P-1', otra.id)];
    const problems = validateClassDraft(
      draft({ attributes: [attribute({ required: true })] }),
      opts([otra], assets, null),
    );
    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Borrado
 * ------------------------------------------------------------------ */

describe('canDeleteClass', () => {
  it('TEST-CLS-028 no deja borrar una clase en uso y dice cuántos activos la usan', () => {
    const clase = assetClass('BOMBA');
    const otra = assetClass('OTRA');
    const assets = [asset('P-1', clase.id), asset('P-2', clase.id)];

    const result = canDeleteClass(clase.id, [clase, otra], assets);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('2 activo(s)');
  });

  it('TEST-CLS-029 no deja borrar una clase de la que heredan otras', () => {
    const base = assetClass('BASE');
    const hija = assetClass('HIJA', { parentClassId: base.id });

    const result = canDeleteClass(base.id, [base, hija], []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('HIJA');
  });

  it('TEST-CLS-030 no deja quedarse sin ninguna clase', () => {
    const unica = assetClass('UNICA');
    const result = canDeleteClass(unica.id, [unica], []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('única clase');
  });

  it('TEST-CLS-031 deja borrar una clase libre', () => {
    const libre = assetClass('LIBRE');
    const otra = assetClass('OTRA');
    const assets = [asset('P-1', otra.id)];

    expect(canDeleteClass(libre.id, [libre, otra], assets).allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Conversión
 * ------------------------------------------------------------------ */

describe('classDraftToClass', () => {
  it('TEST-CLS-032 renumera el orden de los atributos según su posición', () => {
    const result = classDraftToClass(
      draft({
        attributes: [
          attribute({ key: 'a', label: 'A', order: 40 }),
          attribute({ key: 'b', label: 'B', order: 7 }),
          attribute({ key: 'c', label: 'C', order: 7 }),
        ],
      }),
      newUuid(),
    );
    expect(result.attributes.map((a) => a.order)).toEqual([0, 1, 2]);
    expect(result.attributes.map((a) => a.key)).toEqual(['a', 'b', 'c']);
  });

  it('TEST-CLS-033 recorta el código y el nombre y conserva el identificador al editar', () => {
    const existente = assetClass('BOMBA');
    const result = classDraftToClass(
      { ...classDraftFrom(existente), code: '  BOMBA_2  ', name: '  Bomba  ' },
      newUuid(),
    );
    expect(result.id).toBe(existente.id);
    expect(result.code).toBe('BOMBA_2');
    expect(result.name).toBe('Bomba');
  });

  it('TEST-CLS-034 el viaje clase → borrador → clase no pierde nada', () => {
    const original = assetClass('BOMBA', {
      description: 'Bombas centrífugas del circuito primario',
      level: 'equipment',
      icon: 'instrument',
      attributes: [attribute({ order: 0 }), attribute({ key: 'npsh', label: 'NPSH', order: 1 })],
    });
    expect(classDraftToClass(classDraftFrom(original), newUuid())).toEqual(original);
  });
});

describe('newAttribute', () => {
  it('TEST-CLS-035 nace como texto opcional en el grupo General', () => {
    const definition = newAttribute(3);
    expect(definition.type).toBe('text');
    expect(definition.required).toBe(false);
    expect(definition.group).toBe('General');
    expect(definition.order).toBe(3);
    expect(definition.unit).toBeNull();
  });
});
