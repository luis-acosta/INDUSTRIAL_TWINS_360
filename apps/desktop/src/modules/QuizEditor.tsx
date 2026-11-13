/**
 * Editor de evaluaciones (O01–O09).
 *
 * Una evaluación con ramas es un grafo, y un grafo editado a ciegas se rompe
 * con facilidad: una opción que salta a una pregunta borrada, un ciclo que no
 * termina nunca. Por eso aquí:
 *
 *  - `validateQuiz` se muestra siempre, no tras pulsar comprobar.
 *  - Borrar una pregunta dice antes cuántas ramas la señalan, y al hacerlo las
 *    limpia (`removeQuestion` del dominio).
 *  - Las puntuaciones máximas por clave están a la vista, porque una nota
 *    mínima de 80 sobre un máximo de 60 es imposible de aprobar y nada en la
 *    pantalla lo delataría.
 */
import { useMemo, useState } from 'react';
import {
  addChoice,
  addGoal,
  addHuntTarget,
  createQuestion,
  deadHuntTargets,
  duplicateQuestion,
  maxScoresOf,
  moveChoice,
  moveQuestion,
  orphanGoals,
  questionRemovalImpact,
  removeChoice,
  removeGoal,
  removeHuntTarget,
  removeQuestion,
  scoreKeysOf,
  setChoiceCorrect,
  unreachableGoals,
  updateChoice,
  updateGoal,
  updateHuntTarget,
  updateQuestion,
  validateQuiz,
  type Project,
  type Question,
  type QuestionKind,
  type Quiz,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Field,
  IconAdd,
  IconCopy,
  IconTrash,
  NumberInput,
  Panel,
  SectionLabel,
  Select,
  TextArea,
  TextInput,
} from '@it360/ui';
import { ActionEditor } from './ActionEditor';
import { CheckboxRow, SwitchRow } from './TourEditor';

export interface QuizEditorProps {
  readonly quiz: Quiz;
  readonly project: Project;
  readonly onChange: (quiz: Quiz, label: string) => void;
  readonly onRequestDelete: () => void;
}

const KIND_LABELS: Record<QuestionKind, string> = {
  singleChoice: 'Respuesta única',
  multipleChoice: 'Respuesta múltiple',
  trueFalse: 'Verdadero / falso',
  hotspotHunt: 'Buscar marcadores',
  ordering: 'Ordenar',
};

export function QuizEditor({ quiz, project, onChange, onRequestDelete }: QuizEditorProps): JSX.Element {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<QuestionKind>('singleChoice');

  /* Todo lo que devuelve `validateQuiz` impide publicar: son referencias
     muertas y ciclos, no cuestiones de criterio. */
  const problems = useMemo(() => validateQuiz(quiz), [quiz]);

  const ordered = useMemo(() => [...quiz.questions].sort((a, b) => a.order - b.order), [quiz.questions]);
  const maxScores = useMemo(() => maxScoresOf(quiz), [quiz]);
  const keys = useMemo(() => scoreKeysOf(quiz), [quiz]);
  const orphans = useMemo(() => orphanGoals(quiz), [quiz]);
  const unreachable = useMemo(() => unreachableGoals(quiz), [quiz]);

  const set = (patch: Partial<Quiz>, label: string): void => onChange({ ...quiz, ...patch }, label);

  const impact = pendingRemoval === null ? null : questionRemovalImpact(quiz, pendingRemoval);

  const onAddQuestion = (): void => {
    const question = createQuestion(newKind, ordered.length);
    onChange(
      { ...quiz, questions: [...ordered, question] },
      `Añadir pregunta (${KIND_LABELS[newKind].toLowerCase()})`,
    );
    setOpenQuestion(question.id);
  };

  const onConfirmRemoval = (): void => {
    if (pendingRemoval === null) return;
    onChange(removeQuestion(quiz, pendingRemoval), 'Quitar pregunta');
    if (openQuestion === pendingRemoval) setOpenQuestion(null);
    setPendingRemoval(null);
  };

  /** Nota mínima por clave; 0 quita la exigencia. */
  const setPassing = (key: string, value: number): void => {
    const next = { ...quiz.passingScores };
    if (value <= 0) delete next[key];
    else next[key] = value;
    set({ passingScores: next }, 'Cambiar nota mínima');
  };

  return (
    <div className="tour-editor">
      <header className="tour-editor__head">
        <Field label="Nombre de la evaluación">
          {({ id }) => (
            <TextInput
              id={id}
              value={quiz.name}
              onChange={(event) => set({ name: event.currentTarget.value }, 'Renombrar evaluación')}
            />
          )}
        </Field>
        <div className="tour-editor__summary">
          <span>{ordered.length} pregunta(s)</span>
          <span>{keys.length} clave(s) de puntuación</span>
          {problems.length > 0 && <Badge tone="alarm">{problems.length} error(es)</Badge>}
        </div>
      </header>

      {problems.length > 0 && (
        <Callout tone="alarm" title="No se puede publicar todavía">
          <ul className="tour-editor__problems">
            {problems.map((problem, index) => (
              <li key={`e${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      {(orphans.length > 0 || unreachable.length > 0) && (
        <Callout tone="warning" title="Objetivos que no se alcanzarán nunca">
          <ul className="tour-editor__problems">
            {orphans.length > 0 && (
              <li>Ninguna pregunta puntúa en: {orphans.join(', ')}.</li>
            )}
            {unreachable.length > 0 && (
              <li>Piden más puntos de los alcanzables: {unreachable.join(', ')}.</li>
            )}
          </ul>
          Sus acciones no se ejecutarán.
        </Callout>
      )}

      <Panel title="Preguntas" level="raised">
        {ordered.length === 0 ? (
          <p className="tour-editor__hint">
            Una evaluación sin preguntas no se puede hacer. Añada la primera abajo.
          </p>
        ) : (
          <ol className="waypoints" aria-label="Preguntas">
            {ordered.map((question, index) => (
              <QuestionRow
                key={question.id}
                question={question}
                index={index}
                total={ordered.length}
                quiz={quiz}
                project={project}
                open={openQuestion === question.id}
                onToggle={() => setOpenQuestion(openQuestion === question.id ? null : question.id)}
                onPatch={(patch, label) => onChange(updateQuestion(quiz, question.id, patch), label)}
                onQuizChange={onChange}
                onMove={(delta) =>
                  onChange(moveQuestion(quiz, question.id, index + delta), 'Reordenar preguntas')
                }
                onDuplicate={() => onChange(duplicateQuestion(quiz, question.id), 'Duplicar pregunta')}
                onRemove={() => setPendingRemoval(question.id)}
              />
            ))}
          </ol>
        )}

        <div className="tour-editor__add">
          <Field label="Tipo de pregunta nueva">
            {({ id }) => (
              <Select
                id={id}
                value={newKind}
                onChange={(event) => setNewKind(event.currentTarget.value as QuestionKind)}
              >
                {Object.entries(KIND_LABELS).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button size="sm" variant="secondary" icon={<IconAdd size={14} />} onClick={onAddQuestion}>
            Añadir pregunta
          </Button>
        </div>
      </Panel>

      <Panel title="Puntuación" level="raised">
        {keys.length === 0 ? (
          <p className="tour-editor__hint">Las claves aparecen al añadir preguntas.</p>
        ) : (
          <div className="quiz-scores">
            {keys.map((key) => {
              const max = maxScores[key] ?? 0;
              const passing = quiz.passingScores[key];
              const impossible = passing !== undefined && passing > max;

              return (
                <div key={key} className="quiz-scores__row">
                  <div className="quiz-scores__key">
                    <span>{key}</span>
                    <Badge tone="neutral" mono>
                      máx. {max}
                    </Badge>
                  </div>
                  <Field
                    label="Nota mínima"
                    {...(impossible ? { error: `Imposible: el máximo alcanzable es ${max}.` } : {})}
                  >
                    {({ id, describedBy, invalid }) => (
                      <NumberInput
                        id={id}
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={passing ?? 0}
                        min={0}
                        onValueChange={(value) => setPassing(key, value)}
                      />
                    )}
                  </Field>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Objetivos de puntuación" level="raised">
        <GoalsPanel quiz={quiz} project={project} keys={keys} maxScores={maxScores} onChange={onChange} />
      </Panel>

      <Panel title="Presentación" level="raised">
        <div className="tour-editor__behaviour">
          <SwitchRow
            label="Explicar cada respuesta al momento"
            hint="Desactivado, la explicación se muestra sólo en el informe final."
            checked={quiz.immediateFeedback}
            onChange={(checked) => set({ immediateFeedback: checked }, 'Cambiar explicaciones')}
          />
          <SwitchRow
            label="Mostrar informe final"
            hint="Puntuaciones por clave y tiempos empleados."
            checked={quiz.showReport}
            onChange={(checked) => set({ showReport: checked }, 'Cambiar informe final')}
          />
          <SwitchRow
            label="Preguntas en orden aleatorio"
            hint="Si hay ramas entre preguntas, el salto manda sobre el orden aleatorio."
            checked={quiz.shuffleQuestions}
            onChange={(checked) => set({ shuffleQuestions: checked }, 'Cambiar orden aleatorio')}
          />
          <SwitchRow
            label="Opciones en orden aleatorio"
            hint="No afecta a las preguntas de ordenar, donde el orden es la respuesta."
            checked={quiz.shuffleChoices}
            onChange={(checked) => set({ shuffleChoices: checked }, 'Cambiar opciones aleatorias')}
          />

          <Field label="Primera pregunta" hint="Automático = la primera del orden.">
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={quiz.entryQuestionId ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  set({ entryQuestionId: value === '' ? null : value }, 'Cambiar pregunta de entrada');
                }}
              >
                <option value="">Automático</option>
                {ordered.map((question, index) => (
                  <option key={question.id} value={question.id}>
                    {index + 1}. {truncate(question.prompt, 40)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Descripción" level="raised">
        <Field label="Para el autor" hint="No se muestra al evaluado.">
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              value={quiz.description}
              onChange={(event) => set({ description: event.currentTarget.value }, 'Editar descripción')}
            />
          )}
        </Field>
      </Panel>

      <div className="tour-editor__foot">
        <Button variant="danger" size="sm" icon={<IconTrash size={14} />} onClick={onRequestDelete}>
          Eliminar evaluación
        </Button>
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={onConfirmRemoval}
        destructive
        title="Quitar pregunta"
        confirmLabel="Quitar"
        message={removalMessage(impact)}
      />
    </div>
  );
}

/**
 * Lo que se le dice al autor antes de borrar una pregunta.
 *
 * Las ramas que la señalan no se pierden en silencio: se cuentan aquí y se
 * limpian al confirmar. Un salto hacia una pregunta que ya no existe deja la
 * evaluación muerta a mitad.
 */
function removalMessage(
  impact: { choiceBranches: number; questionBranches: number; wasEntry: boolean } | null,
): string {
  if (impact === null) return 'La pregunta se eliminará de la evaluación.';

  const consequences: string[] = [];
  if (impact.choiceBranches > 0) {
    consequences.push(`${impact.choiceBranches} opción(es) que saltaban a ella volverán a seguir el orden`);
  }
  if (impact.questionBranches > 0) {
    consequences.push(
      `${impact.questionBranches} pregunta(s) que continuaban en ella volverán a seguir el orden`,
    );
  }
  if (impact.wasEntry) consequences.push('la entrada de la evaluación pasará a automático');

  const base = 'La pregunta se eliminará de la evaluación.';
  if (consequences.length === 0) return `${base} La operación se puede deshacer con Ctrl+Z.`;

  return `${base} Además, ${consequences.join('; ')}. La operación se puede deshacer con Ctrl+Z.`;
}

/* ------------------------------------------------------------------ *
 * Una pregunta
 * ------------------------------------------------------------------ */

function QuestionRow({
  question,
  index,
  total,
  quiz,
  project,
  open,
  onToggle,
  onPatch,
  onQuizChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  question: Question;
  index: number;
  total: number;
  quiz: Quiz;
  project: Project;
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Question>, label: string) => void;
  onQuizChange: (quiz: Quiz, label: string) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}): JSX.Element {
  const others = quiz.questions.filter((q) => q.id !== question.id);
  const usesChoices = question.kind !== 'hotspotHunt';
  const correct = question.choices.filter((c) => c.correct).length;

  return (
    <li className="waypoint">
      <div className="waypoint__head">
        <span className="waypoint__ordinal">{index + 1}</span>
        <button type="button" className="waypoint__title" aria-expanded={open} onClick={onToggle}>
          <span className="waypoint__scene">{truncate(question.prompt, 60)}</span>
          <span className="waypoint__meta">
            {KIND_LABELS[question.kind]}
            {usesChoices && ` · ${question.choices.length} opción(es)`}
            {question.scoreKey !== 'general' && ` · ${question.scoreKey}`}
            {!question.required && ' · opcional'}
          </span>
        </button>

        <div className="waypoint__tools">
          {usesChoices && question.kind !== 'ordering' && correct === 0 && (
            <Badge tone="warning">sin correcta</Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Subir pregunta ${index + 1}`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            icon={<span aria-hidden>↑</span>}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Bajar pregunta ${index + 1}`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            icon={<span aria-hidden>↓</span>}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Duplicar pregunta ${index + 1}`}
            onClick={onDuplicate}
            icon={<IconCopy size={13} />}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Quitar pregunta ${index + 1}`}
            onClick={onRemove}
            icon={<IconTrash size={13} />}
          />
        </div>
      </div>

      {open && (
        <div className="waypoint__body">
          <Field label="Enunciado">
            {({ id }) => (
              <TextArea
                id={id}
                rows={2}
                value={question.prompt}
                onChange={(event) => onPatch({ prompt: event.currentTarget.value }, 'Editar enunciado')}
              />
            )}
          </Field>

          <div className="waypoint__times">
            <Field label="Clave de puntuación" hint="Permite notas separadas por materia.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={question.scoreKey}
                  onChange={(event) =>
                    onPatch(
                      { scoreKey: event.currentTarget.value === '' ? 'general' : event.currentTarget.value },
                      'Cambiar clave de puntuación',
                    )
                  }
                />
              )}
            </Field>
            <Field label="Penalización" hint="Puntos restados al fallar.">
              {({ id, describedBy }) => (
                <NumberInput
                  id={id}
                  aria-describedby={describedBy}
                  value={question.penalty}
                  min={0}
                  onValueChange={(value) => onPatch({ penalty: value }, 'Cambiar penalización')}
                />
              )}
            </Field>
          </div>

          <div className="waypoint__times">
            <Field label="Tiempo límite" hint="0 = sin límite.">
              {({ id, describedBy }) => (
                <NumberInput
                  id={id}
                  aria-describedby={describedBy}
                  value={question.timeLimitS}
                  min={0}
                  max={3600}
                  unit="s"
                  onValueChange={(value) => onPatch({ timeLimitS: value }, 'Cambiar tiempo límite')}
                />
              )}
            </Field>
            <Field label="Intentos" hint="0 = ilimitados.">
              {({ id, describedBy }) => (
                <NumberInput
                  id={id}
                  aria-describedby={describedBy}
                  value={question.maxAttempts}
                  min={0}
                  max={20}
                  onValueChange={(value) => onPatch({ maxAttempts: value }, 'Cambiar intentos')}
                />
              )}
            </Field>
          </div>

          <div className="waypoint__times">
            <Field label="Multimedia de la pregunta" hint="Imagen, audio o vídeo mostrado con el enunciado.">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={question.mediaId ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onPatch({ mediaId: value === '' ? null : (value as Uuid) }, 'Cambiar multimedia');
                  }}
                >
                  <option value="">Sin multimedia</option>
                  {project.media
                    .filter((m) => m.kind === 'image' || m.kind === 'audio' || m.kind === 'video')
                    .map((media) => (
                      <option key={media.id} value={media.id}>
                        {media.originalName}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Se plantea en la escena" hint="Vacío = en la escena en que esté el visitante.">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={question.sceneId ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onPatch({ sceneId: value === '' ? null : (value as Uuid) }, 'Cambiar escena de la pregunta');
                  }}
                >
                  <option value="">La escena actual</option>
                  {project.scenes.map((scene) => (
                    <option key={scene.id} value={scene.id}>
                      {scene.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <CheckboxRow
            label="Obligatoria"
            hint="Sin responderla no se puede terminar la evaluación."
            checked={question.required}
            onChange={(checked) => onPatch({ required: checked }, 'Cambiar obligatoriedad')}
          />

          <Field
            label="Al responder, continuar en"
            hint="Se usa cuando la opción elegida no define su propia rama."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={question.nextQuestionId ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onPatch({ nextQuestionId: value === '' ? null : value }, 'Cambiar continuación');
                }}
              >
                <option value="">La siguiente del orden</option>
                {others.map((q) => (
                  <option key={q.id} value={q.id}>
                    {truncate(q.prompt, 40)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {question.kind === 'hotspotHunt' ? (
            <HuntTargets
              question={question}
              project={project}
              quiz={quiz}
              onQuizChange={onQuizChange}
            />
          ) : (
            <>
              <SectionLabel>Opciones</SectionLabel>
              {question.choices.length === 0 ? (
                <p className="tour-editor__hint">Sin opciones, la pregunta no se puede responder.</p>
              ) : (
                <ul className="choices">
                  {question.choices.map((choice, choiceIndex) => (
                    <li key={choice.id} className="choice">
                      <div className="choice__main">
                        {question.kind !== 'ordering' && (
                          <label className="choice__correct">
                            <input
                              type="checkbox"
                              checked={choice.correct}
                              aria-label={`La opción ${choiceIndex + 1} es correcta`}
                              onChange={(event) =>
                                onQuizChange(
                                  setChoiceCorrect(
                                    quiz,
                                    question.id,
                                    choice.id,
                                    event.currentTarget.checked,
                                  ),
                                  'Marcar opción correcta',
                                )
                              }
                            />
                            <span>correcta</span>
                          </label>
                        )}
                        <TextInput
                          aria-label={`Texto de la opción ${choiceIndex + 1}`}
                          value={choice.text}
                          onChange={(event) =>
                            onQuizChange(
                              updateChoice(quiz, question.id, choice.id, { text: event.currentTarget.value }),
                              'Editar opción',
                            )
                          }
                        />
                        <NumberInput
                          aria-label={`Puntos de la opción ${choiceIndex + 1}`}
                          value={choice.points}
                          onValueChange={(value) =>
                            onQuizChange(
                              updateChoice(quiz, question.id, choice.id, { points: value }),
                              'Cambiar puntos de la opción',
                            )
                          }
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          aria-label={`Subir opción ${choiceIndex + 1}`}
                          disabled={choiceIndex === 0}
                          onClick={() =>
                            onQuizChange(
                              moveChoice(quiz, question.id, choice.id, choiceIndex - 1),
                              'Reordenar opciones',
                            )
                          }
                          icon={<span aria-hidden>↑</span>}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          aria-label={`Quitar opción ${choiceIndex + 1}`}
                          onClick={() =>
                            onQuizChange(removeChoice(quiz, question.id, choice.id), 'Quitar opción')
                          }
                          icon={<IconTrash size={13} />}
                        />
                      </div>

                      <div className="choice__extra">
                        <Field label="Explicación">
                          {({ id }) => (
                            <TextInput
                              id={id}
                              value={choice.feedback}
                              onChange={(event) =>
                                onQuizChange(
                                  updateChoice(quiz, question.id, choice.id, {
                                    feedback: event.currentTarget.value,
                                  }),
                                  'Editar explicación',
                                )
                              }
                            />
                          )}
                        </Field>
                        <Field label="Si se elige, saltar a">
                          {({ id }) => (
                            <Select
                              id={id}
                              value={choice.nextQuestionId ?? ''}
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                onQuizChange(
                                  updateChoice(quiz, question.id, choice.id, {
                                    nextQuestionId: value === '' ? null : value,
                                  }),
                                  'Cambiar rama de la opción',
                                );
                              }}
                            >
                              <option value="">Sin rama</option>
                              {others.map((q) => (
                                <option key={q.id} value={q.id}>
                                  {truncate(q.prompt, 36)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <Button
                size="sm"
                variant="ghost"
                icon={<IconAdd size={13} />}
                onClick={() => onQuizChange(addChoice(quiz, question.id), 'Añadir opción')}
              >
                Añadir opción
              </Button>

              {question.kind === 'ordering' && (
                <OrderingSetup question={question} quiz={quiz} onQuizChange={onQuizChange} />
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Ordenar: la respuesta correcta es una lista de opciones
 * ------------------------------------------------------------------ */

function OrderingSetup({
  question,
  quiz,
  onQuizChange,
}: {
  question: Question;
  quiz: Quiz;
  onQuizChange: (quiz: Quiz, label: string) => void;
}): JSX.Element {
  const inOrder = question.correctOrder
    .map((id) => question.choices.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const missing = question.choices.filter((c) => !question.correctOrder.includes(c.id));

  const move = (index: number, delta: number): void => {
    const next = [...question.correctOrder];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    onQuizChange(updateQuestion(quiz, question.id, { correctOrder: next }), 'Reordenar respuesta correcta');
  };

  return (
    <>
      <SectionLabel>Orden correcto</SectionLabel>
      {inOrder.length === 0 ? (
        <p className="tour-editor__hint">
          Añada las opciones al orden correcto; sin él la pregunta no se puede acertar.
        </p>
      ) : (
        <ol className="ordering">
          {inOrder.map((choice, index) => (
            <li key={choice.id} className="ordering__item">
              <span>{choice.text}</span>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`Subir ${choice.text} en el orden correcto`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                icon={<span aria-hidden>↑</span>}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`Quitar ${choice.text} del orden correcto`}
                onClick={() =>
                  onQuizChange(
                    updateQuestion(quiz, question.id, {
                      correctOrder: question.correctOrder.filter((id) => id !== choice.id),
                    }),
                    'Quitar del orden correcto',
                  )
                }
                icon={<IconTrash size={13} />}
              />
            </li>
          ))}
        </ol>
      )}

      {missing.length > 0 && (
        <Field label="Añadir al orden correcto">
          {({ id }) => (
            <Select
              id={id}
              value=""
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === '') return;
                onQuizChange(
                  updateQuestion(quiz, question.id, {
                    correctOrder: [...question.correctOrder, value],
                  }),
                  'Añadir al orden correcto',
                );
              }}
            >
              <option value="">Elija una opción…</option>
              {missing.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.text}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Buscar marcadores: los objetivos se eligen en la escena
 * ------------------------------------------------------------------ */

function HuntTargets({
  question,
  project,
  quiz,
  onQuizChange,
}: {
  question: Question;
  project: Project;
  quiz: Quiz;
  onQuizChange: (quiz: Quiz, label: string) => void;
}): JSX.Element {
  /* Marcadores del proyecto que todavía no son objetivo de esta pregunta. El
     mismo marcador dos veces puntuaría dos veces por un solo hallazgo. */
  const taken = new Set(question.huntTargets.map((t) => t.hotspotId));
  const available = project.scenes.flatMap((scene) =>
    scene.hotspots.filter((h) => !taken.has(h.id)).map((hotspot) => ({ scene, hotspot })),
  );

  const liveHotspots = new Set(project.scenes.flatMap((s) => s.hotspots.map((h) => h.id)));
  const dead = deadHuntTargets(quiz, liveHotspots);

  return (
    <>
      <SectionLabel>Marcadores a encontrar</SectionLabel>

      {question.huntTargets.length === 0 ? (
        <p className="tour-editor__hint">Sin objetivos, la pregunta no tiene nada que buscar.</p>
      ) : (
        <ul className="choices" aria-label="Marcadores a encontrar">
          {question.huntTargets.map((target, index) => {
            const scene = project.scenes.find((s) => s.id === target.sceneId);
            const missing = dead.includes(target.id);

            return (
              <li key={target.id} className="choice">
                <div className="hunt-target">
                  <span className="hunt-target__place">
                    {scene?.title ?? 'escena eliminada'}
                    {missing && (
                      <Badge tone="alarm">marcador borrado</Badge>
                    )}
                  </span>
                  <TextInput
                    aria-label={`Nombre del objetivo ${index + 1}`}
                    placeholder="Qué hay que encontrar"
                    value={target.label}
                    onChange={(event) =>
                      onQuizChange(
                        updateHuntTarget(quiz, question.id, target.id, {
                          label: event.currentTarget.value,
                        }),
                        'Renombrar objetivo',
                      )
                    }
                  />
                  <NumberInput
                    aria-label={`Puntos del objetivo ${index + 1}`}
                    value={target.points}
                    onValueChange={(value) =>
                      onQuizChange(
                        updateHuntTarget(quiz, question.id, target.id, { points: value }),
                        'Cambiar puntos del objetivo',
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Quitar objetivo ${index + 1}`}
                    onClick={() =>
                      onQuizChange(
                        removeHuntTarget(quiz, question.id, target.id),
                        'Quitar objetivo',
                      )
                    }
                    icon={<IconTrash size={13} />}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {available.length === 0 ? (
        <p className="tour-editor__hint">
          {taken.size === 0
            ? 'No hay marcadores en el proyecto. Cree marcadores en las escenas para poder buscarlos.'
            : 'Todos los marcadores del proyecto ya son objetivo de esta pregunta.'}
        </p>
      ) : (
        <Field label="Añadir marcador a buscar">
          {({ id }) => (
            <Select
              id={id}
              value=""
              onChange={(event) => {
                const value = event.currentTarget.value;
                const found = available.find((entry) => entry.hotspot.id === value);
                if (found === undefined) return;
                onQuizChange(
                  addHuntTarget(quiz, question.id, {
                    sceneId: found.scene.id,
                    hotspotId: found.hotspot.id,
                    label: found.hotspot.name,
                  }),
                  'Añadir objetivo a buscar',
                );
              }}
            >
              <option value="">Elija un marcador…</option>
              {available.map(({ scene, hotspot }) => (
                <option key={hotspot.id} value={hotspot.id}>
                  {scene.title} · {hotspot.name === '' ? 'marcador sin nombre' : hotspot.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Objetivos de puntuación (O08)
 *
 * Un objetivo desbloquea acciones al alcanzarse. Las dos formas de que no
 * ocurra nunca —una clave que nadie puntúa y una meta por encima del máximo—
 * se ven aquí, junto al objetivo, además de en el aviso de arriba.
 * ------------------------------------------------------------------ */

function GoalsPanel({
  quiz,
  project,
  keys,
  maxScores,
  onChange,
}: {
  quiz: Quiz;
  project: Project;
  keys: readonly string[];
  maxScores: Record<string, number>;
  onChange: (quiz: Quiz, label: string) => void;
}): JSX.Element {
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const free = keys.filter((key) => !quiz.goals.some((goal) => goal.scoreKey === key));
  const firstScene = project.scenes[0];

  return (
    <>
      {quiz.goals.length === 0 ? (
        <p className="tour-editor__hint">
          Ninguno. Un objetivo ejecuta acciones cuando el evaluado alcanza una puntuación.
        </p>
      ) : (
        <ul className="goals" aria-label="Objetivos de puntuación">
          {quiz.goals.map((goal) => {
            const max = maxScores[goal.scoreKey] ?? 0;
            const impossible = goal.target > max;

            return (
              <li key={goal.scoreKey} className="goal">
                <div className="goal__head">
                  <Badge tone="neutral" mono>
                    {goal.scoreKey}
                  </Badge>
                  <TextInput
                    aria-label={`Nombre del objetivo ${goal.scoreKey}`}
                    value={goal.label}
                    onChange={(event) =>
                      onChange(
                        updateGoal(quiz, goal.scoreKey, { label: event.currentTarget.value }),
                        'Renombrar objetivo',
                      )
                    }
                  />
                  <Field
                    label="Meta"
                    {...(impossible ? { error: `El máximo alcanzable es ${max}.` } : {})}
                  >
                    {({ id, describedBy, invalid }) => (
                      <NumberInput
                        id={id}
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={goal.target}
                        onValueChange={(value) =>
                          onChange(updateGoal(quiz, goal.scoreKey, { target: value }), 'Cambiar meta')
                        }
                      />
                    )}
                  </Field>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Quitar objetivo ${goal.scoreKey}`}
                    onClick={() => onChange(removeGoal(quiz, goal.scoreKey), 'Quitar objetivo')}
                    icon={<IconTrash size={13} />}
                  />
                </div>

                {firstScene !== undefined && (
                  <ActionEditor
                    project={project}
                    scene={{ id: firstScene.id, title: firstScene.title }}
                    actions={goal.onReached}
                    title="Al alcanzarlo"
                    fixedEvent="scoreThreshold"
                    onChange={(actions, label) =>
                      onChange(
                        updateGoal(quiz, goal.scoreKey, { onReached: [...actions] }),
                        label,
                      )
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {free.length === 0 && quiz.goals.length > 0 ? (
        <p className="tour-editor__hint">Cada clave de puntuación ya tiene su objetivo.</p>
      ) : free.length === 0 ? (
        <p className="tour-editor__hint">
          Los objetivos se apoyan en las claves de puntuación; añada preguntas primero.
        </p>
      ) : (
        <div className="tour-editor__add">
          <Field label="Clave">
            {({ id }) => (
              <Select id={id} value={newKey} onChange={(event) => setNewKey(event.currentTarget.value)}>
                <option value="">Elija una clave…</option>
                {free.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Nombre del objetivo">
            {({ id }) => (
              <TextInput
                id={id}
                value={newLabel}
                placeholder="Apto en seguridad"
                onChange={(event) => setNewLabel(event.currentTarget.value)}
              />
            )}
          </Field>
          <Button
            size="sm"
            variant="secondary"
            icon={<IconAdd size={13} />}
            disabled={newKey === '' || newLabel.trim() === ''}
            onClick={() => {
              onChange(
                addGoal(quiz, {
                  scoreKey: newKey,
                  label: newLabel.trim(),
                  target: maxScores[newKey] ?? 0,
                }),
                `Añadir objetivo ${newLabel.trim()}`,
              );
              setNewKey('');
              setNewLabel('');
            }}
          >
            Añadir objetivo
          </Button>
        </div>
      )}
    </>
  );
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
