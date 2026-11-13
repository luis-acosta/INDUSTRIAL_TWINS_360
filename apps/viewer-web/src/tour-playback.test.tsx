/**
 * Pruebas de la reproducción en el visor publicado (J01–J03, J08, O01–O09).
 *
 * El motor y las decisiones sueltas ya están probados (`playback.test.ts`);
 * aquí se comprueba lo que sólo se rompe al montarlo: que el recorrido avance
 * de verdad de una escena a otra, que el botón de pausa pare el temporizador,
 * que un recorrido condicionado no arranque, y que la evaluación puntúe y
 * cierre con su informe.
 *
 * Los temporizadores son falsos: esperar 4 segundos reales por parada haría
 * la suite inservible y no comprobaría nada más.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@it360/ui';
import {
  actionSchema,
  toManifest,
  type ActionEvent,
  type Manifest,
  type Project,
  type Quiz,
  type Tour,
} from '@it360/domain';
import {
  ISO_NOW,
  makeHotspot,
  makeMedia,
  makeProject,
  makeQuiz,
  makeScene,
  makeTour,
  testUuid,
} from '@it360/domain/testing';
import { TourViewer } from './TourViewer';
import type { LoadedTour } from './manifest';

/* ------------------------------------------------------------------ *
 * El visor panorámico no se puede renderizar en jsdom
 * ------------------------------------------------------------------ */

/**
 * El lienzo WebGL no existe en jsdom, así que `PanoramaViewer` se sustituye
 * por un doble que publica lo mismo que consume el visor: la escena activa y
 * un botón por marcador. Es lo justo para poder comprobar que el recorrido
 * cambia de escena y que pulsar un marcador cuenta en la búsqueda.
 */
vi.mock('@it360/viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@it360/viewer')>();

  return {
    ...actual,
    PanoramaViewer: ({
      scene,
      onHotspotActivate,
    }: {
      scene: { id: string; title: string; hotspots: readonly { id: string; name: string }[] } | null;
      onHotspotActivate: (hotspot: unknown) => void;
    }) => (
      <div data-testid="panorama" data-scene={scene?.title ?? ''}>
        {(scene?.hotspots ?? []).map((hotspot) => (
          <button key={hotspot.id} type="button" onClick={() => onHotspotActivate(hotspot)}>
            {hotspot.name}
          </button>
        ))}
      </div>
    ),
  };
});

/* ------------------------------------------------------------------ *
 * Paquete de prueba
 * ------------------------------------------------------------------ */

const PROJECT = testUuid(1);

function waypoint(sceneId: string, order: number, over: Record<string, unknown> = {}) {
  return {
    id: testUuid(100 + order),
    sceneId,
    view: { yaw: 0, pitch: 0, fov: 75 },
    dwellMs: 2000,
    travelMs: 500,
    actions: [],
    caption: '',
    audioMediaId: null,
    waitForAudio: true,
    order,
    ...over,
  };
}

/** Paquete publicado con dos escenas y lo que se le añada. */
function loaded(options: {
  readonly tours?: readonly Tour[];
  readonly quizzes?: readonly Quiz[];
  readonly hotspots?: boolean;
} = {}): LoadedTour {
  const base = makeProject();
  const sceneA = makeScene(10, PROJECT, {
    title: 'Nave principal',
    ...(options.hotspots === true
      ? { hotspots: [makeHotspot(20, testUuid(10), { name: 'Extintor' })] }
      : {}),
  });
  const sceneB = makeScene(11, PROJECT, { title: 'Sala de bombas' });

  const project: Project = {
    ...base,
    scenes: [sceneA, sceneB],
    tours: [...(options.tours ?? [])],
    quizzes: [...(options.quizzes ?? [])],
  };

  const manifest: Manifest = toManifest(project, {
    publishedAt: ISO_NOW,
    appVersion: '0.25.0',
    offlineCapable: true,
  });

  return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
}

const mount = (tour: LoadedTour): void => {
  render(
    <ToastProvider>
      <TourViewer tour={tour} />
    </ToastProvider>,
  );
};

const sceneTitle = (): string => screen.getByTestId('panorama').getAttribute('data-scene') ?? '';

/** Avanza los temporizadores dentro de `act`, como haría el navegador. */
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  // El visor lee la escena inicial del fragmento de la dirección (S09), que es
  // estado global: sin limpiarlo, una prueba que lo fija abre la escena
  // equivocada en todas las siguientes.
  globalThis.history.replaceState(null, '', '/');

  vi.useFakeTimers();
  // La narración no suena en jsdom; `play()` no existe y su ausencia haría
  // fallar la parada en lugar de seguir por permanencia.
  vi.stubGlobal(
    'Audio',
    class {
      onended: (() => void) | null = null;
      src = '';
      play(): Promise<void> {
        return Promise.reject(new Error('autoplay bloqueado'));
      }
      pause(): void {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Pulsación del botón del pie de un diálogo, cuando la X comparte etiqueta. */
const clickInFooter = async (name: string | RegExp): Promise<void> => {
  const footer = document.querySelector('.it-dialog__footer');
  if (footer === null) throw new Error('No hay pie de diálogo en pantalla');
  await act(async () => {
    fireEvent.click(within(footer as HTMLElement).getByRole('button', { name }));
  });
};

/**
 * Pulsación síncrona, envuelta en `act`.
 *
 * No se usa `user-event` en este archivo: su espera interna depende de los
 * temporizadores, y aquí los temporizadores son falsos y sólo avanzan cuando
 * esta prueba lo pide, de modo que cada pulsación se quedaría esperando para
 * siempre. `fireEvent` basta para un botón.
 */
const click = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

/* ------------------------------------------------------------------ *
 * Arranque
 * ------------------------------------------------------------------ */

describe('recorrido automático en el visor', () => {
  const twoStops = (over: Partial<Tour> = {}): Tour =>
    makeTour(2, PROJECT, {
      name: 'Visita de planta',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      ...over,
    } as never);

  it('TEST-VPB-001 sin recorridos no se ofrece ninguno', () => {
    mount(loaded());
    expect(screen.queryByRole('button', { name: /Recorrido/ })).not.toBeInTheDocument();
  });

  it('TEST-VPB-002 un recorrido publicado se puede iniciar desde la barra', async () => {
    mount(loaded({ tours: [twoStops()] }));

    await click('Recorrido');

    expect(screen.getByRole('region', { name: /Visita de planta/ })).toBeInTheDocument();
    expect(screen.getByText('Parada 1 de 2')).toBeInTheDocument();
  });

  it('TEST-VPB-003 un recorrido sin paradas no se ofrece', () => {
    // Ofrecerlo acabaría en una barra que no avanza y un visitante esperando.
    mount(loaded({ tours: [makeTour(2, PROJECT, { name: 'Vacío' })] }));
    expect(screen.queryByRole('button', { name: /Recorrido/ })).not.toBeInTheDocument();
  });

  it('TEST-VPB-004 el recorrido avanza de una escena a la siguiente', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');

    await advance(500); // desplazamiento
    expect(sceneTitle()).toBe('Nave principal');

    await advance(2000); // permanencia
    await advance(500); // desplazamiento a la segunda
    expect(sceneTitle()).toBe('Sala de bombas');
    expect(screen.getByText('Parada 2 de 2')).toBeInTheDocument();
  });

  it('TEST-VPB-005 al terminar lo dice y ofrece repetir', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');

    await advance(500); // viaje a la primera
    await advance(2000); // permanencia
    await advance(500); // viaje a la segunda
    await advance(2000); // permanencia

    expect(screen.getByText('Recorrido terminado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repetir' })).toBeInTheDocument();
  });

  it('TEST-VPB-006 en bucle vuelve a la primera parada en lugar de terminar', async () => {
    mount(loaded({ tours: [twoStops({ loop: true })] }));
    await click('Recorrido');

    await advance(500);
    await advance(2000);
    await advance(500);
    await advance(2000);
    await advance(500);

    expect(screen.queryByText('Recorrido terminado')).not.toBeInTheDocument();
    expect(sceneTitle()).toBe('Nave principal');
  });

  it('TEST-VPB-007 el rótulo de la parada se muestra mientras dura', async () => {
    const tour = makeTour(2, PROJECT, {
      name: 'Visita',
      waypoints: [
        waypoint(testUuid(10), 0, { caption: 'Bomba principal, caudal nominal' }),
        waypoint(testUuid(11), 1),
      ],
    } as never);

    mount(loaded({ tours: [tour] }));
    await click('Recorrido');
    await advance(500);

    expect(screen.getByText('Bomba principal, caudal nominal')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Interrupción (J03)
 * ------------------------------------------------------------------ */

describe('interrupción', () => {
  const twoStops = (over: Partial<Tour> = {}): Tour =>
    makeTour(2, PROJECT, {
      name: 'Visita',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      ...over,
    } as never);

  it('TEST-VPB-008 pausar detiene el avance de verdad', async () => {
    // Sin cancelar el temporizador, el recorrido «pausado» saltaría de escena
    // unos segundos después y el botón de pausa quedaría desmentido.
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');
    await advance(500);

    await click('Pausar');
    await advance(10_000);

    expect(sceneTitle()).toBe('Nave principal');
    expect(screen.getByText('Parada 1 de 2')).toBeInTheDocument();
  });

  it('TEST-VPB-009 continuar reanuda donde se quedó', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');
    await advance(500);
    await click('Pausar');

    await click('Continuar');
    await advance(500);
    await advance(2000);
    await advance(500);

    expect(sceneTitle()).toBe('Sala de bombas');
  });

  it('TEST-VPB-010 un recorrido no interrumpible no ofrece pausa', async () => {
    // Un botón que no hace nada es peor que ninguno: el visitante lo pulsa y
    // concluye que la pantalla está colgada.
    mount(loaded({ tours: [twoStops({ allowInterrupt: false })] }));
    await click('Recorrido');

    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument();
    expect(screen.getByText('sin pausa')).toBeInTheDocument();
  });

  it('TEST-VPB-011 en pausa se dice que puede mirar alrededor', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');
    await click('Pausar');

    expect(screen.getByText(/mirar alrededor/)).toBeInTheDocument();
  });

  it('TEST-VPB-012 con reanudación automática se anuncia el plazo', async () => {
    mount(loaded({ tours: [twoStops({ autoResumeIdleS: 30 })] }));
    await click('Recorrido');
    await click('Pausar');

    expect(screen.getByText(/30 s sin actividad/)).toBeInTheDocument();
  });

  it('TEST-VPB-013 la reanudación automática ocurre al cumplirse el plazo', async () => {
    mount(loaded({ tours: [twoStops({ autoResumeIdleS: 5 })] }));
    await click('Recorrido');
    await advance(500);
    await click('Pausar');

    await advance(6000);
    expect(screen.queryByRole('button', { name: 'Continuar' })).not.toBeInTheDocument();
  });

  it('TEST-VPB-014 se puede saltar a la parada siguiente y volver', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');
    await advance(500);

    await click('Parada siguiente');
    await advance(500);
    expect(sceneTitle()).toBe('Sala de bombas');

    await click('Parada anterior');
    await advance(500);
    expect(sceneTitle()).toBe('Nave principal');
  });

  it('TEST-VPB-015 salir del recorrido retira la barra', async () => {
    mount(loaded({ tours: [twoStops()] }));
    await click('Recorrido');

    await click('Salir del recorrido');
    expect(screen.queryByRole('region', { name: /Visita/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Condición de acceso (J08)
 * ------------------------------------------------------------------ */

describe('condición por evaluación', () => {
  const quiz = (): Quiz =>
    makeQuiz(3, PROJECT, {
      name: 'Seguridad básica',
      questions: [
        {
          id: 'q1',
          kind: 'trueFalse',
          prompt: '¿Hay que usar casco en la nave?',
          mediaId: null,
          sceneId: null,
          choices: [
            { id: 'v', text: 'Verdadero', correct: true, feedback: 'Siempre.', points: 10, nextQuestionId: null },
            { id: 'f', text: 'Falso', correct: false, feedback: 'No es así.', points: 0, nextQuestionId: null },
          ],
          huntTargets: [],
          correctOrder: [],
          scoreKey: 'general',
          penalty: 0,
          timeLimitS: 0,
          maxAttempts: 1,
          nextQuestionId: null,
          required: true,
          order: 0,
        },
      ],
    } as never);

  const gatedTour = (over: Partial<Tour> = {}): Tour =>
    makeTour(2, PROJECT, {
      name: 'Visita restringida',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      requiresQuizId: testUuid(3),
      ...over,
    } as never);

  it('TEST-VPB-016 un recorrido condicionado no arranca y dice qué falta', async () => {
    mount(loaded({ tours: [gatedTour()], quizzes: [quiz()] }));
    await click('Recorrido');

    expect(screen.getByText(/Seguridad básica/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Visita restringida/ })).not.toBeInTheDocument();
  });

  it('TEST-VPB-017 se ofrece hacer la evaluación en ese momento', async () => {
    mount(loaded({ tours: [gatedTour()], quizzes: [quiz()] }));
    await click('Recorrido');

    await click('Hacer la evaluación');
    expect(screen.getByText('¿Hay que usar casco en la nave?')).toBeInTheDocument();
  });

  it('TEST-VPB-018 completada la evaluación, el recorrido arranca', async () => {
    mount(loaded({ tours: [gatedTour()], quizzes: [quiz()] }));
    await click('Recorrido');
    await click('Hacer la evaluación');

    await click('Verdadero');
    await click('Responder');
    await click('Continuar');
    await clickInFooter('Cerrar');

    await click('Recorrido');
    expect(screen.getByRole('region', { name: /Visita restringida/ })).toBeInTheDocument();
  });

  it('TEST-VPB-019 sin la nota mínima el recorrido sigue cerrado, con la cifra', async () => {
    mount(loaded({ tours: [gatedTour({ requiresQuizMinScore: 10 })], quizzes: [quiz()] }));
    await click('Recorrido');
    await click('Hacer la evaluación');

    await click('Falso');
    await click('Responder');
    await click('Continuar');
    await clickInFooter('Cerrar');

    await click('Recorrido');
    expect(screen.getByText(/obtuvo 0/)).toBeInTheDocument();
  });

  it('TEST-VPB-020 se advierte de que el resultado sólo vale esta visita', async () => {
    // El paquete publicado no escribe nada; insinuar un expediente sería
    // prometer algo que nadie podrá recuperar en otro equipo.
    mount(loaded({ tours: [gatedTour()], quizzes: [quiz()] }));
    await click('Recorrido');

    expect(screen.getByText(/sólo durante esta visita/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Evaluación (O01–O09)
 * ------------------------------------------------------------------ */

describe('evaluación en el visor', () => {
  const twoQuestions = (over: Record<string, unknown> = {}): Quiz =>
    makeQuiz(3, PROJECT, {
      name: 'Seguridad',
      questions: [
        {
          id: 'q1',
          kind: 'multipleChoice',
          prompt: 'Elija los equipos de protección obligatorios',
          mediaId: null,
          sceneId: null,
          choices: [
            { id: 'a', text: 'Casco', correct: true, feedback: '', points: 5, nextQuestionId: null },
            { id: 'b', text: 'Botas', correct: true, feedback: '', points: 5, nextQuestionId: null },
            { id: 'c', text: 'Bufanda', correct: false, feedback: 'Es un riesgo de atrapamiento.', points: 0, nextQuestionId: null },
          ],
          huntTargets: [],
          correctOrder: [],
          scoreKey: 'general',
          penalty: 0,
          timeLimitS: 0,
          maxAttempts: 1,
          nextQuestionId: null,
          required: true,
          order: 0,
        },
        {
          id: 'q2',
          kind: 'singleChoice',
          prompt: '¿Dónde está la salida de emergencia?',
          mediaId: null,
          sceneId: null,
          choices: [
            { id: 'a', text: 'Al norte', correct: true, feedback: '', points: 5, nextQuestionId: null },
            { id: 'b', text: 'Al sur', correct: false, feedback: '', points: 0, nextQuestionId: null },
          ],
          huntTargets: [],
          correctOrder: [],
          scoreKey: 'general',
          penalty: 0,
          timeLimitS: 0,
          maxAttempts: 1,
          nextQuestionId: null,
          required: true,
          order: 1,
        },
      ],
      ...over,
    } as never);

  /** Abre la evaluación a través de la condición de un recorrido. */
  const openQuiz = async (quiz: Quiz): Promise<void> => {
    const tour = makeTour(2, PROJECT, {
      name: 'Visita',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      requiresQuizId: quiz.id,
    } as never);

    mount(loaded({ tours: [tour], quizzes: [quiz] }));
    await click('Recorrido');
    await click('Hacer la evaluación');
  };

  it('TEST-VPB-021 una pregunta obligatoria no se puede responder vacía', async () => {
    await openQuiz(twoQuestions());
    expect(screen.getByRole('button', { name: 'Responder' })).toBeDisabled();
  });

  it('TEST-VPB-022 en respuesta múltiple se pueden marcar varias', async () => {
    await openQuiz(twoQuestions());

    await click('Casco');
    await click('Botas');

    expect(screen.getByRole('button', { name: 'Casco' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Botas' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('TEST-VPB-023 la explicación de la opción elegida se muestra antes de seguir', async () => {
    // Leer por qué se falló es la parte que enseña; pasarla de largo convierte
    // la evaluación en un trámite.
    await openQuiz(twoQuestions());

    await click('Bufanda');
    await click('Responder');

    expect(screen.getByText('Es un riesgo de atrapamiento.')).toBeInTheDocument();
    expect(screen.getByText('Incorrecto')).toBeInTheDocument();
  });

  it('TEST-VPB-024 sin explicaciones inmediatas no se interrumpe entre preguntas', async () => {
    await openQuiz(twoQuestions({ immediateFeedback: false }));

    await click('Casco');
    await click('Responder');

    expect(screen.getByText('¿Dónde está la salida de emergencia?')).toBeInTheDocument();
  });

  it('TEST-VPB-025 al acabar se muestra el informe con la puntuación', async () => {
    await openQuiz(twoQuestions({ immediateFeedback: false }));

    await click('Casco');
    await click('Botas');
    await click('Responder');
    await click('Al norte');
    await click('Responder');

    expect(screen.getByText(/Resultado: Seguridad/)).toBeInTheDocument();
    expect(screen.getByText('Respuestas')).toBeInTheDocument();
    expect(screen.getByText('Acertadas')).toBeInTheDocument();
  });

  it('TEST-VPB-026 con nota mínima el informe dice si es apto', async () => {
    await openQuiz(
      twoQuestions({ immediateFeedback: false, passingScores: { general: 10 } }),
    );

    await click('Casco');
    await click('Botas');
    await click('Responder');
    await click('Al norte');
    await click('Responder');

    expect(screen.getByText('Apto')).toBeInTheDocument();
  });

  it('TEST-VPB-027 sin alcanzar la nota mínima se ofrece repetir', async () => {
    await openQuiz(
      twoQuestions({ immediateFeedback: false, passingScores: { general: 20 } }),
    );

    await click('Bufanda');
    await click('Responder');
    await click('Al sur');
    await click('Responder');

    expect(screen.getByText('No alcanza la nota mínima')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repetir' })).toBeInTheDocument();
  });

  it('TEST-VPB-028 quien no quiere mostrar el detalle no lo muestra', async () => {
    await openQuiz(twoQuestions({ immediateFeedback: false, showReport: false }));

    await click('Casco');
    await click('Responder');
    await click('Al norte');
    await click('Responder');

    expect(screen.getByText(/eligió no mostrar el detalle/)).toBeInTheDocument();
    expect(screen.queryByText('Acertadas')).not.toBeInTheDocument();
  });

  it('TEST-VPB-029 una pregunta opcional se puede saltar', async () => {
    const quiz = twoQuestions({ immediateFeedback: false });
    const optional: Quiz = {
      ...quiz,
      questions: quiz.questions.map((q) => (q.id === 'q1' ? { ...q, required: false } : q)),
    };
    await openQuiz(optional);

    expect(screen.getByRole('button', { name: 'Saltar' })).toBeEnabled();
    await click('Saltar');
    expect(screen.getByText('¿Dónde está la salida de emergencia?')).toBeInTheDocument();
  });

  it('TEST-VPB-030 el tiempo límite corta la pregunta enviando lo marcado', async () => {
    const quiz = twoQuestions({ immediateFeedback: false });
    const timed: Quiz = {
      ...quiz,
      questions: quiz.questions.map((q) => (q.id === 'q1' ? { ...q, timeLimitS: 10 } : q)),
    };
    await openQuiz(timed);

    expect(screen.getByText(/Quedan 10 s/)).toBeInTheDocument();
    await click('Casco');

    await advance(11_000);
    // Se recoge la hoja: ni se salta la pregunta ni se da por acertada.
    expect(screen.getByText('¿Dónde está la salida de emergencia?')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Búsqueda de marcadores (O04)
 * ------------------------------------------------------------------ */

describe('búsqueda de marcadores', () => {
  const huntQuiz = (): Quiz =>
    makeQuiz(3, PROJECT, {
      name: 'Riesgos',
      questions: [
        {
          id: 'q1',
          kind: 'hotspotHunt',
          prompt: 'Localice el extintor de la nave',
          mediaId: null,
          sceneId: testUuid(10),
          choices: [],
          huntTargets: [
            { id: 't1', sceneId: testUuid(10), hotspotId: testUuid(20), label: 'Extintor', points: 5 },
          ],
          correctOrder: [],
          scoreKey: 'general',
          penalty: 0,
          timeLimitS: 0,
          maxAttempts: 1,
          nextQuestionId: null,
          required: true,
          order: 0,
        },
      ],
    } as never);

  const open = async (): Promise<void> => {
    const quiz = huntQuiz();
    const tour = makeTour(2, PROJECT, {
      name: 'Visita',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      requiresQuizId: quiz.id,
    } as never);

    mount(loaded({ tours: [tour], quizzes: [quiz], hotspots: true }));
    await click('Recorrido');
    await click('Hacer la evaluación');
  };

  it('TEST-VPB-031 la ventana se aparta para poder buscar en la escena', async () => {
    // Una lista de marcadores para pulsar en un diálogo anularía justo lo que
    // esta pregunta evalúa.
    await open();
    const hud = screen.getByRole('region', { name: 'Búsqueda en curso' });
    expect(within(hud).getByText('Localice el extintor de la nave')).toBeInTheDocument();
    expect(within(hud).getByText('0/1')).toBeInTheDocument();
  });

  it('TEST-VPB-032 pulsar el marcador buscado avanza el recuento', async () => {
    await open();
    await click('Extintor');

    // Encontrado el único objetivo, la pregunta se cierra: primero su
    // explicación y después el informe.
    await click('Continuar');
    expect(screen.getByText(/Resultado: Riesgos/)).toBeInTheDocument();
  });

  it('TEST-VPB-033 la búsqueda puntúa lo que valen sus objetivos', async () => {
    await open();
    await click('Extintor');
    await click('Continuar');

    const scores = screen.getByText('general').closest('.it-prop');
    expect(scores?.textContent).toContain('5');
  });

  it('TEST-VPB-034 se puede volver a ver la pregunta sin perder el recuento', async () => {
    await open();
    await click('Ver la pregunta');

    expect(screen.getByText(/Encuentre 1 marcador/)).toBeInTheDocument();
    await click('Buscar en la escena');
    expect(screen.getByRole('region', { name: 'Búsqueda en curso' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Multimedia, puntuaciones independientes y objetivos (O03, O06, O08)
 * ------------------------------------------------------------------ */

describe('contenido y puntuación de la evaluación', () => {
  /** Pregunta de una opción, con los campos que el esquema exige. */
  const question = (over: Record<string, unknown>) => ({
    id: 'q1',
    kind: 'singleChoice',
    prompt: 'Enunciado',
    mediaId: null,
    sceneId: null,
    choices: [
      { id: 'a', text: 'Elegir', correct: true, feedback: '', points: 5, nextQuestionId: null },
    ],
    huntTargets: [],
    correctOrder: [],
    scoreKey: 'general',
    penalty: 0,
    timeLimitS: 0,
    maxAttempts: 1,
    nextQuestionId: null,
    required: true,
    order: 0,
    ...over,
  });

  /** Paquete con la evaluación dada, abierta por la condición del recorrido. */
  const openWith = async (quiz: Quiz, media: readonly ReturnType<typeof makeMedia>[] = []) => {
    const base = makeProject();
    const sceneA = makeScene(10, PROJECT, { title: 'Nave principal' });
    const tour = makeTour(2, PROJECT, {
      name: 'Visita',
      waypoints: [waypoint(testUuid(10), 0), waypoint(testUuid(11), 1)],
      requiresQuizId: quiz.id,
    } as never);

    const manifest = toManifest(
      {
        ...base,
        scenes: [sceneA, makeScene(11, PROJECT, { title: 'Sala de bombas' })],
        media: [...media],
        tours: [tour],
        quizzes: [quiz],
      },
      { publishedAt: ISO_NOW, appVersion: '0.25.0', offlineCapable: true },
    );

    mount({ manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' });
    await click('Recorrido');
    await click('Hacer la evaluación');
  };

  it('TEST-VPB-035 una imagen de la pregunta se presenta junto al enunciado', async () => {
    const image = makeMedia(30, { relativePath: 'media/riesgo.jpg', originalName: 'riesgo.jpg' });
    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Con imagen',
        questions: [question({ mediaId: image.id, prompt: '¿Qué riesgo se ve aquí?' })],
      } as never),
      [image],
    );

    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('media/riesgo.jpg');
  });

  it('TEST-VPB-036 un audio de la pregunta se presenta con sus mandos', async () => {
    const audio = makeMedia(31, {
      mime: 'audio/mpeg',
      kind: 'audio',
      relativePath: 'media/aviso.mp3',
      originalName: 'aviso.mp3',
      width: null,
      height: null,
      durationS: 12,
      panorama: null,
    });

    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Con audio',
        questions: [question({ mediaId: audio.id })],
      } as never),
      [audio],
    );

    // El reproductor nativo no tiene rol accesible; se localiza por etiqueta.
    const player = document.querySelector('audio');
    expect(player?.getAttribute('src')).toContain('media/aviso.mp3');
    expect(player?.hasAttribute('controls')).toBe(true);
  });

  it('TEST-VPB-037 una multimedia que falta no impide responder', async () => {
    // El enunciado se puede contestar sin ella; bloquear la pregunta por un
    // medio ausente dejaría la evaluación muerta.
    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Medio ausente',
        questions: [question({ mediaId: testUuid(99) })],
      } as never),
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elegir' })).toBeInTheDocument();
  });

  it('TEST-VPB-038 el informe lista cada clave de puntuación por separado', async () => {
    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Dos materias',
        immediateFeedback: false,
        questions: [
          question({ id: 'q1', scoreKey: 'seguridad', prompt: 'De seguridad', order: 0 }),
          question({
            id: 'q2',
            scoreKey: 'proceso',
            prompt: 'De proceso',
            order: 1,
            choices: [
              { id: 'a', text: 'Elegir proceso', correct: true, feedback: '', points: 3, nextQuestionId: null },
            ],
          }),
        ],
      } as never),
    );

    await click('Elegir');
    await click('Responder');
    await click('Elegir proceso');
    await click('Responder');

    expect(screen.getByText('seguridad')).toBeInTheDocument();
    expect(screen.getByText('proceso')).toBeInTheDocument();
  });

  it('TEST-VPB-039 alcanzar un objetivo ejecuta sus acciones', async () => {
    // Es lo que hace que un objetivo sirva de algo: sin ejecutar la acción,
    // el autor configuró un desbloqueo que nunca ocurre.
    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Con objetivo',
        immediateFeedback: false,
        questions: [question({})],
        goals: [
          {
            scoreKey: 'general',
            label: 'Apto',
            target: 5,
            onReached: [
              {
                id: testUuid(50),
                event: 'scoreThreshold',
                config: { type: 'goToScene', sceneId: testUuid(11), entryMode: 'initialView' },
                order: 0,
                delayMs: 0,
                focusDwellMs: 1200,
                once: false,
                requiresScore: null,
                enabled: true,
              },
            ],
          },
        ],
      } as never),
    );

    await click('Elegir');
    await click('Responder');

    // La acción del objetivo llevó al visitante a la otra escena.
    expect(sceneTitle()).toBe('Sala de bombas');
  });

  it('TEST-VPB-040 un objetivo que no se alcanza no ejecuta nada', async () => {
    await openWith(
      makeQuiz(3, PROJECT, {
        name: 'Objetivo alto',
        immediateFeedback: false,
        questions: [question({})],
        goals: [
          {
            scoreKey: 'general',
            label: 'Apto',
            target: 100,
            onReached: [
              {
                id: testUuid(50),
                event: 'scoreThreshold',
                config: { type: 'goToScene', sceneId: testUuid(11), entryMode: 'initialView' },
                order: 0,
                delayMs: 0,
                focusDwellMs: 1200,
                once: false,
                requiresScore: null,
                enabled: true,
              },
            ],
          },
        ],
      } as never),
    );

    await click('Elegir');
    await click('Responder');

    expect(sceneTitle()).toBe('Nave principal');
  });
});

/* ------------------------------------------------------------------ *
 * Disparo de acciones por clic, puntero y mirada (D13)
 * ------------------------------------------------------------------ */

describe('cómo se activa un marcador', () => {
  /** Acción que lleva a la segunda escena, con el evento indicado. */
  const goToAction = (event: ActionEvent, over: Record<string, unknown> = {}) =>
    actionSchema.parse({
      id: testUuid(70),
      event,
      config: { type: 'goToScene', sceneId: testUuid(11), entryMode: 'initialView' },
      ...over,
    });

  /** Paquete con un marcador que tiene la acción dada. */
  const withAction = (event: ActionEvent): LoadedTour => {
    const base = makeProject();
    const sceneA = makeScene(10, PROJECT, {
      title: 'Nave principal',
      hotspots: [
        makeHotspot(20, testUuid(10), { name: 'Paso al taller', actions: [goToAction(event)] }),
      ],
    });

    const manifest = toManifest(
      { ...base, scenes: [sceneA, makeScene(11, PROJECT, { title: 'Sala de bombas' })] },
      { publishedAt: ISO_NOW, appVersion: '0.26.0', offlineCapable: true },
    );

    return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
  };

  it('TEST-VPB-041 una acción de clic se ejecuta al pulsar', async () => {
    mount(withAction('click'));
    await click('Paso al taller');
    expect(sceneTitle()).toBe('Sala de bombas');
  });

  it('TEST-VPB-042 una acción de mirada no se ejecuta al pulsar', async () => {
    // El fallo que esto persigue: ejecutar las acciones de «al pulsar» cuando
    // el visitante sólo ha mirado, y dejar la acción de mirada sin ejecutarse
    // nunca.
    mount(withAction('focusEnter'));
    await click('Paso al taller');
    expect(sceneTitle()).toBe('Nave principal');
  });

  it('TEST-VPB-043 una acción de paso del puntero no se ejecuta al pulsar', async () => {
    mount(withAction('hover'));
    await click('Paso al taller');
    expect(sceneTitle()).toBe('Nave principal');
  });

  it('TEST-VPB-044 una acción deshabilitada no se ejecuta', async () => {
    const base = makeProject();
    const disabled = goToAction('click', { enabled: false });
    const sceneA = makeScene(10, PROJECT, {
      title: 'Nave principal',
      hotspots: [makeHotspot(20, testUuid(10), { name: 'Paso al taller', actions: [disabled] })],
    });

    const manifest = toManifest(
      { ...base, scenes: [sceneA, makeScene(11, PROJECT, { title: 'Sala de bombas' })] },
      { publishedAt: ISO_NOW, appVersion: '0.26.0', offlineCapable: true },
    );

    mount({ manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' });
    await click('Paso al taller');
    expect(sceneTitle()).toBe('Nave principal');
  });
});

/* ------------------------------------------------------------------ *
 * Transición al cambiar de escena (C04)
 * ------------------------------------------------------------------ */

describe('transición entre escenas', () => {
  /** Marcador que lleva a la segunda escena con la transición indicada. */
  const withTransition = (kind: 'cut' | 'fade' | 'zoomThrough'): LoadedTour => {
    const base = makeProject();
    const sceneA = makeScene(10, PROJECT, {
      title: 'Nave principal',
      hotspots: [
        makeHotspot(20, testUuid(10), {
          name: 'Paso al taller',
          actions: [
            actionSchema.parse({
              id: testUuid(70),
              event: 'click',
              config: {
                type: 'goToScene',
                sceneId: testUuid(11),
                entryMode: 'initialView',
                transition: { kind, durationMs: kind === 'cut' ? 0 : 600, useGeometry: false },
              },
            }),
          ],
        }),
      ],
    });

    const manifest = toManifest(
      { ...base, scenes: [sceneA, makeScene(11, PROJECT, { title: 'Sala de bombas' })] },
      { publishedAt: ISO_NOW, appVersion: '0.28.0', offlineCapable: true },
    );

    return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
  };

  it('TEST-VPB-045 un corte cambia de escena sin superponer nada', async () => {
    mount(withTransition('cut'));
    await click('Paso al taller');

    expect(sceneTitle()).toBe('Sala de bombas');
    expect(document.querySelector('.transition-overlay')).toBeNull();
  });

  it('TEST-VPB-046 la escena cambia aunque no se pueda fotografiar el lienzo', async () => {
    // En jsdom no hay WebGL y el doble del visor no dibuja lienzo alguno, así
    // que no hay nada que fotografiar. Es exactamente el caso que no debe
    // impedir moverse por la planta.
    mount(withTransition('zoomThrough'));
    await click('Paso al taller');

    expect(sceneTitle()).toBe('Sala de bombas');
  });

  it('TEST-VPB-047 volver a la escena en la que ya se está no hace nada', async () => {
    // Sin esta guarda se fotografiaría y se animaría un cambio que no ocurre.
    const base = makeProject();
    const sceneA = makeScene(10, PROJECT, {
      title: 'Nave principal',
      hotspots: [
        makeHotspot(20, testUuid(10), {
          name: 'A esta misma escena',
          actions: [
            actionSchema.parse({
              id: testUuid(71),
              event: 'click',
              config: { type: 'goToScene', sceneId: testUuid(10), entryMode: 'initialView' },
            }),
          ],
        }),
      ],
    });

    const manifest = toManifest(
      { ...base, scenes: [sceneA, makeScene(11, PROJECT, { title: 'Sala de bombas' })] },
      { publishedAt: ISO_NOW, appVersion: '0.28.0', offlineCapable: true },
    );

    mount({ manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' });
    await click('A esta misma escena');

    expect(sceneTitle()).toBe('Nave principal');
    expect(document.querySelector('.transition-overlay')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Enlaces a una escena y una vista (S09)
 * ------------------------------------------------------------------ */

describe('enlaces compartibles', () => {
  const twoScenes = (): LoadedTour => {
    const base = makeProject();
    const manifest = toManifest(
      {
        ...base,
        scenes: [
          makeScene(10, PROJECT, { title: 'Nave principal' }),
          makeScene(11, PROJECT, { title: 'Sala de bombas' }),
        ],
      },
      { publishedAt: ISO_NOW, appVersion: '0.30.0', offlineCapable: true },
    );
    return { manifest, baseUrl: 'https://ejemplo.invalid/recorrido/' };
  };

  /** Coloca un fragmento en la dirección antes de montar el visor. */
  const withHash = (hash: string): void => {
    globalThis.history.replaceState(null, '', `/${hash}`);
  };

  it('TEST-VPB-048 sin enlace se abre la escena de entrada', () => {
    withHash('');
    mount(twoScenes());
    expect(sceneTitle()).toBe('Nave principal');
  });

  it('TEST-VPB-049 un enlace abre directamente la escena que indica', () => {
    // Sin salto visible desde la escena de entrada: la dirección decide el
    // estado inicial, no un efecto posterior.
    withHash(`#escena=${testUuid(11)}`);
    mount(twoScenes());
    expect(sceneTitle()).toBe('Sala de bombas');
  });

  it('TEST-VPB-050 un enlace a una escena que ya no está lo dice y abre la de entrada', async () => {
    // Quien lo recibió merece saberlo, y no creer que le mandaron mal la
    // dirección.
    withHash('#escena=00000000-0000-4000-8000-000000009999');
    mount(twoScenes());

    expect(screen.getByText(/ya no está en este recorrido/)).toBeInTheDocument();
    expect(sceneTitle()).toBe('Nave principal');

    await click('Entendido');
    expect(screen.queryByText(/ya no está en este recorrido/)).not.toBeInTheDocument();
  });

  it('TEST-VPB-051 la dirección refleja la escena en la que se está', async () => {
    withHash('');
    mount(twoScenes());

    await click('Sala de bombas');
    expect(globalThis.location.hash).toContain(testUuid(11));
  });

  it('TEST-VPB-052 se puede compartir la vista actual', async () => {
    withHash('');
    mount(twoScenes());

    await click('Compartir esta vista');

    const field = screen.getByLabelText('Enlace a esta vista');
    expect((field as HTMLInputElement).value).toContain(`escena=${testUuid(10)}`);
  });

  it('TEST-VPB-053 si el navegador no deja copiar, se dice y el enlace queda a la vista', async () => {
    // Un botón «Copiar» que no copia y no lo dice deja a la persona pegando lo
    // que tenía antes.
    const original = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('sin permiso')) },
      configurable: true,
    });

    withHash('');
    mount(twoScenes());
    await click('Compartir esta vista');
    await click('Copiar enlace');

    expect(screen.getByText('El navegador no dejó copiar')).toBeInTheDocument();
    expect(screen.getByLabelText('Enlace a esta vista')).toBeInTheDocument();

    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: original,
      configurable: true,
    });
  });
});
