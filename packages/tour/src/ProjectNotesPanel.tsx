/**
 * Panel de notas del proyecto en el recorrido (P09).
 *
 * Es la pantalla para consultar y participar desde un teléfono, de pie en la
 * planta. Se distingue del panel de notas de campo (P01), que sirve para
 * **crear** observaciones sin servicio y se queda en el navegador hasta que se
 * descargan: esto lee las notas que el responsable del proyecto gestiona, y
 * exige servicio e identidad.
 *
 * Está pensado para un pulgar y una mano:
 *
 *  - Lo vencido primero, que es el orden que da el servicio.
 *  - Un filtro de tres botones y nada más. En una pantalla de teléfono, cada
 *    control que se añade quita sitio a la nota que se está leyendo.
 *  - Los estados que se pueden poner los dice el servicio, no esta pantalla: si
 *    los llevara escritos, ofrecería uno que el servicio rechaza en cuanto
 *    cambie una de las dos.
 *  - Los fallos se cuentan con lo que se puede hacer: «no hay cobertura, vuelva
 *    a intentarlo» es accionable; «error 503» no.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Callout, Dialog, Field, Select, TextArea, TextInput } from '@it360/ui';
import { NOTE_PRIORITY_LABELS, NOTE_STATUS_LABELS, type DomainError } from '@it360/domain';

import {
  loadNotesIdentity,
  saveNotesIdentity,
  type NotesClient,
  type NotesIdentity,
  type ServedNote,
} from './notes-client';

export interface ProjectNotesPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Construye el cliente para una identidad.
   *
   * Es una fábrica y no un cliente hecho porque la identidad se pide **aquí**:
   * en un teléfono no hay sesión, y el servicio necesita saber quién pregunta
   * para recortar lo que devuelve. Recibir un cliente ya construido obligaría a
   * tener la identidad antes de abrir el panel, y entonces alguien que no se
   * hubiera identificado nunca vería el botón —la función existiría y no se
   * podría usar—.
   */
  readonly makeClient: (identity: NotesIdentity) => NotesClient;
  readonly projectId: string;
  /** Escena que se está viendo, para poder filtrar por ella. */
  readonly sceneId: string | null;
  readonly sceneTitle: string;
}

type Filter = 'all' | 'scene' | 'mine';

export function ProjectNotesPanel({
  open,
  onClose,
  makeClient,
  projectId,
  sceneId,
  sceneTitle,
}: ProjectNotesPanelProps): JSX.Element | null {
  const [identity, setIdentity] = useState<NotesIdentity | null>(() => loadNotesIdentity());
  const [draftUser, setDraftUser] = useState('');
  const [draftName, setDraftName] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [notes, setNotes] = useState<readonly ServedNote[]>([]);
  const [statuses, setStatuses] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<DomainError | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const client = useMemo(
    () => (identity === null ? null : makeClient(identity)),
    [identity, makeClient],
  );

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    setLoading(true);
    const result = await client.list({
      projectId,
      ...(filter === 'scene' && sceneId !== null ? { sceneId } : {}),
      ...(filter === 'mine' ? { mine: true } : {}),
    });
    setLoading(false);

    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setNotes(result.value.notes);
    setStatuses(result.value.fieldStatuses);
  }, [client, projectId, filter, sceneId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  if (!open) return null;

  /* Identificación. No es autenticación y se dice con esas palabras: el
     servicio acepta la identidad por cabeceras y así lo documenta. Mentir aquí
     —«inicie sesión»— haría creer que algo comprueba quién es quién. */
  if (identity === null) {
    return (
      <Dialog
        open
        size="sm"
        title="Identifíquese para ver las notas"
        onClose={onClose}
        footer={
          <div style={{ display: 'flex', gap: 'var(--it-space-2)' }}>
            <Button
              variant="primary"
              disabled={draftUser.trim().length === 0}
              onClick={() => {
                const next: NotesIdentity = {
                  userId: draftUser.trim(),
                  role: 'editor',
                  ...(draftName.trim().length > 0 ? { displayName: draftName.trim() } : {}),
                };
                saveNotesIdentity(next);
                setIdentity(next);
              }}
            >
              Continuar
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        }
      >
        <div className="project-notes">
          <Callout tone="info" title="Esto identifica, no autentica">
            El servicio usa su identificador para decidir qué notas puede ver. En esta versión no
            comprueba contraseñas, de modo que úselo sólo en la red de la planta.
          </Callout>
          <Field label="Su identificador de usuario">
            {({ id }) => (
              <TextInput
                id={id}
                value={draftUser}
                placeholder="tecnico.ruiz"
                onChange={(event) => setDraftUser(event.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Nombre con el que firma (opcional)">
            {({ id }) => (
              <TextInput
                id={id}
                value={draftName}
                placeholder="Ruiz"
                onChange={(event) => setDraftName(event.currentTarget.value)}
              />
            )}
          </Field>
        </div>
      </Dialog>
    );
  }

  const selected = notes.find((note) => note.id === selectedId) ?? null;

  /** Sustituye una nota en la lista sin recargar: la red de una planta es lenta. */
  const merge = (updated: ServedNote): void => {
    setNotes((current) => current.map((note) => (note.id === updated.id ? updated : note)));
  };

  const sendComment = async (): Promise<void> => {
    if (client === null || selected === null || draft.trim().length === 0) return;
    setSending(true);
    const result = await client.comment(selected.id, draft.trim());
    setSending(false);

    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setDraft('');
    merge(result.value);
  };

  const changeStatus = async (status: string): Promise<void> => {
    if (client === null || selected === null) return;
    const result = await client.setStatus(selected.id, status);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    merge(result.value);
  };

  return (
    <Dialog
      open
      size="md"
      title="Notas del proyecto"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="project-notes">
        <div className="project-notes__filters" role="group" aria-label="Filtrar notas">
          <Button
            size="sm"
            variant={filter === 'all' ? 'primary' : 'secondary'}
            onClick={() => setFilter('all')}
          >
            Todas
          </Button>
          <Button
            size="sm"
            variant={filter === 'scene' ? 'primary' : 'secondary'}
            disabled={sceneId === null}
            onClick={() => setFilter('scene')}
          >
            De esta escena
          </Button>
          <Button
            size="sm"
            variant={filter === 'mine' ? 'primary' : 'secondary'}
            onClick={() => setFilter('mine')}
          >
            Mías
          </Button>
        </div>

        {problem !== null && (
          <Callout tone="alarm" title={problem.message}>
            {problem.recovery ?? ''}
          </Callout>
        )}

        {loading && notes.length === 0 && <p className="project-notes__empty">Cargando…</p>}

        {!loading && notes.length === 0 && problem === null && (
          <p className="project-notes__empty">
            {filter === 'scene'
              ? `No hay notas en «${sceneTitle}».`
              : filter === 'mine'
                ? 'No tiene notas asignadas.'
                : 'El proyecto no tiene notas que usted pueda ver.'}
          </p>
        )}

        <ul className="project-notes__list">
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="project-notes__item"
                aria-expanded={note.id === selectedId}
                onClick={() => {
                  setSelectedId(note.id === selectedId ? null : note.id);
                  setDraft('');
                }}
              >
                <span className="project-notes__title">{note.title}</span>
                <span className="project-notes__meta">
                  <Badge tone={note.priority === 'urgent' ? 'alarm' : 'neutral'}>
                    {NOTE_PRIORITY_LABELS[
                      note.priority as keyof typeof NOTE_PRIORITY_LABELS
                    ] ?? note.priority}
                  </Badge>
                  <Badge tone="neutral">
                    {NOTE_STATUS_LABELS[note.status as keyof typeof NOTE_STATUS_LABELS] ??
                      note.status}
                  </Badge>
                  {note.comments.length > 0 && (
                    <Badge tone="neutral">{note.comments.length} comentario(s)</Badge>
                  )}
                </span>
              </button>

              {note.id === selectedId && (
                <div className="project-notes__detail">
                  {note.body.length > 0 && <p className="project-notes__body">{note.body}</p>}

                  <ol className="project-notes__comments">
                    {note.comments.map((comment) => (
                      <li key={comment.id}>
                        <strong>{comment.authorName}</strong> {comment.body}
                      </li>
                    ))}
                  </ol>

                  <TextArea
                    rows={2}
                    value={draft}
                    placeholder="Añadir un comentario"
                    aria-label="Comentario"
                    onChange={(event) => setDraft(event.currentTarget.value)}
                  />
                  <div className="project-notes__actions">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={sending || draft.trim().length === 0}
                      onClick={() => void sendComment()}
                    >
                      Comentar
                    </Button>

                    {/* Los estados vienen del servicio. Resolver y archivar no
                        están aquí a propósito: resolver exige escribir cómo se
                        resolvió, y eso no cabe en esta pantalla. */}
                    <Select
                      size="sm"
                      value={note.status}
                      aria-label="Estado de la nota"
                      onChange={(event) => void changeStatus(event.currentTarget.value)}
                    >
                      {statuses.map((status) => (
                        <option key={status} value={status}>
                          {NOTE_STATUS_LABELS[status as keyof typeof NOTE_STATUS_LABELS] ??
                            status}
                        </option>
                      ))}
                      {!statuses.includes(note.status) && (
                        <option value={note.status} disabled>
                          {NOTE_STATUS_LABELS[
                            note.status as keyof typeof NOTE_STATUS_LABELS
                          ] ?? note.status}
                        </option>
                      )}
                    </Select>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
