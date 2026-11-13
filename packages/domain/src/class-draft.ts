/**
 * Validación del borrador de una clase de activo (X03).
 *
 * Configurar una clase es más delicado que editar un activo, porque una clase
 * se aplica a muchos. Tres consecuencias que esta capa tiene que vigilar:
 *
 * 1. **Cambiar la clave de un atributo pierde los datos.** Los valores se
 *    guardan en el activo indexados por la clave, no por la etiqueta. Renombrar
 *    la etiqueta es gratis; cambiar la clave deja huérfanos los valores de
 *    todos los activos de esa clase. Eso no se puede impedir sin impedir
 *    corregir un error, así que se **avisa con el número exacto de activos**
 *    afectados antes de dejarlo hacer.
 * 2. **Marcar un atributo como obligatorio invalida activos que ya existen.**
 *    Los que no lo tengan relleno quedan incompletos, y el autor tiene derecho
 *    a saber cuántos son antes de guardar.
 * 3. **La herencia puede cerrar un ciclo.** Una clase que hereda de sí misma,
 *    directa o indirectamente, cuelga `resolveClassAttributes` o la deja
 *    devolviendo lo que encuentre antes de abortar. Se rechaza al guardar.
 */
import {
  hierarchyLevelSchema,
  type Asset,
  type AssetClass,
  type AttributeDefinition,
  type HierarchyLevel,
} from './asset';
import type { Uuid } from './identity';

/** Lo que recoge el formulario de una clase. */
export interface ClassDraft {
  readonly id: Uuid | null;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly level: HierarchyLevel;
  readonly parentClassId: Uuid | null;
  readonly icon: string;
  readonly attributes: readonly AttributeDefinition[];
}

export interface ClassProblem {
  /** `code`, `name`, `parentClassId`, o `attributes.<índice>.<campo>`. */
  readonly field: string;
  readonly message: string;
  readonly severity: 'blocking' | 'advisory';
}

export interface ValidateClassOptions {
  readonly classes: readonly AssetClass[];
  readonly assets: readonly Asset[];
  /** Clase tal como estaba guardada, para detectar qué cambió. */
  readonly previous: AssetClass | null;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Activos que usan una clase, contando la herencia.
 *
 * Un atributo definido en `BASE_ROTATING` lo heredan las bombas y los
 * compresores; cambiarlo afecta a los activos de todas las clases hijas, no
 * sólo a los de la clase que se está editando. Contar sólo los directos daría
 * un número tranquilizador y falso.
 */
export function affectedAssets(
  classId: Uuid,
  classes: readonly AssetClass[],
  assets: readonly Asset[],
): readonly Asset[] {
  const family = new Set<string>([classId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of classes) {
      if (
        candidate.parentClassId !== null &&
        family.has(candidate.parentClassId) &&
        !family.has(candidate.id)
      ) {
        family.add(candidate.id);
        grew = true;
      }
    }
  }
  return assets.filter((asset) => family.has(asset.classId));
}

/** Clases que pueden ser padre de un borrador, sin cerrar ciclos. */
export function eligibleParentClasses(
  draft: ClassDraft,
  classes: readonly AssetClass[],
): readonly AssetClass[] {
  if (draft.id === null) return classes;

  const byId = new Map(classes.map((c) => [c.id as string, c]));

  const descendsFromDraft = (candidate: AssetClass): boolean => {
    let cursor: AssetClass | undefined = candidate;
    const guard = new Set<string>();
    while (cursor !== undefined && !guard.has(cursor.id)) {
      if (cursor.id === draft.id) return true;
      guard.add(cursor.id);
      cursor = cursor.parentClassId !== null ? byId.get(cursor.parentClassId) : undefined;
    }
    return false;
  };

  return classes.filter((candidate) => !descendsFromDraft(candidate));
}

/**
 * Atributos que la clase hereda, con la clase que los define.
 *
 * Se expone para que el formulario pueda mostrarlos en gris y avisar cuando el
 * autor define uno con la misma clave: redefinir es legítimo —una bomba puede
 * estrechar el rango de potencia de su clase base— pero hacerlo sin saberlo
 * no lo es.
 */
export function inheritedAttributes(
  draft: ClassDraft,
  classes: readonly AssetClass[],
): readonly { readonly definition: AttributeDefinition; readonly fromCode: string }[] {
  const byId = new Map(classes.map((c) => [c.id as string, c]));
  const result: { definition: AttributeDefinition; fromCode: string }[] = [];
  const seen = new Set<string>();

  let cursor = draft.parentClassId === null ? undefined : byId.get(draft.parentClassId);
  const guard = new Set<string>();

  while (cursor !== undefined && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    for (const definition of cursor.attributes) {
      if (seen.has(definition.key)) continue;
      seen.add(definition.key);
      result.push({ definition, fromCode: cursor.code });
    }
    cursor = cursor.parentClassId !== null ? byId.get(cursor.parentClassId) : undefined;
  }

  return result;
}

/**
 * Valida el borrador de una clase.
 *
 * Los avisos de pérdida de datos llevan el número exacto de activos afectados,
 * porque «puede afectar a otros activos» no es información con la que decidir.
 */
export function validateClassDraft(
  draft: ClassDraft,
  options: ValidateClassOptions,
): readonly ClassProblem[] {
  const problems: ClassProblem[] = [];

  /* --- Código --- */

  const code = draft.code.trim();
  if (code.length === 0) {
    problems.push({ field: 'code', message: 'La clase necesita un código', severity: 'blocking' });
  } else if (!CODE_PATTERN.test(code)) {
    problems.push({
      field: 'code',
      message: 'El código admite mayúsculas, dígitos y guion bajo, y empieza por letra',
      severity: 'blocking',
    });
  } else {
    const clash = options.classes.find((c) => c.id !== draft.id && c.code === code);
    if (clash !== undefined) {
      problems.push({
        field: 'code',
        message: `Ese código ya lo usa la clase «${clash.name}»`,
        severity: 'blocking',
      });
    }
  }

  /* --- Nombre --- */

  if (draft.name.trim().length === 0) {
    problems.push({ field: 'name', message: 'La clase necesita un nombre', severity: 'blocking' });
  }

  /* --- Nivel --- */

  if (!hierarchyLevelSchema.safeParse(draft.level).success) {
    problems.push({ field: 'level', message: 'Nivel jerárquico no válido', severity: 'blocking' });
  }

  /* --- Herencia --- */

  if (draft.parentClassId !== null) {
    if (draft.parentClassId === draft.id) {
      problems.push({
        field: 'parentClassId',
        message: 'Una clase no puede heredar de sí misma',
        severity: 'blocking',
      });
    } else if (!options.classes.some((c) => c.id === draft.parentClassId)) {
      problems.push({
        field: 'parentClassId',
        message: 'La clase de la que hereda ya no existe en el proyecto',
        severity: 'blocking',
      });
    } else if (
      draft.id !== null &&
      !eligibleParentClasses(draft, options.classes).some((c) => c.id === draft.parentClassId)
    ) {
      problems.push({
        field: 'parentClassId',
        message: 'Esa clase hereda de esta; elegirla cerraría un ciclo de herencia',
        severity: 'blocking',
      });
    }
  }

  /* --- Atributos --- */

  const keys = new Map<string, number>();
  const heredados = new Map(
    inheritedAttributes(draft, options.classes).map((entry) => [
      entry.definition.key,
      entry.fromCode,
    ]),
  );

  draft.attributes.forEach((definition, index) => {
    const field = (part: string): string => `attributes.${index}.${part}`;

    if (definition.key.trim().length === 0) {
      problems.push({
        field: field('key'),
        message: 'El atributo necesita una clave',
        severity: 'blocking',
      });
    } else if (!KEY_PATTERN.test(definition.key)) {
      problems.push({
        field: field('key'),
        message: 'La clave admite minúsculas, dígitos y guion bajo, y empieza por letra',
        severity: 'blocking',
      });
    } else {
      const duplicate = keys.get(definition.key);
      if (duplicate !== undefined) {
        problems.push({
          field: field('key'),
          message: `La clave «${definition.key}» ya está en la posición ${duplicate + 1} de esta misma clase`,
          severity: 'blocking',
        });
      } else {
        keys.set(definition.key, index);
      }

      const from = heredados.get(definition.key);
      if (from !== undefined) {
        problems.push({
          field: field('key'),
          message: `Redefine «${definition.key}», heredado de ${from}; el valor de esta clase sustituye al suyo`,
          severity: 'advisory',
        });
      }
    }

    if (definition.label.trim().length === 0) {
      problems.push({
        field: field('label'),
        message: 'El atributo necesita una etiqueta visible',
        severity: 'blocking',
      });
    }

    if (definition.type === 'enum' && definition.options.length === 0) {
      problems.push({
        field: field('options'),
        message: 'Un atributo de lista necesita al menos un valor admitido',
        severity: 'blocking',
      });
    }

    if (definition.type === 'quantity' && (definition.unit ?? '').trim().length === 0) {
      // No se infiere la unidad: una presión de diseño sin unidad es un dato
      // inservible, y adivinarla es peor que exigirla.
      problems.push({
        field: field('unit'),
        message: 'Una magnitud necesita su unidad declarada; no se puede inferir',
        severity: 'blocking',
      });
    }
  });

  /* --- Consecuencias sobre los activos que ya existen --- */

  const previous = options.previous;
  if (previous !== null && draft.id !== null) {
    const afectados = affectedAssets(draft.id, options.classes, options.assets);
    const previousKeys = new Set(previous.attributes.map((a) => a.key));
    const draftKeys = new Set(draft.attributes.map((a) => a.key));

    const eliminadas = [...previousKeys].filter((key) => !draftKeys.has(key));
    if (eliminadas.length > 0 && afectados.length > 0) {
      const conDatos = afectados.filter((asset) =>
        eliminadas.some((key) => asset.attributes[key] !== undefined),
      );
      if (conDatos.length > 0) {
        problems.push({
          field: 'attributes',
          message:
            `Quitar ${eliminadas.map((k) => `«${k}»`).join(', ')} deja sin mostrar ese dato en ` +
            `${conDatos.length} activo(s) que lo tienen relleno. El valor sigue guardado y vuelve ` +
            `si se restaura la clave.`,
          severity: 'advisory',
        });
      }
    }

    const nuevasObligatorias = draft.attributes.filter(
      (definition) =>
        definition.required &&
        !previous.attributes.some((p) => p.key === definition.key && p.required),
    );
    for (const definition of nuevasObligatorias) {
      const incompletos = afectados.filter(
        (asset) =>
          asset.attributes[definition.key] === undefined ||
          asset.attributes[definition.key] === null ||
          asset.attributes[definition.key] === '',
      );
      if (incompletos.length > 0) {
        problems.push({
          field: 'attributes',
          message:
            `Hacer obligatorio «${definition.label}» deja incompletos ${incompletos.length} ` +
            `activo(s) que ya existen y no lo tienen relleno.`,
          severity: 'advisory',
        });
      }
    }

    if (previous.level !== draft.level && afectados.length > 0) {
      problems.push({
        field: 'level',
        message:
          `Cambiar el nivel habitual a «${draft.level}» no mueve los ${afectados.length} ` +
          `activo(s) existentes; sólo afecta a los avisos de la ficha.`,
        severity: 'advisory',
      });
    }
  }

  return problems;
}

/** `true` si el borrador de clase se puede guardar. */
export function canSaveClass(problems: readonly ClassProblem[]): boolean {
  return !problems.some((p) => p.severity === 'blocking');
}

/**
 * Comprueba si eliminar una clase es posible y qué arrastra.
 *
 * Una clase en uso no se borra: dejaría activos apuntando a una clase
 * inexistente y su ficha técnica quedaría vacía sin explicación. El mensaje
 * dice cuántos activos la usan para que el autor sepa qué reasignar.
 */
export function canDeleteClass(
  classId: Uuid,
  classes: readonly AssetClass[],
  assets: readonly Asset[],
): { readonly allowed: boolean; readonly reason: string } {
  const directos = assets.filter((asset) => asset.classId === classId);
  if (directos.length > 0) {
    return {
      allowed: false,
      reason:
        `${directos.length} activo(s) usan esta clase. Reasígnelos a otra clase antes de ` +
        `eliminarla; si se borrase, su ficha técnica quedaría vacía.`,
    };
  }

  const hijas = classes.filter((c) => c.parentClassId === classId);
  if (hijas.length > 0) {
    return {
      allowed: false,
      reason:
        `${hijas.length} clase(s) heredan de esta (${hijas.map((c) => c.code).join(', ')}). ` +
        `Cambie su herencia antes de eliminarla.`,
    };
  }

  if (classes.length <= 1) {
    return {
      allowed: false,
      reason: 'Es la única clase del proyecto, y un activo nuevo necesita al menos una.',
    };
  }

  return { allowed: true, reason: 'No hay activos ni clases que dependan de ella.' };
}

/** Atributo nuevo, con los valores por defecto del esquema. */
export function newAttribute(order: number): AttributeDefinition {
  return {
    key: '',
    label: '',
    type: 'text',
    unit: null,
    required: false,
    options: [],
    group: 'General',
    order,
    helpText: '',
  };
}

/** Borrador en blanco de clase. */
export function emptyClassDraft(level: HierarchyLevel = 'equipment'): ClassDraft {
  return {
    id: null,
    code: '',
    name: '',
    description: '',
    level,
    parentClassId: null,
    icon: 'equipment',
    attributes: [],
  };
}

/** Borrador a partir de una clase existente. */
export function classDraftFrom(assetClass: AssetClass): ClassDraft {
  return {
    id: assetClass.id,
    code: assetClass.code,
    name: assetClass.name,
    description: assetClass.description,
    level: assetClass.level,
    parentClassId: assetClass.parentClassId,
    icon: assetClass.icon,
    attributes: [...assetClass.attributes],
  };
}

/** Convierte un borrador validado en una clase. */
export function classDraftToClass(draft: ClassDraft, newId: Uuid): AssetClass {
  return {
    id: draft.id ?? newId,
    code: draft.code.trim(),
    name: draft.name.trim(),
    description: draft.description,
    level: draft.level,
    // El orden se renumera al guardar: el autor reordena arrastrando y no
    // teniendo que teclear números consecutivos a mano.
    attributes: draft.attributes.map((definition, index) => ({ ...definition, order: index })),
    icon: draft.icon,
    parentClassId: draft.parentClassId,
  };
}
