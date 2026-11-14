/**
 * Pruebas de la preparación de imágenes al publicar (V01, V02).
 *
 * El codificador vive en Rust y se prueba con `cargo test`; lo que se prueba
 * aquí es el pegamento, y en particular lo que más daño haría si estuviera mal:
 * que el registro del medio quede de acuerdo con el archivo que de verdad se
 * escribe. Si se recodifica el archivo y el registro sigue diciendo la ruta, el
 * tamaño y la suma del original, el paquete afirma una suma que no es la de su
 * archivo y la comprobación de integridad falla en casa del cliente.
 *
 * Sin contenedor no hay codificador, así que estas pruebas recorren el camino
 * de copia —el de la versión web— y comprueban que se declara.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLISH_PROFILES,
  publishQualitySchema,
  type Project,
  type PublishQuality,
} from '@it360/domain';
import { makeMedia, makeProject } from '@it360/domain/testing';
import { prepareMediaForPublish, publishSummary } from './image-publish';

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(3);

function projectWith(quality: PublishQuality = PUBLISH_PROFILES.balanced): {
  project: Project;
  files: Map<string, Uint8Array>;
} {
  const base = makeProject();
  const pano = makeMedia(80, {
    kind: 'image',
    mime: 'image/jpeg',
    relativePath: 'media/panoramas/sala.jpg',
    originalName: 'sala.jpg',
    width: 12_000,
    height: 6_000,
    byteSize: 1_000,
  });

  return {
    project: {
      ...base,
      media: [pano],
      settings: { ...base.settings, publishQuality: quality },
    },
    files: new Map([['media/panoramas/sala.jpg', bytes(1_000)]]),
  };
}

describe('prepareMediaForPublish', () => {
  it('TEST-IPB-001 sin contenedor se copia y se dice, en lugar de fingir', async () => {
    // La versión web no puede recodificar. Callarlo haría creer al autor que
    // su paquete está optimizado cuando lleva los originales.
    const { project, files } = projectWith();
    const prepared = await prepareMediaForPublish(project, files);

    expect(prepared.files.get('media/panoramas/sala.jpg')).toBeDefined();
    expect(prepared.notes.join(' ')).toContain('sin recodificar');
  });

  it('TEST-IPB-002 el registro del medio no se toca si el archivo no cambia', async () => {
    // Actualizar la suma de un archivo que no se ha recodificado la haría
    // falsa, que es justo el fallo que esta capa debe evitar.
    const { project, files } = projectWith();
    const prepared = await prepareMediaForPublish(project, files);

    expect(prepared.project.media[0]).toEqual(project.media[0]);
  });

  it('TEST-IPB-003 un archivo que falta no se inventa ni rompe la preparación', async () => {
    const { project } = projectWith();
    const prepared = await prepareMediaForPublish(project, new Map());

    expect(prepared.files.size).toBe(0);
    // El registro se conserva: el exportador es quien denuncia la falta, y
    // cambiarlo aquí alteraría ese diagnóstico.
    expect(prepared.project.media).toHaveLength(1);
  });

  it('TEST-IPB-004 el teselado pedido se declara como no aplicado', async () => {
    // El visor carga la imagen completa: escribir la pirámide abultaría el
    // paquete y parecería una función terminada.
    const { project, files } = projectWith(publishQualitySchema.parse({ tiled: true }));
    const prepared = await prepareMediaForPublish(project, files);

    expect(prepared.notes.join(' ')).toContain('teselado todavía no se aplica');
    expect(prepared.project.media[0]?.tiles).toEqual([]);
  });

  it('TEST-IPB-005 pedir AVIF se declara en las notas', async () => {
    const { project, files } = projectWith(publishQualitySchema.parse({ format: 'avif' }));
    const prepared = await prepareMediaForPublish(project, files);

    expect(prepared.notes.join(' ')).toContain('AVIF');
  });

  it('TEST-IPB-006 se informa del progreso para poder mostrarlo', async () => {
    // Una publicación de cuarenta panorámicas tarda minutos: sin progreso, el
    // autor no sabe si sigue viva.
    const { project, files } = projectWith();
    const seen: number[] = [];

    await prepareMediaForPublish(project, files, (done) => seen.push(done));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(project.media.length);
  });

  it('TEST-IPB-007 un proyecto sin imágenes no produce advertencias', async () => {
    const base = makeProject();
    const prepared = await prepareMediaForPublish(base, new Map());

    expect(prepared.notes).toEqual([]);
    expect(prepared.originalBytes).toBe(0);
  });
});

describe('publishSummary', () => {
  it('TEST-IPB-008 dice cuánto se ha ahorrado de verdad', async () => {
    // Medido, no estimado: la cifra sale de los bytes escritos.
    const summary = publishSummary({
      project: makeProject(),
      files: new Map(),
      notes: [],
      originalBytes: 100_000_000,
      publishedBytes: 40_000_000,
    });

    expect(summary).toContain('100.0 MB');
    expect(summary).toContain('40.0 MB');
    expect(summary).toContain('60 % menos');
  });

  it('TEST-IPB-009 si el formato elegido pesa más, lo dice así', async () => {
    // Pasa con WebP sin pérdida, y el autor tiene que saberlo antes de
    // entregar el paquete, no después.
    const summary = publishSummary({
      project: makeProject(),
      files: new Map(),
      notes: [],
      originalBytes: 40_000_000,
      publishedBytes: 60_000_000,
    });

    expect(summary).toContain('más');
  });

  it('TEST-IPB-010 sin imágenes no se inventa un ahorro', async () => {
    const summary = publishSummary({
      project: makeProject(),
      files: new Map(),
      notes: [],
      originalBytes: 0,
      publishedBytes: 0,
    });

    expect(summary).toBe('Sin imágenes que preparar.');
  });
});
