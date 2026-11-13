/**
 * Etiquetas de escenas y marcadores (Y08).
 *
 * El esquema ya las admitía y nada en el editor las ponía. El problema de las
 * etiquetas libres no es guardarlas: es que se multipliquen sin que el autor
 * se entere. En una planta con cuarenta escenas, «Crítico», «critico» y
 * «crítico » son tres etiquetas distintas, el filtro devuelve un tercio de lo
 * que debería y nadie sabe por qué.
 *
 * La respuesta aquí tiene dos piezas deliberadas:
 *
 *  - **Se normaliza lo que no cambia el significado**: mayúsculas, espacios
 *    sobrantes y espacios internos. «Equipo Crítico » y «equipo crítico» son
 *    la misma etiqueta y se guardan igual.
 *  - **No se funden los acentos al guardar, pero sí al buscar.** Guardar
 *    «critico» por «crítico» estropearía la etiqueta que el autor lee en
 *    pantalla. En cambio, al buscar sí conviene que `#critico` encuentre
 *    «crítico», porque quien escribe deprisa omite la tilde. Y cuando el autor
 *    va a crear una etiqueta que sólo se diferencia por la tilde, se le avisa
 *    de la que ya existe en lugar de fundirlas por su cuenta: puede que
 *    quisiera dos.
 *
 * Ojo con el nombre: el «TAG» de un activo (`identity.ts`) es otra cosa — el
 * identificador de un equipo, como «P-101», que se normaliza en mayúsculas y
 * sin tocar los separadores porque un TAG inventado entra en el catálogo y
 * nadie lo revisa. Estas son etiquetas de organización, libres y en
 * minúsculas. Por eso las funciones de aquí llevan `TagLabel` en el nombre.
 */
import type { Project } from './project';
import type { Scene } from './scene';
import type { Hotspot } from './hotspot';

/** Longitud máxima que admite el esquema. */
export const MAX_TAG_LENGTH = 48;

/**
 * Forma canónica de una etiqueta.
 *
 * Minúsculas, sin espacios en los extremos y con los espacios internos
 * convertidos en guiones. Devuelve cadena vacía cuando no queda nada
 * aprovechable, que es como se rechaza una etiqueta en blanco.
 */
export function normalizeTagLabel(raw: string): string {
  const trimmed = raw
    .trim()
    .toLocaleLowerCase('es')
    // Los separadores que la gente teclea indistintamente.
    .replace(/[\s_]+/g, '-')
    // Un guion suelto al principio o al final no significa nada.
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return trimmed.slice(0, MAX_TAG_LENGTH);
}

/**
 * Clave de comparación: la forma canónica sin tildes ni diéresis.
 *
 * Sólo se usa para buscar y para detectar parecidos, nunca para guardar.
 */
export function tagLabelKey(raw: string): string {
  return normalizeTagLabel(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Añade una etiqueta si no estaba ya, en forma canónica. */
export function addTag(tags: readonly string[], raw: string): string[] {
  const tag = normalizeTagLabel(raw);
  if (tag === '') return [...tags];
  if (tags.some((existing) => existing === tag)) return [...tags];
  return [...tags, tag].sort((a, b) => a.localeCompare(b, 'es'));
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  const canonical = normalizeTagLabel(tag);
  return tags.filter((existing) => existing !== canonical);
}

/**
 * Etiquetas ya existentes que sólo se diferencian de la nueva en la tilde.
 *
 * Sirve para avisar antes de crear «critico» teniendo «crítico». No se funden
 * solas: puede que el autor quiera las dos, y deshacer una fusión automática
 * que nadie pidió es más trabajo que confirmarla.
 */
export function similarTags(existing: readonly string[], raw: string): string[] {
  const tag = normalizeTagLabel(raw);
  if (tag === '') return [];

  const key = tagLabelKey(raw);
  return existing.filter((candidate) => candidate !== tag && tagLabelKey(candidate) === key);
}

/* ------------------------------------------------------------------ *
 * Uso en el proyecto
 * ------------------------------------------------------------------ */

export interface TagUsage {
  readonly tag: string;
  readonly scenes: number;
  readonly hotspots: number;
  readonly total: number;
}

/** Recuento de uso de cada etiqueta del proyecto, de más usada a menos. */
export function tagUsage(project: Project): TagUsage[] {
  const scenes = new Map<string, number>();
  const hotspots = new Map<string, number>();

  for (const scene of project.scenes) {
    for (const tag of scene.tags) scenes.set(tag, (scenes.get(tag) ?? 0) + 1);
    for (const hotspot of scene.hotspots) {
      for (const tag of hotspot.tags) hotspots.set(tag, (hotspots.get(tag) ?? 0) + 1);
    }
  }

  const all = new Set<string>([...scenes.keys(), ...hotspots.keys()]);

  return [...all]
    .map((tag) => {
      const inScenes = scenes.get(tag) ?? 0;
      const inHotspots = hotspots.get(tag) ?? 0;
      return { tag, scenes: inScenes, hotspots: inHotspots, total: inScenes + inHotspots };
    })
    .sort((a, b) => b.total - a.total || a.tag.localeCompare(b.tag, 'es'));
}

/** Todas las etiquetas del proyecto, en orden alfabético. */
export const allTags = (project: Project): string[] =>
  tagUsage(project)
    .map((usage) => usage.tag)
    .sort((a, b) => a.localeCompare(b, 'es'));

/* ------------------------------------------------------------------ *
 * Reorganizar
 * ------------------------------------------------------------------ */

/** Aplica una transformación a las etiquetas de todo el proyecto. */
function mapProjectTags(
  project: Project,
  transform: (tags: readonly string[]) => string[],
): Project {
  const scenes: Scene[] = project.scenes.map((scene) => {
    const hotspots: Hotspot[] = scene.hotspots.map((hotspot) => ({
      ...hotspot,
      tags: transform(hotspot.tags),
    }));
    return { ...scene, tags: transform(scene.tags), hotspots };
  });

  return { ...project, scenes };
}

/**
 * Renombra una etiqueta en todo el proyecto.
 *
 * Si el destino ya existe, los dos conjuntos quedan fundidos: es lo que el
 * autor quiere decir al renombrar «critico» a «crítico», y dejar las dos
 * sería no haber hecho nada. La operación es la misma que fusionar, y por eso
 * la pantalla avisa cuando el destino existe.
 */
export function renameTagInProject(project: Project, from: string, to: string): Project {
  const source = normalizeTagLabel(from);
  const target = normalizeTagLabel(to);
  if (source === '' || target === '' || source === target) return project;

  return mapProjectTags(project, (tags) => {
    if (!tags.includes(source)) return [...tags];
    const kept = tags.filter((tag) => tag !== source && tag !== target);
    return [...kept, target].sort((a, b) => a.localeCompare(b, 'es'));
  });
}

/** Funde varias etiquetas en una sola. */
export function mergeTagsInProject(
  project: Project,
  sources: readonly string[],
  target: string,
): Project {
  const canonicalTarget = normalizeTagLabel(target);
  if (canonicalTarget === '') return project;

  const canonicalSources = new Set(
    sources.map(normalizeTagLabel).filter((tag) => tag !== '' && tag !== canonicalTarget),
  );
  if (canonicalSources.size === 0) return project;

  return mapProjectTags(project, (tags) => {
    if (!tags.some((tag) => canonicalSources.has(tag))) return [...tags];
    const kept = tags.filter((tag) => !canonicalSources.has(tag) && tag !== canonicalTarget);
    return [...kept, canonicalTarget].sort((a, b) => a.localeCompare(b, 'es'));
  });
}

/** Quita una etiqueta de todo el proyecto. */
export function deleteTagFromProject(project: Project, tag: string): Project {
  const canonical = normalizeTagLabel(tag);
  if (canonical === '') return project;
  return mapProjectTags(project, (tags) => tags.filter((existing) => existing !== canonical));
}

/* ------------------------------------------------------------------ *
 * Búsqueda (Y08)
 * ------------------------------------------------------------------ */

export interface SearchQuery {
  /** Texto libre, para buscar en títulos y nombres. */
  readonly text: string;
  /** Etiquetas pedidas con `#`, ya en clave de comparación. */
  readonly tags: readonly string[];
}

/**
 * Separa el texto libre de las etiquetas pedidas con `#`.
 *
 * «bomba #critico» busca lo que se llame «bomba» y además esté etiquetado como
 * crítico. Las etiquetas se guardan en clave de comparación para que `#critico`
 * encuentre «crítico»: quien escribe deprisa omite la tilde, y obligarle a
 * acertarla convertiría la búsqueda en un acertijo.
 */
export function parseSearchQuery(raw: string): SearchQuery {
  const tags: string[] = [];
  const words: string[] = [];

  for (const token of raw.trim().split(/\s+/)) {
    if (token === '') continue;
    if (token.startsWith('#') && token.length > 1) {
      const key = tagLabelKey(token.slice(1));
      if (key !== '') tags.push(key);
    } else {
      words.push(token);
    }
  }

  return { text: words.join(' ').toLocaleLowerCase('es'), tags };
}

/**
 * Si un elemento satisface la consulta.
 *
 * Las etiquetas se exigen todas (y lógico): pedir dos es acotar, no ampliar.
 * El texto libre se compara contra cualquiera de los campos dados.
 */
export function matchesSearch(
  query: SearchQuery,
  item: { readonly tags: readonly string[]; readonly fields: readonly string[] },
): boolean {
  if (query.tags.length > 0) {
    const keys = new Set(item.tags.map(tagLabelKey));
    if (!query.tags.every((tag) => keys.has(tag))) return false;
  }

  if (query.text === '') return true;

  return item.fields.some((field) => field.toLocaleLowerCase('es').includes(query.text));
}

/** `true` cuando la consulta no pide nada y debe mostrarse todo. */
export const isEmptyQuery = (query: SearchQuery): boolean =>
  query.text === '' && query.tags.length === 0;

/**
 * Sugerencias de etiqueta para lo que se está escribiendo tras `#`.
 *
 * Devuelve las etiquetas del proyecto que empiezan por el fragmento, y después
 * las que lo contienen: quien escribe «#cri» busca «crítico» antes que
 * «equipo-critico».
 */
export function suggestTags(available: readonly string[], fragment: string): string[] {
  const key = tagLabelKey(fragment);
  if (key === '') return [...available].sort((a, b) => a.localeCompare(b, 'es'));

  const starts: string[] = [];
  const contains: string[] = [];

  for (const tag of available) {
    const candidate = tagLabelKey(tag);
    if (candidate.startsWith(key)) starts.push(tag);
    else if (candidate.includes(key)) contains.push(tag);
  }

  const byName = (a: string, b: string): number => a.localeCompare(b, 'es');
  return [...starts.sort(byName), ...contains.sort(byName)];
}
