import { describe, expect, it } from 'vitest';
import {
  addComment,
  archiveNote,
  attachMedia,
  attachUrl,
  canDeleteCategory,
  countByCategory,
  editComment,
  orphanCategories,
  removeAttachment,
  renameCategoryId,
  reopenNote,
  resolveNote,
  validateAttachmentUrl,
  validateCategory,
  type CategoryDraft,
} from './note-authoring';
import { DEFAULT_NOTE_CATEGORIES, type Note, type NoteCategory } from './note';
import { newUuid, type Uuid } from './identity';

const NOW = '2026-05-01T12:00:00.000Z';
const LATER = '2026-05-02T09:30:00.000Z';
const PROJECT = newUuid();
const AUTHOR = { authorId: 'luis', authorName: 'Luis' };

function note(over: Partial<Note> = {}): Note {
  return {
    id: newUuid(),
    projectId: PROJECT,
    title: 'Fuga en la brida de la bomba',
    body: 'Goteo continuo en la brida de aspiración.',
    anchor: null,
    sceneId: null,
    assetId: null,
    categoryId: 'leak',
    priority: 'high',
    status: 'open',
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    attachments: [],
    comments: [],
    authorId: 'luis',
    authorName: 'Luis',
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    resolvedById: null,
    resolution: '',
    ...over,
  };
}

const categories: readonly NoteCategory[] = DEFAULT_NOTE_CATEGORIES.map((category) => ({
  ...category,
  description: '',
}));

/* ------------------------------------------------------------------ *
 * Conversaciones (P02)
 * ------------------------------------------------------------------ */

describe('addComment', () => {
  it('TEST-NTA-001 añade el comentario con autor y fecha', () => {
    const result = addComment(note(), 'Avisado mantenimiento mecánico.', AUTHOR, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.comments).toHaveLength(1);
    const comment = result.value.comments[0];
    expect(comment?.body).toBe('Avisado mantenimiento mecánico.');
    expect(comment?.authorName).toBe('Luis');
    expect(comment?.createdAt).toBe(LATER);
    expect(comment?.editedAt).toBeNull();
    expect(result.value.updatedAt).toBe(LATER);
  });

  it('TEST-NTA-002 rechaza un comentario vacío o en blanco', () => {
    // Un comentario en blanco en el hilo hace creer que alguien respondió.
    expect(addComment(note(), '', AUTHOR, LATER).ok).toBe(false);
    expect(addComment(note(), '   \n ', AUTHOR, LATER).ok).toBe(false);
  });

  it('TEST-NTA-003 recorta los espacios del cuerpo', () => {
    const result = addComment(note(), '  Revisado  ', AUTHOR, LATER);
    expect(result.ok && result.value.comments[0]?.body).toBe('Revisado');
  });

  it('TEST-NTA-004 conserva los comentarios anteriores y respeta el orden', () => {
    const primero = addComment(note(), 'Primero', AUTHOR, NOW);
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;

    const segundo = addComment(primero.value, 'Segundo', AUTHOR, LATER);
    expect(segundo.ok).toBe(true);
    if (!segundo.ok) return;

    expect(segundo.value.comments.map((c) => c.body)).toEqual(['Primero', 'Segundo']);
  });

  it('TEST-NTA-005 el comentario queda atado a su nota', () => {
    const target = note();
    const result = addComment(target, 'Hecho', AUTHOR, LATER);
    expect(result.ok && result.value.comments[0]?.noteId).toBe(target.id);
  });
});

describe('editComment', () => {
  it('TEST-NTA-006 marca editedAt al cambiar el texto', () => {
    // En una observación de seguridad importa saber que el texto cambió
    // después de que alguien lo leyera.
    const con = addComment(note(), 'Pendiente', AUTHOR, NOW);
    expect(con.ok).toBe(true);
    if (!con.ok) return;
    const commentId = con.value.comments[0]?.id as Uuid;

    const result = editComment(con.value, commentId, 'Resuelto en el turno de noche', LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.comments[0]?.body).toBe('Resuelto en el turno de noche');
    expect(result.value.comments[0]?.editedAt).toBe(LATER);
  });

  it('TEST-NTA-007 un texto idéntico no marca la nota como editada', () => {
    // Guardar sin cambios no es una edición, y marcarla sembraría dudas sobre
    // un texto que nadie tocó.
    const con = addComment(note(), 'Pendiente', AUTHOR, NOW);
    if (!con.ok) return;
    const commentId = con.value.comments[0]?.id as Uuid;

    const result = editComment(con.value, commentId, '  Pendiente  ', LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments[0]?.editedAt).toBeNull();
  });

  it('TEST-NTA-008 no deja vaciar un comentario', () => {
    const con = addComment(note(), 'Pendiente', AUTHOR, NOW);
    if (!con.ok) return;
    const commentId = con.value.comments[0]?.id as Uuid;

    const result = editComment(con.value, commentId, '   ', LATER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain('comentario nuevo');
  });

  it('TEST-NTA-009 informa si el comentario ya no existe', () => {
    const result = editComment(note(), newUuid(), 'Otra cosa', LATER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ *
 * Adjuntos (P06)
 * ------------------------------------------------------------------ */

describe('validateAttachmentUrl', () => {
  it('TEST-NTA-010 admite http y https', () => {
    expect(validateAttachmentUrl('https://ejemplo.com/plano.pdf').ok).toBe(true);
    expect(validateAttachmentUrl('http://intranet.local/ot/1234').ok).toBe(true);
  });

  it('TEST-NTA-011 rechaza javascript:', () => {
    // El adjunto termina renderizado en el visor publicado, que es una página
    // servida a cualquiera con el enlace. Esto no es un adjunto, es una vía de
    // ejecución de código ajeno.
    const result = validateAttachmentUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('javascript:');
  });

  it('TEST-NTA-012 rechaza data: y file:', () => {
    expect(validateAttachmentUrl('data:text/html,<script>x</script>').ok).toBe(false);
    expect(validateAttachmentUrl('file:///C:/Users/luis/plano.pdf').ok).toBe(false);
  });

  it('TEST-NTA-013 rechaza un texto que no es un enlace', () => {
    const result = validateAttachmentUrl('plano de la bomba');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain('https://');
  });

  it('TEST-NTA-014 rechaza el enlace vacío', () => {
    expect(validateAttachmentUrl('   ').ok).toBe(false);
  });
});

describe('attachUrl', () => {
  it('TEST-NTA-015 adjunta el enlace con su descripción', () => {
    const result = attachUrl(note(), 'https://ejemplo.com/ot/1234', '  Orden de trabajo  ', LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attachments).toHaveLength(1);
    expect(result.value.attachments[0]?.caption).toBe('Orden de trabajo');
    expect(result.value.attachments[0]?.mediaId).toBeNull();
    expect(result.value.updatedAt).toBe(LATER);
  });

  it('TEST-NTA-016 no adjunta un enlace inseguro', () => {
    const result = attachUrl(note(), 'javascript:void(0)', 'Truco', LATER);
    expect(result.ok).toBe(false);
  });
});

describe('attachMedia', () => {
  it('TEST-NTA-017 adjunta un archivo de la biblioteca', () => {
    const mediaId = newUuid();
    const result = attachMedia(note(), mediaId, 'Foto de la fuga', new Set([mediaId]), LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attachments[0]?.mediaId).toBe(mediaId);
    expect(result.value.attachments[0]?.url).toBeNull();
  });

  it('TEST-NTA-018 rechaza un archivo que no está en la biblioteca', () => {
    // Un adjunto huérfano deja un hueco en el visor publicado y hace fallar la
    // comprobación previa, sin que el autor sepa de dónde vino.
    const result = attachMedia(note(), newUuid(), '', new Set<string>(), LATER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('TEST-NTA-019 no adjunta dos veces el mismo archivo', () => {
    const mediaId = newUuid();
    const primero = attachMedia(note(), mediaId, '', new Set([mediaId]), NOW);
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;

    const segundo = attachMedia(primero.value, mediaId, '', new Set([mediaId]), LATER);
    expect(segundo.ok).toBe(false);
  });
});

describe('removeAttachment', () => {
  it('TEST-NTA-020 quita el adjunto y actualiza la fecha', () => {
    const mediaId = newUuid();
    const con = attachMedia(note(), mediaId, '', new Set([mediaId]), NOW);
    if (!con.ok) return;
    const attachmentId = con.value.attachments[0]?.id as Uuid;

    const result = removeAttachment(con.value, attachmentId, LATER);
    expect(result.attachments).toEqual([]);
    expect(result.updatedAt).toBe(LATER);
  });

  it('TEST-NTA-021 quitar algo que no está no cambia la nota', () => {
    const original = note();
    expect(removeAttachment(original, newUuid(), LATER)).toBe(original);
  });
});

/* ------------------------------------------------------------------ *
 * Cierre y archivo (P08)
 * ------------------------------------------------------------------ */

describe('resolveNote', () => {
  it('TEST-NTA-022 resuelve con resumen, fecha y responsable del cierre', () => {
    const result = resolveNote(note(), {
      resolution: 'Apretada la brida y comprobada sin goteo tras 24 h.',
      resolvedById: 'luis',
      now: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('resolved');
    expect(result.value.resolvedAt).toBe(LATER);
    expect(result.value.resolvedById).toBe('luis');
    expect(result.value.resolution).toContain('sin goteo');
  });

  it('TEST-NTA-023 no cierra una nota sin decir cómo se resolvió', () => {
    // Una nota cerrada sin resumen no informa a quien la lea el año que viene;
    // es ruido con apariencia de orden.
    const result = resolveNote(note(), { resolution: '  ', resolvedById: 'luis', now: LATER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.path).toBe('resolution');
  });

  it('TEST-NTA-024 no resuelve desde un estado que no lo permite', () => {
    const result = resolveNote(note({ status: 'archived' }), {
      resolution: 'Ya estaba',
      resolvedById: 'luis',
      now: LATER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFLICT');
  });
});

describe('archiveNote', () => {
  it('TEST-NTA-025 archiva sin marcar resolvedAt', () => {
    // Contar una nota archivada como resuelta falsearía el recuento de lo que
    // de verdad se arregló.
    const result = archiveNote(note(), 'El equipo se retiró de servicio.', LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('archived');
    expect(result.value.resolvedAt).toBeNull();
    expect(result.value.resolution).toBe('');
    expect(result.value.body).toContain('[Archivada] El equipo se retiró de servicio.');
  });

  it('TEST-NTA-026 archiva sin motivo sin tocar el cuerpo', () => {
    const original = note();
    const result = archiveNote(original, '   ', LATER);
    expect(result.ok && result.value.body).toBe(original.body);
  });

  it('TEST-NTA-027 no archiva desde un estado que no lo permite', () => {
    expect(archiveNote(note({ status: 'inProgress' }), 'Duplicada', LATER).ok).toBe(false);
    expect(archiveNote(note({ status: 'resolved' }), 'Cerrada hace meses', LATER).ok).toBe(true);
  });
});

describe('reopenNote', () => {
  it('TEST-NTA-028 reabre una resuelta y limpia los datos del cierre', () => {
    const resuelta = note({
      status: 'resolved',
      resolution: 'Apretada la brida',
      resolvedAt: NOW,
      resolvedById: 'luis',
    });

    const result = reopenNote(resuelta, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('open');
    expect(result.value.resolvedAt).toBeNull();
    expect(result.value.resolvedById).toBeNull();
    // El texto de la resolución anterior se conserva: al reabrir, lo que se
    // intentó la vez pasada es justo lo que hay que saber.
    expect(result.value.resolution).toBe('Apretada la brida');
  });

  it('TEST-NTA-029 reabre una archivada', () => {
    expect(reopenNote(note({ status: 'archived' }), LATER).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Categorías (P03)
 * ------------------------------------------------------------------ */

const draft = (over: Partial<CategoryDraft> = {}): CategoryDraft => ({
  id: 'vibracion',
  label: 'Vibración',
  colorToken: 'warning',
  description: '',
  ...over,
});

describe('validateCategory', () => {
  it('TEST-NTA-030 acepta una categoría nueva válida', () => {
    expect(validateCategory(draft(), categories, null)).toEqual([]);
  });

  it('TEST-NTA-031 exige identificador y nombre', () => {
    const problems = validateCategory(draft({ id: '', label: ' ' }), categories, null);
    expect(problems.map((p) => p.field).sort()).toEqual(['id', 'label']);
  });

  it('TEST-NTA-032 rechaza un identificador con mayúsculas o espacios', () => {
    expect(validateCategory(draft({ id: 'Vibracion' }), categories, null)).toHaveLength(1);
    expect(validateCategory(draft({ id: 'vib racion' }), categories, null)).toHaveLength(1);
    expect(validateCategory(draft({ id: '1vib' }), categories, null)).toHaveLength(1);
  });

  it('TEST-NTA-033 rechaza un identificador ya usado', () => {
    expect(validateCategory(draft({ id: 'leak' }), categories, null)).toHaveLength(1);
  });

  it('TEST-NTA-034 al editar no se queja de su propio identificador', () => {
    expect(validateCategory(draft({ id: 'leak', label: 'Fugas' }), categories, 'leak')).toEqual([]);
  });
});

describe('canDeleteCategory', () => {
  it('TEST-NTA-035 no deja borrar una categoría en uso y dice cuántas notas la usan', () => {
    // Reasignar las notas a «Otro» automáticamente sería cómodo y mentiroso.
    const notes = [note({ categoryId: 'leak' }), note({ categoryId: 'leak' })];
    const result = canDeleteCategory('leak', notes);

    expect(result.allowed).toBe(false);
    expect(result.inUse).toBe(2);
    expect(result.reason).toContain('2 nota(s)');
  });

  it('TEST-NTA-036 nunca deja borrar «Otro»', () => {
    const result = canDeleteCategory('other', []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('reserva');
  });

  it('TEST-NTA-037 deja borrar una categoría que nadie usa', () => {
    expect(canDeleteCategory('corrosion', [note({ categoryId: 'leak' })]).allowed).toBe(true);
  });
});

describe('renameCategoryId', () => {
  it('TEST-NTA-038 arrastra las notas al nuevo identificador', () => {
    // Cambiar el identificador sin mover las notas las dejaría apuntando a una
    // categoría inexistente.
    const notes = [note({ categoryId: 'leak' }), note({ categoryId: 'safety' })];
    const result = renameCategoryId(categories, notes, 'leak', 'fuga');

    expect(result.categories.some((c) => c.id === 'fuga')).toBe(true);
    expect(result.categories.some((c) => c.id === 'leak')).toBe(false);
    expect(result.notes[0]?.categoryId).toBe('fuga');
    expect(result.notes[1]?.categoryId).toBe('safety');
  });

  it('TEST-NTA-039 renombrar al mismo identificador no cambia nada', () => {
    const notes = [note()];
    const result = renameCategoryId(categories, notes, 'leak', 'leak');
    expect(result.notes).toBe(notes);
    expect(result.categories).toBe(categories);
  });
});

describe('countByCategory', () => {
  it('TEST-NTA-040 cuenta cada categoría, incluidas las que están a cero', () => {
    const notes = [note({ categoryId: 'leak' }), note({ categoryId: 'leak' })];
    const counts = countByCategory(notes, categories);

    expect(counts.leak).toBe(2);
    expect(counts.corrosion).toBe(0);
    expect(counts.safety).toBe(0);
  });
});

describe('orphanCategories', () => {
  it('TEST-NTA-041 detecta las categorías que las notas usan y el proyecto no define', () => {
    // Sale de un proyecto importado o editado a mano: sin avisarlo, esas notas
    // no las encuentra el filtro y el autor las creería perdidas.
    const notes = [note({ categoryId: 'vibracion' }), note({ categoryId: 'leak' })];
    expect(orphanCategories(notes, categories)).toEqual(['vibracion']);
  });

  it('TEST-NTA-042 no informa de nada cuando todo está definido', () => {
    expect(orphanCategories([note({ categoryId: 'leak' })], categories)).toEqual([]);
  });
});
