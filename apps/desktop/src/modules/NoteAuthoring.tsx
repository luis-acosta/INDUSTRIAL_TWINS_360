/**
 * Autoría de notas en el inspector: conversación, categoría, adjuntos y cierre
 * (P02, P03, P06, P08).
 *
 * El componente es deliberadamente delgado: cada acción llama a una función de
 * `@it360/domain/note-authoring`, que es donde están las reglas y donde se
 * prueban. Lo que aporta esta capa es el orden en que el autor se encuentra las
 * cosas y los mensajes que recibe cuando el dominio dice no.
 *
 * Dos decisiones de presentación que son decisiones de fondo:
 *
 * - **Resolver y archivar son dos botones distintos**, no dos valores de un
 *   selector. Cerrar algo que se arregló y retirar algo que dejó de aplicar son
 *   actos diferentes, y ponerlos en la misma lista invita a usar el que esté
 *   más cerca.
 * - **La resolución se pide en el momento de resolver**, en el propio diálogo,
 *   y no como un campo que se rellena antes y se olvida.
 */
import { useState } from 'react';
import {
  addComment,
  archiveNote,
  attachMedia,
  attachUrl,
  canTransition,
  removeAttachment,
  reopenNote,
  resolveNote,
  type Note,
  type NoteCategory,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  CountPill,
  Dialog,
  Field,
  IconAdd,
  SectionLabel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface NoteAuthoringProps {
  readonly store: ProjectStore;
  readonly note: Note;
  /** Escribe la nota modificada en el proyecto, pasando por el historial. */
  readonly onWrite: (label: string, next: Note) => void;
}

/** Autor local. Con servidor, vendrá de la sesión autenticada. */
const LOCAL_AUTHOR = { authorId: 'local', authorName: 'Usuario local' };

export function NoteAuthoring({ store, note, onWrite }: NoteAuthoringProps): JSX.Element {
  const { push } = useToast();
  const [draft, setDraft] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCaption, setLinkCaption] = useState('');
  const [resolving, setResolving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [resolution, setResolution] = useState('');
  const [archiveReason, setArchiveReason] = useState('');

  const categories = store.project.noteCategories;
  const mediaIds = new Set(store.project.media.map((media) => media.id as string));
  const now = (): string => new Date().toISOString();

  /** Muestra el motivo del dominio tal cual, sin reescribirlo. */
  const refuse = (message: string, recovery?: string): void => {
    push({
      tone: 'warning',
      title: message,
      ...(recovery !== undefined ? { description: recovery } : {}),
    });
  };

  const onPublishComment = (): void => {
    const result = addComment(note, draft, LOCAL_AUTHOR, now());
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Comentar nota', result.value);
    setDraft('');
  };

  const onAttachLink = (): void => {
    const result = attachUrl(note, linkUrl, linkCaption, now());
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Adjuntar enlace a la nota', result.value);
    setLinkUrl('');
    setLinkCaption('');
  };

  const onAttachMedia = (mediaId: Uuid): void => {
    const result = attachMedia(note, mediaId, '', mediaIds, now());
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Adjuntar archivo a la nota', result.value);
  };

  const onResolve = (): void => {
    const result = resolveNote(note, {
      resolution,
      resolvedById: LOCAL_AUTHOR.authorId,
      now: now(),
    });
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Resolver nota', result.value);
    setResolving(false);
    setResolution('');
  };

  const onArchive = (): void => {
    const result = archiveNote(note, archiveReason, now());
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Archivar nota', result.value);
    setArchiving(false);
    setArchiveReason('');
  };

  const onReopen = (): void => {
    const result = reopenNote(note, now());
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    onWrite('Reabrir nota', result.value);
  };

  const mediaCandidates = store.project.media.filter(
    (media) =>
      !media.quarantined &&
      !note.attachments.some((attachment) => attachment.mediaId === media.id),
  );

  const categoryOf = (id: string): NoteCategory | undefined =>
    categories.find((category) => category.id === id);

  const current = categoryOf(note.categoryId);

  return (
    <>
      {/* ---------------- Categoría (P03) ---------------- */}

      <Field
        label="Categoría"
        inline
        hint={
          current === undefined
            ? `«${note.categoryId}» no está definida en el proyecto; el filtro por categoría no la encontrará.`
            : undefined
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={note.categoryId}
            onChange={(event) =>
              onWrite('Clasificar nota', {
                ...note,
                categoryId: event.currentTarget.value,
                updatedAt: now(),
              })
            }
          >
            {current === undefined && (
              <option value={note.categoryId}>{note.categoryId} (sin definir)</option>
            )}
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* ---------------- Cierre y archivo (P08) ---------------- */}

      <SectionLabel>Cierre</SectionLabel>
      <div className="note-authoring__actions">
        {canTransition(note.status, 'resolved') && note.status !== 'resolved' && (
          <Button size="sm" variant="primary" onClick={() => setResolving(true)}>
            Resolver
          </Button>
        )}
        {canTransition(note.status, 'archived') && note.status !== 'archived' && (
          <Button size="sm" variant="secondary" onClick={() => setArchiving(true)}>
            Archivar
          </Button>
        )}
        {(note.status === 'resolved' || note.status === 'archived') && (
          <Button size="sm" variant="secondary" onClick={onReopen}>
            Reabrir
          </Button>
        )}
      </div>
      <p className="note-authoring__hint">
        <b>Resolver</b> es declarar que se arregló, y pide decir cómo. <b>Archivar</b> es declarar
        que dejó de aplicar —el equipo se retiró, era un duplicado— y no cuenta como resuelta.
      </p>

      {/* ---------------- Adjuntos (P06) ---------------- */}

      <SectionLabel>
        Adjuntos{' '}
        {note.attachments.length > 0 && (
          <CountPill count={note.attachments.length} label="adjuntos" />
        )}
      </SectionLabel>

      {note.attachments.length > 0 && (
        <ul className="note-authoring__attachments">
          {note.attachments.map((attachment) => {
            const media =
              attachment.mediaId === null
                ? undefined
                : store.project.media.find((m) => m.id === attachment.mediaId);
            return (
              <li key={attachment.id}>
                <span className="note-authoring__attachment-name">
                  {attachment.url ?? media?.originalName ?? 'archivo que ya no está'}
                </span>
                {attachment.caption.length > 0 && (
                  <span className="note-authoring__attachment-caption">{attachment.caption}</span>
                )}
                <Badge tone="neutral">{attachment.url !== null ? 'enlace' : 'archivo'}</Badge>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Quitar adjunto ${attachment.url ?? media?.originalName ?? ''}`}
                  onClick={() => onWrite('Quitar adjunto', removeAttachment(note, attachment.id, now()))}
                >
                  Quitar
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Field label="Enlace" inline hint="Sólo http:// y https://.">
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            size="sm"
            aria-describedby={describedBy}
            placeholder="https://…"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="Descripción del enlace" inline>
        {({ id }) => (
          <TextInput
            id={id}
            size="sm"
            value={linkCaption}
            onChange={(event) => setLinkCaption(event.currentTarget.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        variant="secondary"
        fullWidth
        icon={<IconAdd size={13} />}
        disabled={linkUrl.trim().length === 0}
        onClick={onAttachLink}
      >
        Adjuntar enlace
      </Button>

      <Field
        label="Archivo del proyecto"
        inline
        hint={
          mediaCandidates.length === 0
            ? 'No hay archivos sin adjuntar en la biblioteca.'
            : undefined
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value=""
            disabled={mediaCandidates.length === 0}
            onChange={(event) => {
              if (event.currentTarget.value !== '') {
                onAttachMedia(event.currentTarget.value as Uuid);
              }
            }}
          >
            <option value="">— elegir archivo —</option>
            {mediaCandidates.map((media) => (
              <option key={media.id} value={media.id}>
                {media.originalName}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* ---------------- Conversación (P02) ---------------- */}

      <SectionLabel>
        Conversación{' '}
        {note.comments.length > 0 && (
          <CountPill count={note.comments.length} label="comentarios" />
        )}
      </SectionLabel>

      {note.comments.map((comment) => (
        <Callout
          key={comment.id}
          tone="info"
          title={`${comment.authorName} · ${comment.createdAt.slice(0, 16).replace('T', ' ')}${
            comment.editedAt !== null ? ' · editado' : ''
          }`}
        >
          {comment.body}
        </Callout>
      ))}

      <Field label="Escribir un comentario">
        {({ id }) => (
          <TextArea
            id={id}
            rows={3}
            placeholder="Qué se ha hecho, qué falta, a quién se avisó…"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        variant="secondary"
        fullWidth
        disabled={draft.trim().length === 0}
        onClick={onPublishComment}
      >
        Publicar comentario
      </Button>

      {/* ---------------- Diálogos ---------------- */}

      <Dialog
        open={resolving}
        onClose={() => setResolving(false)}
        title="Resolver la nota"
        description="Un resumen de una línea basta: qué se hizo, quién lo hizo y cuándo quedó comprobado."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResolving(false)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={onResolve}
              disabled={resolution.trim().length === 0}
            >
              Resolver
            </Button>
          </>
        }
      >
        <Field label="Cómo se resolvió" required>
          {({ id }) => (
            <TextArea
              id={id}
              rows={4}
              value={resolution}
              onChange={(event) => setResolution(event.currentTarget.value)}
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title="Archivar la nota"
        description="Archivar es declarar que dejó de aplicar. No cuenta como resuelta en el recuento de pendientes."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiving(false)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={onArchive}>
              Archivar
            </Button>
          </>
        }
      >
        <Field
          label="Motivo"
          hint="Opcional, pero es lo que explicará mañana por qué esta nota no se arregló."
        >
          {({ id }) => (
            <TextArea
              id={id}
              rows={3}
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.currentTarget.value)}
            />
          )}
        </Field>
      </Dialog>
    </>
  );
}
