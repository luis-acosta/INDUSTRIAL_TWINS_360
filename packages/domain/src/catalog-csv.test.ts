import { describe, expect, it } from 'vitest';
import {
  applyImport,
  describeImportPlan,
  detectSeparator,
  exportCatalogCsv,
  mapColumns,
  parseCriticality,
  parseCsvLine,
  parseLevel,
  planImport,
} from './catalog-csv';
import type { Asset, AssetClass } from './asset';
import { newUuid, type Tag, type Uuid } from './identity';

const NOW = '2026-02-01T10:00:00.000Z';
const PROJECT = newUuid();
const CLASS_PUMP = newUuid();
const CLASS_GENERIC = newUuid();

const classes: readonly AssetClass[] = [
  {
    id: CLASS_PUMP,
    code: 'PUMP_CENTRIFUGAL',
    name: 'Bomba centrífuga',
    description: '',
    level: 'equipment',
    attributes: [],
    icon: 'equipment',
    parentClassId: null,
  },
  {
    id: CLASS_GENERIC,
    code: 'GENERIC',
    name: 'Activo genérico',
    description: '',
    level: 'equipment',
    attributes: [],
    icon: 'equipment',
    parentClassId: null,
  },
];

function asset(tag: string, level: Asset['level'], parentId: Uuid | null): Asset {
  return {
    id: newUuid(),
    projectId: PROJECT,
    tag: tag as unknown as Tag,
    name: tag,
    description: '',
    classId: CLASS_GENERIC,
    level,
    parentId,
    attributes: {},
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

const applyOptions = (existing: readonly Asset[]) => ({
  projectId: PROJECT,
  existingAssets: existing,
  classes,
  now: NOW,
  fallbackClassId: CLASS_GENERIC,
});

/* ------------------------------------------------------------------ *
 * Lectura de CSV
 * ------------------------------------------------------------------ */

describe('parseCsvLine', () => {
  it('TEST-CSV-001 separa campos simples', () => {
    expect(parseCsvLine('P-101,Bomba,equipo')).toEqual(['P-101', 'Bomba', 'equipo']);
  });

  it('TEST-CSV-002 respeta las comillas con separador dentro', () => {
    expect(parseCsvLine('P-101,"Bomba, principal",equipo')).toEqual([
      'P-101',
      'Bomba, principal',
      'equipo',
    ]);
  });

  it('TEST-CSV-003 interpreta la comilla doble como comilla literal', () => {
    expect(parseCsvLine('P-101,"Bomba ""A""",equipo')).toEqual(['P-101', 'Bomba "A"', 'equipo']);
  });

  it('TEST-CSV-004 conserva los campos vacíos para no desplazar las columnas', () => {
    // Si un campo vacío se descartara, el modelo del activo acabaría en la
    // columna del fabricante y la importación sería silenciosamente errónea.
    expect(parseCsvLine('P-101,,equipo,')).toEqual(['P-101', '', 'equipo', '']);
  });

  it('TEST-CSV-005 admite punto y coma', () => {
    expect(parseCsvLine('P-101;Bomba;equipo', ';')).toEqual(['P-101', 'Bomba', 'equipo']);
  });
});

describe('detectSeparator', () => {
  it('TEST-CSV-006 detecta el punto y coma de Excel en español', () => {
    expect(detectSeparator('TAG;Nombre;Nivel;TAG padre')).toBe(';');
  });

  it('TEST-CSV-007 detecta la coma', () => {
    expect(detectSeparator('TAG,Nombre,Nivel')).toBe(',');
  });

  it('TEST-CSV-008 detecta el tabulador', () => {
    expect(detectSeparator('TAG\tNombre\tNivel')).toBe('\t');
  });
});

describe('mapColumns', () => {
  it('TEST-CSV-009 reconoce los nombres en español con acentos', () => {
    const { columns } = mapColumns(['TAG', 'Descripción', 'Nivel', 'TAG padre']);
    expect(columns.tag).toBe(0);
    expect(columns.name).toBe(1);
    expect(columns.level).toBe(2);
    expect(columns.parentTag).toBe(3);
  });

  it('TEST-CSV-010 reconoce los nombres en inglés', () => {
    const { columns } = mapColumns(['Tag', 'Name', 'Level', 'Parent Tag']);
    expect(columns.name).toBe(1);
    expect(columns.parentTag).toBe(3);
  });

  it('TEST-CSV-011 informa de las columnas que no usa', () => {
    const { unknown } = mapColumns(['TAG', 'Nombre', 'Nivel', 'Centro de coste']);
    expect(unknown).toEqual(['Centro de coste']);
  });

  it('TEST-CSV-012 ante dos columnas con el mismo significado se queda con la primera', () => {
    const { columns } = mapColumns(['TAG', 'Nombre', 'Descripción', 'Nivel']);
    expect(columns.name).toBe(1);
  });
});

describe('parseLevel y parseCriticality', () => {
  it('TEST-CSV-013 traduce los niveles en español', () => {
    expect(parseLevel('planta')).toBe('plant');
    expect(parseLevel('Unidad')).toBe('unit');
    expect(parseLevel('ÁREA')).toBe('area');
    expect(parseLevel('equipo')).toBe('equipment');
    expect(parseLevel('instrumento')).toBe('component');
  });

  it('TEST-CSV-014 devuelve null para un nivel desconocido en lugar de suponerlo', () => {
    expect(parseLevel('subsistema')).toBeNull();
    expect(parseLevel('')).toBeNull();
  });

  it('TEST-CSV-015 traduce la criticidad y no inventa valores', () => {
    expect(parseCriticality('alta')).toBe('high');
    expect(parseCriticality('CRÍTICA')).toBe('critical');
    expect(parseCriticality('urgentísima')).toBeNull();
    expect(parseCriticality('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Plan de importación
 * ------------------------------------------------------------------ */

describe('planImport', () => {
  it('TEST-CSV-016 planifica una jerarquía completa en un archivo', () => {
    const csv = [
      'TAG;Nombre;Nivel;TAG padre;Clase',
      'PL-1;Planta Norte;planta;;',
      'U-200;Unidad de bombeo;unidad;PL-1;',
      'P-101;Bomba principal;equipo;U-200;PUMP_CENTRIFUGAL',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.separator).toBe(';');
    expect(plan.toCreate).toHaveLength(3);
    expect(plan.rejected).toEqual([]);
    expect(plan.applicable).toBe(true);
  });

  it('TEST-CSV-017 acepta el hijo antes que el padre en el mismo archivo', () => {
    // Una hoja ordenada por TAG trae P-101 antes que U-200. Rechazar al hijo
    // por no haber leído aún al padre haría inservible el orden natural.
    const csv = [
      'TAG;Nombre;Nivel;TAG padre',
      'P-101;Bomba;equipo;U-200',
      'U-200;Unidad;unidad;PL-1',
      'PL-1;Planta;planta;',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.rejected).toEqual([]);
    expect(plan.toCreate).toHaveLength(3);
  });

  it('TEST-CSV-018 rechaza la fila cuyo padre no existe en ningún sitio', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P-101;Bomba;equipo;U-999'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });

    expect(plan.toCreate).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.message).toContain('U-999');
    expect(plan.applicable).toBe(false);
  });

  it('TEST-CSV-019 resuelve el padre contra un activo que ya está en el proyecto', () => {
    const unit = asset('U-200', 'unit', null);
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P-101;Bomba;equipo;U-200'].join('\n');

    const plan = planImport(csv, { existingAssets: [unit], classes });
    expect(plan.rejected).toEqual([]);
    expect(plan.toCreate).toHaveLength(1);
  });

  it('TEST-CSV-020 una fila inválida no cancela las demás', () => {
    const csv = [
      'TAG;Nombre;Nivel;TAG padre',
      'PL-1;Planta;planta;',
      'P-102;Bomba B;subsistema;PL-1',
      'P-103;Bomba C;equipo;PL-1',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.toCreate.map((row) => row.tag)).toEqual(['PL-1', 'P-103']);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.line).toBe(3);
  });

  it('TEST-CSV-021 rechaza el TAG repetido dentro del archivo señalando la línea previa', () => {
    const csv = [
      'TAG;Nombre;Nivel;TAG padre',
      'PL-1;Planta;planta;',
      'P-101;Bomba A;equipo;PL-1',
      'P-101;Bomba A bis;equipo;PL-1',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.line).toBe(4);
    expect(plan.rejected[0]?.message).toContain('línea 3');
  });

  it('TEST-CSV-022 rechaza el TAG que ya existe salvo que se pida actualizar', () => {
    const existing = asset('P-101', 'equipment', null);
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P-101;Bomba renombrada;equipo;'].join('\n');

    const sin = planImport(csv, { existingAssets: [existing], classes });
    expect(sin.rejected).toHaveLength(1);
    expect(sin.toUpdate).toEqual([]);

    const con = planImport(csv, { existingAssets: [existing], classes, updateExisting: true });
    expect(con.rejected).toEqual([]);
    expect(con.toUpdate).toHaveLength(1);
    expect(con.toUpdate[0]?.existingId).toBe(existing.id);
  });

  it('TEST-CSV-023 rechaza un TAG con caracteres no admitidos', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P 101 (bomba);Bomba;equipo;'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.rejected).toHaveLength(1);
    expect(plan.toCreate).toEqual([]);
  });

  it('TEST-CSV-024 exige el padre salvo en el nivel planta', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'U-200;Unidad;unidad;'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.rejected[0]?.message).toContain('necesita el TAG de su padre');
  });

  it('TEST-CSV-025 avisa del padre declarado en una planta pero no la rechaza', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'PL-1;Planta;planta;ALGO'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.parentTag).toBeNull();
    expect(plan.warnings.some((w) => w.includes('no tiene padre'))).toBe(true);
  });

  it('TEST-CSV-026 rechaza la fila sin nombre', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'PL-1;;planta;'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.rejected[0]?.message).toContain('Falta el nombre');
  });

  it('TEST-CSV-027 falla con un informe claro si faltan columnas obligatorias', () => {
    const csv = ['Codigo;Fabricante', 'P-101;ACME'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });

    expect(plan.applicable).toBe(false);
    expect(plan.warnings.join(' ')).toContain('nombre');
    expect(plan.warnings.join(' ')).toContain('nivel');
  });

  it('TEST-CSV-028 trata el archivo vacío como no aplicable sin lanzar', () => {
    const plan = planImport('', { existingAssets: [], classes });
    expect(plan.applicable).toBe(false);
    expect(plan.warnings[0]).toContain('vacío');
  });

  it('TEST-CSV-029 avisa de la clase inexistente sin rechazar el activo', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre;Clase', 'PL-1;Planta;planta;;NO_EXISTE'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });

    expect(plan.toCreate).toHaveLength(1);
    expect(plan.warnings.some((w) => w.includes('NO_EXISTE'))).toBe(true);
  });

  it('TEST-CSV-030 avisa de la criticidad no reconocida y la deja sin declarar', () => {
    const csv = [
      'TAG;Nombre;Nivel;TAG padre;Criticidad',
      'PL-1;Planta;planta;;importantísima',
    ].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });

    expect(plan.toCreate[0]?.criticality).toBeNull();
    expect(plan.warnings.some((w) => w.includes('criticidad no reconocida'))).toBe(true);
  });

  it('TEST-CSV-031 normaliza el TAG en minúsculas y lo casa con el existente', () => {
    const existing = asset('P-101', 'equipment', null);
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'p-101;Bomba;equipo;'].join('\n');

    const plan = planImport(csv, { existingAssets: [existing], classes, updateExisting: true });
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]?.tag).toBe('P-101');
  });

  it('TEST-CSV-032 ignora las líneas en blanco del final del archivo', () => {
    const csv = 'TAG;Nombre;Nivel;TAG padre\r\nPL-1;Planta;planta;\r\n\r\n';
    const plan = planImport(csv, { existingAssets: [], classes });
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.rejected).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Aplicación
 * ------------------------------------------------------------------ */

describe('applyImport', () => {
  it('TEST-CSV-033 crea la jerarquía con los padres resueltos', () => {
    const csv = [
      'TAG;Nombre;Nivel;TAG padre;Clase',
      'P-101;Bomba;equipo;U-200;PUMP_CENTRIFUGAL',
      'U-200;Unidad;unidad;PL-1;',
      'PL-1;Planta;planta;;',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [], classes });
    const { assets, created, updated } = applyImport(plan, applyOptions([]));

    expect(created).toBe(3);
    expect(updated).toBe(0);

    const byTag = new Map(assets.map((a) => [a.tag as string, a]));
    const plant = byTag.get('PL-1');
    const unit = byTag.get('U-200');
    const pump = byTag.get('P-101');

    expect(plant?.parentId).toBeNull();
    expect(unit?.parentId).toBe(plant?.id);
    expect(pump?.parentId).toBe(unit?.id);
    expect(pump?.classId).toBe(CLASS_PUMP);
  });

  it('TEST-CSV-034 asigna la clase de reserva cuando la fila no declara una válida', () => {
    const csv = ['TAG;Nombre;Nivel;TAG padre;Clase', 'PL-1;Planta;planta;;NO_EXISTE'].join('\n');
    const plan = planImport(csv, { existingAssets: [], classes });
    const { assets } = applyImport(plan, applyOptions([]));
    expect(assets[0]?.classId).toBe(CLASS_GENERIC);
  });

  it('TEST-CSV-035 al actualizar conserva los atributos y sube la revisión', () => {
    const existing: Asset = {
      ...asset('P-101', 'equipment', null),
      attributes: { caudal: 120, fabricanteAlternativo: 'ACME' },
      revision: 4,
      status: 'published',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P-101;Bomba principal;equipo;'].join('\n');
    const plan = planImport(csv, { existingAssets: [existing], classes, updateExisting: true });
    const { assets, created, updated } = applyImport(plan, applyOptions([existing]));

    expect(created).toBe(0);
    expect(updated).toBe(1);

    const updatedAsset = assets.find((a) => a.id === existing.id);
    expect(updatedAsset?.name).toBe('Bomba principal');
    expect(updatedAsset?.revision).toBe(5);
    expect(updatedAsset?.attributes).toEqual(existing.attributes);
    expect(updatedAsset?.status).toBe('published');
    expect(updatedAsset?.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(updatedAsset?.updatedAt).toBe(NOW);
  });

  it('TEST-CSV-036 no borra un dato existente con una celda vacía', () => {
    // Una hoja parcial —sólo TAG, nombre y nivel— no debe vaciar el fabricante
    // que ya estaba en la ficha: el silencio no es una orden de borrado.
    const existing: Asset = {
      ...asset('P-101', 'equipment', null),
      manufacturer: 'ACME',
      model: 'CX-9',
      serialNumber: 'SN-7',
      description: 'Bomba del circuito primario',
    };

    const csv = ['TAG;Nombre;Nivel;TAG padre;Fabricante', 'P-101;Bomba;equipo;;'].join('\n');
    const plan = planImport(csv, { existingAssets: [existing], classes, updateExisting: true });
    const { assets } = applyImport(plan, applyOptions([existing]));

    const result = assets.find((a) => a.id === existing.id);
    expect(result?.manufacturer).toBe('ACME');
    expect(result?.model).toBe('CX-9');
    expect(result?.serialNumber).toBe('SN-7');
    expect(result?.description).toBe('Bomba del circuito primario');
  });

  it('TEST-CSV-036b una hoja parcial sin columna de jerarquía no desvincula el activo', () => {
    // El cliente devuelve una hoja con TAG y nombre para corregir la
    // nomenclatura. Si eso dejara el equipo sin padre, la corrección
    // destruiría el árbol de la planta.
    const unit = asset('U-200', 'unit', null);
    const pump: Asset = { ...asset('P-101', 'equipment', null), parentId: unit.id };

    const csv = ['TAG;Nombre;Nivel', 'P-101;Bomba de alimentación;equipo'].join('\n');
    const plan = planImport(csv, {
      existingAssets: [unit, pump],
      classes,
      updateExisting: true,
    });

    expect(plan.rejected).toEqual([]);
    expect(plan.toUpdate).toHaveLength(1);

    const { assets } = applyImport(plan, applyOptions([unit, pump]));
    const result = assets.find((a) => a.id === pump.id);
    expect(result?.name).toBe('Bomba de alimentación');
    expect(result?.parentId).toBe(unit.id);
  });

  it('TEST-CSV-037 conserva los activos del proyecto que el archivo no menciona', () => {
    const otro = asset('T-500', 'equipment', null);
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'PL-1;Planta;planta;'].join('\n');

    const plan = planImport(csv, { existingAssets: [otro], classes });
    const { assets } = applyImport(plan, applyOptions([otro]));

    expect(assets).toHaveLength(2);
    expect(assets.some((a) => a.id === otro.id)).toBe(true);
  });

  it('TEST-CSV-038 cuelga un activo nuevo de un padre que ya estaba en el proyecto', () => {
    const unit = asset('U-200', 'unit', null);
    const csv = ['TAG;Nombre;Nivel;TAG padre', 'P-101;Bomba;equipo;U-200'].join('\n');

    const plan = planImport(csv, { existingAssets: [unit], classes });
    const { assets } = applyImport(plan, applyOptions([unit]));

    const pump = assets.find((a) => (a.tag as string) === 'P-101');
    expect(pump?.parentId).toBe(unit.id);
  });
});

/* ------------------------------------------------------------------ *
 * Exportación y viaje de ida y vuelta
 * ------------------------------------------------------------------ */

describe('exportCatalogCsv', () => {
  it('TEST-CSV-039 escribe la cabecera y una fila por activo', () => {
    const plant = asset('PL-1', 'plant', null);
    const unit = { ...asset('U-200', 'unit', plant.id), parentId: plant.id };

    const csv = exportCatalogCsv([unit, plant], classes, { withBom: false });
    const lines = csv.trim().split('\r\n');

    expect(lines[0]?.startsWith('TAG;Nombre;Nivel')).toBe(true);
    expect(lines).toHaveLength(3);
    // La planta va antes que la unidad aunque se pasaran al revés.
    expect(lines[1]?.startsWith('PL-1')).toBe(true);
  });

  it('TEST-CSV-040 exporta el TAG del padre, no su identificador', () => {
    const plant = asset('PL-1', 'plant', null);
    const unit = { ...asset('U-200', 'unit', plant.id), parentId: plant.id };

    const csv = exportCatalogCsv([plant, unit], classes, { withBom: false });
    expect(csv).toContain('U-200;U-200;unidad;PL-1');
    expect(csv).not.toContain(plant.id);
  });

  it('TEST-CSV-041 incluye la marca de orden de bytes por defecto', () => {
    const csv = exportCatalogCsv([asset('PL-1', 'plant', null)], classes);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(exportCatalogCsv([], classes, { withBom: false }).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('TEST-CSV-042 entrecomilla los campos que contienen el separador', () => {
    const item: Asset = { ...asset('P-101', 'equipment', null), name: 'Bomba; principal' };
    const csv = exportCatalogCsv([item], classes, { withBom: false });
    expect(csv).toContain('"Bomba; principal"');
  });

  it('TEST-CSV-043 el archivo exportado se vuelve a importar sin pérdidas', () => {
    // Es la prueba que justifica exportar TAG en lugar de UUID: el cliente
    // edita la hoja en Excel y la devuelve, y la jerarquía debe sobrevivir.
    const plant = asset('PL-1', 'plant', null);
    const unit: Asset = { ...asset('U-200', 'unit', null), parentId: plant.id };
    const pump: Asset = {
      ...asset('P-101', 'equipment', null),
      parentId: unit.id,
      classId: CLASS_PUMP,
      manufacturer: 'ACME',
      model: 'CX-9',
      serialNumber: 'SN-7',
      criticality: 'high',
      description: 'Bomba del circuito primario',
    };

    const csv = exportCatalogCsv([plant, unit, pump], classes, { withBom: false });
    const plan = planImport(csv, { existingAssets: [], classes });

    expect(plan.rejected).toEqual([]);
    expect(plan.toCreate).toHaveLength(3);

    const { assets } = applyImport(plan, applyOptions([]));
    const byTag = new Map(assets.map((a) => [a.tag as string, a]));
    const reimported = byTag.get('P-101');

    expect(reimported?.level).toBe('equipment');
    expect(reimported?.classId).toBe(CLASS_PUMP);
    expect(reimported?.manufacturer).toBe('ACME');
    expect(reimported?.model).toBe('CX-9');
    expect(reimported?.serialNumber).toBe('SN-7');
    expect(reimported?.criticality).toBe('high');
    expect(reimported?.description).toBe('Bomba del circuito primario');
    expect(reimported?.parentId).toBe(byTag.get('U-200')?.id);
    expect(byTag.get('U-200')?.parentId).toBe(byTag.get('PL-1')?.id);
  });

  it('TEST-CSV-044 un catálogo vacío exporta sólo la cabecera', () => {
    const csv = exportCatalogCsv([], classes, { withBom: false });
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });
});

describe('describeImportPlan', () => {
  it('TEST-CSV-045 resume altas, actualizaciones y rechazos', () => {
    const existing = asset('P-101', 'equipment', null);
    const csv = [
      'TAG;Nombre;Nivel;TAG padre',
      'PL-1;Planta;planta;',
      'P-101;Bomba;equipo;PL-1',
      'P-XX;Bomba mala;subsistema;PL-1',
    ].join('\n');

    const plan = planImport(csv, { existingAssets: [existing], classes, updateExisting: true });
    const summary = describeImportPlan(plan);

    expect(summary).toContain('1 activo(s) nuevo(s)');
    expect(summary).toContain('1 actualización(es)');
    expect(summary).toContain('1 fila(s) rechazada(s)');
  });

  it('TEST-CSV-046 explica por qué no se puede aplicar', () => {
    const plan = planImport('Codigo;Fabricante\nP-101;ACME', { existingAssets: [], classes });
    expect(describeImportPlan(plan)).toContain('Faltan columnas obligatorias');
  });
});
