/**
 * Secciones de un proyecto para la revisión y el conflicto (X16, X17).
 *
 * El servicio de revisión no guarda el proyecto: guarda un resumen por
 * sección. Con eso puede decir «ambos tocasteis la escena 4 y el activo P-101»
 * sin haber visto ni una panorámica, y la edición sigue viviendo en el equipo
 * del autor, que es el diseño del producto.
 *
 * Lo que decide este módulo es **qué es una sección**, y la respuesta tiene
 * consecuencias prácticas:
 *
 * - Demasiado gruesa (el proyecto entero) y cualquier edición simultánea es un
 *   conflicto: el flujo se vuelve inservible y la gente lo rodea.
 * - Demasiado fina (cada campo) y el autor recibe una lista de doscientas
 *   diferencias que no le dice qué hacer.
 *
 * La unidad elegida es la que una persona reconoce como «su trabajo»: una
 * escena, un activo, un plano, una ventana, un recorrido, la interfaz. Es
 * también la unidad en la que se reparten las tareas en una planta.
 */
import type { Project } from './project';

/** Resumen de una sección: clave estable y huella de su contenido. */
export interface SectionDigest {
  readonly section: string;
  readonly digest: string;
}

/**
 * Función de huella sobre un valor.
 *
 * Recibe el valor y no su texto porque la serialización canónica —claves
 * ordenadas, sin espacios— vive en el paquete de persistencia, y el dominio no
 * depende de él. `sha256Canonical` encaja con esta firma tal cual.
 *
 * Que se reciba en lugar de importarse tiene además la ventaja de que una
 * prueba puede pasar una huella de juguete y comprobar la **composición** de
 * secciones sin depender de `crypto.subtle`, que no existe en todos los
 * entornos de prueba.
 */
export type DigestFn = (value: unknown) => Promise<string>;

/**
 * Secciones de un proyecto, en orden estable.
 *
 * El orden es alfabético por clave y no el del documento: así dos autores con
 * las mismas escenas en distinto orden de edición producen la misma lista, y
 * un reordenamiento no se confunde con un cambio de contenido.
 */
export async function projectSections(project: Project, digest: DigestFn): Promise<SectionDigest[]> {
  const parts: { section: string; value: unknown }[] = [];

  for (const scene of project.scenes) {
    parts.push({ section: `scene:${scene.id}`, value: scene });
  }
  for (const asset of project.assets) {
    parts.push({ section: `asset:${asset.id}`, value: asset });
  }
  for (const plan of project.plans) {
    parts.push({ section: `plan:${plan.id}`, value: plan });
  }
  for (const window of project.infoWindows) {
    parts.push({ section: `window:${window.id}`, value: window });
  }
  for (const tour of project.tours) {
    parts.push({ section: `tour:${tour.id}`, value: tour });
  }
  for (const skin of project.skins) {
    parts.push({ section: `skin:${skin.id}`, value: skin });
  }
  for (const quiz of project.quizzes) {
    parts.push({ section: `quiz:${quiz.id}`, value: quiz });
  }

  // Los medios van como una sección única: su contenido no se edita —se
  // sustituye— y una sección por archivo llenaría la lista de conflictos de
  // entradas que nadie ha tocado a mano.
  parts.push({
    section: 'media',
    value: project.media.map((item) => ({ id: item.id, sha256: item.sha256, relativePath: item.relativePath })),
  });

  // Los ajustes del proyecto que no pertenecen a ninguna sección anterior.
  parts.push({
    section: 'settings',
    value: {
      title: project.title,
      description: project.description,
      client: project.client,
      site: project.site,
      settings: project.settings,
      telemetryConnections: project.telemetryConnections,
      telemetryMappings: project.telemetryMappings,
      conditionRules: project.conditionRules,
    },
  });

  // Los marcadores de plano van con los planos y no sueltos: mover un
  // marcador es editar el plano desde el punto de vista de quien trabaja.
  parts.push({
    section: 'planMarkers',
    value: project.planMarkers,
  });

  // El catálogo de clases, los documentos y las notas se agrupan porque se
  // editan como listas y no pieza a pieza.
  parts.push({ section: 'assetClasses', value: project.assetClasses });
  parts.push({ section: 'assetLocations', value: project.assetLocations });
  parts.push({ section: 'documents', value: project.documents });
  parts.push({ section: 'notes', value: { categories: project.noteCategories, notes: project.notes } });

  const sections = await Promise.all(
    parts.map(async ({ section, value }) => ({
      section,
      digest: await digest(value),
    })),
  );

  return sections.sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : 0));
}

/** Pasa la lista a la forma que espera el servicio. */
export function sectionsToMap(sections: readonly SectionDigest[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { section, digest } of sections) map[section] = digest;
  return map;
}

/**
 * Huella del conjunto.
 *
 * Se calcula sobre la lista ya ordenada de resúmenes y no sobre el proyecto
 * entero: así dos proyectos con el mismo contenido y distinto orden interno
 * dan la misma huella, que es lo que permite detectar «esto ya se publicó».
 */
export async function projectDigest(
  sections: readonly SectionDigest[],
  digest: DigestFn,
): Promise<string> {
  return digest(sections.map(({ section, digest: value }) => [section, value]));
}

/** Nombre legible de una sección, para mostrar un conflicto. */
export function sectionLabel(section: string, project: Project): string {
  const [kind, id] = section.split(':');
  if (id === undefined) {
    return kind === 'media' ? 'Biblioteca de medios' : kind === 'settings' ? 'Ajustes del proyecto' : section;
  }

  const named = (items: readonly { readonly id: string; readonly title?: string; readonly name?: string }[]): string | null => {
    const found = items.find((item) => item.id === id);
    if (found === undefined) return null;
    return found.title ?? found.name ?? null;
  };

  switch (kind) {
    case 'scene':
      return `Escena «${named(project.scenes) ?? id}»`;
    case 'asset':
      return `Activo «${named(project.assets) ?? id}»`;
    case 'plan':
      return `Plano «${named(project.plans) ?? id}»`;
    case 'window':
      return `Ventana «${named(project.infoWindows) ?? id}»`;
    case 'tour':
      return `Recorrido «${named(project.tours) ?? id}»`;
    case 'skin':
      return `Interfaz «${named(project.skins) ?? id}»`;
    case 'quiz':
      return `Evaluación «${named(project.quizzes) ?? id}»`;
    default:
      // Una sección de una versión más nueva del editor: se muestra tal cual
      // en lugar de ocultarla, porque el conflicto es real aunque este
      // programa no sepa nombrarlo.
      return section;
  }
}
