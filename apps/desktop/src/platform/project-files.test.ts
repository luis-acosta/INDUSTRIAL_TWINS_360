/**
 * Pruebas de la capa de archivos.
 *
 * El riesgo que cubren es concreto: que «Guardar» no haga nada y no lo diga.
 * Fuera del contenedor no hay sistema de archivos, y la tentación al escribir
 * esta capa es devolver silencio —una promesa que se resuelve sin escribir—
 * porque así no hay que tratar el caso en la interfaz. El usuario cerraría la
 * aplicación convencido de haber guardado.
 *
 * El contenedor no se puede ejecutar aquí, así que lo que se comprueba es la
 * frontera: sin contenedor, cada operación devuelve un error explicativo; y el
 * contenido binario del paquete se reúne correctamente, que es la parte que sí
 * es lógica pura.
 */
import { describe, expect, it } from 'vitest';
import type { Media, Project } from '@it360/domain';
import { makeMedia, makeProject } from '@it360/domain/testing';
import {
  collectPackage,
  collectPackageFiles,
  createWorkspace,
  pickAndOpenProject,
  saveProject,
  saveProjectAs,
} from './project-files';

/** URL de datos con un contenido conocido. */
function dataUrl(text: string): string {
  return `data:application/octet-stream;base64,${btoa(text)}`;
}

describe('createWorkspace', () => {
  // TEST-PF-001
  it('no construye un espacio de trabajo fuera del contenedor', () => {
    // jsdom no es Tauri: no hay disco al que escribir.
    expect(createWorkspace()).toBeNull();
  });
});

describe('operaciones sin contenedor', () => {
  const project: Project = makeProject({});
  const files = new Map<string, Uint8Array>();

  // TEST-PF-002
  it('guardar devuelve un error y no finge haber escrito', async () => {
    const result = await saveProject(project, files, 'C:\\proyectos\\planta.ivp');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE_FAILED');
      // El mensaje tiene que servirle al usuario, no sólo al programador.
      expect(result.error.message).toContain('aplicación de escritorio');
      expect(result.error.recovery).toBeDefined();
    }
  });

  // TEST-PF-003
  it('guardar como devuelve el mismo error', async () => {
    const result = await saveProjectAs(project, files);
    expect(result.ok).toBe(false);
  });

  // TEST-PF-004
  it('abrir devuelve el mismo error', async () => {
    const result = await pickAndOpenProject();
    expect(result.ok).toBe(false);
  });
});

describe('collectPackageFiles', () => {
  // TEST-PF-005
  it('indexa el contenido por la ruta relativa que declara cada medio', () => {
    const media: Media = makeMedia(1, { relativePath: 'media/pano-1.jpg' });
    const project = makeProject({ media: [media] });
    const urls = new Map([[media.id, dataUrl('contenido-1')]]);

    const files = collectPackageFiles(project, urls);

    expect([...files.keys()]).toEqual(['media/pano-1.jpg']);
    expect(new TextDecoder().decode(files.get('media/pano-1.jpg'))).toBe('contenido-1');
  });

  // TEST-PF-006
  it('conserva los bytes que ya venían de un paquete abierto', () => {
    // Al guardar un proyecto abierto hay que reescribir el paquete completo.
    // Si estos bytes se perdieran, el archivo resultante no tendría imágenes.
    const media: Media = makeMedia(1, { relativePath: 'media/original.jpg' });
    const project = makeProject({ media: [media] });
    const existing = new Map([['media/original.jpg', new TextEncoder().encode('del paquete')]]);

    const files = collectPackageFiles(project, new Map(), existing);

    expect(new TextDecoder().decode(files.get('media/original.jpg'))).toBe('del paquete');
  });

  // TEST-PF-007
  it('los bytes del paquete tienen prioridad sobre una URL del navegador', () => {
    // Una URL `blob:` no se puede decodificar aquí, y sobrescribir con nada
    // dejaría el medio vacío en el archivo guardado.
    const media: Media = makeMedia(1, { relativePath: 'media/original.jpg' });
    const project = makeProject({ media: [media] });
    const existing = new Map([['media/original.jpg', new TextEncoder().encode('bueno')]]);
    const urls = new Map([[media.id, 'blob:http://localhost/9f3c']]);

    const files = collectPackageFiles(project, urls, existing);

    expect(new TextDecoder().decode(files.get('media/original.jpg'))).toBe('bueno');
  });

  // TEST-PF-008
  it('omite el medio cuyo contenido no se puede obtener en lugar de guardar basura', () => {
    const media: Media = makeMedia(1, { relativePath: 'media/perdido.jpg' });
    const project = makeProject({ media: [media] });

    const files = collectPackageFiles(project, new Map([[media.id, 'blob:http://localhost/x']]));

    // Preferible un paquete al que le falta un archivo —la verificación de
    // integridad lo detecta al abrir— que uno con un archivo de cero bytes
    // cuya suma no coincide y que parece corrupción del disco.
    expect(files.size).toBe(0);
  });

  // TEST-PF-009
  it('no duplica el contenido cuando dos medios comparten ruta', () => {
    // No debería ocurrir, pero si ocurre, la última escritura no debe
    // sobrescribir silenciosamente a la primera.
    const first: Media = makeMedia(1, { relativePath: 'media/choque.jpg' });
    const second: Media = makeMedia(2, { relativePath: 'media/choque.jpg' });
    const project = makeProject({ media: [first, second] });
    const urls = new Map([
      [first.id, dataUrl('primero')],
      [second.id, dataUrl('segundo')],
    ]);

    const files = collectPackageFiles(project, urls);

    expect(files.size).toBe(1);
    expect(new TextDecoder().decode(files.get('media/choque.jpg'))).toBe('primero');
  });
});

/* ------------------------------------------------------------------ *
 * Medios que no se pueden reunir (Y02)
 * ------------------------------------------------------------------ */

describe('collectPackage', () => {
  it('TEST-PKG-010 informa de los medios cuyos bytes no se pueden reunir', () => {
    // Es el fallo que esto persigue: antes se omitían en silencio, de modo que
    // un proyecto se exportaba sin una de sus panorámicas y el fallo lo
    // descubría quien lo recibía.
    const media = makeMedia(40, { originalName: 'nave.jpg', relativePath: 'media/nave.jpg' });
    const project = { ...makeProject(), media: [media] };

    const result = collectPackage(project, new Map());

    expect(result.files.size).toBe(0);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.originalName).toBe('nave.jpg');
  });

  it('TEST-PKG-011 una URL que no es de datos cuenta como ausente', () => {
    // Una URL de objeto no lleva los bytes consigo: no se puede empaquetar.
    const media = makeMedia(40, { originalName: 'nave.jpg', relativePath: 'media/nave.jpg' });
    const project = { ...makeProject(), media: [media] };

    const result = collectPackage(project, new Map([[media.id, 'blob:http://localhost/x']]));

    expect(result.missing).toHaveLength(1);
  });

  it('TEST-PKG-012 los medios ya presentes no se dan por ausentes', () => {
    const media = makeMedia(40, { relativePath: 'media/nave.jpg' });
    const project = { ...makeProject(), media: [media] };
    const existing = new Map([['media/nave.jpg', new Uint8Array([1, 2, 3])]]);

    const result = collectPackage(project, new Map(), existing);

    expect(result.missing).toEqual([]);
    expect(result.files.get('media/nave.jpg')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('TEST-PKG-013 un proyecto completo no reporta ausencias', () => {
    const media = makeMedia(40, { relativePath: 'media/nave.jpg' });
    const project = { ...makeProject(), media: [media] };
    const urls = new Map([[media.id, 'data:image/jpeg;base64,/9j/4AAQ']]);

    const result = collectPackage(project, urls);

    expect(result.missing).toEqual([]);
    expect(result.files.size).toBe(1);
  });

  it('TEST-PKG-014 un proyecto sin medios no reporta nada', () => {
    const result = collectPackage(makeProject(), new Map());
    expect(result.missing).toEqual([]);
    expect(result.files.size).toBe(0);
  });
});
