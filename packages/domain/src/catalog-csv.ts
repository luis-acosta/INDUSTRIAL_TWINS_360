/**
 * Importación y exportación del catálogo de activos en CSV (X06).
 *
 * El cliente industrial tiene su lista de equipos en una hoja de cálculo. Esa
 * lista es la fuente de verdad del catálogo y teclearla otra vez en la
 * aplicación no es una opción: son cientos de TAG y cada error de transcripción
 * se convierte en un marcador que apunta al equipo equivocado.
 *
 * La importación está construida sobre tres principios:
 *
 * 1. **Nada se escribe sin un informe previo.** `planImport` devuelve qué se
 *    crearía, qué se actualizaría y qué se rechaza, sin tocar el proyecto. El
 *    usuario decide después. Importar y explicar luego convierte la revisión en
 *    limpieza.
 * 2. **Una fila mala no cancela el archivo.** De doscientas filas, tres van a
 *    tener el nivel mal escrito. Se rechazan esas tres, con su número de línea
 *    y el motivo, y las ciento noventa y siete se importan.
 * 3. **La jerarquía se resuelve por TAG del padre, no por identificador.** En
 *    la hoja del cliente no hay UUID; hay «U-200» en la columna de unidad. El
 *    importador casa esos TAG con los activos existentes y con las filas del
 *    propio archivo, en cualquier orden: la hoja puede traer el hijo antes que
 *    el padre.
 */
import {
  HIERARCHY_LEVELS,
  hierarchyLevelSchema,
  type Asset,
  type AssetClass,
  type HierarchyLevel,
} from './asset';
import { newUuid, normalizeTag, parseTag, type Tag, type Uuid } from './identity';

/* ------------------------------------------------------------------ *
 * Lectura y escritura de CSV
 * ------------------------------------------------------------------ */

/**
 * Divide una línea de CSV respetando las comillas.
 *
 * Se escribe en lugar de usar una biblioteca porque el formato que hace falta
 * es el que exporta Excel y es pequeño: comillas dobles para entrecomillar,
 * dobles comillas para una comilla literal. Una biblioteca traería opciones
 * que no se usan y una dependencia más que mantener.
 */
export function parseCsvLine(line: string, separator = ','): readonly string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === separator) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char ?? '';
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Detecta el separador de un CSV.
 *
 * Excel en español exporta con punto y coma, y en inglés con coma. Adivinarlo
 * mal produce una sola columna con todo dentro, y el usuario ve «ninguna fila
 * válida» sin entender por qué. Se cuenta cuál aparece más en la cabecera.
 */
export function detectSeparator(headerLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;

  for (const candidate of candidates) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/** Escapa un campo para escribirlo en CSV. */
function escapeCsvField(value: string, separator: string): string {
  if (value.includes('"') || value.includes(separator) || /[\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Columnas
 * ------------------------------------------------------------------ */

/**
 * Nombres de columna reconocidos, con sus variantes.
 *
 * Se aceptan varias grafías porque la hoja del cliente no se va a reescribir
 * para encajar con el importador. La comparación ignora mayúsculas, acentos y
 * espacios.
 */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  tag: ['tag', 'etiqueta', 'codigo', 'código', 'tagequipo'],
  name: ['nombre', 'name', 'descripcion', 'descripción', 'denominacion', 'denominación'],
  level: ['nivel', 'level', 'tipo'],
  parentTag: ['padre', 'tagpadre', 'parent', 'parenttag', 'perteneceA', 'ubicacion', 'ubicación'],
  classCode: ['clase', 'class', 'codigoclase', 'tipoactivo'],
  manufacturer: ['fabricante', 'manufacturer', 'marca'],
  model: ['modelo', 'model'],
  // «Número de serie» es la cabecera que escribe la propia exportación: sin
  // la variante con «de», el archivo que genera esta aplicación no se podría
  // volver a importar sin perder el número de serie.
  serialNumber: [
    'serie',
    'numeroserie',
    'númeroserie',
    'numerodeserie',
    'númerodeserie',
    'serial',
    'serialnumber',
  ],
  criticality: ['criticidad', 'criticality'],
  description: ['observaciones', 'notas', 'comentarios', 'descripcionlarga'],
};

/** Normaliza un nombre de columna para compararlo. */
function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

export type ColumnKey = keyof typeof COLUMN_ALIASES;

/** Casa las columnas del archivo con las que el importador entiende. */
export function mapColumns(header: readonly string[]): {
  readonly columns: Readonly<Partial<Record<ColumnKey, number>>>;
  readonly unknown: readonly string[];
} {
  const columns: Partial<Record<ColumnKey, number>> = {};
  const unknown: string[] = [];

  header.forEach((raw, index) => {
    const normalized = normalizeHeader(raw);
    const match = (Object.keys(COLUMN_ALIASES) as ColumnKey[]).find((key) =>
      COLUMN_ALIASES[key]?.some((alias) => normalizeHeader(alias) === normalized),
    );

    if (match === undefined) {
      if (raw.trim().length > 0) unknown.push(raw);
      return;
    }
    // La primera columna con ese significado gana: una hoja con dos columnas
    // «nombre» es un error del cliente, y usar la última silenciosamente
    // escondería el problema.
    if (columns[match] === undefined) columns[match] = index;
  });

  return { columns, unknown };
}

/* ------------------------------------------------------------------ *
 * Niveles y criticidad
 * ------------------------------------------------------------------ */

const LEVEL_ALIASES: Readonly<Record<string, HierarchyLevel>> = {
  planta: 'plant',
  plant: 'plant',
  unidad: 'unit',
  unit: 'unit',
  area: 'area',
  zona: 'area',
  equipo: 'equipment',
  equipment: 'equipment',
  equipos: 'equipment',
  componente: 'component',
  component: 'component',
  instrumento: 'component',
};

export function parseLevel(raw: string): HierarchyLevel | null {
  const normalized = normalizeHeader(raw);
  const alias = LEVEL_ALIASES[normalized];
  if (alias !== undefined) return alias;
  const direct = hierarchyLevelSchema.safeParse(raw.trim());
  return direct.success ? direct.data : null;
}

const CRITICALITY_ALIASES: Readonly<Record<string, Asset['criticality']>> = {
  baja: 'low',
  low: 'low',
  media: 'medium',
  medium: 'medium',
  alta: 'high',
  high: 'high',
  critica: 'critical',
  critico: 'critical',
  critical: 'critical',
};

export function parseCriticality(raw: string): Asset['criticality'] {
  if (raw.trim() === '') return null;
  return CRITICALITY_ALIASES[normalizeHeader(raw)] ?? null;
}

/* ------------------------------------------------------------------ *
 * Plan de importación
 * ------------------------------------------------------------------ */

export interface RowProblem {
  /** Número de línea en el archivo, contando la cabecera como 1. */
  readonly line: number;
  readonly tag: string;
  readonly message: string;
}

export interface PlannedAsset {
  readonly line: number;
  readonly tag: Tag;
  readonly name: string;
  readonly level: HierarchyLevel;
  /** TAG del padre tal como viene en el archivo. */
  readonly parentTag: string | null;
  readonly classCode: string | null;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly criticality: Asset['criticality'];
  readonly description: string;
  /** Activo existente que esta fila actualiza, si lo hay. */
  readonly existingId: Uuid | null;
}

export interface ImportPlan {
  readonly separator: string;
  readonly columns: Readonly<Partial<Record<ColumnKey, number>>>;
  readonly unknownColumns: readonly string[];
  readonly toCreate: readonly PlannedAsset[];
  readonly toUpdate: readonly PlannedAsset[];
  readonly rejected: readonly RowProblem[];
  readonly warnings: readonly string[];
  /** `true` si el plan se puede aplicar. */
  readonly applicable: boolean;
}

export interface PlanOptions {
  readonly existingAssets: readonly Asset[];
  readonly classes: readonly AssetClass[];
  /** Actualiza los activos cuyo TAG ya existe, en lugar de rechazarlos. */
  readonly updateExisting?: boolean;
}

/**
 * Analiza un CSV y devuelve qué haría la importación, sin tocar nada.
 */
export function planImport(csv: string, options: PlanOptions): ImportPlan {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerLine = lines[0];

  if (headerLine === undefined) {
    return {
      separator: ',',
      columns: {},
      unknownColumns: [],
      toCreate: [],
      toUpdate: [],
      rejected: [],
      warnings: ['El archivo está vacío.'],
      applicable: false,
    };
  }

  const separator = detectSeparator(headerLine);
  const { columns, unknown } = mapColumns(parseCsvLine(headerLine, separator));

  const warnings: string[] = [];
  if (unknown.length > 0) {
    // Se avisa en lugar de fallar: una hoja de cliente trae columnas de su
    // propio sistema que no nos interesan, y eso no es un error.
    warnings.push(
      `Columnas que no se usan y se ignoran: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? '…' : ''}.`,
    );
  }

  if (columns.tag === undefined || columns.name === undefined || columns.level === undefined) {
    const missing = [
      columns.tag === undefined ? 'TAG' : null,
      columns.name === undefined ? 'nombre' : null,
      columns.level === undefined ? 'nivel' : null,
    ].filter((value): value is string => value !== null);

    return {
      separator,
      columns,
      unknownColumns: unknown,
      toCreate: [],
      toUpdate: [],
      rejected: [],
      warnings: [
        ...warnings,
        `Faltan columnas obligatorias: ${missing.join(', ')}. La primera fila debe ser la cabecera.`,
      ],
      applicable: false,
    };
  }

  const byTag = new Map<string, Asset>();
  for (const asset of options.existingAssets) byTag.set(normalizeTag(asset.tag), asset);

  const classByCode = new Map<string, AssetClass>();
  for (const assetClass of options.classes) classByCode.set(normalizeHeader(assetClass.code), assetClass);

  const rejected: RowProblem[] = [];
  const planned: PlannedAsset[] = [];
  const seenInFile = new Map<string, number>();

  const field = (fields: readonly string[], key: ColumnKey): string => {
    const index = columns[key];
    return index === undefined ? '' : (fields[index] ?? '');
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNumber = i + 1;
    const fields = parseCsvLine(line, separator);

    const rawTag = field(fields, 'tag');
    const tagResult = parseTag(rawTag);
    if (!tagResult.ok) {
      rejected.push({ line: lineNumber, tag: rawTag, message: tagResult.error.message });
      continue;
    }
    const tag = tagResult.value;
    const normalized = normalizeTag(tag);

    const duplicateLine = seenInFile.get(normalized);
    if (duplicateLine !== undefined) {
      rejected.push({
        line: lineNumber,
        tag,
        message: `El TAG ya aparece en la línea ${duplicateLine} del mismo archivo.`,
      });
      continue;
    }

    const name = field(fields, 'name');
    if (name.trim().length === 0) {
      rejected.push({ line: lineNumber, tag, message: 'Falta el nombre del activo.' });
      continue;
    }

    const level = parseLevel(field(fields, 'level'));
    if (level === null) {
      rejected.push({
        line: lineNumber,
        tag,
        message: `Nivel no reconocido: «${field(fields, 'level')}». Use uno de: ${HIERARCHY_LEVELS.join(', ')}.`,
      });
      continue;
    }

    const existing = byTag.get(normalized);
    if (existing !== undefined && options.updateExisting !== true) {
      rejected.push({
        line: lineNumber,
        tag,
        message: 'El TAG ya existe en el proyecto. Active la actualización para sobrescribirlo.',
      });
      continue;
    }

    const parentTagRaw = field(fields, 'parentTag').trim();
    const parentTag = parentTagRaw.length === 0 ? null : parentTagRaw;

    if (level === 'plant' && parentTag !== null) {
      warnings.push(
        `Línea ${lineNumber}: una planta no tiene padre; se ignora «${parentTag}».`,
      );
    }
    // El padre sólo es obligatorio al crear. Una hoja parcial que corrige
    // nombres no trae la columna de jerarquía, y exigirla ahí obligaría al
    // cliente a rellenar a mano un dato que la aplicación ya conoce.
    if (level !== 'plant' && parentTag === null && existing === undefined) {
      rejected.push({
        line: lineNumber,
        tag,
        message: `Un activo nuevo de nivel «${level}» necesita el TAG de su padre.`,
      });
      continue;
    }

    const classCodeRaw = field(fields, 'classCode').trim();
    const classCode = classCodeRaw.length === 0 ? null : classCodeRaw;
    if (classCode !== null && !classByCode.has(normalizeHeader(classCode))) {
      warnings.push(
        `Línea ${lineNumber}: la clase «${classCode}» no existe en el proyecto; el activo se importa sin atributos de clase.`,
      );
    }

    const criticalityRaw = field(fields, 'criticality');
    if (criticalityRaw.trim().length > 0 && parseCriticality(criticalityRaw) === null) {
      warnings.push(
        `Línea ${lineNumber}: criticidad no reconocida «${criticalityRaw}»; se deja sin declarar.`,
      );
    }

    seenInFile.set(normalized, lineNumber);
    planned.push({
      line: lineNumber,
      tag,
      name: name.trim(),
      level,
      parentTag: level === 'plant' ? null : parentTag,
      classCode,
      manufacturer: field(fields, 'manufacturer').trim(),
      model: field(fields, 'model').trim(),
      serialNumber: field(fields, 'serialNumber').trim(),
      criticality: parseCriticality(criticalityRaw),
      description: field(fields, 'description').trim(),
      existingId: existing?.id ?? null,
    });
  }

  /* --- Comprobación de la jerarquía --- */

  const plannedTags = new Set(planned.map((row) => normalizeTag(row.tag)));
  const resolvable = (parentTag: string): boolean =>
    byTag.has(normalizeTag(parentTag)) || plannedTags.has(normalizeTag(parentTag));

  const orphans: PlannedAsset[] = [];
  const accepted: PlannedAsset[] = [];

  for (const row of planned) {
    if (row.parentTag !== null && !resolvable(row.parentTag)) {
      orphans.push(row);
      continue;
    }
    accepted.push(row);
  }

  for (const orphan of orphans) {
    rejected.push({
      line: orphan.line,
      tag: orphan.tag,
      message: `No existe el padre «${orphan.parentTag}» ni en el proyecto ni en el archivo.`,
    });
  }

  const toCreate = accepted.filter((row) => row.existingId === null);
  const toUpdate = accepted.filter((row) => row.existingId !== null);

  return {
    separator,
    columns,
    unknownColumns: unknown,
    toCreate,
    toUpdate,
    rejected,
    warnings,
    applicable: accepted.length > 0,
  };
}

/* ------------------------------------------------------------------ *
 * Aplicación del plan
 * ------------------------------------------------------------------ */

export interface ApplyOptions {
  readonly projectId: Uuid;
  readonly existingAssets: readonly Asset[];
  readonly classes: readonly AssetClass[];
  readonly now: string;
  /** Clase que se asigna cuando la fila no declara ninguna válida. */
  readonly fallbackClassId: Uuid;
}

/**
 * Convierte un plan en activos.
 *
 * Los padres se resuelven en dos pasadas porque el archivo puede traer el hijo
 * antes que el padre, que es lo normal cuando la hoja está ordenada por TAG.
 * Resolver en una sola pasada dejaría sin padre a la mitad de las filas.
 */
export function applyImport(
  plan: ImportPlan,
  options: ApplyOptions,
): { readonly assets: readonly Asset[]; readonly created: number; readonly updated: number } {
  const classByCode = new Map<string, AssetClass>();
  for (const assetClass of options.classes) classByCode.set(normalizeHeader(assetClass.code), assetClass);

  const result = new Map<string, Asset>();
  for (const asset of options.existingAssets) result.set(asset.id, asset);

  const idByTag = new Map<string, Uuid>();
  for (const asset of options.existingAssets) idByTag.set(normalizeTag(asset.tag), asset.id);

  // Primera pasada: identificadores, para que cualquier fila pueda ser padre.
  const rows = [...plan.toCreate, ...plan.toUpdate];
  for (const row of rows) {
    const id = row.existingId ?? newUuid();
    idByTag.set(normalizeTag(row.tag), id);
  }

  let created = 0;
  let updated = 0;

  // Segunda pasada: los activos, ya con los padres resueltos.
  for (const row of rows) {
    const id = idByTag.get(normalizeTag(row.tag));
    if (id === undefined) continue;

    const previous = result.get(id);
    const classId =
      (row.classCode !== null ? classByCode.get(normalizeHeader(row.classCode))?.id : undefined) ??
      previous?.classId ??
      options.fallbackClassId;

    // La celda vacía de la columna «padre» no es una orden de desvincular: en
    // una actualización se conserva el padre que ya tenía el activo.
    const parentId =
      row.parentTag !== null
        ? (idByTag.get(normalizeTag(row.parentTag)) ?? null)
        : row.level === 'plant'
          ? null
          : (previous?.parentId ?? null);

    const asset: Asset = {
      id,
      projectId: options.projectId,
      tag: row.tag,
      name: row.name,
      description: row.description.length > 0 ? row.description : (previous?.description ?? ''),
      classId,
      level: row.level,
      parentId,
      attributes: previous?.attributes ?? {},
      // La revisión sube al actualizar: es el registro de que el activo cambió.
      revision: previous === undefined ? 1 : previous.revision + 1,
      status: previous?.status ?? 'draft',
      criticality: row.criticality ?? previous?.criticality ?? null,
      manufacturer: row.manufacturer.length > 0 ? row.manufacturer : (previous?.manufacturer ?? ''),
      model: row.model.length > 0 ? row.model : (previous?.model ?? ''),
      serialNumber:
        row.serialNumber.length > 0 ? row.serialNumber : (previous?.serialNumber ?? ''),
      createdAt: previous?.createdAt ?? options.now,
      updatedAt: options.now,
    };

    if (previous === undefined) created += 1;
    else updated += 1;

    result.set(id, asset);
  }

  return { assets: [...result.values()], created, updated };
}

/* ------------------------------------------------------------------ *
 * Exportación
 * ------------------------------------------------------------------ */

export interface ExportOptions {
  readonly separator?: string;
  /** Incluye la marca de orden de bytes para que Excel lea bien los acentos. */
  readonly withBom?: boolean;
}

const EXPORT_HEADER = [
  'TAG',
  'Nombre',
  'Nivel',
  'TAG padre',
  'Clase',
  'Fabricante',
  'Modelo',
  'Número de serie',
  'Criticidad',
  'Estado',
  'Revisión',
  'Observaciones',
] as const;

const LEVEL_LABELS_ES: Readonly<Record<HierarchyLevel, string>> = {
  plant: 'planta',
  unit: 'unidad',
  area: 'area',
  equipment: 'equipo',
  component: 'componente',
};

const CRITICALITY_LABELS_ES: Readonly<Record<string, string>> = {
  low: 'baja',
  medium: 'media',
  high: 'alta',
  critical: 'critica',
};

/**
 * Exporta el catálogo a CSV.
 *
 * Se exporta el TAG del padre y no su identificador, de modo que el archivo se
 * pueda editar en Excel y volver a importar. Exportar UUID haría el archivo
 * ilegible y, peor, intocable: nadie puede editar a mano una columna de
 * identificadores sin romper la jerarquía.
 *
 * La marca de orden de bytes va por defecto porque Excel en Windows, sin ella,
 * muestra «PresiÃ³n» en lugar de «Presión», y el cliente concluye que la
 * exportación está mal.
 */
export function exportCatalogCsv(
  assets: readonly Asset[],
  classes: readonly AssetClass[],
  options: ExportOptions = {},
): string {
  const separator = options.separator ?? ';';
  const classById = new Map(classes.map((c) => [c.id as string, c]));
  const tagById = new Map(assets.map((a) => [a.id as string, a.tag]));

  // Orden jerárquico: una hoja ordenada por nivel y TAG se lee de arriba
  // abajo como el árbol que representa.
  const sorted = [...assets].sort(
    (a, b) =>
      HIERARCHY_LEVELS.indexOf(a.level) - HIERARCHY_LEVELS.indexOf(b.level) ||
      a.tag.localeCompare(b.tag, 'es'),
  );

  const lines = [EXPORT_HEADER.map((h) => escapeCsvField(h, separator)).join(separator)];

  for (const asset of sorted) {
    const row = [
      asset.tag,
      asset.name,
      LEVEL_LABELS_ES[asset.level],
      asset.parentId === null ? '' : (tagById.get(asset.parentId) ?? ''),
      classById.get(asset.classId)?.code ?? '',
      asset.manufacturer,
      asset.model,
      asset.serialNumber,
      asset.criticality === null ? '' : (CRITICALITY_LABELS_ES[asset.criticality] ?? ''),
      asset.status,
      String(asset.revision),
      asset.description,
    ];
    lines.push(row.map((field) => escapeCsvField(field, separator)).join(separator));
  }

  const body = lines.join('\r\n') + '\r\n';
  return options.withBom === false ? body : `﻿${body}`;
}

/** Resumen del plan en texto, para mostrarlo antes de aplicar. */
export function describeImportPlan(plan: ImportPlan): string {
  if (!plan.applicable) {
    return plan.warnings.length > 0
      ? plan.warnings.join(' ')
      : 'No hay ninguna fila que se pueda importar.';
  }

  const parts = [
    `${plan.toCreate.length} activo(s) nuevo(s)`,
    plan.toUpdate.length > 0 ? `${plan.toUpdate.length} actualización(es)` : null,
    plan.rejected.length > 0 ? `${plan.rejected.length} fila(s) rechazada(s)` : null,
    plan.warnings.length > 0 ? `${plan.warnings.length} aviso(s)` : null,
  ].filter((part): part is string => part !== null);

  return parts.join(', ') + '.';
}
