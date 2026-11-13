/**
 * Validación del borrador de un activo (X01–X04, X07).
 *
 * La lógica vive aquí, fuera de React, por una razón concreta: las reglas que
 * deciden si un activo es admisible —TAG único en su alcance, padre de nivel
 * estrictamente superior, atributos obligatorios de la clase— son las mismas
 * que tendrá que aplicar la importación, el servidor y cualquier pantalla
 * futura. Si vivieran en el componente, cada uno acabaría con su propia
 * versión y divergirían.
 *
 * El criterio de los mensajes es que digan qué hay que cambiar, no qué regla
 * se incumplió: «Ese TAG ya lo usa P-101 en la misma unidad» sirve;
 * «violación de restricción de unicidad» no.
 */
import {
  hierarchyDepth,
  HIERARCHY_LABELS,
  resolveClassAttributes,
  validateAttributeValue,
  type Asset,
  type AssetClass,
  type AttributeValue,
  type HierarchyLevel,
} from './asset';
import { normalizeTag, parseTag, type TagUniquenessScope, type Uuid } from './identity';
import { ok, type Result } from './result';

/** Lo que el formulario recoge, antes de convertirse en un activo. */
export interface AssetDraft {
  /** `null` cuando se está creando. */
  readonly id: Uuid | null;
  readonly tag: string;
  readonly name: string;
  readonly level: HierarchyLevel;
  readonly parentId: Uuid | null;
  readonly classId: Uuid;
  readonly description: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly criticality: Asset['criticality'];
  readonly status: Asset['status'];
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

/** Un problema del borrador, atado al campo que lo causa. */
export interface DraftProblem {
  /** Campo del formulario, o `attributes.<clave>` para la ficha técnica. */
  readonly field: string;
  readonly message: string;
  /**
   * `blocking` impide guardar; `advisory` avisa y deja guardar.
   *
   * La distinción es deliberada: un activo sin fabricante es incompleto pero
   * guardable, y bloquear por ello obligaría al autor a inventarse un dato.
   * Un TAG duplicado, en cambio, rompe la búsqueda por TAG y la telemetría.
   */
  readonly severity: 'blocking' | 'advisory';
}

export interface ValidateDraftOptions {
  readonly assets: readonly Asset[];
  readonly classes: readonly AssetClass[];
  readonly uniquenessScope: TagUniquenessScope;
}

/**
 * Ancestro del activo en un nivel dado, siguiendo la cadena de padres.
 *
 * Lleva guarda contra ciclos porque esta función se llama mientras el usuario
 * edita: un padre mal elegido puede cerrar un ciclo momentáneamente, y un
 * bucle infinito aquí congelaría el formulario en medio de la escritura.
 */
function ancestorAt(
  startParentId: Uuid | null,
  level: HierarchyLevel,
  byId: ReadonlyMap<string, Asset>,
): string | undefined {
  let cursor = startParentId === null ? undefined : byId.get(startParentId);
  const guard = new Set<string>();
  while (cursor !== undefined && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    if (cursor.level === level) return cursor.id;
    cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
  }
  return undefined;
}

/**
 * Clave de unicidad del TAG para un borrador.
 *
 * Se calcula desde el padre elegido en el formulario y no desde el activo
 * guardado, porque mover un equipo de unidad cambia su alcance: un TAG que
 * era válido puede dejar de serlo por el solo hecho de cambiarle el padre, y
 * el autor tiene que verlo en ese momento, no al guardar.
 */
export function draftScopeKey(
  draft: AssetDraft,
  scope: TagUniquenessScope,
  byId: ReadonlyMap<string, Asset>,
): string | null {
  if (scope === 'none') return null;
  const tag = normalizeTag(draft.tag);
  if (scope === 'project') return `::${tag}`;

  const parts: string[] = [];
  const selfPlant = draft.level === 'plant' ? (draft.id ?? '') : null;
  parts.push(selfPlant ?? ancestorAt(draft.parentId, 'plant', byId) ?? '');

  if (scope === 'unit' || scope === 'area') {
    const selfUnit = draft.level === 'unit' ? (draft.id ?? '') : null;
    parts.push(selfUnit ?? ancestorAt(draft.parentId, 'unit', byId) ?? '');
  }
  if (scope === 'area') {
    const selfArea = draft.level === 'area' ? (draft.id ?? '') : null;
    parts.push(selfArea ?? ancestorAt(draft.parentId, 'area', byId) ?? '');
  }
  return `${parts.join('/')}::${tag}`;
}

/**
 * Candidatos válidos como padre de un borrador.
 *
 * Filtra por nivel y descarta la propia descendencia: ofrecer un descendiente
 * y rechazarlo después es peor que no ofrecerlo.
 */
export function eligibleParents(draft: AssetDraft, assets: readonly Asset[]): readonly Asset[] {
  if (draft.level === 'plant') return [];

  const byId = new Map(assets.map((a) => [a.id as string, a]));

  const isSelfOrDescendant = (candidate: Asset): boolean => {
    if (draft.id === null) return false;
    let cursor: Asset | undefined = candidate;
    const guard = new Set<string>();
    while (cursor !== undefined && !guard.has(cursor.id)) {
      if (cursor.id === draft.id) return true;
      guard.add(cursor.id);
      cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
    }
    return false;
  };

  return assets.filter(
    (candidate) =>
      candidate.id !== draft.id &&
      hierarchyDepth(candidate.level) < hierarchyDepth(draft.level) &&
      !isSelfOrDescendant(candidate),
  );
}

/**
 * Valida un borrador y devuelve todos sus problemas.
 *
 * Devuelve la lista completa y no el primer fallo: un formulario que corrige
 * de uno en uno obliga a guardar cuatro veces para enterarse de cuatro cosas.
 */
export function validateAssetDraft(
  draft: AssetDraft,
  options: ValidateDraftOptions,
): readonly DraftProblem[] {
  const problems: DraftProblem[] = [];
  const byId = new Map(options.assets.map((a) => [a.id as string, a]));

  /* --- TAG --- */

  const tagResult = parseTag(draft.tag);
  if (!tagResult.ok) {
    problems.push({ field: 'tag', message: tagResult.error.message, severity: 'blocking' });
  } else {
    const key = draftScopeKey(draft, options.uniquenessScope, byId);
    if (key !== null) {
      const clash = options.assets.find(
        (other) =>
          other.id !== draft.id &&
          draftScopeKey(
            { ...draft, id: other.id, tag: other.tag, level: other.level, parentId: other.parentId },
            options.uniquenessScope,
            byId,
          ) === key,
      );
      if (clash !== undefined) {
        problems.push({
          field: 'tag',
          message: `Ese TAG ya lo usa «${clash.name}» en el mismo alcance de unicidad`,
          severity: 'blocking',
        });
      }
    }
  }

  /* --- Nombre --- */

  if (draft.name.trim().length === 0) {
    problems.push({ field: 'name', message: 'El activo necesita un nombre', severity: 'blocking' });
  }

  /* --- Jerarquía --- */

  if (draft.level === 'plant') {
    if (draft.parentId !== null) {
      problems.push({
        field: 'parentId',
        message: 'Una planta es la raíz de la jerarquía y no cuelga de nada',
        severity: 'blocking',
      });
    }
  } else if (draft.parentId === null) {
    problems.push({
      field: 'parentId',
      message: `Un activo de nivel «${HIERARCHY_LABELS[draft.level]}» necesita un elemento superior`,
      severity: 'blocking',
    });
  } else {
    const parent = byId.get(draft.parentId);
    if (parent === undefined) {
      problems.push({
        field: 'parentId',
        message: 'El elemento superior elegido ya no existe en el proyecto',
        severity: 'blocking',
      });
    } else if (hierarchyDepth(parent.level) >= hierarchyDepth(draft.level)) {
      problems.push({
        field: 'parentId',
        message: `Un «${HIERARCHY_LABELS[draft.level]}» no puede colgar de un «${HIERARCHY_LABELS[parent.level]}»`,
        severity: 'blocking',
      });
    } else if (
      draft.id !== null &&
      eligibleParents(draft, options.assets).every((a) => a.id !== parent.id)
    ) {
      // Lo único que queda por descartar: el padre elegido desciende de este
      // activo, de modo que aceptarlo cerraría un ciclo.
      problems.push({
        field: 'parentId',
        message: 'Ese elemento cuelga de este activo; elegirlo cerraría un ciclo',
        severity: 'blocking',
      });
    }
  }

  /* --- Clase y ficha técnica --- */

  const classesById = new Map(options.classes.map((c) => [c.id as string, c]));
  const assetClass = classesById.get(draft.classId);

  if (assetClass === undefined) {
    problems.push({
      field: 'classId',
      message: 'El activo necesita una clase; la elegida no existe en el proyecto',
      severity: 'blocking',
    });
  } else {
    if (assetClass.level !== draft.level) {
      // Aviso y no bloqueo: la clase declara el nivel habitual de sus activos,
      // y un patín completo puede legítimamente llevar una clase de equipo.
      problems.push({
        field: 'classId',
        message: `La clase «${assetClass.name}» se usa normalmente en nivel «${HIERARCHY_LABELS[assetClass.level]}»`,
        severity: 'advisory',
      });
    }

    for (const definition of resolveClassAttributes(draft.classId, classesById)) {
      const value = draft.attributes[definition.key] ?? null;
      const problem = validateAttributeValue(definition, value);
      if (problem !== null) {
        problems.push({
          field: `attributes.${definition.key}`,
          message: problem,
          severity: 'blocking',
        });
      }
    }
  }

  /* --- Datos de placa --- */

  if (draft.status === 'published' && draft.manufacturer.trim().length === 0) {
    problems.push({
      field: 'manufacturer',
      message: 'Un activo publicado sin fabricante deja la ficha incompleta para el técnico',
      severity: 'advisory',
    });
  }

  return problems;
}

/** `true` si el borrador se puede guardar. */
export function canSaveDraft(problems: readonly DraftProblem[]): boolean {
  return !problems.some((p) => p.severity === 'blocking');
}

/** Problemas de un campo concreto, para pintarlos junto a él. */
export function problemsFor(
  problems: readonly DraftProblem[],
  field: string,
): readonly DraftProblem[] {
  return problems.filter((p) => p.field === field);
}

/**
 * Convierte un borrador en un activo, o explica por qué no puede.
 *
 * Devuelve un `Result` y no un activo directamente porque el TAG es el único
 * dato que esta función no puede arreglar ni inventar. La alternativa sería
 * forzar el tipo con una aserción y escribir en el proyecto un TAG que el
 * dominio considera inválido: la búsqueda por TAG y la telemetría dejarían de
 * encontrar el equipo, y el archivo guardado no volvería a validar al abrirlo.
 * Que el caso sea inalcanzable tras `canSaveDraft` no lo hace seguro de
 * suponer; lo hace barato de comprobar.
 *
 * `revision` sube en cada guardado de un activo existente porque es el
 * registro de que la ficha cambió, y `createdAt` se conserva: la fecha de alta
 * de un equipo no se reescribe al corregirle el modelo.
 */
export function draftToAsset(
  draft: AssetDraft,
  options: {
    readonly projectId: Uuid;
    readonly previous: Asset | null;
    readonly now: string;
    readonly newId: Uuid;
  },
): Result<Asset> {
  const tagResult = parseTag(draft.tag);
  if (!tagResult.ok) return tagResult;

  const previous = options.previous;

  return ok({
    id: previous?.id ?? options.newId,
    projectId: options.projectId,
    tag: tagResult.value,
    name: draft.name.trim(),
    description: draft.description,
    classId: draft.classId,
    level: draft.level,
    parentId: draft.parentId,
    attributes: { ...draft.attributes },
    revision: previous === null ? 1 : previous.revision + 1,
    status: draft.status,
    criticality: draft.criticality,
    manufacturer: draft.manufacturer.trim(),
    model: draft.model.trim(),
    serialNumber: draft.serialNumber.trim(),
    createdAt: previous?.createdAt ?? options.now,
    updatedAt: options.now,
  });
}

/** Borrador en blanco. */
export function emptyDraft(options: {
  readonly level: HierarchyLevel;
  readonly parentId: Uuid | null;
  readonly classId: Uuid;
}): AssetDraft {
  return {
    id: null,
    tag: '',
    name: '',
    level: options.level,
    parentId: options.parentId,
    classId: options.classId,
    description: '',
    manufacturer: '',
    model: '',
    serialNumber: '',
    criticality: null,
    status: 'draft',
    attributes: {},
  };
}

/** Borrador a partir de un activo existente. */
export function draftFromAsset(asset: Asset): AssetDraft {
  return {
    id: asset.id,
    tag: asset.tag,
    name: asset.name,
    level: asset.level,
    parentId: asset.parentId,
    classId: asset.classId,
    description: asset.description,
    manufacturer: asset.manufacturer,
    model: asset.model,
    serialNumber: asset.serialNumber,
    criticality: asset.criticality,
    status: asset.status,
    attributes: { ...asset.attributes },
  };
}
