/**
 * Ejecución de la evaluación en el visor publicado (O01–O09).
 *
 * Una pregunta a la vez, en una ventana sobre la escena. Lo que el visitante
 * necesita saber en todo momento: qué se le pregunta, cuánto queda, si acertó
 * y por qué.
 *
 * Decisiones que no son de estilo:
 *
 *  - **La explicación se muestra entre pregunta y pregunta**, no después de
 *    responder y a la vez avanzando: leer por qué se falló es la parte que
 *    enseña, y pasarla de largo convierte la evaluación en un trámite.
 *  - **La búsqueda de marcadores no se responde desde aquí.** La ventana se
 *    aparta y el visitante busca en la escena; esta pantalla sólo lleva la
 *    cuenta. Una lista de marcadores para pulsar en un cuadro de diálogo
 *    anularía justo lo que esa pregunta evalúa.
 *  - **El tiempo límite corta la pregunta, no la sesión.** Se envía lo que
 *    hubiera marcado, que es lo que haría un examinador al recoger la hoja.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildReport,
  reportToCsv,
  startQuiz,
  submitAnswer,
  type Action,
  type Question,
  type Quiz,
  type QuizRuntime,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ProgressBar,
  PropertyList,
  PropertyRow,
  SectionLabel,
  cx,
} from '@it360/ui';
import {
  attemptsLeft,
  canSubmit,
  formatElapsed,
  huntProgress,
  quizElapsedS,
  quizPassed,
  scoreLines,
  selectionMode,
  toggleSelection,
} from './playback';

export interface QuizPlayerProps {
  readonly quiz: Quiz;
  /** URL de la multimedia de una pregunta, si está en el paquete. */
  readonly mediaUrl: (mediaId: string | null) => string | null;
  /** Acciones a ejecutar al alcanzar un objetivo (O08). */
  readonly onGoalReached: (actions: readonly Action[], label: string) => void;
  /** Lleva al visitante a la escena en que se plantea la pregunta. */
  readonly onGoToScene: (sceneId: string) => void;
  /** Marcadores encontrados en la escena, por identificador de objetivo. */
  readonly huntFound: readonly string[];
  readonly onHuntStart: (question: Question) => void;
  readonly onFinish: (runtime: QuizRuntime) => void;
  readonly onClose: () => void;
  /**
   * Avance de la evaluación, 0..1 (F10).
   *
   * Lo publica este componente porque es quien sabe por qué pregunta va;
   * derivarlo fuera exigiría duplicar el recuento de respuestas y los dos
   * acabarían discrepando en el primer cambio de reglas.
   */
  readonly onProgress?: (fraction: number | null) => void;
}

export function QuizPlayer({
  quiz,
  mediaUrl,
  onGoalReached,
  onGoToScene,
  huntFound,
  onHuntStart,
  onFinish,
  onClose,
  onProgress,
}: QuizPlayerProps): JSX.Element {
  const [runtime, setRuntime] = useState<QuizRuntime>(() => startQuiz(quiz, Date.now()));
  const [selected, setSelected] = useState<readonly string[]>([]);
  /**
   * Explicación pendiente de leer.
   *
   * Lleva su propio enunciado porque la última pregunta de la evaluación ya no
   * está en `currentQuestionId` cuando se muestra su explicación: sin el
   * enunciado aquí, esa explicación —la que cierra la sesión— no se podría
   * presentar.
   */
  const [feedback, setFeedback] = useState<{
    prompt: string;
    correct: boolean;
    texts: readonly string[];
  } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const question = useMemo(
    () => quiz.questions.find((q) => q.id === runtime.currentQuestionId) ?? null,
    [quiz.questions, runtime.currentQuestionId],
  );

  /**
   * La evaluación ha terminado.
   *
   * El informe espera a que se cierre la explicación pendiente: sin esa
   * espera, la explicación de la última pregunta no se vería nunca, y es la
   * que más suele importar porque es la que cierra la sesión.
   */
  const finished = runtime.currentQuestionId === null;
  const answered = runtime.answers.length;
  const total = quiz.questions.length;

  useEffect(() => {
    // `null` al terminar: la barra de una evaluación cerrada no debe quedarse
    // al cien por cien, porque eso dice «en curso y completa».
    onProgress?.(finished ? null : total === 0 ? null : answered / total);
  }, [answered, total, finished, onProgress]);

  /* ---------------------------------------------------------------- *
   * Respuesta
   * ---------------------------------------------------------------- */

  const commit = useCallback(
    (ids: readonly string[]) => {
      if (question === null) return;

      const result = submitAnswer(quiz, runtime, question.id, ids, Date.now(), new Date().toISOString());
      setRuntime(result.runtime);
      setSelected([]);
      setSecondsLeft(null);

      for (const goal of result.newlyReachedGoals) {
        if (goal.onReached.length > 0) onGoalReached(goal.onReached, `Objetivo ${goal.label}`);
      }

      if (quiz.immediateFeedback) {
        const texts = question.choices
          .filter((choice) => ids.includes(choice.id) && choice.feedback !== '')
          .map((choice) => choice.feedback);
        setFeedback({ prompt: question.prompt, correct: result.answer.correct, texts });
      }

      if (result.runtime.currentQuestionId === null) onFinish(result.runtime);
    },
    [question, quiz, runtime, onGoalReached, onFinish],
  );

  /* ---------------------------------------------------------------- *
   * Tiempo límite de la pregunta
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (question === null || question.timeLimitS <= 0 || feedback !== null) {
      setSecondsLeft(null);
      return;
    }

    setSecondsLeft(question.timeLimitS);
    const started = Date.now();

    const tick = setInterval(() => {
      const left = question.timeLimitS - Math.floor((Date.now() - started) / 1000);
      setSecondsLeft(Math.max(left, 0));
    }, 500);

    // Al agotarse se envía lo marcado, que es lo que haría un examinador al
    // recoger la hoja: ni se salta la pregunta ni se da por acertada.
    const expiry = setTimeout(() => commit(selectedAtExpiry.current), question.timeLimitS * 1000);

    return () => {
      clearInterval(tick);
      clearTimeout(expiry);
    };
    // `commit` cambia en cada selección; el temporizador se arma una sola vez
    // por pregunta y lee la selección por referencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.id, feedback === null]);

  /** Selección en el momento de expirar, leída sin rearmar el temporizador. */
  const selectedAtExpiry = useMemo(() => ({ current: selected as readonly string[] }), []);
  selectedAtExpiry.current = selected;

  /* ---------------------------------------------------------------- *
   * Búsqueda de marcadores
   * ---------------------------------------------------------------- */

  const hunt = question !== null && selectionMode(question) === 'hunt' ? question : null;
  const progress = hunt === null ? null : huntProgress(hunt, huntFound);

  useEffect(() => {
    if (hunt === null) return;
    onHuntStart(hunt);
    if (hunt.sceneId !== null) onGoToScene(hunt.sceneId);
    setMinimized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunt?.id]);

  useEffect(() => {
    if (hunt === null || progress === null || !progress.complete) return;
    commit(huntFound);
    setMinimized(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.complete]);

  /* ---------------------------------------------------------------- *
   * Presentación
   * ---------------------------------------------------------------- */

  if (minimized && hunt !== null && progress !== null) {
    return (
      <section className="hunt-hud" aria-label="Búsqueda en curso">
        <div className="hunt-hud__head">
          <span className="hunt-hud__prompt">{hunt.prompt}</span>
          <Badge tone={progress.complete ? 'nominal' : 'accent'} mono>
            {progress.found}/{progress.total}
          </Badge>
        </div>
        <p className="hunt-hud__hint">
          Pulse en la escena los marcadores que se piden. El recuento avanza al encontrarlos.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setMinimized(false)}>
          Ver la pregunta
        </Button>
      </section>
    );
  }

  if (finished && feedback !== null) {
    return (
      <Dialog
        open
        onClose={() => setFeedback(null)}
        title={quiz.name}
        description="Última pregunta"
        size="md"
        footer={
          <Button variant="primary" onClick={() => setFeedback(null)}>
            Continuar
          </Button>
        }
      >
        <p className="quiz__prompt">{feedback.prompt}</p>
        <FeedbackCallout feedback={feedback} />
      </Dialog>
    );
  }

  if (finished) {
    return (
      <QuizReportDialog
        quiz={quiz}
        runtime={runtime}
        onClose={onClose}
        onRetry={() => {
          setRuntime(startQuiz(quiz, Date.now()));
          setSelected([]);
          setFeedback(null);
        }}
      />
    );
  }

  if (question === null) {
    return (
      <Dialog open onClose={onClose} title={quiz.name} size="md">
        <Callout tone="alarm" title="La evaluación no se puede continuar">
          La siguiente pregunta no está en el paquete publicado. Avise a quien preparó el recorrido.
        </Callout>
      </Dialog>
    );
  }

  const left = attemptsLeft(question, runtime);
  const mode = selectionMode(question);
  const media = mediaUrl(question.mediaId);

  return (
    <Dialog
      open
      onClose={onClose}
      title={quiz.name}
      description={`Pregunta ${answered + 1} de ${total}`}
      size="lg"
      footer={
        feedback !== null ? (
          <Button
            variant="primary"
            onClick={() => {
              setFeedback(null);
              if (runtime.currentQuestionId === null) onFinish(runtime);
            }}
          >
            Continuar
          </Button>
        ) : (
          <>
            {hunt !== null && (
              <Button variant="secondary" onClick={() => setMinimized(true)}>
                Buscar en la escena
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Salir
            </Button>
            <Button
              variant="primary"
              disabled={!canSubmit(question, selected)}
              onClick={() => commit(selected)}
            >
              {selected.length === 0 && !question.required ? 'Saltar' : 'Responder'}
            </Button>
          </>
        )
      }
    >
      <ProgressBar value={total === 0 ? 0 : answered / total} label="Avance de la evaluación" />

      {secondsLeft !== null && (
        <p className={cx('quiz__timer', secondsLeft <= 5 && 'quiz__timer--urgent')}>
          Quedan {secondsLeft} s
        </p>
      )}

      <p className="quiz__prompt">{question.prompt}</p>

      {media !== null && <QuestionMedia url={media} mediaId={question.mediaId} />}

      {feedback !== null ? (
        <FeedbackCallout feedback={feedback} />
      ) : hunt !== null && progress !== null ? (
        <div className="quiz__hunt">
          <p className="quiz__hint">
            Encuentre {progress.total} marcador(es) en la escena. Encontrados: {progress.found}.
          </p>
          <ul className="quiz__targets">
            {hunt.huntTargets.map((target) => (
              <li key={target.id} data-found={huntFound.includes(target.id)}>
                {huntFound.includes(target.id)
                  ? (target.label === '' ? 'Marcador encontrado' : target.label)
                  : 'Por encontrar'}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p className="quiz__hint">
            {mode === 'single' && 'Elija una opción.'}
            {mode === 'multiple' && 'Puede elegir varias opciones.'}
            {mode === 'ordered' && 'Pulse las opciones en el orden correcto.'}
            {left !== null && ` Intentos restantes: ${left}.`}
          </p>

          <ul className="quiz__choices">
            {question.choices.map((choice) => {
              const position = selected.indexOf(choice.id);
              const picked = position >= 0;

              return (
                <li key={choice.id}>
                  <button
                    type="button"
                    className="quiz__choice"
                    aria-pressed={picked}
                    onClick={() => setSelected(toggleSelection(question, selected, choice.id))}
                  >
                    {mode === 'ordered' && (
                      <span className="quiz__choice-order" aria-hidden>
                        {picked ? position + 1 : '·'}
                      </span>
                    )}
                    <span>{choice.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {question.choices.length === 0 && (
            <Callout tone="alarm" title="Esta pregunta no tiene opciones">
              No se puede responder. Avise a quien preparó el recorrido.
            </Callout>
          )}
        </>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Explicación de la respuesta
 * ------------------------------------------------------------------ */

function FeedbackCallout({
  feedback,
}: {
  feedback: { readonly correct: boolean; readonly texts: readonly string[] };
}): JSX.Element {
  return (
    <Callout
      tone={feedback.correct ? 'nominal' : 'warning'}
      title={feedback.correct ? 'Correcto' : 'Incorrecto'}
    >
      {feedback.texts.length === 0 ? (
        <p>{feedback.correct ? 'Respuesta correcta.' : 'Esa no era la respuesta.'}</p>
      ) : (
        <ul className="quiz__feedback">
          {feedback.texts.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

/* ------------------------------------------------------------------ *
 * Multimedia de la pregunta (O03)
 * ------------------------------------------------------------------ */

function QuestionMedia({ url, mediaId }: { url: string; mediaId: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <Callout tone="warning" title="La multimedia de la pregunta no se pudo cargar">
        El enunciado se puede responder sin ella.
      </Callout>
    );
  }

  /* El tipo se deduce de la extensión servida: el manifiesto ya validó el
     medio, y pedir aquí el mime obligaría a buscarlo de nuevo. */
  const lower = url.toLowerCase();
  const isAudio = /\.(mp3|m4a|aac|ogg|wav|opus)(\?|$)/.test(lower);
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|$)/.test(lower);

  if (isAudio) {
    return <audio className="quiz__media" controls src={url} onError={() => setFailed(true)} />;
  }

  if (isVideo) {
    return (
      <video
        className="quiz__media"
        controls
        playsInline
        src={url}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <img
      className="quiz__media"
      src={url}
      alt={`Imagen de la pregunta${mediaId === null ? '' : ''}`}
      onError={() => setFailed(true)}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Fin de sesión (O09)
 * ------------------------------------------------------------------ */

function QuizReportDialog({
  quiz,
  runtime,
  onClose,
  onRetry,
}: {
  quiz: Quiz;
  runtime: QuizRuntime;
  onClose: () => void;
  onRetry: () => void;
}): JSX.Element {
  const lines = scoreLines(quiz, runtime);
  const passed = quizPassed(quiz, runtime);
  const elapsed = quizElapsedS(runtime);
  const demanded = lines.some((line) => line.passing !== null);

  /** Descarga del informe en CSV, generado en el propio navegador. */
  const download = (): void => {
    const report = buildReport(quiz, runtime, new Date().toISOString());
    const blob = new Blob([reportToCsv(report)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `evaluacion-${quiz.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.csv`;
    link.rel = 'noopener';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Resultado: ${quiz.name}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={download}>
            Descargar resultado
          </Button>
          <Button variant="secondary" onClick={onRetry}>
            Repetir
          </Button>
          <Button variant="primary" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      {quiz.showReport ? (
        <>
          {demanded && (
            <Callout
              tone={passed ? 'nominal' : 'warning'}
              title={passed ? 'Apto' : 'No alcanza la nota mínima'}
            >
              {passed
                ? 'Alcanzó la puntuación exigida en todas las materias.'
                : 'Puede repetir la evaluación para alcanzar la puntuación exigida.'}
            </Callout>
          )}

          <SectionLabel>Puntuación</SectionLabel>
          <PropertyList>
            {lines.map((line) => (
              <PropertyRow
                key={line.scoreKey}
                label={line.scoreKey}
                mono
                value={
                  line.passing === null
                    ? String(line.obtained)
                    : `${line.obtained} / mínimo ${line.passing}`
                }
                {...(line.passed === null
                  ? {}
                  : { tone: line.passed ? ('nominal' as const) : ('warning' as const) })}
              />
            ))}
          </PropertyList>

          <SectionLabel>Sesión</SectionLabel>
          <PropertyList>
            <PropertyRow label="Respuestas" mono value={String(runtime.answers.length)} />
            <PropertyRow
              label="Acertadas"
              mono
              value={String(runtime.answers.filter((a) => a.correct).length)}
            />
            {elapsed !== null && <PropertyRow label="Tiempo" mono value={formatElapsed(elapsed)} />}
          </PropertyList>
        </>
      ) : (
        <p>
          Evaluación completada. El autor del recorrido eligió no mostrar el detalle de las
          puntuaciones.
        </p>
      )}
    </Dialog>
  );
}
