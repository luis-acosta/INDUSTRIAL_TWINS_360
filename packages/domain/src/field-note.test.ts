import { describe, expect, it } from 'vitest';
import {
  applyFieldNoteImport,
  bundleFieldNotes,
  createFieldNote,
  describeFieldNotePlan,
  fieldNoteOriginOf,
  fieldNoteToNote,
  FIELD_NOTE_FORMAT,
  isFieldNote,
  planFieldNoteImport,
  type FieldNote,
} from './field-note';
import { DEFAULT_NOTE_CATEGORIES, type Note, type NoteCategory } from './note';
import { newUuid, type Uuid } from './identity';
import type { Scene } from './scene';

const NOW = '2026-06-01T08:00:00.000Z';
const LATER = '2026-06-02T10:00:00.000Z';
const PROJECT = newUuid();
const OTHER_PROJECT = newUuid();
const SCENE = newUuid();

const categories: readonly NoteCategory[] = DEFAULT_NOTE_CATEGORIES.map((category) => ({
  ...category,
  description: '',
}));

/** Escena mínima: sólo se usan su identificador y su presencia. */
function scene(id: Uuid): Scene {
  return {
    id,
    projectId: PROJECT,
    title: 'Sala de bombas',
    description: '',
    order: 0,
    kind: 'panorama',
    mediaId: newUuid(),
    camera: {
      initialView: { yaw: 0, pitch: 0, fov: 75 },
      zoom: { minFovDeg: 30, maxFovDeg: 100 },
      limits: { yawMin: null, yawMax: null, pitchMin: -85, pitchMax: 85 },
      motion: { speed: 1, inertia: 0.2, autoRotateDegPerS: 0 },
    },
    hotspots: [],
    model: null,
    northOffsetDeg: 0,
    captureAt: null,
    gps: null,
    skinId: null,
    published: true,
    ambientEffect: { kind: 'none', intensity: 0 },
  } as unknown as Scene;
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: newUuid(),
    projectId: PROJECT,
    title: 'Nota del editor',
    body: '',
    anchor: null,
    sceneId: null,
    assetId: null,
    categoryId: 'other',
    priority: 'normal',
    status: 'open',
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    attachments: [],
    comments: [],
    authorId: 'local',
    authorName: 'Usuario local',
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    resolvedById: null,
    resolution: '',
    ...over,
  };
}

const fieldNote = (over: Partial<FieldNote> = {}): FieldNote => ({
  ...createFieldNote({
    sceneId: SCENE,
    yaw: 1.2,
    pitch: -0.3,
    title: 'Goteo en la brida',
    body: 'Charco bajo la bomba.',
    categoryId: 'leak',
    priority: 'high',
    authorName: 'Operador de turno',
    now: NOW,
  }),
  ...over,
});

const opts = (over: Partial<Parameters<typeof planFieldNoteImport>[1]> = {}) => ({
  projectId: PROJECT,
  scenes: [scene(SCENE)],
  categories,
  existingNotes: [] as readonly Note[],
  ...over,
});

/* ------------------------------------------------------------------ *
 * Creación y empaquetado
 * ------------------------------------------------------------------ */

describe('createFieldNote', () => {
  it('TEST-FLD-001 ancla la nota al punto que se estaba mirando', () => {
    const result = fieldNote();
    expect(result.anchor).toEqual({ space: 'spherical', yaw: 1.2, pitch: -0.3 });
    expect(result.sceneId).toBe(SCENE);
  });

  it('TEST-FLD-002 recorta los espacios del título, el cuerpo y el autor', () => {
    const result = createFieldNote({
      sceneId: SCENE,
      yaw: 0,
      pitch: 0,
      title: '  Fuga  ',
      body: '  Goteo  ',
      categoryId: 'leak',
      priority: 'normal',
      authorName: '  Ana  ',
      now: NOW,
    });
    expect(result.title).toBe('Fuga');
    expect(result.body).toBe('Goteo');
    expect(result.authorName).toBe('Ana');
  });

  it('TEST-FLD-003 cada nota recibe su propio identificador', () => {
    expect(fieldNote().id).not.toBe(fieldNote().id);
  });
});

describe('bundleFieldNotes', () => {
  it('TEST-FLD-004 empaqueta con formato, versión y proyecto de origen', () => {
    const bundle = bundleFieldNotes([fieldNote()], PROJECT, 'Planta Norte', LATER);
    expect(bundle.format).toBe(FIELD_NOTE_FORMAT);
    expect(bundle.version).toBe(1);
    expect(bundle.projectId).toBe(PROJECT);
    expect(bundle.projectTitle).toBe('Planta Norte');
    expect(bundle.exportedAt).toBe(LATER);
    expect(bundle.notes).toHaveLength(1);
  });

  it('TEST-FLD-005 el paquete sobrevive a un viaje por JSON', () => {
    // Es el viaje real: el visor lo descarga como archivo y el editor lo lee.
    const bundle = bundleFieldNotes([fieldNote()], PROJECT, 'Planta Norte', LATER);
    const roundTrip = JSON.parse(JSON.stringify(bundle)) as unknown;

    const plan = planFieldNoteImport(roundTrip, opts());
    expect(plan.applicable).toBe(true);
    expect(plan.toImport).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Plan de importación
 * ------------------------------------------------------------------ */

describe('planFieldNoteImport', () => {
  it('TEST-FLD-006 acepta un paquete válido', () => {
    const bundle = bundleFieldNotes([fieldNote(), fieldNote()], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts());

    expect(plan.toImport).toHaveLength(2);
    expect(plan.rejected).toEqual([]);
    expect(plan.applicable).toBe(true);
  });

  it('TEST-FLD-007 rechaza un archivo que no es un paquete de notas', () => {
    const plan = planFieldNoteImport({ cualquier: 'cosa' }, opts());
    expect(plan.applicable).toBe(false);
    expect(plan.warnings[0]).toContain('no es un paquete');
  });

  it('TEST-FLD-008 rechaza texto suelto sin lanzar', () => {
    expect(planFieldNoteImport('no es json', opts()).applicable).toBe(false);
    expect(planFieldNoteImport(null, opts()).applicable).toBe(false);
    expect(planFieldNoteImport([], opts()).applicable).toBe(false);
  });

  it('TEST-FLD-009 no importa notas de otro proyecto', () => {
    // Una observación anclada a un punto de otra planta señalaría un sitio que
    // aquí no existe, o peor, el equipo equivocado.
    const bundle = bundleFieldNotes([fieldNote()], OTHER_PROJECT, 'Planta Sur', LATER);
    const plan = planFieldNoteImport(bundle, opts());

    expect(plan.applicable).toBe(false);
    expect(plan.warnings[0]).toContain('Planta Sur');
  });

  it('TEST-FLD-010 rechaza un paquete de una versión futura del formato', () => {
    const bundle = { ...bundleFieldNotes([fieldNote()], PROJECT, 'Planta', LATER), version: 99 };
    const plan = planFieldNoteImport(bundle, opts());

    expect(plan.applicable).toBe(false);
    expect(plan.warnings[0]).toContain('Actualice la aplicación');
  });

  it('TEST-FLD-011 una nota con escena inexistente no cancela las demás', () => {
    // Las notas se tomaron una sola vez, delante del equipo, y no se pueden
    // volver a tomar: perder once por una sería inaceptable.
    const buena = fieldNote();
    const huerfana = fieldNote({ sceneId: newUuid(), title: 'Nota sin escena' });
    const bundle = bundleFieldNotes([huerfana, buena], PROJECT, 'Planta', LATER);

    const plan = planFieldNoteImport(bundle, opts());
    expect(plan.toImport.map((n) => n.id)).toEqual([buena.id]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.label).toBe('Nota sin escena');
    expect(plan.rejected[0]?.message).toContain('panorámica');
  });

  it('TEST-FLD-012 avisa de una categoría que el proyecto no define, sin rechazar la nota', () => {
    const bundle = bundleFieldNotes(
      [fieldNote({ categoryId: 'vibracion', title: 'Ruido en el acople' })],
      PROJECT,
      'Planta',
      LATER,
    );
    const plan = planFieldNoteImport(bundle, opts());

    expect(plan.toImport).toHaveLength(1);
    expect(plan.warnings.some((w) => w.includes('vibracion'))).toBe(true);
  });

  it('TEST-FLD-013 omite las notas ya importadas en lugar de duplicarlas', () => {
    // El operador puede entregar el mismo archivo dos veces; duplicar las
    // observaciones falsearía el recuento de pendientes.
    const original = fieldNote();
    const yaImportada = fieldNoteToNote(original, {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: NOW,
    });

    const bundle = bundleFieldNotes([original, fieldNote()], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts({ existingNotes: [yaImportada] }));

    expect(plan.toImport).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.warnings.some((w) => w.includes('ya se importaron'))).toBe(true);
  });

  it('TEST-FLD-014 rechaza la nota repetida dentro del mismo archivo', () => {
    const repetida = fieldNote();
    const bundle = bundleFieldNotes([repetida, repetida], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts());

    expect(plan.toImport).toHaveLength(1);
    expect(plan.rejected[0]?.message).toContain('dos veces');
  });

  it('TEST-FLD-015 un paquete sin notas no es aplicable', () => {
    const plan = planFieldNoteImport(bundleFieldNotes([], PROJECT, 'Planta', LATER), opts());
    expect(plan.applicable).toBe(false);
  });

  it('TEST-FLD-016 las notas del editor no se confunden con las ya importadas', () => {
    // `fieldNoteOriginOf` devuelve null para las del editor; si no, la primera
    // nota creada a mano haría que el importador se saltara notas de campo.
    const bundle = bundleFieldNotes([fieldNote()], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts({ existingNotes: [note(), note()] }));

    expect(plan.toImport).toHaveLength(1);
    expect(plan.duplicates).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Conversión y aplicación
 * ------------------------------------------------------------------ */

describe('fieldNoteToNote', () => {
  it('TEST-FLD-017 entra abierta, sin responsable y sin fecha comprometida', () => {
    // Quien la tomó describió lo que vio; decidir quién lo atiende es del
    // responsable del proyecto.
    const result = fieldNoteToNote(fieldNote(), {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: LATER,
    });

    expect(result.status).toBe('open');
    expect(result.assigneeId).toBeNull();
    expect(result.dueDate).toBeNull();
    expect(result.resolution).toBe('');
  });

  it('TEST-FLD-018 marca el autor como declarado y no como verificado', () => {
    // El recorrido publicado no autentica a nadie; presentarlo como verificado
    // sería mentir sobre la trazabilidad.
    const result = fieldNoteToNote(fieldNote({ authorName: 'Ana Pérez' }), {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: LATER,
    });

    expect(result.authorName).toContain('Ana Pérez');
    expect(result.authorName).toContain('declarado');
  });

  it('TEST-FLD-019 conserva el ancla, la escena y la fecha en que se tomó', () => {
    const original = fieldNote();
    const result = fieldNoteToNote(original, {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: LATER,
    });

    expect(result.anchor).toEqual(original.anchor);
    expect(result.sceneId).toBe(original.sceneId);
    // La fecha de creación es la del campo, no la de la importación: cuándo se
    // vio el problema es el dato que importa.
    expect(result.createdAt).toBe(NOW);
    expect(result.updatedAt).toBe(LATER);
  });

  it('TEST-FLD-020 una categoría desconocida cae en «other» y no inventa una', () => {
    const result = fieldNoteToNote(fieldNote({ categoryId: 'vibracion' }), {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: LATER,
    });
    expect(result.categoryId).toBe('other');
  });

  it('TEST-FLD-021 queda marcada como procedente del campo y se puede rastrear', () => {
    const original = fieldNote();
    const result = fieldNoteToNote(original, {
      projectId: PROJECT,
      knownCategoryIds: new Set(categories.map((c) => c.id)),
      now: LATER,
    });

    expect(isFieldNote(result)).toBe(true);
    expect(fieldNoteOriginOf(result)).toBe(original.id);
    expect(isFieldNote(note())).toBe(false);
    expect(fieldNoteOriginOf(note())).toBeNull();
  });
});

describe('applyFieldNoteImport', () => {
  it('TEST-FLD-022 añade las notas nuevas conservando las que ya había', () => {
    const existente = note();
    const bundle = bundleFieldNotes([fieldNote(), fieldNote()], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts({ existingNotes: [existente] }));

    const result = applyFieldNoteImport(plan, {
      projectId: PROJECT,
      categories,
      existingNotes: [existente],
      now: LATER,
    });

    expect(result.imported).toBe(2);
    expect(result.notes).toHaveLength(3);
    expect(result.notes.some((n) => n.id === existente.id)).toBe(true);
  });

  it('TEST-FLD-023 importar dos veces el mismo archivo no duplica nada', () => {
    const bundle = bundleFieldNotes([fieldNote()], PROJECT, 'Planta', LATER);

    const primera = planFieldNoteImport(bundle, opts());
    const tras = applyFieldNoteImport(primera, {
      projectId: PROJECT,
      categories,
      existingNotes: [],
      now: LATER,
    });
    expect(tras.imported).toBe(1);

    const segunda = planFieldNoteImport(bundle, opts({ existingNotes: tras.notes }));
    expect(segunda.applicable).toBe(false);
    expect(segunda.duplicates).toHaveLength(1);
  });
});

describe('describeFieldNotePlan', () => {
  it('TEST-FLD-024 resume lo nuevo, lo repetido y lo rechazado', () => {
    const buena = fieldNote();
    const huerfana = fieldNote({ sceneId: newUuid() });
    const bundle = bundleFieldNotes([buena, huerfana], PROJECT, 'Planta', LATER);
    const plan = planFieldNoteImport(bundle, opts());

    const summary = describeFieldNotePlan(plan);
    expect(summary).toContain('1 nota(s) nueva(s)');
    expect(summary).toContain('1 rechazada(s)');
  });

  it('TEST-FLD-025 explica por qué no se puede aplicar', () => {
    const bundle = bundleFieldNotes([fieldNote()], OTHER_PROJECT, 'Planta Sur', LATER);
    expect(describeFieldNotePlan(planFieldNoteImport(bundle, opts()))).toContain('otro proyecto');
  });
});
