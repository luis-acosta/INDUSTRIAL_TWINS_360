/**
 * Editor de un recorrido automático (J01–J03, J08).
 *
 * El orden de la pantalla sigue el orden en que se construye un recorrido:
 * primero las paradas, luego cómo se comporta, y al final de qué depende.
 *
 * Las paradas se editan en la propia lista, no en un panel aparte: son pocos
 * campos y verlos junto a la secuencia es lo que permite notar que una parada
 * de cuatro segundos lleva una narración de medio minuto.
 *
 * Los avisos de validación están siempre a la vista, no detrás de un botón de
 * comprobar. Un recorrido que apunta a una escena borrada se para en seco
 * delante de la visita, y ese es exactamente el momento en que el autor ya no
 * puede arreglarlo.
 *
 * El teclado hace todo lo que hace el ratón: subir y bajar una parada tiene
 * botones, no hay arrastre obligatorio.
 */
import { useId, useState } from 'react';
import {
  duplicateWaypoint,
  moveWaypoint,
  newUuid,
  removeWaypoint,
  updateWaypoint,
  validateTour,
  type Media,
  type Project,
  type Tour,
  type Uuid,
  type TourProblem,
  type Waypoint,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  IconCopy,
  IconTrash,
  NumberInput,
  Panel,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '@it360/ui';
import { ActionEditor } from './ActionEditor';
import { formatDuration } from './ToursModule';

export interface TourEditorProps {
  /** Importa un audio en el proyecto y devuelve su identificador (V05). */
  readonly onImportAudio?: (file: File) => Promise<string | null>;
  readonly tour: Tour;
  readonly project: Project;
  readonly onChange: (tour: Tour, label: string) => void;
  readonly onRequestDelete: () => void;
}

export function TourEditor({
  tour,
  project,
  onChange,
  onRequestDelete,
  onImportAudio,
}: TourEditorProps): JSX.Element {
  const [openWaypoint, setOpenWaypoint] = useState<string | null>(null);

  const problems = validateTour(tour, {
    sceneIds: new Set(project.scenes.map((s) => s.id)),
    quizIds: new Set(project.quizzes.map((q) => q.id)),
    mediaIds: new Set(project.media.map((m) => m.id)),
  });

  const blocking = problems.filter((p) => p.severity === 'blocking');
  const advisories = problems.filter((p) => p.severity === 'advisory');
  const ordered = [...tour.waypoints].sort((a, b) => a.order - b.order);

  const audios = project.media.filter((m) => m.kind === 'audio');
  const sceneTitle = (id: string): string =>
    project.scenes.find((s) => s.id === id)?.title ?? 'escena eliminada';

  const set = (patch: Partial<Tour>, label: string): void => onChange({ ...tour, ...patch }, label);

  const problemsOf = (waypointId: string): TourProblem[] =>
    problems.filter((p) => p.waypointId === waypointId);

  const onAddWaypoint = (sceneId: string): void => {
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (scene === undefined) return;

    // La vista inicial de la escena es el punto de partida razonable; el autor
    // la ajusta después desde el visor.
    const waypoint: Waypoint = {
      id: newUuid(),
      sceneId: scene.id,
      view: scene.camera.initialView,
      dwellMs: 4000,
      travelMs: 1500,
      actions: [],
      caption: '',
      audioMediaId: null,
      waitForAudio: true,
      order: ordered.length,
    };

    onChange({ ...tour, waypoints: [...ordered, waypoint] }, `Añadir parada en ${scene.title}`);
    setOpenWaypoint(waypoint.id);
  };

  return (
    <div className="tour-editor">
      <header className="tour-editor__head">
        <Field label="Nombre del recorrido">
          {({ id }) => (
            <TextInput
              id={id}
              value={tour.name}
              onChange={(event) => set({ name: event.currentTarget.value }, 'Renombrar recorrido')}
            />
          )}
        </Field>
        <div className="tour-editor__summary">
          <span>{ordered.length} parada(s)</span>
          <span>{formatDuration(estimated(tour))}</span>
          {blocking.length > 0 && <Badge tone="alarm">{blocking.length} error(es)</Badge>}
        </div>
      </header>

      {blocking.length > 0 && (
        <Callout tone="alarm" title="No se puede publicar todavía">
          <ul className="tour-editor__problems">
            {blocking.map((problem, index) => (
              <li key={`b${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      {advisories.length > 0 && (
        <Callout tone="info" title="Conviene revisar">
          <ul className="tour-editor__problems">
            {advisories.map((problem, index) => (
              <li key={`a${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      <Panel title="Puntos de paso" level="raised">
        {ordered.length === 0 ? (
          <p className="tour-editor__hint">
            Un recorrido necesita al menos una parada. Añada la primera abajo.
          </p>
        ) : (
          <ol className="waypoints" aria-label="Puntos de paso">
            {ordered.map((waypoint, index) => (
              <WaypointRow
                key={waypoint.id}
                waypoint={waypoint}
                index={index}
                total={ordered.length}
                sceneTitle={sceneTitle(waypoint.sceneId)}
                project={project}
                audios={audios}
                problems={problemsOf(waypoint.id)}
                open={openWaypoint === waypoint.id}
                onToggle={() => setOpenWaypoint(openWaypoint === waypoint.id ? null : waypoint.id)}
                onPatch={(patch, label) => onChange(updateWaypoint(tour, waypoint.id, patch), label)}
                {...(onImportAudio === undefined ? {} : { onImportAudio })}
                onMove={(delta) =>
                  onChange(moveWaypoint(tour, waypoint.id, index + delta), 'Reordenar paradas')
                }
                onDuplicate={() => onChange(duplicateWaypoint(tour, waypoint.id), 'Duplicar parada')}
                onRemove={() => {
                  onChange(removeWaypoint(tour, waypoint.id), 'Quitar parada');
                  setOpenWaypoint(null);
                }}
              />
            ))}
          </ol>
        )}

        <div className="tour-editor__add">
          <Field label="Añadir parada en">
            {({ id }) => (
              <Select
                id={id}
                value=""
                onChange={(event) => onAddWaypoint(event.currentTarget.value)}
                disabled={project.scenes.length === 0}
              >
                <option value="">
                  {project.scenes.length === 0 ? 'No hay escenas en el proyecto' : 'Elija una escena…'}
                </option>
                {project.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Comportamiento" level="raised">
        <div className="tour-editor__behaviour">
          <SwitchRow
            label="El visitante puede interrumpirlo"
            hint="Desactivarlo sólo tiene sentido en un quiosco vigilado: el visitante no podrá pausar ni mirar a otro lado."
            checked={tour.allowInterrupt}
            onChange={(checked) =>
              set({ allowInterrupt: checked }, checked ? 'Permitir interrupción' : 'Impedir interrupción')
            }
          />
          <SwitchRow
            label="Reanudar donde se interrumpió"
            hint="Desactivado, el recorrido vuelve a empezar desde la primera parada."
            checked={tour.resumeAfterInterrupt}
            disabled={!tour.allowInterrupt}
            onChange={(checked) => set({ resumeAfterInterrupt: checked }, 'Cambiar reanudación')}
          />
          <SwitchRow
            label="En bucle"
            hint="Al acabar la última parada vuelve a la primera."
            checked={tour.loop}
            onChange={(checked) => set({ loop: checked }, checked ? 'Activar bucle' : 'Desactivar bucle')}
          />

          <Field
            label="Reanudar solo tras inactividad"
            hint="Segundos sin tocar nada antes de continuar por su cuenta. 0 = nunca."
          >
            {({ id, describedBy }) => (
              <NumberInput
                id={id}
                aria-describedby={describedBy}
                value={tour.autoResumeIdleS}
                min={0}
                max={3600}
                step={5}
                unit="s"
                disabled={!tour.allowInterrupt}
                onValueChange={(value) => set({ autoResumeIdleS: value }, 'Cambiar reanudación automática')}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Condiciones de acceso" level="raised">
        <div className="tour-editor__gate">
          <Field
            label="Exige haber hecho la evaluación"
            hint="El visitante no puede empezar el recorrido sin superarla."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={tour.requiresQuizId ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  set(
                    value === ''
                      ? { requiresQuizId: null, requiresQuizMinScore: null }
                      : { requiresQuizId: value as Uuid },
                    'Cambiar evaluación requerida',
                  );
                }}
              >
                <option value="">Sin condición</option>
                {project.quizzes.map((quiz) => (
                  <option key={quiz.id} value={quiz.id}>
                    {quiz.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Nota mínima" hint="Puntuación general necesaria. 0 = basta con completarla.">
            {({ id, describedBy }) => (
              <NumberInput
                id={id}
                aria-describedby={describedBy}
                value={tour.requiresQuizMinScore ?? 0}
                min={0}
                disabled={tour.requiresQuizId === null}
                onValueChange={(value) =>
                  set({ requiresQuizMinScore: value === 0 ? null : value }, 'Cambiar nota mínima')
                }
              />
            )}
          </Field>
        </div>

        {project.quizzes.length === 0 && (
          <p className="tour-editor__hint">
            No hay evaluaciones en el proyecto. Cree una para poder condicionar el acceso.
          </p>
        )}
      </Panel>

      <Panel title="Descripción" level="raised">
        <Field label="Para el autor" hint="No se muestra al visitante.">
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              value={tour.description}
              onChange={(event) => set({ description: event.currentTarget.value }, 'Editar descripción')}
            />
          )}
        </Field>
      </Panel>

      <div className="tour-editor__foot">
        <Button variant="danger" size="sm" icon={<IconTrash size={14} />} onClick={onRequestDelete}>
          Eliminar recorrido
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Una parada
 * ------------------------------------------------------------------ */

function WaypointRow({
  waypoint,
  index,
  total,
  sceneTitle,
  project,
  audios,
  problems,
  open,
  onToggle,
  onPatch,
  onImportAudio,
  onMove,
  onDuplicate,
  onRemove,
}: {
  waypoint: Waypoint;
  index: number;
  total: number;
  sceneTitle: string;
  project: Project;
  audios: readonly Media[];
  problems: readonly TourProblem[];
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Waypoint>, label: string) => void;
  /** Importa un audio y devuelve su identificador, o `null` si no se pudo. */
  onImportAudio?: (file: File) => Promise<string | null>;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}): JSX.Element {
  const hasBlocking = problems.some((p) => p.severity === 'blocking');
  const audio = audios.find((m) => m.id === waypoint.audioMediaId);

  return (
    <li className="waypoint" data-problem={hasBlocking ? 'blocking' : undefined}>
      <div className="waypoint__head">
        <span className="waypoint__ordinal">{index + 1}</span>
        <button type="button" className="waypoint__title" aria-expanded={open} onClick={onToggle}>
          <span className="waypoint__scene">{sceneTitle}</span>
          <span className="waypoint__meta">
            {waypoint.waitForAudio && audio !== undefined
              ? 'espera al audio'
              : `${Math.round(waypoint.dwellMs / 1000)} s`}
            {waypoint.caption !== '' && ` · «${truncate(waypoint.caption, 32)}»`}
          </span>
        </button>

        <div className="waypoint__tools">
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Subir parada ${index + 1}`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            icon={<span aria-hidden>↑</span>}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Bajar parada ${index + 1}`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            icon={<span aria-hidden>↓</span>}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Duplicar parada ${index + 1}`}
            onClick={onDuplicate}
            icon={<IconCopy size={13} />}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Quitar parada ${index + 1}`}
            onClick={onRemove}
            icon={<IconTrash size={13} />}
          />
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="waypoint__problems">
          {problems.map((problem, i) => (
            <li key={i} data-severity={problem.severity}>
              {problem.message}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="waypoint__body">
          <Field label="Escena">
            {({ id }) => (
              <Select
                id={id}
                value={waypoint.sceneId}
                onChange={(event) =>
                  onPatch({ sceneId: event.currentTarget.value as Uuid }, 'Cambiar escena de la parada')
                }
              >
                {project.scenes.every((s) => s.id !== waypoint.sceneId) && (
                  <option value={waypoint.sceneId}>escena eliminada</option>
                )}
                {project.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Rótulo" hint="Texto mostrado durante la parada.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={waypoint.caption}
                onChange={(event) =>
                  onPatch({ caption: event.currentTarget.value }, 'Editar rótulo de la parada')
                }
              />
            )}
          </Field>

          <div className="waypoint__times">
            <Field label="Permanencia">
              {({ id }) => (
                <NumberInput
                  id={id}
                  value={Math.round(waypoint.dwellMs / 1000)}
                  min={0}
                  max={600}
                  unit="s"
                  onValueChange={(value) => onPatch({ dwellMs: value * 1000 }, 'Cambiar permanencia')}
                />
              )}
            </Field>
            <Field label="Desplazamiento">
              {({ id }) => (
                <NumberInput
                  id={id}
                  value={Math.round(waypoint.travelMs / 1000)}
                  min={0}
                  max={60}
                  unit="s"
                  onValueChange={(value) => onPatch({ travelMs: value * 1000 }, 'Cambiar desplazamiento')}
                />
              )}
            </Field>
          </div>

          <Field
            label="Narración"
            hint={
              audios.length === 0
                ? 'Aún no hay narraciones en el proyecto: importe un archivo de audio.'
                : undefined
            }
          >
            {({ id }) => (
              <div style={{ display: 'flex', gap: 'var(--it-space-2)', alignItems: 'center' }}>
                <Select
                  id={id}
                  value={waypoint.audioMediaId ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onPatch({ audioMediaId: value === '' ? null : (value as Uuid) }, 'Cambiar narración');
                  }}
                >
                  <option value="">Sin narración</option>
                  {audios.map((media) => (
                    <option key={media.id} value={media.id}>
                      {media.originalName}
                      {media.durationS === null ? '' : ` · ${Math.round(media.durationS)} s`}
                    </option>
                  ))}
                </Select>

                {/* Importar desde aquí y no desde una biblioteca aparte: el
                    autor está decidiendo la narración de esta parada, y
                    obligarle a ir a otro sitio y volver es donde se pierde el
                    hilo de lo que estaba haciendo. */}
                {onImportAudio !== undefined && (
                  <label className="button button--secondary button--sm">
                    Importar audio
                    <input
                      type="file"
                      accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,.mp3,.ogg,.wav,.weba,.m4a"
                      style={{ display: 'none' }}
                      onChange={async (event) => {
                        const file = event.currentTarget.files?.[0];
                        // El campo se limpia antes de esperar: si no, volver a
                        // elegir el mismo archivo no dispararía el evento.
                        event.currentTarget.value = '';
                        if (file === undefined) return;
                        const mediaId = await onImportAudio(file);
                        if (mediaId !== null) {
                          onPatch({ audioMediaId: mediaId as Uuid }, 'Asignar narración importada');
                        }
                      }}
                    />
                  </label>
                )}
              </div>
            )}
          </Field>

          <CheckboxRow
            label="Esperar a que termine la narración"
            hint="Sin esto, una narración más larga que la permanencia se corta a mitad."
            checked={waypoint.waitForAudio}
            onChange={(checked) => onPatch({ waitForAudio: checked }, 'Cambiar espera de audio')}
          />

          <ActionEditor
            project={project}
            scene={{ id: waypoint.sceneId, title: sceneTitle }}
            actions={waypoint.actions}
            title="Acciones al llegar"
            fixedEvent="waypointReached"
            onChange={(actions, label) => onPatch({ actions: [...actions] }, label)}
          />
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Interruptor y casilla con texto de ayuda
 *
 * El componente del sistema de diseño no lleva ayuda, y estas opciones la
 * necesitan: «no interrumpible» sin explicación parece una preferencia y es
 * una decisión con consecuencias. La ayuda se asocia con `aria-describedby`
 * para que el lector de pantalla también la anuncie.
 * ------------------------------------------------------------------ */

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const hintId = useId();

  return (
    <div className="switch-row">
      <Switch
        label={label}
        checked={checked}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <p className="switch-row__hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

function CheckboxRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const hintId = useId();

  return (
    <div className="switch-row">
      <Checkbox
        label={label}
        checked={checked}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <p className="switch-row__hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

export { SwitchRow, CheckboxRow };

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const estimated = (tour: Tour): number =>
  tour.waypoints.reduce((sum, w) => sum + w.dwellMs + w.travelMs, 0) / 1000;
