/**
 * Pruebas de las etiquetas de organización (Y08).
 *
 * El fallo que persiguen casi todas: que una etiqueta se multiplique sin que
 * el autor se entere. En una planta con cuarenta escenas, «Crítico»,
 * «critico» y «crítico » serían tres etiquetas, el filtro devolvería un tercio
 * de lo que debería y nadie sabría por qué.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TAG_LENGTH,
  addTag,
  allTags,
  deleteTagFromProject,
  isEmptyQuery,
  matchesSearch,
  mergeTagsInProject,
  normalizeTagLabel,
  parseSearchQuery,
  removeTag,
  renameTagInProject,
  similarTags,
  suggestTags,
  tagLabelKey,
  tagUsage,
} from './tags';
import { makeHotspot, makeProject, makeScene, testUuid } from './testing';
import type { Project } from './project';

const PROJECT = testUuid(1);

/** Proyecto con dos escenas y dos marcadores, cada uno con sus etiquetas. */
function tagged(): Project {
  const base = makeProject();
  const sceneA = makeScene(10, PROJECT, {
    title: 'Nave principal',
    tags: ['planta-baja', 'crítico'],
    hotspots: [
      makeHotspot(20, testUuid(10), { name: 'Bomba P-101', tags: ['crítico', 'bombas'] }),
    ],
  });
  const sceneB = makeScene(11, PROJECT, {
    title: 'Sala de bombas',
    tags: ['planta-baja'],
    hotspots: [makeHotspot(21, testUuid(11), { name: 'Válvula V-7', tags: ['bombas'] })],
  });

  return { ...base, scenes: [sceneA, sceneB] };
}

/* ------------------------------------------------------------------ *
 * Normalización
 * ------------------------------------------------------------------ */

describe('normalizeTagLabel', () => {
  it('TEST-TAG-001 mayúsculas y espacios sobrantes no crean etiquetas distintas', () => {
    expect(normalizeTagLabel('  Equipo Crítico  ')).toBe('equipo-crítico');
    expect(normalizeTagLabel('equipo crítico')).toBe('equipo-crítico');
    expect(normalizeTagLabel('EQUIPO_CRÍTICO')).toBe('equipo-crítico');
  });

  it('TEST-TAG-002 los separadores repetidos se colapsan', () => {
    expect(normalizeTagLabel('zona---norte')).toBe('zona-norte');
    expect(normalizeTagLabel('zona   norte')).toBe('zona-norte');
  });

  it('TEST-TAG-003 los guiones de los extremos se quitan', () => {
    expect(normalizeTagLabel('-crítico-')).toBe('crítico');
  });

  it('TEST-TAG-004 una etiqueta en blanco queda vacía, que es como se rechaza', () => {
    expect(normalizeTagLabel('   ')).toBe('');
    expect(normalizeTagLabel('---')).toBe('');
    expect(normalizeTagLabel('')).toBe('');
  });

  it('TEST-TAG-005 se respeta el límite del esquema', () => {
    const long = 'a'.repeat(80);
    expect(normalizeTagLabel(long)).toHaveLength(MAX_TAG_LENGTH);
  });

  it('TEST-TAG-006 las tildes se conservan al guardar', () => {
    // Guardar «critico» por «crítico» estropearía la etiqueta que el autor lee
    // en pantalla.
    expect(normalizeTagLabel('Crítico')).toBe('crítico');
    expect(normalizeTagLabel('Diseño')).toBe('diseño');
  });
});

describe('tagLabelKey', () => {
  it('TEST-TAG-007 la clave de comparación sí funde las tildes', () => {
    // Para buscar, no para guardar: quien escribe deprisa omite la tilde.
    expect(tagLabelKey('crítico')).toBe(tagLabelKey('critico'));
    expect(tagLabelKey('Diseño')).toBe('diseno');
  });

  it('TEST-TAG-008 etiquetas realmente distintas no comparten clave', () => {
    expect(tagLabelKey('bombas')).not.toBe(tagLabelKey('bomba'));
  });
});

/* ------------------------------------------------------------------ *
 * Asignar y quitar
 * ------------------------------------------------------------------ */

describe('addTag', () => {
  it('TEST-TAG-009 añadir la misma etiqueta dos veces no la duplica', () => {
    const once = addTag([], 'Crítico');
    expect(addTag(once, 'crítico')).toEqual(['crítico']);
  });

  it('TEST-TAG-010 las etiquetas quedan ordenadas', () => {
    let tags = addTag([], 'zona-norte');
    tags = addTag(tags, 'bombas');
    tags = addTag(tags, 'crítico');
    expect(tags).toEqual(['bombas', 'crítico', 'zona-norte']);
  });

  it('TEST-TAG-011 una etiqueta en blanco no se añade', () => {
    expect(addTag(['bombas'], '   ')).toEqual(['bombas']);
  });

  it('TEST-TAG-012 quitar usa la forma canónica', () => {
    expect(removeTag(['crítico', 'bombas'], 'CRÍTICO')).toEqual(['bombas']);
  });

  it('TEST-TAG-013 quitar algo que no está no cambia la lista', () => {
    expect(removeTag(['bombas'], 'crítico')).toEqual(['bombas']);
  });
});

describe('similarTags', () => {
  it('TEST-TAG-014 avisa de la etiqueta que sólo se diferencia en la tilde', () => {
    // No se funden solas: puede que el autor quiera las dos, y deshacer una
    // fusión que nadie pidió es más trabajo que confirmarla.
    expect(similarTags(['crítico', 'bombas'], 'critico')).toEqual(['crítico']);
  });

  it('TEST-TAG-015 la propia etiqueta no se cuenta como parecida', () => {
    expect(similarTags(['crítico'], 'Crítico')).toEqual([]);
  });

  it('TEST-TAG-016 sin parecidos la lista está vacía', () => {
    expect(similarTags(['bombas'], 'válvulas')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Uso en el proyecto
 * ------------------------------------------------------------------ */

describe('tagUsage', () => {
  it('TEST-TAG-017 cuenta por separado escenas y marcadores', () => {
    const usage = tagUsage(tagged());
    const critico = usage.find((u) => u.tag === 'crítico');

    expect(critico).toMatchObject({ scenes: 1, hotspots: 1, total: 2 });
  });

  it('TEST-TAG-018 ordena de más usada a menos', () => {
    const usage = tagUsage(tagged());
    expect(usage[0]?.total).toBeGreaterThanOrEqual(usage[1]?.total ?? 0);
  });

  it('TEST-TAG-019 un proyecto sin etiquetas no tiene ninguna', () => {
    expect(tagUsage(makeProject())).toEqual([]);
  });

  it('TEST-TAG-020 enumera todas las etiquetas en orden alfabético', () => {
    expect(allTags(tagged())).toEqual(['bombas', 'crítico', 'planta-baja']);
  });
});

/* ------------------------------------------------------------------ *
 * Reorganizar
 * ------------------------------------------------------------------ */

describe('renameTagInProject', () => {
  it('TEST-TAG-021 renombrar alcanza escenas y marcadores', () => {
    const result = renameTagInProject(tagged(), 'crítico', 'prioritario');
    const usage = tagUsage(result);

    expect(usage.find((u) => u.tag === 'crítico')).toBeUndefined();
    expect(usage.find((u) => u.tag === 'prioritario')).toMatchObject({ scenes: 1, hotspots: 1 });
  });

  it('TEST-TAG-022 renombrar al nombre de otra etiqueta las funde', () => {
    // Es lo que el autor quiere decir al renombrar «critico» a «crítico»;
    // dejar las dos sería no haber hecho nada.
    const result = renameTagInProject(tagged(), 'crítico', 'bombas');
    const bombas = tagUsage(result).find((u) => u.tag === 'bombas');

    expect(bombas).toMatchObject({ scenes: 1, hotspots: 2 });
    expect(tagUsage(result).find((u) => u.tag === 'crítico')).toBeUndefined();
  });

  it('TEST-TAG-023 fundir no deja la etiqueta repetida en el mismo elemento', () => {
    // El marcador tenía «crítico» y «bombas»; tras fundir debe quedar una.
    const result = renameTagInProject(tagged(), 'crítico', 'bombas');
    const hotspot = result.scenes[0]?.hotspots[0];

    expect(hotspot?.tags).toEqual(['bombas']);
  });

  it('TEST-TAG-024 renombrar a sí misma no cambia nada', () => {
    const project = tagged();
    expect(renameTagInProject(project, 'crítico', 'Crítico')).toBe(project);
  });

  it('TEST-TAG-025 renombrar a vacío no cambia nada', () => {
    const project = tagged();
    expect(renameTagInProject(project, 'crítico', '  ')).toBe(project);
  });

  it('TEST-TAG-026 los elementos sin esa etiqueta quedan intactos', () => {
    const result = renameTagInProject(tagged(), 'crítico', 'prioritario');
    expect(result.scenes[1]?.tags).toEqual(['planta-baja']);
  });
});

describe('mergeTagsInProject', () => {
  it('TEST-TAG-027 funde varias etiquetas en una', () => {
    const result = mergeTagsInProject(tagged(), ['crítico', 'bombas'], 'equipos');
    const usage = tagUsage(result);

    expect(usage.find((u) => u.tag === 'equipos')).toMatchObject({ scenes: 1, hotspots: 2 });
    expect(usage.find((u) => u.tag === 'crítico')).toBeUndefined();
    expect(usage.find((u) => u.tag === 'bombas')).toBeUndefined();
  });

  it('TEST-TAG-028 el destino puede ser una de las fundidas', () => {
    const result = mergeTagsInProject(tagged(), ['crítico', 'bombas'], 'bombas');
    expect(tagUsage(result).find((u) => u.tag === 'bombas')).toMatchObject({ hotspots: 2 });
  });

  it('TEST-TAG-029 sin origen válido no cambia nada', () => {
    const project = tagged();
    expect(mergeTagsInProject(project, [], 'equipos')).toBe(project);
    expect(mergeTagsInProject(project, ['equipos'], 'equipos')).toBe(project);
  });

  it('TEST-TAG-030 un destino en blanco no cambia nada', () => {
    const project = tagged();
    expect(mergeTagsInProject(project, ['crítico'], '  ')).toBe(project);
  });
});

describe('deleteTagFromProject', () => {
  it('TEST-TAG-031 quitar una etiqueta la borra de todo el proyecto', () => {
    const result = deleteTagFromProject(tagged(), 'crítico');
    expect(tagUsage(result).find((u) => u.tag === 'crítico')).toBeUndefined();
    expect(allTags(result)).toEqual(['bombas', 'planta-baja']);
  });

  it('TEST-TAG-032 las demás etiquetas del elemento se conservan', () => {
    const result = deleteTagFromProject(tagged(), 'crítico');
    expect(result.scenes[0]?.hotspots[0]?.tags).toEqual(['bombas']);
  });

  it('TEST-TAG-033 borrar una etiqueta inexistente no rompe nada', () => {
    const result = deleteTagFromProject(tagged(), 'inexistente');
    expect(allTags(result)).toEqual(['bombas', 'crítico', 'planta-baja']);
  });
});

/* ------------------------------------------------------------------ *
 * Búsqueda
 * ------------------------------------------------------------------ */

describe('parseSearchQuery', () => {
  it('TEST-TAG-034 separa el texto libre de las etiquetas', () => {
    const query = parseSearchQuery('bomba #critico');
    expect(query.text).toBe('bomba');
    expect(query.tags).toEqual(['critico']);
  });

  it('TEST-TAG-035 admite varias etiquetas', () => {
    const query = parseSearchQuery('#bombas #critico');
    expect(query.text).toBe('');
    expect(query.tags).toEqual(['bombas', 'critico']);
  });

  it('TEST-TAG-036 la tilde no hace falta al buscar', () => {
    expect(parseSearchQuery('#critico').tags).toEqual(parseSearchQuery('#crítico').tags);
  });

  it('TEST-TAG-037 una almohadilla suelta no es una etiqueta', () => {
    const query = parseSearchQuery('bomba #');
    expect(query.tags).toEqual([]);
    expect(query.text).toBe('bomba #');
  });

  it('TEST-TAG-038 una consulta vacía no pide nada', () => {
    expect(isEmptyQuery(parseSearchQuery('   '))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery('#bombas'))).toBe(false);
  });
});

describe('matchesSearch', () => {
  const item = { tags: ['crítico', 'bombas'], fields: ['Bomba P-101', 'Nave principal'] };

  it('TEST-TAG-039 una consulta vacía deja pasar todo', () => {
    expect(matchesSearch(parseSearchQuery(''), item)).toBe(true);
  });

  it('TEST-TAG-040 el texto se busca en cualquiera de los campos', () => {
    expect(matchesSearch(parseSearchQuery('p-101'), item)).toBe(true);
    expect(matchesSearch(parseSearchQuery('nave'), item)).toBe(true);
    expect(matchesSearch(parseSearchQuery('turbina'), item)).toBe(false);
  });

  it('TEST-TAG-041 la etiqueta se compara sin tildes', () => {
    expect(matchesSearch(parseSearchQuery('#critico'), item)).toBe(true);
  });

  it('TEST-TAG-042 varias etiquetas se exigen todas', () => {
    // Pedir dos es acotar, no ampliar.
    expect(matchesSearch(parseSearchQuery('#critico #bombas'), item)).toBe(true);
    expect(matchesSearch(parseSearchQuery('#critico #valvulas'), item)).toBe(false);
  });

  it('TEST-TAG-043 texto y etiqueta se exigen a la vez', () => {
    expect(matchesSearch(parseSearchQuery('bomba #critico'), item)).toBe(true);
    expect(matchesSearch(parseSearchQuery('turbina #critico'), item)).toBe(false);
  });

  it('TEST-TAG-044 un elemento sin etiquetas no satisface una consulta por etiqueta', () => {
    const plain = { tags: [], fields: ['Bomba P-101'] };
    expect(matchesSearch(parseSearchQuery('#critico'), plain)).toBe(false);
    expect(matchesSearch(parseSearchQuery('bomba'), plain)).toBe(true);
  });
});

describe('suggestTags', () => {
  const available = ['bombas', 'crítico', 'equipo-critico', 'planta-baja'];

  it('TEST-TAG-045 sin fragmento devuelve todas, ordenadas', () => {
    expect(suggestTags(available, '')).toEqual([
      'bombas',
      'crítico',
      'equipo-critico',
      'planta-baja',
    ]);
  });

  it('TEST-TAG-046 las que empiezan por el fragmento van primero', () => {
    // Quien escribe «cri» busca «crítico» antes que «equipo-critico».
    expect(suggestTags(available, 'cri')).toEqual(['crítico', 'equipo-critico']);
  });

  it('TEST-TAG-047 la tilde no hace falta para sugerir', () => {
    expect(suggestTags(available, 'crí')).toEqual(['crítico', 'equipo-critico']);
  });

  it('TEST-TAG-048 un fragmento sin coincidencias no sugiere nada', () => {
    expect(suggestTags(available, 'turbina')).toEqual([]);
  });
});
