/**
 * Notas creadas en el recorrido publicado (P01).
 *
 * El requisito pide crear notas ancladas a puntos del recorrido publicado, y el
 * recorrido publicado es un sitio estático que puede estar funcionando sin red,
 * en una tableta, dentro de una planta. Eso impone el diseño:
 *
 * - **La nota se guarda primero en el navegador de quien la escribe.** No hay
 *   servidor garantizado. Si hubiera que esperar a uno, la nota se perdería
 *   justo cuando más falta hace: delante del equipo, sin cobertura.
 * - **Se entrega como un archivo que el autor importa al proyecto.** Es el
 *   único camino que funciona igual con servidor y sin él, y deja al autor del
 *   proyecto decidiendo qué entra, que es lo correcto: una observación de campo
 *   es una propuesta, no una escritura directa sobre el proyecto maestro.
 * - **La nota de campo no es una nota del proyecto hasta que se importa.** Se
 *   modela como un tipo aparte, con menos campos, porque quien la escribe en la
 *   planta no asigna responsables ni fija fechas comprometidas: describe lo que
 *   ve y dónde lo ve.
 *
 * La importación sigue el mismo patrón que el catálogo CSV —planificar, mostrar
 * el informe, aplicar— y por la misma razón: nada se escribe en el proyecto sin
 * que el autor haya visto qué se va a escribir.
 */
import { z } from 'zod';
import { anchorSchema } from './hotspot';
import { notePrioritySchema, type Note, type NoteCategory } from './note';
import { newUuid, uuidSchema, type Uuid } from './identity';
import type { Scene } from './scene';

export const FIELD_NOTE_FORMAT = 'it360.field-notes';
export const FIELD_NOTE_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Formato
 * ------------------------------------------------------------------ */

export const fieldNoteSchema = z.object({
  id: uuidSchema,
  /** Escena del recorrido donde se tomó. */
  sceneId: uuidSchema,
  /** Punto exacto al que apunta, en coordenadas de la escena. */
  anchor: anchorSchema,
  title: z.string().min(1).max(250),
  body: z.string().max(20_000).default(''),
  categoryId: z.string().max(64).default('other'),
  priority: notePrioritySchema.default('normal'),
  /**
   * Quien la escribió, tal como lo teclee.
   *
   * Es texto libre y no una cuenta: el recorrido publicado no autentica a
   * nadie. Al importar se marca como declarado, y no como verificado, porque
   * afirmar lo contrario sería falso.
   */
  authorName: z.string().min(1).max(200),
  createdAt: z.string().datetime({ offset: true }),
});

export type FieldNote = z.infer<typeof fieldNoteSchema>;

export const fieldNoteBundleSchema = z.object({
  format: z.literal(FIELD_NOTE_FORMAT),
  version: z.number().int().min(1),
  /** Proyecto del que salió el recorrido. Evita mezclar plantas. */
  projectId: uuidSchema,
  projectTitle: z.string().max(250).default(''),
  exportedAt: z.string().datetime({ offset: true }),
  notes: z.array(fieldNoteSchema),
});

export type FieldNoteBundle = z.infer<typeof fieldNoteBundleSchema>;

/** Crea una nota de campo a partir de lo que el visor recoge. */
export function createFieldNote(input: {
  readonly sceneId: Uuid;
  readonly yaw: number;
  readonly pitch: number;
  readonly title: string;
  readonly body: string;
  readonly categoryId: string;
  readonly priority: FieldNote['priority'];
  readonly authorName: string;
  readonly now: string;
}): FieldNote {
  return {
    id: newUuid(),
    sceneId: input.sceneId,
    anchor: { space: 'spherical', yaw: input.yaw, pitch: input.pitch },
    title: input.title.trim(),
    body: input.body.trim(),
    categoryId: input.categoryId,
    priority: input.priority,
    authorName: input.authorName.trim(),
    createdAt: input.now,
  };
}

/** Empaqueta las notas para entregarlas como archivo. */
export function bundleFieldNotes(
  notes: readonly FieldNote[],
  projectId: Uuid,
  projectTitle: string,
  now: string,
): FieldNoteBundle {
  return {
    format: FIELD_NOTE_FORMAT,
    version: FIELD_NOTE_VERSION,
    projectId,
    projectTitle,
    exportedAt: now,
    notes: [...notes],
  };
}

/* ------------------------------------------------------------------ *
 * Importación al proyecto
 * ------------------------------------------------------------------ */

export interface FieldNoteProblem {
  /** Título de la nota, o su identificador si no tiene título legible. */
  readonly label: string;
  readonly message: string;
}

export interface FieldNoteImportPlan {
  readonly toImport: readonly FieldNote[];
  readonly rejected: readonly FieldNoteProblem[];
  readonly warnings: readonly string[];
  /** Notas que ya se importaron en una ocasión anterior. */
  readonly duplicates: readonly FieldNote[];
  readonly applicable: boolean;
}

export interface FieldNoteImportOptions {
  readonly projectId: Uuid;
  readonly scenes: readonly Scene[];
  readonly categories: readonly NoteCategory[];
  readonly existingNotes: readonly Note[];
}

/**
 * Analiza un paquete de notas de campo sin tocar el proyecto.
 *
 * Rechaza por nota y no por archivo: de doce observaciones tomadas en planta,
 * una puede apuntar a una escena que el autor borró después, y perder las once
 * restantes por eso sería inaceptable —se tomaron una sola vez, delante del
 * equipo, y no se pueden volver a tomar—.
 */
export function planFieldNoteImport(
  bundle: unknown,
  options: FieldNoteImportOptions,
): FieldNoteImportPlan {
  const parsed = fieldNoteBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    return {
      toImport: [],
      rejected: [],
      duplicates: [],
      warnings: [
        'El archivo no es un paquete de notas de campo de INDUSTRIAL TWINS 360, o está dañado.',
      ],
      applicable: false,
    };
  }

  const data = parsed.data;
  const warnings: string[] = [];

  if (data.version > FIELD_NOTE_VERSION) {
    return {
      toImport: [],
      rejected: [],
      duplicates: [],
      warnings: [
        `El paquete usa la versión ${data.version} del formato y esta aplicación entiende hasta la ${FIELD_NOTE_VERSION}. Actualice la aplicación antes de importarlo.`,
      ],
      applicable: false,
    };
  }

  if (data.projectId !== options.projectId) {
    // No se importa entre proyectos: una observación anclada a un punto de otra
    // planta señalaría un sitio que aquí no existe, o peor, el equipo
    // equivocado.
    return {
      toImport: [],
      rejected: [],
      duplicates: [],
      warnings: [
        `Estas notas se tomaron en otro proyecto${data.projectTitle.length > 0 ? ` («${data.projectTitle}»)` : ''}. Ábralo para importarlas allí.`,
      ],
      applicable: false,
    };
  }

  const sceneIds = new Set(options.scenes.map((scene) => scene.id as string));
  const categoryIds = new Set(options.categories.map((category) => category.id));
  const alreadyImported = new Set(
    options.existingNotes
      .map((note) => fieldNoteOriginOf(note))
      .filter((origin): origin is string => origin !== null),
  );

  const rejected: FieldNoteProblem[] = [];
  const duplicates: FieldNote[] = [];
  const toImport: FieldNote[] = [];
  const seen = new Set<string>();

  for (const note of data.notes) {
    const label = note.title.length > 0 ? note.title : note.id;

    if (seen.has(note.id)) {
      rejected.push({ label, message: 'La nota aparece dos veces en el mismo archivo.' });
      continue;
    }
    seen.add(note.id);

    if (alreadyImported.has(note.id)) {
      duplicates.push(note);
      continue;
    }

    if (!sceneIds.has(note.sceneId)) {
      rejected.push({
        label,
        message: 'La panorámica donde se tomó ya no está en el proyecto.',
      });
      continue;
    }

    if (!categoryIds.has(note.categoryId)) {
      warnings.push(
        `«${label}» usa la categoría «${note.categoryId}», que este proyecto no define; se importa sin clasificar.`,
      );
    }

    toImport.push(note);
  }

  if (duplicates.length > 0) {
    warnings.push(
      `${duplicates.length} nota(s) ya se importaron antes y se omiten, para no duplicarlas.`,
    );
  }

  return {
    toImport,
    rejected,
    duplicates,
    warnings,
    applicable: toImport.length > 0,
  };
}

/** Marca con la que se registra el origen de una nota importada del campo. */
const ORIGIN_PREFIX = 'campo:';

/**
 * Identificador de la nota de campo de la que salió una nota del proyecto.
 *
 * Se guarda en `authorId` con un prefijo, en lugar de añadir un campo al
 * esquema, para que un proyecto guardado con esta versión siga abriéndose en
 * una anterior sin perder el dato. Devuelve `null` para las notas creadas en el
 * editor.
 */
export function fieldNoteOriginOf(note: Note): string | null {
  return note.authorId.startsWith(ORIGIN_PREFIX)
    ? note.authorId.slice(ORIGIN_PREFIX.length)
    : null;
}

/** `true` si la nota llegó desde el recorrido publicado. */
export const isFieldNote = (note: Note): boolean => fieldNoteOriginOf(note) !== null;

/**
 * Convierte una nota de campo en una nota del proyecto.
 *
 * Entra como `open` y sin responsable: quien la tomó describió lo que vio, y
 * decidir quién lo atiende es del responsable del proyecto. El nombre del autor
 * se marca como declarado porque el recorrido publicado no autentica a nadie, y
 * presentarlo como verificado sería mentir sobre la trazabilidad.
 */
export function fieldNoteToNote(
  note: FieldNote,
  options: {
    readonly projectId: Uuid;
    readonly knownCategoryIds: ReadonlySet<string>;
    readonly now: string;
  },
): Note {
  return {
    id: newUuid(),
    projectId: options.projectId,
    title: note.title,
    body: note.body,
    anchor: note.anchor,
    sceneId: note.sceneId,
    assetId: null,
    categoryId: options.knownCategoryIds.has(note.categoryId) ? note.categoryId : 'other',
    priority: note.priority,
    status: 'open',
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    attachments: [],
    comments: [],
    authorId: `${ORIGIN_PREFIX}${note.id}`,
    authorName: `${note.authorName} (declarado, desde el recorrido)`,
    createdAt: note.createdAt,
    updatedAt: options.now,
    resolvedAt: null,
    resolvedById: null,
    resolution: '',
  };
}

/** Aplica un plan de importación y devuelve la lista completa de notas. */
export function applyFieldNoteImport(
  plan: FieldNoteImportPlan,
  options: {
    readonly projectId: Uuid;
    readonly categories: readonly NoteCategory[];
    readonly existingNotes: readonly Note[];
    readonly now: string;
  },
): { readonly notes: readonly Note[]; readonly imported: number } {
  const known = new Set(options.categories.map((category) => category.id));
  const created = plan.toImport.map((note) =>
    fieldNoteToNote(note, { projectId: options.projectId, knownCategoryIds: known, now: options.now }),
  );

  return { notes: [...options.existingNotes, ...created], imported: created.length };
}

/** Resumen del plan en una línea, para mostrarlo antes de aplicar. */
export function describeFieldNotePlan(plan: FieldNoteImportPlan): string {
  if (!plan.applicable) {
    return plan.warnings.length > 0
      ? plan.warnings.join(' ')
      : 'No hay ninguna nota nueva que importar.';
  }

  const parts = [
    `${plan.toImport.length} nota(s) nueva(s)`,
    plan.duplicates.length > 0 ? `${plan.duplicates.length} ya importada(s)` : null,
    plan.rejected.length > 0 ? `${plan.rejected.length} rechazada(s)` : null,
  ].filter((part): part is string => part !== null);

  return parts.join(', ') + '.';
}
