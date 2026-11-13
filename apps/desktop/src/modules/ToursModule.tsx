/**
 * Recorridos y formación (etapa 09: J01–J03, J08, O01–O09).
 *
 * Dos cosas distintas comparten pantalla porque se condicionan: un recorrido
 * puede exigir haber aprobado una evaluación (J08). Tenerlas en módulos
 * separados obligaría a saltar de uno a otro para configurar una sola cosa.
 *
 * La lista de la izquierda mezcla recorridos y evaluaciones, separados por
 * epígrafe. A la derecha se edita lo seleccionado.
 *
 * Los avisos de validación están siempre a la vista, no detrás de un botón de
 * comprobar. Un recorrido que apunta a una escena borrada se para en seco
 * delante de la visita, y ese es exactamente el momento en que el autor ya no
 * puede arreglarlo.
 */
import { useMemo, useState } from 'react';
import {
  createQuiz,
  createTour,
  estimatedTourSeconds,
  validateQuiz,
  validateTour,
  type Quiz,
  type Tour,
} from '@it360/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  CountPill,
  EmptyState,
  IconQuiz,
  IconTour,
  SectionLabel,
  useToast,
} from '@it360/ui';
import { QuizEditor } from './QuizEditor';
import { TourEditor } from './TourEditor';
import type { ProjectStore } from '../state/project-store';

export interface ToursModuleProps {
  readonly store: ProjectStore;
}

type Selection = { readonly kind: 'tour' | 'quiz'; readonly id: string } | null;

export function ToursModule({ store }: ToursModuleProps): JSX.Element {
  const { project } = store;
  const { push } = useToast();
  const [selection, setSelection] = useState<Selection>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tour = useMemo(
    () => (selection?.kind === 'tour' ? (project.tours.find((t) => t.id === selection.id) ?? null) : null),
    [selection, project.tours],
  );

  const quiz = useMemo(
    () => (selection?.kind === 'quiz' ? (project.quizzes.find((q) => q.id === selection.id) ?? null) : null),
    [selection, project.quizzes],
  );

  /* Conjuntos que la validación necesita para detectar referencias muertas. */
  const refs = useMemo(
    () => ({
      sceneIds: new Set(project.scenes.map((s) => s.id)),
      quizIds: new Set(project.quizzes.map((q) => q.id)),
      mediaIds: new Set(project.media.map((m) => m.id)),
    }),
    [project.scenes, project.quizzes, project.media],
  );

  const onNewTour = (): void => {
    const created = createTour(project.id, `Recorrido ${project.tours.length + 1}`, new Date().toISOString());
    store.updateProject(`Crear recorrido ${created.name}`, { tours: [...project.tours, created] });
    setSelection({ kind: 'tour', id: created.id });
  };

  const onNewQuiz = (): void => {
    const created = createQuiz(project.id, `Evaluación ${project.quizzes.length + 1}`, new Date().toISOString());
    store.updateProject(`Crear evaluación ${created.name}`, { quizzes: [...project.quizzes, created] });
    setSelection({ kind: 'quiz', id: created.id });
  };

  const onSaveTour = (next: Tour, label: string): void => {
    store.updateProject(label, {
      tours: project.tours.map((t) => (t.id === next.id ? { ...next, updatedAt: new Date().toISOString() } : t)),
    });
  };

  const onSaveQuiz = (next: Quiz, label: string): void => {
    store.updateProject(label, {
      quizzes: project.quizzes.map((q) => (q.id === next.id ? { ...next, updatedAt: new Date().toISOString() } : q)),
    });
  };

  /**
   * Borrar una evaluación deja sin referencia los recorridos que la exigían.
   *
   * Se limpia aquí, en la misma operación: un recorrido que exige una
   * evaluación borrada no se puede publicar, y el autor no tendría por qué
   * adivinar cuál de ellos quedó roto.
   */
  const onDelete = (): void => {
    if (tour !== null) {
      store.updateProject(`Eliminar recorrido ${tour.name}`, {
        tours: project.tours.filter((t) => t.id !== tour.id),
      });
      push({ tone: 'neutral', title: `Recorrido «${tour.name}» eliminado` });
    } else if (quiz !== null) {
      const affected = project.tours.filter((t) => t.requiresQuizId === quiz.id);
      store.updateProject(`Eliminar evaluación ${quiz.name}`, {
        quizzes: project.quizzes.filter((q) => q.id !== quiz.id),
        tours: project.tours.map((t) =>
          t.requiresQuizId === quiz.id ? { ...t, requiresQuizId: null, requiresQuizMinScore: null } : t,
        ),
      });
      push({
        tone: affected.length > 0 ? 'warning' : 'neutral',
        title: `Evaluación «${quiz.name}» eliminada`,
        ...(affected.length > 0
          ? { description: `${affected.length} recorrido(s) ya no la exigen.` }
          : {}),
      });
    }

    setConfirmDelete(false);
    setSelection(null);
  };

  const deleteTarget = tour?.name ?? quiz?.name ?? '';
  const quizDependents = quiz === null ? [] : project.tours.filter((t) => t.requiresQuizId === quiz.id);

  return (
    <div className="module">
      <header className="module__head">
        <div>
          <h1 className="module__title">Recorridos y formación</h1>
          <p className="module__subtitle">
            Recorridos automáticos con puntos de paso, y evaluaciones con puntuaciones independientes.
          </p>
        </div>
        <div className="module__actions">
          <Button size="sm" variant="secondary" icon={<IconTour size={14} />} onClick={onNewTour}>
            Nuevo recorrido
          </Button>
          <Button size="sm" variant="secondary" icon={<IconQuiz size={14} />} onClick={onNewQuiz}>
            Nueva evaluación
          </Button>
        </div>
      </header>

      <div className="tours">
        <aside className="tours__list" aria-label="Recorridos y evaluaciones">
          <div className="tours__group">
            <div className="tours__group-head">
              <SectionLabel>Recorridos</SectionLabel>
              <CountPill count={project.tours.length} label="recorridos" />
            </div>
            {project.tours.length === 0 ? (
              <p className="tours__empty">Ninguno todavía.</p>
            ) : (
              <ul className="tours__items">
                {project.tours.map((item) => (
                  <TourRow
                    key={item.id}
                    tour={item}
                    current={selection?.kind === 'tour' && selection.id === item.id}
                    problems={validateTour(item, refs)}
                    onSelect={() => setSelection({ kind: 'tour', id: item.id })}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="tours__group">
            <div className="tours__group-head">
              <SectionLabel>Evaluaciones</SectionLabel>
              <CountPill count={project.quizzes.length} label="evaluaciones" />
            </div>
            {project.quizzes.length === 0 ? (
              <p className="tours__empty">Ninguna todavía.</p>
            ) : (
              <ul className="tours__items">
                {project.quizzes.map((item) => (
                  <QuizRow
                    key={item.id}
                    quiz={item}
                    current={selection?.kind === 'quiz' && selection.id === item.id}
                    onSelect={() => setSelection({ kind: 'quiz', id: item.id })}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="tours__detail">
          {tour !== null && (
            <TourEditor
              tour={tour}
              project={project}
              onChange={onSaveTour}
              onRequestDelete={() => setConfirmDelete(true)}
            />
          )}
          {quiz !== null && (
            <QuizEditor
              quiz={quiz}
              project={project}
              onChange={onSaveQuiz}
              onRequestDelete={() => setConfirmDelete(true)}
            />
          )}
          {tour === null && quiz === null && (
            <EmptyState
              icon={<IconTour size={30} />}
              title={
                project.tours.length === 0 && project.quizzes.length === 0
                  ? 'Sin recorridos ni evaluaciones'
                  : 'Seleccione un recorrido o una evaluación'
              }
              description={
                project.tours.length === 0 && project.quizzes.length === 0
                  ? 'Un recorrido lleva al visitante por una secuencia de vistas. Una evaluación comprueba lo aprendido y puede condicionar el acceso a un recorrido.'
                  : 'Elija uno de la lista para editar sus puntos de paso, su narración y sus condiciones.'
              }
            />
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        destructive
        title={tour !== null ? 'Eliminar recorrido' : 'Eliminar evaluación'}
        confirmLabel="Eliminar"
        message={
          quizDependents.length > 0
            ? `Se eliminará «${deleteTarget}». ${quizDependents.length} recorrido(s) dejarán de exigirla: ${quizDependents
                .map((t) => t.name)
                .join(', ')}. La operación se puede deshacer con Ctrl+Z.`
            : `Se eliminará «${deleteTarget}». La operación se puede deshacer con Ctrl+Z.`
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Filas de la lista
 * ------------------------------------------------------------------ */

function TourRow({
  tour,
  current,
  problems,
  onSelect,
}: {
  tour: Tour;
  current: boolean;
  problems: readonly { severity: 'blocking' | 'advisory' }[];
  onSelect: () => void;
}): JSX.Element {
  const blocking = problems.filter((p) => p.severity === 'blocking').length;
  const seconds = estimatedTourSeconds(tour);

  return (
    <li>
      <button type="button" className="tours__item" aria-current={current} onClick={onSelect}>
        <span className="tours__item-name">{tour.name}</span>
        <span className="tours__item-meta">
          {tour.waypoints.length} parada(s) · {formatDuration(seconds)}
          {!tour.allowInterrupt && ' · no interrumpible'}
        </span>
        {blocking > 0 && (
          <Badge tone="alarm">
            {blocking}
          </Badge>
        )}
      </button>
    </li>
  );
}

function QuizRow({
  quiz,
  current,
  onSelect,
}: {
  quiz: Quiz;
  current: boolean;
  onSelect: () => void;
}): JSX.Element {
  const blocking = validateQuiz(quiz).length;

  return (
    <li>
      <button type="button" className="tours__item" aria-current={current} onClick={onSelect}>
        <span className="tours__item-name">{quiz.name}</span>
        <span className="tours__item-meta">
          {quiz.questions.length} pregunta(s)
          {quiz.goals.length > 0 && ` · ${quiz.goals.length} objetivo(s)`}
        </span>
        {blocking > 0 && (
          <Badge tone="alarm">
            {blocking}
          </Badge>
        )}
      </button>
    </li>
  );
}

/** Duración en minutos y segundos, siempre como mínimo (no cuenta el audio). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'sin duración';
  if (seconds < 60) return `≥ ${Math.round(seconds)} s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `≥ ${minutes} min` : `≥ ${minutes} min ${rest} s`;
}
