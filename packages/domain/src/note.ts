/**
 * Notas, tareas y colaboración local (etapa 06, grupo P y X08).
 *
 * El requisito dice «utilizables sin servidor», y eso define el diseño: la
 * nota es un registro local completo, con su hilo de comentarios y sus
 * adjuntos dentro del propio paquete del proyecto. Cuando la etapa 11 añade
 * el servidor, lo que se sincroniza son estos mismos registros; no hay un
 * modelo «local» y otro «de servidor» que haya que reconciliar.
 */
import { z } from 'zod';
import { anchorSchema } from './hotspot';
import { uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Ciclo de vida (P08, X08)
 * ------------------------------------------------------------------ */

/**
 * Estados de una nota.
 *
 * `resolved` y `archived` son distintos: resolver dice «esto ya está hecho»
 * y archivar dice «esto ya no interesa ver». Una nota resuelta sigue
 * contando en el histórico del activo; una archivada desaparece de los
 * listados. Fundirlos obligaría a borrar para limpiar la vista.
 */
export const noteStatusSchema = z.enum(['open', 'inProgress', 'blocked', 'resolved', 'archived']);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

export const NOTE_STATUS_LABELS: Readonly<Record<NoteStatus, string>> = {
  open: 'Abierta',
  inProgress: 'En curso',
  blocked: 'Bloqueada',
  resolved: 'Resuelta',
  archived: 'Archivada',
};

/** Transiciones admitidas. Un estado no puede saltar a cualquier otro. */
export const NOTE_TRANSITIONS: Readonly<Record<NoteStatus, readonly NoteStatus[]>> = {
  open: ['inProgress', 'blocked', 'resolved', 'archived'],
  inProgress: ['open', 'blocked', 'resolved'],
  blocked: ['open', 'inProgress', 'resolved'],
  // Reabrir una nota resuelta es legítimo: la causa puede repetirse.
  resolved: ['open', 'archived'],
  // Una nota archivada sólo se recupera a «abierta», nunca a un estado intermedio.
  archived: ['open'],
};

export const canTransition = (from: NoteStatus, to: NoteStatus): boolean =>
  from === to || NOTE_TRANSITIONS[from].includes(to);

export const notePrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type NotePriority = z.infer<typeof notePrioritySchema>;

export const NOTE_PRIORITY_LABELS: Readonly<Record<NotePriority, string>> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export const NOTE_PRIORITY_WEIGHT: Readonly<Record<NotePriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/* ------------------------------------------------------------------ *
 * Categorías (P03)
 * ------------------------------------------------------------------ */

/**
 * Categorías predefinidas, alineadas con el vocabulario de una inspección de
 * planta. Son un punto de partida editable: cada cliente tiene su taxonomía y
 * forzarle la nuestra haría que todo acabara en «Otro».
 */
export const DEFAULT_NOTE_CATEGORIES = [
  { id: 'safety', label: 'Seguridad', colorToken: 'alarm' },
  { id: 'maintenance', label: 'Mantenimiento', colorToken: 'warning' },
  { id: 'corrosion', label: 'Corrosión', colorToken: 'warning' },
  { id: 'leak', label: 'Fuga', colorToken: 'alarm' },
  { id: 'instrumentation', label: 'Instrumentación', colorToken: 'info' },
  { id: 'housekeeping', label: 'Orden y limpieza', colorToken: 'neutral' },
  { id: 'documentation', label: 'Documentación', colorToken: 'info' },
  { id: 'improvement', label: 'Mejora', colorToken: 'nominal' },
  { id: 'other', label: 'Otro', colorToken: 'neutral' },
] as const;

export const noteCategorySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_\-]*$/, 'El identificador de categoría admite minúsculas, dígitos, - y _'),
  label: z.string().min(1).max(120),
  colorToken: z
    .enum(['accent', 'nominal', 'warning', 'alarm', 'info', 'experimental', 'neutral'])
    .default('neutral'),
  description: z.string().max(500).default(''),
});

export type NoteCategory = z.infer<typeof noteCategorySchema>;

/* ------------------------------------------------------------------ *
 * Adjuntos (P06)
 * ------------------------------------------------------------------ */

export const attachmentSchema = z.object({
  id: uuidSchema,
  mediaId: uuidSchema.nullable().default(null),
  /** Enlace externo, cuando el adjunto no es un archivo del paquete. */
  url: z.string().url().nullable().default(null),
  caption: z.string().max(500).default(''),
  createdAt: z.string().datetime({ offset: true }),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/* ------------------------------------------------------------------ *
 * Comentarios (P02)
 * ------------------------------------------------------------------ */

export const commentSchema = z.object({
  id: uuidSchema,
  noteId: uuidSchema,
  /** Autor. En modo local es el usuario del equipo; con servidor, su cuenta. */
  authorId: z.string().min(1).max(120),
  authorName: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  attachments: z.array(attachmentSchema).default([]),
  createdAt: z.string().datetime({ offset: true }),
  /** Momento de la última edición; `null` si no se ha editado. */
  editedAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export type Comment = z.infer<typeof commentSchema>;

/* ------------------------------------------------------------------ *
 * Nota
 * ------------------------------------------------------------------ */

export const noteSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  title: z.string().min(1).max(250),
  body: z.string().max(20_000).default(''),
  /** Punto del recorrido al que está anclada (P01). */
  anchor: anchorSchema.nullable().default(null),
  sceneId: uuidSchema.nullable().default(null),
  /** Activo al que se refiere, si aplica (X08). */
  assetId: uuidSchema.nullable().default(null),
  categoryId: z.string().max(64).default('other'),
  priority: notePrioritySchema.default('normal'),
  status: noteStatusSchema.default('open'),
  /** Responsable asignado (P05, X08). */
  assigneeId: z.string().max(120).nullable().default(null),
  assigneeName: z.string().max(200).nullable().default(null),
  /** Fecha comprometida, si se fijó. */
  dueDate: z.string().datetime({ offset: true }).nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
  comments: z.array(commentSchema).default([]),
  authorId: z.string().min(1).max(120),
  authorName: z.string().min(1).max(200),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable().default(null),
  resolvedById: z.string().max(120).nullable().default(null),
  /** Resumen de cómo se resolvió; obligatorio al resolver desde la interfaz. */
  resolution: z.string().max(5000).default(''),
});

export type Note = z.infer<typeof noteSchema>;

/** `true` si la nota es una tarea: tiene responsable o fecha comprometida. */
export const isTask = (note: Note): boolean =>
  note.assigneeId !== null || note.dueDate !== null;

/** `true` si la fecha comprometida ya pasó y la nota sigue sin resolver. */
export function isOverdue(note: Note, now: Date): boolean {
  if (note.dueDate === null) return false;
  if (note.status === 'resolved' || note.status === 'archived') return false;
  const due = Date.parse(note.dueDate);
  return !Number.isNaN(due) && due < now.getTime();
}

/* ------------------------------------------------------------------ *
 * Filtros y orden
 * ------------------------------------------------------------------ */

export const noteFilterSchema = z.object({
  statuses: z.array(noteStatusSchema).default([]),
  priorities: z.array(notePrioritySchema).default([]),
  categoryIds: z.array(z.string().max(64)).default([]),
  assigneeIds: z.array(z.string().max(120)).default([]),
  sceneIds: z.array(uuidSchema).default([]),
  assetIds: z.array(uuidSchema).default([]),
  /** Búsqueda en título, cuerpo y comentarios. */
  query: z.string().max(200).default(''),
  onlyOverdue: z.boolean().default(false),
  onlyWithAttachments: z.boolean().default(false),
});

export type NoteFilter = z.infer<typeof noteFilterSchema>;

export const EMPTY_NOTE_FILTER: NoteFilter = {
  statuses: [],
  priorities: [],
  categoryIds: [],
  assigneeIds: [],
  sceneIds: [],
  assetIds: [],
  query: '',
  onlyOverdue: false,
  onlyWithAttachments: false,
};

/** Normaliza texto para búsqueda: minúsculas y sin diacríticos. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Aplica un filtro a un listado de notas.
 *
 * Un array vacío en un criterio significa «no filtres por esto», no «ninguno
 * coincide». Es la convención opuesta a la literal y la única que hace
 * utilizable un panel con ocho filtros: el estado inicial no oculta nada.
 */
export function filterNotes(notes: readonly Note[], filter: NoteFilter, now: Date): Note[] {
  const needle = normalizeForSearch(filter.query.trim());

  return notes.filter((note) => {
    if (filter.statuses.length > 0 && !filter.statuses.includes(note.status)) return false;
    if (filter.priorities.length > 0 && !filter.priorities.includes(note.priority)) return false;
    if (filter.categoryIds.length > 0 && !filter.categoryIds.includes(note.categoryId)) return false;
    if (filter.assigneeIds.length > 0) {
      if (note.assigneeId === null || !filter.assigneeIds.includes(note.assigneeId)) return false;
    }
    if (filter.sceneIds.length > 0) {
      if (note.sceneId === null || !filter.sceneIds.includes(note.sceneId)) return false;
    }
    if (filter.assetIds.length > 0) {
      if (note.assetId === null || !filter.assetIds.includes(note.assetId)) return false;
    }
    if (filter.onlyOverdue && !isOverdue(note, now)) return false;
    if (filter.onlyWithAttachments && note.attachments.length === 0) return false;

    if (needle.length > 0) {
      const haystack = normalizeForSearch(
        [note.title, note.body, note.resolution, ...note.comments.map((c) => c.body)].join(' '),
      );
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

export const noteSortSchema = z.enum([
  'priorityThenDue',
  'newest',
  'oldest',
  'dueDate',
  'status',
  'title',
]);

export type NoteSort = z.infer<typeof noteSortSchema>;

/**
 * Ordena notas.
 *
 * El orden por defecto es `priorityThenDue`: primero lo urgente, y dentro de
 * la misma prioridad, lo que vence antes. Es el orden en el que alguien
 * decide qué atender a continuación, que es para lo que se abre esta lista.
 */
export function sortNotes(notes: readonly Note[], sort: NoteSort): Note[] {
  const copy = [...notes];
  switch (sort) {
    case 'priorityThenDue':
      return copy.sort((a, b) => {
        const byPriority = NOTE_PRIORITY_WEIGHT[a.priority] - NOTE_PRIORITY_WEIGHT[b.priority];
        if (byPriority !== 0) return byPriority;
        // Las notas sin fecha van después de las que la tienen.
        if (a.dueDate !== b.dueDate) {
          if (a.dueDate === null) return 1;
          if (b.dueDate === null) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        }
        return b.createdAt.localeCompare(a.createdAt);
      });
    case 'newest':
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'oldest':
      return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'dueDate':
      return copy.sort((a, b) => {
        if (a.dueDate === null && b.dueDate === null) return 0;
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    case 'status': {
      const order: NoteStatus[] = ['blocked', 'inProgress', 'open', 'resolved', 'archived'];
      return copy.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    }
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'es'));
    default: {
      const exhaustive: never = sort;
      throw new Error(`Orden no contemplado: ${String(exhaustive)}`);
    }
  }
}

/** Recuento por estado, para las pastillas del encabezado del panel. */
export function countByStatus(notes: readonly Note[]): Record<NoteStatus, number> {
  const counts: Record<NoteStatus, number> = {
    open: 0,
    inProgress: 0,
    blocked: 0,
    resolved: 0,
    archived: 0,
  };
  for (const note of notes) counts[note.status] += 1;
  return counts;
}

/* ------------------------------------------------------------------ *
 * Restricción por categoría (P04)
 * ------------------------------------------------------------------ */

/**
 * Categorías de nota que un usuario puede ver, según el servicio.
 *
 * `null` significa «sin restricción». Se distingue del array vacío a
 * propósito: vacío es «ninguna categoría», que es un estado legítimo —un
 * visitante al que se le concedió lectura del recorrido y de ninguna
 * categoría de notas— y no lo mismo que no tener restricción. Confundir los
 * dos es el error que convierte un control de acceso en un filtro que no
 * filtra, o en uno que lo oculta todo.
 */
export type AllowedNoteCategories = readonly string[] | null;

/**
 * Notas que el usuario puede ver (P04).
 *
 * Esto es un **recorte de presentación**, no un control de seguridad: las
 * notas están en el archivo del proyecto y quien lo tiene las tiene. El
 * control real es quién recibe el archivo, y la comprobación por recurso en el
 * servicio para lo que pasa por él. Lo que esta función evita es que una
 * pantalla muestre a un contratista las notas internas de mantenimiento cuando
 * trabajan sobre el mismo proyecto: distinto problema, igual de real.
 *
 * Por eso está aquí y no en el servidor: el recorte tiene que aplicarse donde
 * se dibuja la lista, y la lista se dibuja con datos locales.
 */
export function notesVisibleTo(
  notes: readonly Note[],
  allowed: AllowedNoteCategories,
): readonly Note[] {
  if (allowed === null) return notes;
  const permitted = new Set(allowed);
  return notes.filter((note) => permitted.has(note.categoryId));
}

/**
 * Categorías que se pueden ofrecer al crear o reclasificar una nota.
 *
 * Mismo criterio que para ver: ofrecer una categoría que luego no se puede ver
 * dejaría al autor creando notas que desaparecen de su vista al guardarlas, lo
 * que parece una pérdida de datos.
 */
export function categoriesAvailableTo(
  categories: readonly NoteCategory[],
  allowed: AllowedNoteCategories,
): readonly NoteCategory[] {
  if (allowed === null) return categories;
  const permitted = new Set(allowed);
  return categories.filter((category) => permitted.has(category.id));
}

/**
 * Cuántas notas quedan ocultas por la restricción.
 *
 * La interfaz lo dice en lugar de callarlo: una lista recortada en silencio
 * hace pensar que el proyecto está incompleto, y alguien acaba volviendo a
 * crear una nota que ya existía y no podía ver.
 */
export function hiddenNoteCount(
  notes: readonly Note[],
  allowed: AllowedNoteCategories,
): number {
  if (allowed === null) return 0;
  return notes.length - notesVisibleTo(notes, allowed).length;
}
