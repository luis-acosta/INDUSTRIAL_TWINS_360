import { describe, expect, it } from 'vitest';
import {
  canSaveDraft,
  draftFromAsset,
  draftToAsset,
  eligibleParents,
  emptyDraft,
  problemsFor,
  validateAssetDraft,
  type AssetDraft,
} from './asset-draft';
import type { Asset, AssetClass } from './asset';
import { newUuid, type Tag, type Uuid } from './identity';

const NOW = '2026-03-01T08:00:00.000Z';
const PROJECT = newUuid();
const CLASS_PUMP = newUuid();
const CLASS_UNIT = newUuid();
const CLASS_BASE = newUuid();

const classes: readonly AssetClass[] = [
  {
    id: CLASS_BASE,
    code: 'BASE_ROTATING',
    name: 'Equipo rotativo',
    description: '',
    level: 'equipment',
    icon: 'equipment',
    parentClassId: null,
    attributes: [
      {
        key: 'potencia',
        label: 'Potencia',
        type: 'quantity',
        unit: 'kW',
        required: true,
        options: [],
        group: 'Mecánica',
        order: 0,
        helpText: '',
      },
    ],
  },
  {
    id: CLASS_PUMP,
    code: 'PUMP_CENTRIFUGAL',
    name: 'Bomba centrífuga',
    description: '',
    level: 'equipment',
    icon: 'equipment',
    parentClassId: CLASS_BASE,
    attributes: [
      {
        key: 'servicio',
        label: 'Servicio',
        type: 'enum',
        unit: null,
        required: false,
        options: ['principal', 'reserva'],
        group: 'Proceso',
        order: 1,
        helpText: '',
      },
    ],
  },
  {
    id: CLASS_UNIT,
    code: 'UNIT_PROCESS',
    name: 'Unidad de proceso',
    description: '',
    level: 'unit',
    icon: 'equipment',
    parentClassId: null,
    attributes: [],
  },
];

function asset(
  tag: string,
  level: Asset['level'],
  parentId: Uuid | null,
  overrides: Partial<Asset> = {},
): Asset {
  return {
    id: newUuid(),
    projectId: PROJECT,
    tag: tag as unknown as Tag,
    name: tag,
    description: '',
    classId: level === 'unit' ? CLASS_UNIT : CLASS_PUMP,
    level,
    parentId,
    attributes: { potencia: 75 },
    revision: 1,
    status: 'published',
    criticality: null,
    manufacturer: 'ACME',
    model: '',
    serialNumber: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Jerarquía de prueba: planta → unidad → bomba. */
function hierarchy(): { plant: Asset; unit: Asset; pump: Asset; all: readonly Asset[] } {
  const plant = asset('PL-1', 'plant', null, { classId: CLASS_UNIT });
  const unit = asset('U-200', 'unit', plant.id);
  const pump = asset('P-101', 'equipment', unit.id);
  return { plant, unit, pump, all: [plant, unit, pump] };
}

const validDraft = (over: Partial<AssetDraft> = {}): AssetDraft => ({
  ...emptyDraft({ level: 'equipment', parentId: null, classId: CLASS_PUMP }),
  tag: 'P-999',
  name: 'Bomba nueva',
  manufacturer: 'ACME',
  attributes: { potencia: 50 },
  ...over,
});

const opts = (assets: readonly Asset[], scope: 'project' | 'unit' | 'none' = 'project') => ({
  assets,
  classes,
  uniquenessScope: scope,
});

/* ------------------------------------------------------------------ *
 * TAG
 * ------------------------------------------------------------------ */

describe('validateAssetDraft — TAG', () => {
  it('TEST-DRF-001 acepta un borrador completo', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(validDraft({ parentId: unit.id }), opts(all));
    expect(problems).toEqual([]);
    expect(canSaveDraft(problems)).toBe(true);
  });

  it('TEST-DRF-002 bloquea el TAG vacío', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(validDraft({ tag: '', parentId: unit.id }), opts(all));
    expect(problemsFor(problems, 'tag')).toHaveLength(1);
    expect(canSaveDraft(problems)).toBe(false);
  });

  it('TEST-DRF-003 bloquea el TAG con caracteres no admitidos', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ tag: 'P 101 (bomba)', parentId: unit.id }),
      opts(all),
    );
    expect(problemsFor(problems, 'tag')).toHaveLength(1);
  });

  it('TEST-DRF-004 bloquea el TAG repetido y nombra al activo que lo tiene', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ tag: 'P-101', parentId: unit.id }),
      opts(all),
    );
    const tagProblems = problemsFor(problems, 'tag');
    expect(tagProblems).toHaveLength(1);
    expect(tagProblems[0]?.message).toContain('P-101');
  });

  it('TEST-DRF-005 no se queja del TAG propio al editar', () => {
    const { pump, all } = hierarchy();
    const draft = { ...draftFromAsset(pump), name: 'Bomba renombrada' };
    const problems = validateAssetDraft(draft, opts(all));
    expect(problemsFor(problems, 'tag')).toEqual([]);
  });

  it('TEST-DRF-006 con alcance «ninguno» admite el TAG repetido', () => {
    // El cliente que elige no exigir unicidad lo hace a conciencia, y la
    // aplicación no debe discutírselo.
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ tag: 'P-101', parentId: unit.id }),
      opts(all, 'none'),
    );
    expect(problemsFor(problems, 'tag')).toEqual([]);
  });

  it('TEST-DRF-007 con alcance «unidad» el mismo TAG convive en unidades distintas', () => {
    const plant = asset('PL-1', 'plant', null, { classId: CLASS_UNIT });
    const u1 = asset('U-100', 'unit', plant.id);
    const u2 = asset('U-200', 'unit', plant.id);
    const p1 = asset('P-101', 'equipment', u1.id);

    const enOtraUnidad = validateAssetDraft(
      validDraft({ tag: 'P-101', parentId: u2.id }),
      opts([plant, u1, u2, p1], 'unit'),
    );
    expect(problemsFor(enOtraUnidad, 'tag')).toEqual([]);

    const enLaMisma = validateAssetDraft(
      validDraft({ tag: 'P-101', parentId: u1.id }),
      opts([plant, u1, u2, p1], 'unit'),
    );
    expect(problemsFor(enLaMisma, 'tag')).toHaveLength(1);
  });

  it('TEST-DRF-008 cambiar de padre puede invalidar un TAG que era válido', () => {
    // Es el caso que obliga a calcular el alcance desde el padre del
    // formulario y no desde el activo guardado.
    const plant = asset('PL-1', 'plant', null, { classId: CLASS_UNIT });
    const u1 = asset('U-100', 'unit', plant.id);
    const u2 = asset('U-200', 'unit', plant.id);
    const original = asset('P-101', 'equipment', u1.id);
    const mudanza = asset('P-101', 'equipment', u2.id);
    const all = [plant, u1, u2, original, mudanza];

    const quieto = validateAssetDraft(draftFromAsset(mudanza), opts(all, 'unit'));
    expect(problemsFor(quieto, 'tag')).toEqual([]);

    const movido = validateAssetDraft(
      { ...draftFromAsset(mudanza), parentId: u1.id },
      opts(all, 'unit'),
    );
    expect(problemsFor(movido, 'tag')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Jerarquía
 * ------------------------------------------------------------------ */

describe('validateAssetDraft — jerarquía', () => {
  it('TEST-DRF-009 exige un elemento superior salvo en nivel planta', () => {
    const { all } = hierarchy();
    const sinPadre = validateAssetDraft(validDraft({ parentId: null }), opts(all));
    expect(problemsFor(sinPadre, 'parentId')).toHaveLength(1);

    const planta = validateAssetDraft(
      validDraft({ level: 'plant', parentId: null, classId: CLASS_UNIT, attributes: {} }),
      opts(all),
    );
    expect(problemsFor(planta, 'parentId')).toEqual([]);
  });

  it('TEST-DRF-010 rechaza que una planta cuelgue de algo', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ level: 'plant', parentId: unit.id, classId: CLASS_UNIT, attributes: {} }),
      opts(all),
    );
    expect(problemsFor(problems, 'parentId')[0]?.message).toContain('raíz');
  });

  it('TEST-DRF-011 rechaza colgar de un nivel igual o inferior', () => {
    const { pump, all } = hierarchy();
    const problems = validateAssetDraft(validDraft({ parentId: pump.id }), opts(all));
    expect(problemsFor(problems, 'parentId')[0]?.message).toContain('no puede colgar');
  });

  it('TEST-DRF-012 rechaza el padre que ya no existe', () => {
    const { all } = hierarchy();
    const problems = validateAssetDraft(validDraft({ parentId: newUuid() }), opts(all));
    expect(problemsFor(problems, 'parentId')[0]?.message).toContain('ya no existe');
  });

  it('TEST-DRF-013 impide cerrar un ciclo eligiendo a un descendiente', () => {
    // Para llegar a esta comprobación hace falta un descendiente de nivel
    // superior, que sólo existe si la jerarquía ya venía corrupta —de una
    // importación o de una edición a mano del archivo—. Es justo el proyecto
    // en el que el autor va a intentar arreglar la jerarquía, así que el
    // formulario tiene que resistirlo en lugar de colgarse.
    const plant = asset('PL-1', 'plant', null, { classId: CLASS_UNIT });
    const equipo = asset('E-1', 'equipment', plant.id);
    // Área colgando de un equipo: inversión imposible, presente en el archivo.
    const areaCorrupta = asset('A-1', 'equipment', equipo.id, { level: 'area' });
    const all = [plant, equipo, areaCorrupta];

    // El nivel deja pasar (área está por encima de equipo), y lo único que lo
    // rechaza es la detección del ciclo.
    const problems = validateAssetDraft(
      { ...draftFromAsset(equipo), parentId: areaCorrupta.id },
      opts(all),
    );

    const parentProblems = problemsFor(problems, 'parentId');
    expect(parentProblems).toHaveLength(1);
    expect(parentProblems[0]?.message).toContain('ciclo');
  });

  it('TEST-DRF-013b la validación termina aunque la jerarquía tenga un ciclo', () => {
    // Dos activos que se apuntan mutuamente. Sin las guardas de recorrido,
    // calcular el alcance del TAG daría un bucle infinito y el formulario se
    // quedaría colgado mientras el autor escribe.
    const a = asset('A-1', 'area', null);
    const b = asset('B-1', 'equipment', a.id);
    const ciclo = [{ ...a, parentId: b.id }, b];

    const problems = validateAssetDraft(
      { ...draftFromAsset(b), tag: 'NUEVO-1' },
      opts(ciclo, 'unit'),
    );
    expect(Array.isArray(problems)).toBe(true);
  });
});

describe('eligibleParents', () => {
  it('TEST-DRF-014 una planta no tiene padres posibles', () => {
    const { all } = hierarchy();
    expect(eligibleParents(validDraft({ level: 'plant' }), all)).toEqual([]);
  });

  it('TEST-DRF-015 ofrece sólo niveles estrictamente superiores', () => {
    const { plant, unit, all } = hierarchy();
    const posibles = eligibleParents(validDraft({ level: 'equipment' }), all);
    const ids = posibles.map((a) => a.id);
    expect(ids).toContain(plant.id);
    expect(ids).toContain(unit.id);
    expect(posibles.every((a) => a.level !== 'equipment')).toBe(true);
  });

  it('TEST-DRF-016 no ofrece el propio activo ni su descendencia', () => {
    const plant = asset('PL-1', 'plant', null, { classId: CLASS_UNIT });
    const unit = asset('U-200', 'unit', plant.id);
    const sub = asset('U-201', 'unit', unit.id, { level: 'area' });
    const all = [plant, unit, sub];

    const posibles = eligibleParents({ ...draftFromAsset(unit), level: 'unit' }, all);
    const ids = posibles.map((a) => a.id);
    expect(ids).not.toContain(unit.id);
    expect(ids).not.toContain(sub.id);
    expect(ids).toContain(plant.id);
  });
});

/* ------------------------------------------------------------------ *
 * Clase y ficha técnica
 * ------------------------------------------------------------------ */

describe('validateAssetDraft — clase y atributos', () => {
  it('TEST-DRF-017 bloquea la clase inexistente', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, classId: newUuid() }),
      opts(all),
    );
    expect(problemsFor(problems, 'classId')[0]?.severity).toBe('blocking');
  });

  it('TEST-DRF-018 exige los atributos obligatorios heredados de la clase padre', () => {
    // «potencia» la define BASE_ROTATING y la hereda PUMP_CENTRIFUGAL: si la
    // herencia no se resolviera, el obligatorio pasaría desapercibido.
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, attributes: {} }),
      opts(all),
    );
    const falta = problemsFor(problems, 'attributes.potencia');
    expect(falta).toHaveLength(1);
    expect(falta[0]?.message).toContain('Potencia');
    expect(canSaveDraft(problems)).toBe(false);
  });

  it('TEST-DRF-019 bloquea un valor del tipo equivocado', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, attributes: { potencia: 'bastante' } }),
      opts(all),
    );
    expect(problemsFor(problems, 'attributes.potencia')).toHaveLength(1);
  });

  it('TEST-DRF-020 bloquea un valor fuera de la lista de un enumerado', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, attributes: { potencia: 50, servicio: 'auxiliar' } }),
      opts(all),
    );
    expect(problemsFor(problems, 'attributes.servicio')).toHaveLength(1);
  });

  it('TEST-DRF-021 un atributo opcional vacío no bloquea', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, attributes: { potencia: 50 } }),
      opts(all),
    );
    expect(problemsFor(problems, 'attributes.servicio')).toEqual([]);
    expect(canSaveDraft(problems)).toBe(true);
  });

  it('TEST-DRF-022 avisa, sin bloquear, si la clase es de otro nivel', () => {
    const { plant, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ level: 'unit', parentId: plant.id, classId: CLASS_PUMP }),
      opts(all),
    );
    const aviso = problemsFor(problems, 'classId');
    expect(aviso).toHaveLength(1);
    expect(aviso[0]?.severity).toBe('advisory');
    expect(canSaveDraft(problems)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Avisos
 * ------------------------------------------------------------------ */

describe('validateAssetDraft — avisos', () => {
  it('TEST-DRF-023 un publicado sin fabricante avisa pero se puede guardar', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, status: 'published', manufacturer: '' }),
      opts(all),
    );
    const aviso = problemsFor(problems, 'manufacturer');
    expect(aviso).toHaveLength(1);
    expect(aviso[0]?.severity).toBe('advisory');
    expect(canSaveDraft(problems)).toBe(true);
  });

  it('TEST-DRF-024 un borrador sin fabricante no genera ni aviso', () => {
    const { unit, all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ parentId: unit.id, status: 'draft', manufacturer: '' }),
      opts(all),
    );
    expect(problemsFor(problems, 'manufacturer')).toEqual([]);
  });

  it('TEST-DRF-025 bloquea el nombre vacío o en blanco', () => {
    const { unit, all } = hierarchy();
    expect(
      problemsFor(validateAssetDraft(validDraft({ name: '', parentId: unit.id }), opts(all)), 'name'),
    ).toHaveLength(1);
    expect(
      problemsFor(
        validateAssetDraft(validDraft({ name: '   ', parentId: unit.id }), opts(all)),
        'name',
      ),
    ).toHaveLength(1);
  });

  it('TEST-DRF-026 devuelve todos los problemas, no sólo el primero', () => {
    const { all } = hierarchy();
    const problems = validateAssetDraft(
      validDraft({ tag: '', name: '', parentId: null, attributes: {} }),
      opts(all),
    );
    const campos = new Set(problems.map((p) => p.field));
    expect(campos.has('tag')).toBe(true);
    expect(campos.has('name')).toBe(true);
    expect(campos.has('parentId')).toBe(true);
    expect(campos.has('attributes.potencia')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Conversión
 * ------------------------------------------------------------------ */

describe('draftToAsset', () => {
  it('TEST-DRF-027 crea un activo con revisión 1 y fechas nuevas', () => {
    const { unit } = hierarchy();
    const id = newUuid();
    const built = draftToAsset(validDraft({ parentId: unit.id }), {
      projectId: PROJECT,
      previous: null,
      now: NOW,
      newId: id,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = built.value;

    expect(result.id).toBe(id);
    expect(result.revision).toBe(1);
    expect(result.createdAt).toBe(NOW);
    expect(result.updatedAt).toBe(NOW);
    expect(result.tag).toBe('P-999');
  });

  it('TEST-DRF-028 al editar sube la revisión y conserva la fecha de alta', () => {
    const pump = asset('P-101', 'equipment', null, {
      revision: 7,
      createdAt: '2024-05-05T00:00:00.000Z',
    });

    const built = draftToAsset(
      { ...draftFromAsset(pump), name: 'Bomba revisada' },
      { projectId: PROJECT, previous: pump, now: NOW, newId: newUuid() },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = built.value;

    expect(result.id).toBe(pump.id);
    expect(result.revision).toBe(8);
    expect(result.createdAt).toBe('2024-05-05T00:00:00.000Z');
    expect(result.updatedAt).toBe(NOW);
    expect(result.name).toBe('Bomba revisada');
  });

  it('TEST-DRF-029 normaliza el TAG y recorta los espacios del nombre', () => {
    const { unit } = hierarchy();
    const built = draftToAsset(
      validDraft({ tag: '  p-999/a  ', name: '  Bomba  ', parentId: unit.id }),
      { projectId: PROJECT, previous: null, now: NOW, newId: newUuid() },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.tag).toBe('P-999/A');
    expect(built.value.name).toBe('Bomba');
  });

  it('TEST-DRF-030 el viaje activo → borrador → activo no pierde nada', () => {
    const pump = asset('P-101', 'equipment', null, {
      description: 'Circuito primario',
      criticality: 'high',
      model: 'CX-9',
      serialNumber: 'SN-7',
      attributes: { potencia: 90, servicio: 'principal' },
    });

    const built = draftToAsset(draftFromAsset(pump), {
      projectId: PROJECT,
      previous: pump,
      now: NOW,
      newId: newUuid(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value).toEqual({ ...pump, revision: pump.revision + 1, updatedAt: NOW });
  });

  it('TEST-DRF-032 se niega a construir un activo con un TAG inválido', () => {
    // Antes devolvía el activo con el TAG del anterior, o con uno roto si era
    // nuevo. Escribir un TAG que el dominio rechaza deja un archivo que no
    // vuelve a validar al abrirlo, y un equipo que la búsqueda no encuentra.
    const { unit } = hierarchy();
    const built = draftToAsset(validDraft({ tag: 'P 101 (bomba)', parentId: unit.id }), {
      projectId: PROJECT,
      previous: null,
      now: NOW,
      newId: newUuid(),
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('VALIDATION_FAILED');
  });

  it('TEST-DRF-033 tampoco lo construye reusando el TAG del activo anterior', () => {
    const pump = asset('P-101', 'equipment', null);
    const built = draftToAsset(
      { ...draftFromAsset(pump), tag: '///' },
      { projectId: PROJECT, previous: pump, now: NOW, newId: newUuid() },
    );
    expect(built.ok).toBe(false);
  });
});

describe('emptyDraft', () => {
  it('TEST-DRF-031 arranca en borrador, sin TAG y con el padre indicado', () => {
    const parent = newUuid();
    const draft = emptyDraft({ level: 'equipment', parentId: parent, classId: CLASS_PUMP });

    expect(draft.id).toBeNull();
    expect(draft.tag).toBe('');
    expect(draft.status).toBe('draft');
    expect(draft.parentId).toBe(parent);
    expect(draft.attributes).toEqual({});
  });
});
