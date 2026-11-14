/**
 * Panel de notas de campo del recorrido publicado (P01).
 *
 * Lo que el operador tiene delante: el punto que está mirando, un asunto, una
 * categoría y su nombre. Nada más. Ni responsables ni fechas comprometidas:
 * quien recorre la planta describe lo que ve, y decidir quién lo atiende es del
 * responsable del proyecto.
 *
 * El panel dice con todas las letras dónde quedan las notas —en este navegador,
 * hasta que se descarguen— porque la alternativa es que alguien tome doce
 * observaciones creyendo que llegan solas a alguna parte.
 */
import { useEffect, useState } from 'react';
import {
  bundleFieldNotes,
  createFieldNote,
  NOTE_PRIORITY_LABELS,
  type FieldNote,
  type Manifest,
  type NotePriority,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  Field,
  Select,
  TextArea,
  TextInput,
} from '@it360/ui';
import {
  clearFieldNotes,
  downloadBundle,
  loadFieldNotes,
  saveFieldNotes,
} from './field-notes';

export interface FieldNotePanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly manifest: Manifest;
  /** Escena que se está viendo. */
  readonly sceneId: string | null;
  readonly sceneTitle: string;
  /** Punto que se está mirando, en radianes. */
  readonly yaw: number;
  readonly pitch: number;
}

/** Nombre del autor, recordado entre notas de la misma sesión. */
const AUTHOR_KEY = 'it360.fieldNotes.author';

export function FieldNotePanel({
  open,
  onClose,
  manifest,
  sceneId,
  sceneTitle,
  yaw,
  pitch,
}: FieldNotePanelProps): JSX.Element {
  const [notes, setNotes] = useState<readonly FieldNote[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('other');
  const [priority, setPriority] = useState<NotePriority>('normal');
  const [author, setAuthor] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Se cargan al abrir y no al montar: el panel vive dentro del visor y el
  // operador puede haber escrito desde otra pestaña.
  useEffect(() => {
    if (!open) return;
    setNotes(loadFieldNotes(manifest.projectId));
    setProblem(null);
    setDownloaded(null);
    try {
      setAuthor(window.localStorage.getItem(AUTHOR_KEY) ?? '');
    } catch {
      // Sin almacenamiento el nombre se teclea cada vez; no es motivo de aviso.
    }
  }, [open, manifest.projectId]);

  const persist = (next: readonly FieldNote[]): void => {
    setNotes(next);
    const result = saveFieldNotes(manifest.projectId, next);
    setProblem(result.ok ? null : (result.message ?? 'No se pudieron guardar las notas.'));
  };

  const canSave =
    sceneId !== null && title.trim().length > 0 && author.trim().length > 0;

  const onAdd = (): void => {
    if (sceneId === null) return;

    const note = createFieldNote({
      sceneId: sceneId as Uuid,
      yaw,
      pitch,
      title,
      body,
      categoryId,
      priority,
      authorName: author,
      now: new Date().toISOString(),
    });

    persist([...notes, note]);
    setTitle('');
    setBody('');
    setDownloaded(null);

    try {
      window.localStorage.setItem(AUTHOR_KEY, author.trim());
    } catch {
      // El nombre es una comodidad, no un dato que deba sobrevivir.
    }
  };

  const onDownload = (): void => {
    const bundle = bundleFieldNotes(
      notes,
      manifest.projectId,
      manifest.branding.title.length > 0 ? manifest.branding.title : manifest.title,
      new Date().toISOString(),
    );
    setDownloaded(downloadBundle(bundle, manifest.title));
  };

  const onClear = (): void => {
    const result = clearFieldNotes(manifest.projectId);
    setNotes([]);
    setConfirmClear(false);
    setProblem(result.ok ? null : (result.message ?? null));
  };

  const sceneTitleOf = (id: string): string =>
    manifest.scenes.find((scene) => scene.id === id)?.title ?? 'panorámica retirada';

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Notas de campo"
        description="Quedan guardadas en este navegador hasta que las descargue y las entregue al responsable del recorrido."
        size="lg"
        footer={
          <>
            {notes.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => setConfirmClear(true)}
                style={{ marginRight: 'auto' }}
              >
                Borrar las guardadas
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <Button variant="primary" onClick={onDownload} disabled={notes.length === 0}>
              Descargar {notes.length} nota(s)
            </Button>
          </>
        }
      >
        <div className="field-notes">
          {problem !== null && (
            <Callout tone="alarm" title="Atención con el guardado">
              {problem}
            </Callout>
          )}

          {downloaded !== null && (
            <Callout tone="nominal" title="Archivo descargado">
              {downloaded}. Entréguelo al responsable del recorrido para que lo importe al
              proyecto. Las notas siguen guardadas aquí hasta que las borre.
            </Callout>
          )}

          <section className="field-notes__form">
            <p className="field-notes__where">
              Se anclará al punto que está mirando en <b>{sceneTitle}</b>.
            </p>

            <Field label="Asunto" required>
              {({ id }) => (
                <TextInput
                  id={id}
                  value={title}
                  placeholder="Goteo en la brida de aspiración"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
              )}
            </Field>

            <Field label="Qué se observa">
              {({ id }) => (
                <TextArea
                  id={id}
                  rows={3}
                  value={body}
                  onChange={(event) => setBody(event.currentTarget.value)}
                />
              )}
            </Field>

            <Field label="Categoría">
              {({ id }) => (
                <Select
                  id={id}
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.currentTarget.value)}
                >
                  {manifest.noteCategories.length === 0 && <option value="other">Otro</option>}
                  {manifest.noteCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Prioridad">
              {({ id }) => (
                <Select
                  id={id}
                  value={priority}
                  onChange={(event) => setPriority(event.currentTarget.value as NotePriority)}
                >
                  {Object.entries(NOTE_PRIORITY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Su nombre"
              required
              hint="Se guarda tal como lo escriba. El recorrido publicado no verifica identidades."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={author}
                  onChange={(event) => setAuthor(event.currentTarget.value)}
                />
              )}
            </Field>

            <Button variant="secondary" fullWidth disabled={!canSave} onClick={onAdd}>
              Guardar la nota
            </Button>
          </section>

          {notes.length > 0 && (
            <section className="field-notes__list">
              <h3 className="field-notes__list-title">Notas tomadas ({notes.length})</h3>
              <ul>
                {notes.map((note) => (
                  <li key={note.id}>
                    <strong>{note.title}</strong>
                    <Badge tone={note.priority === 'urgent' ? 'alarm' : 'neutral'}>
                      {NOTE_PRIORITY_LABELS[note.priority]}
                    </Badge>
                    <span className="field-notes__scene">{sceneTitleOf(note.sceneId)}</span>
                    <span className="field-notes__when">
                      {note.createdAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Dialog>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Borrar las notas guardadas"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={onClear}>
              Borrar
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          Se borrarán las {notes.length} nota(s) guardadas en este navegador. Si no ha descargado
          el archivo, no habrá forma de recuperarlas.
        </p>
      </Dialog>
    </>
  );
}
