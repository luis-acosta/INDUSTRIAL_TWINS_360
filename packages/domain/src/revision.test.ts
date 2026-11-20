/**
 * Pruebas de las secciones de revisión.
 *
 * Lo que se verifica es la propiedad de la que depende todo el flujo de
 * conflictos: que la huella de una sección cambie **si y sólo si** cambió esa
 * sección. Si cambiara de más, cualquier edición simultánea sería un conflicto
 * y nadie usaría la revisión; si cambiara de menos, se publicaría encima del
 * trabajo de otro sin avisar.
 *
 * La huella es de juguete a propósito: aquí se comprueba la composición de
 * secciones, no la criptografía, y `crypto.subtle` no existe en todos los
 * entornos de prueba.
 */
import { describe, expect, it } from 'vitest';

import {
  projectDigest,
  projectSections,
  sectionLabel,
  sectionsToMap,
  type DigestFn,
} from './revision';
import { makeMedia, makeProject, makeScene, testUuid } from './testing';
import type { Project } from './project';

/** Huella determinista y legible: el JSON canónico de juguete. */
const digest: DigestFn = async (value) => stableJson(value);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

const PROJECT = testUuid(1);

function withScenes(): Project {
  return {
    ...makeProject(),
    scenes: [
      makeScene(10, PROJECT, { title: 'Nave principal' }),
      makeScene(11, PROJECT, { title: 'Sala de bombas' }),
    ],
  };
}

describe('projectSections', () => {
  it('produce una sección por escena', async () => {
    // TEST-RVS-001: la escena es la unidad en que una persona reconoce su
    // trabajo y en la que se reparten las tareas en una planta.
    const sections = await projectSections(withScenes(), digest);
    const keys = sections.map((s) => s.section);

    expect(keys).toContain(`scene:${testUuid(10)}`);
    expect(keys).toContain(`scene:${testUuid(11)}`);
  });

  it('devuelve las secciones en orden estable', async () => {
    // TEST-RVS-002: dos autores con las mismas escenas en distinto orden de
    // edición tienen que producir la misma lista; si no, reordenar sería un
    // cambio y todo el mundo tendría conflictos.
    const project = withScenes();
    const reversed: Project = { ...project, scenes: [...project.scenes].reverse() };

    const a = await projectSections(project, digest);
    const b = await projectSections(reversed, digest);

    expect(a.map((s) => s.section)).toEqual(b.map((s) => s.section));
    expect(a).toEqual(b);
  });

  it('cambia la huella de la escena que se edita y sólo esa', async () => {
    // TEST-RVS-003: es la propiedad de la que depende todo. Si cambiara de
    // más, cualquier edición simultánea sería conflicto.
    const before = await projectSections(withScenes(), digest);

    const project = withScenes();
    const edited: Project = {
      ...project,
      scenes: [{ ...project.scenes[0]!, title: 'Nave principal (rev. B)' }, project.scenes[1]!],
    };
    const after = await projectSections(edited, digest);

    const changed = after.filter((section) => {
      const previous = before.find((s) => s.section === section.section);
      return previous?.digest !== section.digest;
    });

    expect(changed.map((s) => s.section)).toEqual([`scene:${testUuid(10)}`]);
  });

  it('una escena borrada deja de tener sección', async () => {
    // TEST-RVS-004: la ausencia es lo que el servicio lee como borrado, y de
    // ahí sale el conflicto «borraste lo que otro cambió».
    const project = withScenes();
    const sections = await projectSections({ ...project, scenes: [project.scenes[0]!] }, digest);
    expect(sections.map((s) => s.section)).not.toContain(`scene:${testUuid(11)}`);
  });

  it('agrupa los medios en una sola sección', async () => {
    // TEST-RVS-005: un medio no se edita, se sustituye. Una sección por
    // archivo llenaría la lista de conflictos de entradas que nadie tocó.
    const sections = await projectSections(makeProject(), digest);
    expect(sections.filter((s) => s.section === 'media')).toHaveLength(1);
  });

  it('la sección de medios depende de la huella del archivo y no de su ruta sola', async () => {
    // TEST-RVS-006: si dependiera sólo de la ruta, sustituir una panorámica
    // por otra con el mismo nombre no se vería como un cambio, y es el cambio
    // más grande que se puede hacer en un recorrido.
    // El proyecto de prueba nace sin medios, así que se le añade uno: con la
    // guarda anterior («si no hay medios, salir») la prueba pasaba sin
    // comprobar nada, que es peor que no tenerla.
    const media = makeMedia(50, { kind: 'image' });
    const project: Project = { ...makeProject(), media: [media] };

    const before = await projectSections(project, digest);
    const changed = await projectSections(
      { ...project, media: [{ ...media, sha256: 'otra-huella' }] },
      digest,
    );

    const antes = before.find((s) => s.section === 'media')?.digest;
    const despues = changed.find((s) => s.section === 'media')?.digest;
    expect(despues).not.toBe(antes);
  });

  it('los ajustes del proyecto son su propia sección', async () => {
    // TEST-RVS-007: cambiar el título no debe marcar como editadas las
    // escenas, que es lo que pasaría con una sección única por proyecto.
    const project = makeProject();
    const before = await projectSections(project, digest);
    const after = await projectSections({ ...project, title: 'Otro título' }, digest);

    const changed = after.filter((section) => {
      const previous = before.find((s) => s.section === section.section);
      return previous?.digest !== section.digest;
    });
    expect(changed.map((s) => s.section)).toEqual(['settings']);
  });
});

describe('projectDigest', () => {
  it('no depende del orden interno del proyecto', async () => {
    // TEST-RVS-008: la huella del conjunto se usa para reconocer «esto ya se
    // publicó». Si dependiera del orden, reordenar escenas publicaría otra
    // vez lo mismo.
    const project = withScenes();
    const reversed: Project = { ...project, scenes: [...project.scenes].reverse() };

    const a = await projectDigest(await projectSections(project, digest), digest);
    const b = await projectDigest(await projectSections(reversed, digest), digest);
    expect(a).toBe(b);
  });

  it('cambia con cualquier cambio de contenido', async () => {
    // TEST-RVS-009: si no cambiara, una revisión distinta tendría la misma
    // huella y el histórico dejaría de distinguirlas.
    const project = withScenes();
    const a = await projectDigest(await projectSections(project, digest), digest);
    const b = await projectDigest(
      await projectSections({ ...project, description: 'Nueva descripción' }, digest),
      digest,
    );
    expect(a).not.toBe(b);
  });
});

describe('sectionsToMap', () => {
  it('pasa la lista a la forma del servicio', async () => {
    // TEST-RVS-010: el servicio trabaja con un objeto de clave a huella.
    const sections = await projectSections(withScenes(), digest);
    const map = sectionsToMap(sections);
    expect(Object.keys(map)).toHaveLength(sections.length);
    expect(map[`scene:${testUuid(10)}`]).toBeDefined();
  });
});

describe('sectionLabel', () => {
  it('nombra la escena en conflicto con su título', async () => {
    // TEST-RVS-011: «escena 7f3a-…» no le dice nada a nadie; «Sala de
    // bombas» le dice dónde mirar.
    const project = withScenes();
    expect(sectionLabel(`scene:${testUuid(11)}`, project)).toBe('Escena «Sala de bombas»');
  });

  it('usa el identificador cuando la pieza ya no existe', async () => {
    // TEST-RVS-012: ocurre con lo que el otro autor borró, que es justo un
    // caso de conflicto. Ocultarlo dejaría el conflicto sin explicar.
    const project = withScenes();
    expect(sectionLabel(`scene:${testUuid(99)}`, project)).toContain(testUuid(99));
  });

  it('nombra las secciones agrupadas', async () => {
    // TEST-RVS-013
    const project = withScenes();
    expect(sectionLabel('media', project)).toBe('Biblioteca de medios');
    expect(sectionLabel('settings', project)).toBe('Ajustes del proyecto');
  });

  it('muestra tal cual una sección que este editor no conoce', async () => {
    // TEST-RVS-014: una versión más nueva puede tener secciones que ésta no
    // sabe nombrar. El conflicto es real aunque el nombre no sea bonito, y
    // ocultarlo sería ocultar el conflicto.
    const project = withScenes();
    expect(sectionLabel('futuro:abc', project)).toBe('futuro:abc');
  });
});
