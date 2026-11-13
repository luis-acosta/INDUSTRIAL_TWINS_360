/**
 * Autoría de notas: conversaciones, categorías, adjuntos y cierre
 * (P02, P03, P06, P08).
 *
 * El `note.ts` vecino define qué es una nota, cómo se filtra y qué
 * transiciones de estado son legítimas. Este módulo define las operaciones que
 * la modifican, con las reglas que hacen que una observación de planta siga
 * siendo creíble meses después:
 *
 * - **Un comentario no se borra ni se reescribe en silencio.** Editarlo deja
 *   `editedAt` puesto, porque en una observación de seguridad importa saber
 *   que el texto cambió después de que alguien lo leyera.
 * - **Resolver exige decir cómo se resolvió.** Una nota cerrada sin resumen no
 *   informa a quien la lea el año que viene; es ruido con apariencia de orden.
 * - **Archivar no es resolver.** Se archiva lo que deja de aplicar —el equipo
 *   se retiró, la observación era un duplicado—, y eso no es lo mismo que
 *   haberlo arreglado. Mezclarlos falsea el recuento de pendientes.
 * - **Una categoría en uso no se borra**, porque dejaría notas apuntando a una
 *   categoría inexistente y el filtro por categoría dejaría de encontrarlas.
 */
import {
  canTransition,
  type Attachment,
  type Comment,
  type Note,
  type NoteCategory,
} from './note';
import { domainError, err, ok, type Result } from './result';
import { newUuid, type Uuid } from './identity';

/* ------------------------------------------------------------------ *
 * Conversaciones (P02)
 * ------------------------------------------------------------------ */

export interface CommentAuthor {
  readonly authorId: string;
  readonly authorName: string;
}

/**
 * Añade un comentario a una nota.
 *
 * El cuerpo vacío se rechaza en lugar de guardarse: un comentario en blanco en
 * el hilo de una observación hace creer que alguien respondió algo.
 */
export function addComment(
  note: Note,
  body: string,
  author: CommentAuthor,
  now: string,
): Result<Note> {
  const text = body.trim();
  if (text.length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'El comentario no puede estar vacío', {
        path: 'comments',
        recovery: 'Escriba el comentario antes de publicarlo.',
      }),
    );
  }

  const comment: Comment = {
    id: newUuid(),
    noteId: note.id,
    authorId: author.authorId,
    authorName: author.authorName,
    body: text,
    attachments: [],
    createdAt: now,
    editedAt: null,
  };

  return ok({ ...note, comments: [...note.comments, comment], updatedAt: now });
}

/**
 * Edita el cuerpo de un comentario, dejando constancia de la edición.
 *
 * `editedAt` no es decorativo: en una observación de seguridad, saber que el
 * texto cambió después de que alguien actuara sobre él es parte del registro.
 */
export function editComment(
  note: Note,
  commentId: Uuid,
  body: string,
  now: string,
): Result<Note> {
  const text = body.trim();
  if (text.length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'El comentario no puede quedar vacío', {
        path: 'comments',
        recovery: 'Para retirar lo dicho, añada un comentario nuevo explicándolo.',
      }),
    );
  }

  const target = note.comments.find((comment) => comment.id === commentId);
  if (target === undefined) {
    return err(
      domainError('NOT_FOUND', 'Ese comentario ya no está en la nota', { path: 'comments' }),
    );
  }

  // Un texto idéntico no marca la nota como editada: guardar sin cambios no es
  // una edición, y marcarla sembraría dudas sobre un texto que no se tocó.
  if (target.body === text) return ok(note);

  return ok({
    ...note,
    comments: note.comments.map((comment) =>
      comment.id === commentId ? { ...comment, body: text, editedAt: now } : comment,
    ),
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ *
 * Adjuntos (P06)
 * ------------------------------------------------------------------ */

/** Protocolos admitidos en un enlace adjunto. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Comprueba un enlace antes de adjuntarlo.
 *
 * Se rechaza todo lo que no sea `http` o `https`. Un `javascript:` adjuntado a
 * una nota terminaría renderizado en el visor publicado, que es una página web
 * servida a cualquiera con el enlace: eso es una vía de ejecución de código
 * ajeno, no un adjunto. `file:` se rechaza también, porque apunta al disco de
 * quien la escribió y no significa nada para quien la lee.
 */
export function validateAttachmentUrl(raw: string): Result<string> {
  const text = raw.trim();
  if (text.length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'El enlace no puede estar vacío', { path: 'attachments' }),
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return err(
      domainError('VALIDATION_FAILED', 'Ese texto no es un enlace válido', {
        path: 'attachments',
        recovery: 'Escriba el enlace completo, empezando por https://',
      }),
    );
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    return err(
      domainError('VALIDATION_FAILED', `No se admiten enlaces «${parsed.protocol}»`, {
        path: 'attachments',
        detail: { protocol: parsed.protocol },
        recovery: 'Sólo se admiten enlaces http:// y https://.',
      }),
    );
  }

  return ok(parsed.toString());
}

/** Adjunta un enlace externo a la nota. */
export function attachUrl(
  note: Note,
  url: string,
  caption: string,
  now: string,
): Result<Note> {
  const checked = validateAttachmentUrl(url);
  if (!checked.ok) return checked;

  const attachment: Attachment = {
    id: newUuid(),
    mediaId: null,
    url: checked.value,
    caption: caption.trim(),
    createdAt: now,
  };

  return ok({ ...note, attachments: [...note.attachments, attachment], updatedAt: now });
}

/**
 * Adjunta un archivo de la biblioteca del proyecto.
 *
 * Se exige que el medio exista: un adjunto que apunta a un identificador
 * ausente produce un hueco en el visor publicado y un fallo en la comprobación
 * previa a publicar, y el autor no sabría de dónde vino.
 */
export function attachMedia(
  note: Note,
  mediaId: Uuid,
  caption: string,
  availableMediaIds: ReadonlySet<string>,
  now: string,
): Result<Note> {
  if (!availableMediaIds.has(mediaId)) {
    return err(
      domainError('NOT_FOUND', 'Ese archivo ya no está en la biblioteca del proyecto', {
        path: 'attachments',
      }),
    );
  }

  if (note.attachments.some((attachment) => attachment.mediaId === mediaId)) {
    return err(
      domainError('VALIDATION_FAILED', 'Ese archivo ya está adjunto a la nota', {
        path: 'attachments',
      }),
    );
  }

  const attachment: Attachment = {
    id: newUuid(),
    mediaId,
    url: null,
    caption: caption.trim(),
    createdAt: now,
  };

  return ok({ ...note, attachments: [...note.attachments, attachment], updatedAt: now });
}

/** Quita un adjunto de la nota. El archivo sigue en la biblioteca. */
export function removeAttachment(note: Note, attachmentId: Uuid, now: string): Note {
  if (!note.attachments.some((attachment) => attachment.id === attachmentId)) return note;
  return {
    ...note,
    attachments: note.attachments.filter((attachment) => attachment.id !== attachmentId),
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Cierre y archivo (P08)
 * ------------------------------------------------------------------ */

export interface ResolveOptions {
  readonly resolution: string;
  readonly resolvedById: string;
  readonly now: string;
}

/**
 * Resuelve una nota.
 *
 * Exige el resumen de cómo se resolvió, y no por formalismo: una observación
 * de corrosión cerrada sin explicación no le dice nada a quien la lea el año
 * que viene, y el historial deja de servir para decidir si el problema volvió.
 */
export function resolveNote(note: Note, options: ResolveOptions): Result<Note> {
  if (!canTransition(note.status, 'resolved')) {
    return err(
      domainError(
        'CONFLICT',
        `Una nota «${note.status}» no puede pasar directamente a resuelta`,
        { path: 'status' },
      ),
    );
  }

  const resolution = options.resolution.trim();
  if (resolution.length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'Diga cómo se resolvió antes de cerrarla', {
        path: 'resolution',
        recovery:
          'Un resumen de una línea basta: qué se hizo, quién lo hizo y cuándo quedó comprobado.',
      }),
    );
  }

  return ok({
    ...note,
    status: 'resolved',
    resolution,
    resolvedAt: options.now,
    resolvedById: options.resolvedById,
    updatedAt: options.now,
  });
}

/**
 * Archiva una nota.
 *
 * Archivar es declarar que la nota **deja de aplicar**: el equipo se retiró, la
 * observación era un duplicado, el alcance cambió. No exige resumen de
 * resolución porque no se resolvió nada, y por eso mismo no se marca
 * `resolvedAt`: contar una nota archivada como resuelta falsearía el recuento
 * de lo que de verdad se arregló.
 */
export function archiveNote(note: Note, reason: string, now: string): Result<Note> {
  if (!canTransition(note.status, 'archived')) {
    return err(
      domainError('CONFLICT', `Una nota «${note.status}» no se puede archivar`, {
        path: 'status',
      }),
    );
  }

  const text = reason.trim();
  const body =
    text.length > 0
      ? `${note.body}${note.body.length > 0 ? '\n\n' : ''}[Archivada] ${text}`.slice(0, 20_000)
      : note.body;

  return ok({ ...note, status: 'archived', body, updatedAt: now });
}

/** Reabre una nota resuelta o archivada, si la transición lo permite. */
export function reopenNote(note: Note, now: string): Result<Note> {
  if (!canTransition(note.status, 'open')) {
    return err(
      domainError('CONFLICT', `Una nota «${note.status}» no se puede reabrir`, {
        path: 'status',
      }),
    );
  }

  // Se conserva el texto de la resolución anterior: al reabrir, lo que se
  // intentó la vez pasada es justo lo que hay que saber.
  return ok({
    ...note,
    status: 'open',
    resolvedAt: null,
    resolvedById: null,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ *
 * Categorías (P03)
 * ------------------------------------------------------------------ */

export interface CategoryDraft {
  readonly id: string;
  readonly label: string;
  readonly colorToken: NoteCategory['colorToken'];
  readonly description: string;
}

export interface CategoryProblem {
  readonly field: string;
  readonly message: string;
  readonly severity: 'blocking' | 'advisory';
}

const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Valida una categoría nueva o editada. */
export function validateCategory(
  draft: CategoryDraft,
  categories: readonly NoteCategory[],
  /** `null` al crear; el identificador original al editar. */
  originalId: string | null,
): readonly CategoryProblem[] {
  const problems: CategoryProblem[] = [];
  const id = draft.id.trim();

  if (id.length === 0) {
    problems.push({ field: 'id', message: 'La categoría necesita un identificador', severity: 'blocking' });
  } else if (!CATEGORY_ID_PATTERN.test(id)) {
    problems.push({
      field: 'id',
      message: 'El identificador admite minúsculas, dígitos, guion y guion bajo, y empieza por letra',
      severity: 'blocking',
    });
  } else if (id !== originalId && categories.some((category) => category.id === id)) {
    problems.push({ field: 'id', message: 'Ya existe una categoría con ese identificador', severity: 'blocking' });
  }

  if (draft.label.trim().length === 0) {
    problems.push({ field: 'label', message: 'La categoría necesita un nombre visible', severity: 'blocking' });
  }

  return problems;
}

/**
 * Comprueba si una categoría se puede eliminar y cuántas notas la usan.
 *
 * Se permite borrarla sólo si nadie la usa. Reasignar automáticamente las notas
 * a «Otro» sería cómodo y mentiroso: una observación clasificada como fuga
 * pasaría a no estar clasificada sin que nadie lo decidiera, y el filtro por
 * categoría dejaría de encontrarla.
 */
export function canDeleteCategory(
  categoryId: string,
  notes: readonly Note[],
): { readonly allowed: boolean; readonly inUse: number; readonly reason: string } {
  const inUse = notes.filter((note) => note.categoryId === categoryId).length;

  if (categoryId === 'other') {
    return {
      allowed: false,
      inUse,
      reason: '«Otro» es la categoría de reserva del proyecto y no se puede eliminar.',
    };
  }

  if (inUse > 0) {
    return {
      allowed: false,
      inUse,
      reason:
        `${inUse} nota(s) usan esta categoría. Reclasifíquelas antes de eliminarla; si se ` +
        `borrase, el filtro por categoría dejaría de encontrarlas.`,
    };
  }

  return { allowed: true, inUse: 0, reason: 'Ninguna nota la usa.' };
}

/**
 * Renombra el identificador de una categoría arrastrando las notas.
 *
 * Cambiar el identificador sin mover las notas las dejaría apuntando a una
 * categoría inexistente. Esta función hace las dos cosas a la vez para que no
 * exista un estado intermedio incoherente.
 */
export function renameCategoryId(
  categories: readonly NoteCategory[],
  notes: readonly Note[],
  fromId: string,
  toId: string,
): { readonly categories: readonly NoteCategory[]; readonly notes: readonly Note[] } {
  if (fromId === toId) return { categories, notes };

  return {
    categories: categories.map((category) =>
      category.id === fromId ? { ...category, id: toId } : category,
    ),
    notes: notes.map((note) => (note.categoryId === fromId ? { ...note, categoryId: toId } : note)),
  };
}

/** Notas por categoría, incluidas las categorías sin ninguna. */
export function countByCategory(
  notes: readonly Note[],
  categories: readonly NoteCategory[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const category of categories) counts[category.id] = 0;
  for (const note of notes) counts[note.categoryId] = (counts[note.categoryId] ?? 0) + 1;
  return counts;
}

/**
 * Categorías que las notas usan pero que el proyecto no define.
 *
 * Sale de un proyecto importado o editado a mano. Se expone para poder
 * avisarlo en lugar de dejar notas que el filtro no encuentra y que el autor
 * creería perdidas.
 */
export function orphanCategories(
  notes: readonly Note[],
  categories: readonly NoteCategory[],
): readonly string[] {
  const known = new Set(categories.map((category) => category.id));
  const orphans = new Set<string>();
  for (const note of notes) {
    if (!known.has(note.categoryId)) orphans.add(note.categoryId);
  }
  return [...orphans].sort();
}
