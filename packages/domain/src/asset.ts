/**
 * Catálogo industrial de activos e instrumentos (etapa 05, grupo X01-X07).
 *
 * Es la pieza que separa este producto de un visor de recorridos: el
 * panorama deja de ser una fotografía y pasa a ser la vista de un activo con
 * TAG, jerarquía, ficha técnica, documentos con revisión y variables de
 * proceso. Todo lo que viene después —notas sobre un equipo, telemetría de un
 * instrumento, formación sobre una unidad— se cuelga de aquí.
 */
import { z } from 'zod';
import { anchorSchema } from './hotspot';
import { tagSchema, tagUniquenessScopeSchema, uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Jerarquía (X02)
 * ------------------------------------------------------------------ */

/**
 * Niveles de la jerarquía planta → unidad → área → equipo → componente.
 *
 * El orden es significativo y se usa para validar que un nodo no cuelgue de
 * un nivel inferior al suyo. Se añade `component` por debajo de `equipment`
 * porque en instrumentación real un transmisor pertenece a una bomba, y sin
 * ese nivel el usuario termina creando equipos falsos para representarlo.
 */
export const HIERARCHY_LEVELS = ['plant', 'unit', 'area', 'equipment', 'component'] as const;

export const hierarchyLevelSchema = z.enum(HIERARCHY_LEVELS);
export type HierarchyLevel = z.infer<typeof hierarchyLevelSchema>;

export const hierarchyDepth = (level: HierarchyLevel): number => HIERARCHY_LEVELS.indexOf(level);

/** Etiquetas en español para la interfaz. */
export const HIERARCHY_LABELS: Readonly<Record<HierarchyLevel, string>> = {
  plant: 'Planta',
  unit: 'Unidad',
  area: 'Área',
  equipment: 'Equipo',
  component: 'Componente',
};

/* ------------------------------------------------------------------ *
 * Clases de activo y atributos configurables (X03)
 * ------------------------------------------------------------------ */

/**
 * Tipo de un atributo de ficha técnica.
 *
 * `quantity` lleva unidad declarada y es distinto de `number` a propósito:
 * una presión de diseño sin unidad es un dato inservible, y el contrato
 * prohíbe inferir unidades. Si el usuario no declara la unidad, el atributo
 * es `number` y se muestra sin unidad, sin suponer ninguna.
 */
export const attributeTypeSchema = z.enum([
  'text',
  'longText',
  'number',
  'quantity',
  'boolean',
  'date',
  'enum',
  'tagRef',
  'url',
]);

export type AttributeType = z.infer<typeof attributeTypeSchema>;

export const attributeDefinitionSchema = z.object({
  /** Clave estable: no cambia aunque se renombre la etiqueta. */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'La clave admite minúsculas, dígitos y guion bajo'),
  label: z.string().min(1).max(120),
  type: attributeTypeSchema,
  /** Unidad de medida para `quantity`. Texto libre: `bar`, `°C`, `m³/h`. */
  unit: z.string().max(32).nullable().default(null),
  required: z.boolean().default(false),
  /** Valores admitidos para `enum`. */
  options: z.array(z.string().max(120)).default([]),
  /** Grupo de la ficha en el que se muestra el atributo. */
  group: z.string().max(80).default('General'),
  order: z.number().int().nonnegative().default(0),
  helpText: z.string().max(500).default(''),
});

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

export const assetClassSchema = z.object({
  id: uuidSchema,
  /** Código de clase: `PUMP_CENTRIFUGAL`, `XMTR_PRESSURE`. */
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'El código de clase admite mayúsculas, dígitos y guion bajo'),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(''),
  /** Nivel jerárquico que ocupan los activos de esta clase. */
  level: hierarchyLevelSchema.default('equipment'),
  attributes: z.array(attributeDefinitionSchema).default([]),
  /** Icono del catálogo interno usado en el árbol y en los marcadores. */
  icon: z.string().max(64).default('equipment'),
  /** Clase de la que hereda atributos. */
  parentClassId: uuidSchema.nullable().default(null),
});

export type AssetClass = z.infer<typeof assetClassSchema>;

/**
 * Resuelve los atributos efectivos de una clase recorriendo su herencia.
 *
 * Un atributo redefinido por la clase hija sustituye al del padre, y el
 * recorrido se detiene si detecta un ciclo: un árbol de clases corrupto no
 * debe colgar la aplicación al abrir la ficha de un activo.
 */
export function resolveClassAttributes(
  classId: string,
  classes: ReadonlyMap<string, AssetClass>,
): AttributeDefinition[] {
  const chain: AssetClass[] = [];
  const seen = new Set<string>();
  let current: string | null = classId;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const cls = classes.get(current);
    if (cls === undefined) break;
    chain.push(cls);
    current = cls.parentClassId;
  }

  // De la raíz hacia la hoja, para que la hoja sobreescriba.
  const byKey = new Map<string, AttributeDefinition>();
  for (const cls of chain.reverse()) {
    for (const attr of cls.attributes) byKey.set(attr.key, attr);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group, 'es');
    if (a.order !== b.order) return a.order - b.order;
    return a.label.localeCompare(b.label, 'es');
  });
}

/* ------------------------------------------------------------------ *
 * Valores de atributo
 * ------------------------------------------------------------------ */

export const attributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type AttributeValue = z.infer<typeof attributeValueSchema>;

/** Comprueba un valor contra su definición. Devuelve el problema o `null`. */
export function validateAttributeValue(
  definition: AttributeDefinition,
  value: AttributeValue,
): string | null {
  if (value === null || value === '') {
    return definition.required ? `«${definition.label}» es obligatorio` : null;
  }

  switch (definition.type) {
    case 'text':
    case 'longText':
      if (typeof value !== 'string') return `«${definition.label}» debe ser texto`;
      if (definition.type === 'text' && value.length > 500) {
        return `«${definition.label}» no puede exceder 500 caracteres`;
      }
      return null;

    case 'number':
    case 'quantity':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `«${definition.label}» debe ser un número`;
      }
      return null;

    case 'boolean':
      return typeof value === 'boolean' ? null : `«${definition.label}» debe ser sí o no`;

    case 'date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        return `«${definition.label}» debe ser una fecha válida`;
      }
      return null;

    case 'enum':
      if (typeof value !== 'string' || !definition.options.includes(value)) {
        return `«${definition.label}» debe ser uno de: ${definition.options.join(', ')}`;
      }
      return null;

    case 'tagRef':
      return typeof value === 'string' && tagSchema.safeParse(value).success
        ? null
        : `«${definition.label}» debe ser un TAG válido`;

    case 'url':
      if (typeof value !== 'string') return `«${definition.label}» debe ser una dirección web`;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:'
          ? null
          : `«${definition.label}» debe usar http o https`;
      } catch {
        return `«${definition.label}» no es una dirección web válida`;
      }

    default: {
      const exhaustive: never = definition.type;
      throw new Error(`Tipo de atributo no contemplado: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Activo (X01)
 * ------------------------------------------------------------------ */

export const assetSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  tag: tagSchema,
  name: z.string().min(1).max(250),
  description: z.string().max(4000).default(''),
  classId: uuidSchema,
  level: hierarchyLevelSchema,
  /** Padre en la jerarquía. `null` sólo para el nivel `plant`. */
  parentId: uuidSchema.nullable().default(null),
  attributes: z.record(z.string(), attributeValueSchema).default({}),
  /** Revisión del registro del activo; se incrementa al editar. */
  revision: z.number().int().positive().default(1),
  /** Estado del ciclo de vida del registro (X16). */
  status: z.enum(['draft', 'inReview', 'published', 'archived']).default('draft'),
  /** Criticidad declarada por el cliente: ordena notas y alarmas. */
  criticality: z.enum(['low', 'medium', 'high', 'critical']).nullable().default(null),
  manufacturer: z.string().max(200).default(''),
  model: z.string().max(200).default(''),
  serialNumber: z.string().max(120).default(''),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Asset = z.infer<typeof assetSchema>;

/**
 * Ubicación visual de un activo (X04).
 *
 * Un activo puede estar enlazado desde varias panorámicas: una bomba se ve
 * desde el pasillo y desde la plataforma superior, y ambas vistas son
 * legítimas. Modelar la ubicación como una tabla aparte, y no como un campo
 * del activo, es lo que hace posible ese uno-a-muchos.
 */
export const assetLocationSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema,
  sceneId: uuidSchema,
  hotspotId: uuidSchema.nullable().default(null),
  anchor: anchorSchema,
  /** Ubicación preferente: la que abre «ir al activo» (X05). */
  primary: z.boolean().default(false),
  note: z.string().max(500).default(''),
});

export type AssetLocation = z.infer<typeof assetLocationSchema>;

/* ------------------------------------------------------------------ *
 * Documentos técnicos con revisión (X07)
 * ------------------------------------------------------------------ */

export const documentStatusSchema = z.enum([
  'draft',
  'forReview',
  'approved',
  'superseded',
  'obsolete',
]);

export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  draft: 'Borrador',
  forReview: 'En revisión',
  approved: 'Aprobado',
  superseded: 'Reemplazado',
  obsolete: 'Obsoleto',
};

export const technicalDocumentSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema.nullable().default(null),
  title: z.string().min(1).max(250),
  /** Código de documento del cliente: `P-101-DS-001`. */
  documentCode: z.string().max(120).default(''),
  /** Revisión tal como la nombra el cliente: `A`, `0`, `Rev. 3`. */
  revision: z.string().max(40).default(''),
  status: documentStatusSchema.default('draft'),
  mediaId: uuidSchema,
  discipline: z
    .enum(['process', 'mechanical', 'electrical', 'instrumentation', 'civil', 'safety', 'other'])
    .default('other')
    .describe('Disciplina de ingeniería; ordena el listado de la ficha'),
  issuedAt: z.string().datetime({ offset: true }).nullable().default(null),
  /** Documento que sustituye a este, cuando está reemplazado. */
  supersededById: uuidSchema.nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
});

export type TechnicalDocument = z.infer<typeof technicalDocumentSchema>;

/**
 * Documento vigente de una cadena de revisiones.
 *
 * Mostrar una revisión reemplazada como si fuera la vigente es un error con
 * consecuencia física: alguien interviene un equipo con un plano antiguo.
 * De ahí que el estado se modele explícitamente y que esta función exista.
 */
export function currentRevision(
  documents: readonly TechnicalDocument[],
): TechnicalDocument | null {
  const approved = documents.filter((d) => d.status === 'approved');
  if (approved.length === 0) return null;
  return approved.reduce((latest, candidate) => {
    const a = latest.issuedAt ?? latest.createdAt;
    const b = candidate.issuedAt ?? candidate.createdAt;
    return b > a ? candidate : latest;
  });
}

/* ------------------------------------------------------------------ *
 * Validación de la jerarquía
 * ------------------------------------------------------------------ */

export interface HierarchyProblem {
  readonly assetId: string;
  readonly tag: string;
  readonly message: string;
}

/**
 * Valida la jerarquía completa del catálogo.
 *
 * Comprueba tres cosas que el esquema por sí solo no puede: que ningún activo
 * sea su propio ancestro, que cada nodo cuelgue de un nivel estrictamente
 * superior, y que el TAG sea único en el alcance configurado.
 */
export function validateHierarchy(
  assets: readonly Asset[],
  uniquenessScope: z.infer<typeof tagUniquenessScopeSchema>,
): HierarchyProblem[] {
  const problems: HierarchyProblem[] = [];
  const byId = new Map(assets.map((a) => [a.id as string, a]));

  for (const asset of assets) {
    // Ciclos.
    const seen = new Set<string>([asset.id]);
    let cursor = asset.parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        problems.push({
          assetId: asset.id,
          tag: asset.tag,
          message: 'El activo forma un ciclo en la jerarquía',
        });
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }

    // Nivel del padre.
    if (asset.parentId === null) {
      if (asset.level !== 'plant') {
        problems.push({
          assetId: asset.id,
          tag: asset.tag,
          message: `Un activo de nivel «${HIERARCHY_LABELS[asset.level]}» necesita un elemento superior`,
        });
      }
    } else {
      const parent = byId.get(asset.parentId);
      if (parent === undefined) {
        problems.push({
          assetId: asset.id,
          tag: asset.tag,
          message: 'El elemento superior referenciado no existe',
        });
      } else if (hierarchyDepth(parent.level) >= hierarchyDepth(asset.level)) {
        problems.push({
          assetId: asset.id,
          tag: asset.tag,
          message: `Un «${HIERARCHY_LABELS[asset.level]}» no puede colgar de un «${HIERARCHY_LABELS[parent.level]}»`,
        });
      }
    }
  }

  // Unicidad del TAG en su alcance.
  if (uniquenessScope !== 'none') {
    const ancestorAt = (asset: Asset, level: HierarchyLevel): string | undefined => {
      let cursor: Asset | undefined = asset;
      const guard = new Set<string>();
      while (cursor !== undefined && !guard.has(cursor.id)) {
        guard.add(cursor.id);
        if (cursor.level === level) return cursor.id;
        cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
      }
      return undefined;
    };

    const seenKeys = new Map<string, Asset>();
    for (const asset of assets) {
      const parts: string[] = [];
      if (uniquenessScope !== 'project') parts.push(ancestorAt(asset, 'plant') ?? '');
      if (uniquenessScope === 'unit' || uniquenessScope === 'area') {
        parts.push(ancestorAt(asset, 'unit') ?? '');
      }
      if (uniquenessScope === 'area') parts.push(ancestorAt(asset, 'area') ?? '');
      const key = `${parts.join('/')}::${asset.tag}`;

      const previous = seenKeys.get(key);
      if (previous !== undefined) {
        problems.push({
          assetId: asset.id,
          tag: asset.tag,
          message: `El TAG «${asset.tag}» ya existe en este alcance (${previous.name})`,
        });
      } else {
        seenKeys.set(key, asset);
      }
    }
  }

  return problems;
}

/** Ruta jerárquica legible: `Planta Norte / U-200 / Área 3 / P-101A`. */
export function assetPath(asset: Asset, byId: ReadonlyMap<string, Asset>): string {
  const parts: string[] = [];
  const guard = new Set<string>();
  let cursor: Asset | undefined = asset;
  while (cursor !== undefined && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    parts.unshift(cursor.tag);
    cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
  }
  return parts.join(' / ');
}
