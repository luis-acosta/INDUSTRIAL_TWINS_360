/**
 * Pruebas de la pantalla de recorridos y evaluaciones (etapa 09).
 *
 * El módulo se monta con un proyecto mínimo y un almacén real, no simulado:
 * lo que se comprueba es que al editar en la pantalla el proyecto cambia como
 * debe y que los avisos que impiden publicar se ven sin pulsar nada.
 *
 * Las operaciones sobre la estructura ya están probadas en el dominio
 * (`tour-authoring.test.ts`). Aquí se comprueba lo que sólo falla en la
 * interfaz: que el aviso aparezca, que el botón correcto esté donde se
 * espera, y que la pantalla no deje el proyecto en un estado que el esquema
 * rechazaría.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import {
  createProject,
  hotspotSchema,
  createQuiz,
  createTour,
  createWaypoint,
  insertWaypoint,
  newUuid,
  sceneSchema,
  type Project,
  type Scene,
  type Uuid,
} from '@it360/domain';
import { ToursModule } from './ToursModule';
import { useProjectStore } from '../state/project-store';

const NOW = '2026-10-01T09:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Proyecto de prueba
 * ------------------------------------------------------------------ */

function makeScene(projectId: Uuid, title: string): Scene {
  // Derivado del esquema: una lista de campos escrita a mano aquí se queda
  // atrás en cuanto el esquema de escena cambie.
  return sceneSchema.parse({
    id: newUuid(),
    projectId,
    title,
    kind: 'panorama',
    mediaId: newUuid(),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeProject(): Project {
  const id = newUuid();
  const base = createProject({ id, title: 'Planta de prueba', now: NOW, appVersion: '0.0.0-test' });
  return {
    ...base,
    scenes: [makeScene(id, 'Nave principal'), makeScene(id, 'Sala de bombas')],
  };
}

/** Monta el módulo sobre un almacén real, con el proyecto que se le pase. */
function Harness({ project }: { project: Project }): JSX.Element {
  const store = useProjectStore(project, null);
  return <ToursModule store={store} />;
}

const mount = (project: Project): void => {
  render(
    <ToastProvider>
      <Harness project={project} />
    </ToastProvider>,
  );
};

/* ------------------------------------------------------------------ *
 * Estado inicial
 * ------------------------------------------------------------------ */

describe('ToursModule — estado inicial', () => {
  it('TEST-TUI-001 sin recorridos ni evaluaciones explica para qué sirve cada cosa', () => {
    mount(makeProject());
    expect(screen.getByText('Sin recorridos ni evaluaciones')).toBeInTheDocument();
  });

  it('TEST-TUI-002 crear un recorrido lo selecciona y abre su editor', async () => {
    const user = userEvent.setup();
    mount(makeProject());

    await user.click(screen.getByRole('button', { name: 'Nuevo recorrido' }));

    expect(screen.getByLabelText('Nombre del recorrido')).toHaveValue('Recorrido 1');
    // Un recorrido recién creado no tiene paradas, y eso impide publicarlo.
    expect(screen.getByText('No se puede publicar todavía')).toBeInTheDocument();
  });

  it('TEST-TUI-003 crear una evaluación abre su editor', async () => {
    const user = userEvent.setup();
    mount(makeProject());

    await user.click(screen.getByRole('button', { name: 'Nueva evaluación' }));
    expect(screen.getByLabelText('Nombre de la evaluación')).toHaveValue('Evaluación 1');
  });
});

/* ------------------------------------------------------------------ *
 * Paradas
 * ------------------------------------------------------------------ */

describe('ToursModule — paradas', () => {
  const withTour = (): Project => {
    const project = makeProject();
    const tour = createTour(project.id, 'Visita de planta', NOW);
    return { ...project, tours: [tour] };
  };

  it('TEST-TUI-004 añadir una parada desde el selector de escenas', async () => {
    const user = userEvent.setup();
    mount(withTour());

    await user.click(screen.getByRole('button', { name: /Visita de planta/ }));
    await user.selectOptions(screen.getByLabelText('Añadir parada en'), 'Nave principal');

    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    expect(within(stops).getAllByRole('listitem')).toHaveLength(1);
    expect(within(stops).getByRole('button', { expanded: true })).toHaveTextContent('Nave principal');
    // Con una sola parada el recorrido ya se puede publicar; sólo queda el
    // aviso de que un recorrido de una parada no es un recorrido.
    expect(screen.queryByText('No se puede publicar todavía')).not.toBeInTheDocument();
    expect(screen.getByText('Conviene revisar')).toBeInTheDocument();
  });

  it('TEST-TUI-005 una parada que apunta a una escena borrada impide publicar', async () => {
    // Es el fallo que se descubre delante de la visita: el recorrido se para
    // en seco y nadie sabe por qué.
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(newUuid()));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    const alarm = screen.getByText('No se puede publicar todavía').closest('div');
    expect(alarm).not.toBeNull();
    expect(within(alarm as HTMLElement).getByText(/ya no está en el proyecto/)).toBeInTheDocument();
  });

  it('TEST-TUI-006 la lista avisa con un contador de errores', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(newUuid()));

    mount({ ...project, tours: [tour] });
    const item = screen.getByRole('button', { name: /Visita/ });
    expect(item).toHaveTextContent('1');

    await user.click(item);
    expect(screen.getByText('No se puede publicar todavía')).toBeInTheDocument();
  });

  it('TEST-TUI-007 se puede reordenar una parada con el teclado', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    const before = within(stops).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(before[0]).toContain('Nave principal');

    // Sin arrastre: subir y bajar tienen botones, que es lo que permite usar
    // la pantalla sin ratón.
    await user.click(screen.getByRole('button', { name: 'Subir parada 2' }));

    const after = within(screen.getByRole('list', { name: 'Puntos de paso' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(after[0]).toContain('Sala de bombas');
  });

  it('TEST-TUI-008 quitar una parada la saca de la lista', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));
    await user.click(screen.getByRole('button', { name: 'Quitar parada 1' }));

    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    expect(within(stops).queryByText('Nave principal')).not.toBeInTheDocument();
    expect(within(stops).getByText('Sala de bombas')).toBeInTheDocument();
  });

  it('TEST-TUI-009 la permanencia se escribe en segundos y se guarda en ms', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));
    await user.click(screen.getByRole('button', { name: /Nave principal/ }));

    const dwell = screen.getByLabelText('Permanencia');
    await user.clear(dwell);
    await user.type(dwell, '12{Enter}');

    // La cabecera resume la parada en segundos: es la comprobación de que el
    // valor llegó al proyecto en milisegundos y volvió convertido.
    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    expect(within(stops).getByRole('button', { expanded: true })).toHaveTextContent('12 s');
  });
});

/* ------------------------------------------------------------------ *
 * Comportamiento del recorrido
 * ------------------------------------------------------------------ */

describe('ToursModule — comportamiento', () => {
  const ready = (): Project => {
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));
    return { ...project, tours: [tour] };
  };

  it('TEST-TUI-010 desactivar la interrupción avisa de lo que implica', async () => {
    const user = userEvent.setup();
    mount(ready());
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    await user.click(screen.getByLabelText('El visitante puede interrumpirlo'));

    const advisory = screen.getByText('Conviene revisar').closest('.it-callout');
    expect(advisory).not.toBeNull();
    expect(within(advisory as HTMLElement).getByText(/quiosco vigilado/)).toBeInTheDocument();
  });

  it('TEST-TUI-011 sin interrupción, la reanudación automática queda inservible', async () => {
    const user = userEvent.setup();
    mount(ready());
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    await user.click(screen.getByLabelText('El visitante puede interrumpirlo'));

    expect(screen.getByLabelText('Reanudar solo tras inactividad')).toBeDisabled();
    expect(screen.getByLabelText('Reanudar donde se interrumpió')).toBeDisabled();
  });

  it('TEST-TUI-012 la nota mínima sólo se habilita con evaluación elegida', async () => {
    const user = userEvent.setup();
    const project = ready();
    const quiz = createQuiz(project.id, 'Seguridad', NOW);

    mount({ ...project, quizzes: [quiz] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    expect(screen.getByLabelText('Nota mínima')).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Exige haber hecho la evaluación'), 'Seguridad');
    expect(screen.getByLabelText('Nota mínima')).toBeEnabled();
  });

  it('TEST-TUI-013 sin evaluaciones el campo lo dice en lugar de quedarse vacío', async () => {
    const user = userEvent.setup();
    mount(ready());
    await user.click(screen.getByRole('button', { name: /Visita/ }));

    expect(screen.getByText(/No hay evaluaciones en el proyecto/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Evaluaciones
 * ------------------------------------------------------------------ */

describe('ToursModule — evaluaciones', () => {
  const withQuiz = (): Project => {
    const project = makeProject();
    return { ...project, quizzes: [createQuiz(project.id, 'Seguridad', NOW)] };
  };

  it('TEST-TUI-014 añadir una pregunta de verdadero/falso trae sus dos opciones', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));

    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Verdadero / falso');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    expect(screen.getByDisplayValue('Verdadero')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Falso')).toBeInTheDocument();
  });

  it('TEST-TUI-015 en respuesta única marcar una opción desmarca la otra', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    await user.click(screen.getByRole('button', { name: 'Añadir opción' }));
    await user.click(screen.getByRole('button', { name: 'Añadir opción' }));

    const first = screen.getByRole('checkbox', { name: 'La opción 1 es correcta' });
    const second = screen.getByRole('checkbox', { name: 'La opción 2 es correcta' });

    await user.click(first);
    expect(first).toBeChecked();

    await user.click(second);
    // Dos correctas en una pregunta de respuesta única es un estado que el
    // corrector no sabría puntuar: la pantalla no debe poder producirlo.
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
  });

  it('TEST-TUI-016 una pregunta sin opción correcta se señala en la cabecera', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    expect(screen.getByText('sin correcta')).toBeInTheDocument();
  });

  it('TEST-TUI-017 una nota mínima mayor que el máximo alcanzable se marca imposible', async () => {
    // Nada más en la pantalla lo delataría: la evaluación se publicaría y
    // nadie la aprobaría nunca.
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const passing = screen.getByLabelText('Nota mínima');
    await user.clear(passing);
    await user.type(passing, '80{Enter}');

    expect(screen.getByText(/Imposible: el máximo alcanzable es 0/)).toBeInTheDocument();
  });

  it('TEST-TUI-018 borrar una pregunta avisa de las ramas que la señalan', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    // La segunda pregunta (la abierta) continúa en la primera.
    const next = screen.getByLabelText('Al responder, continuar en');
    await user.selectOptions(next, within(next).getAllByRole('option')[1]!);

    await user.click(screen.getByRole('button', { name: 'Quitar pregunta 1' }));

    expect(screen.getByText(/volverán a seguir el orden/)).toBeInTheDocument();
  });

  it('TEST-TUI-019 al confirmar el borrado la evaluación queda sin ramas rotas', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const next = screen.getByLabelText('Al responder, continuar en');
    await user.selectOptions(next, within(next).getAllByRole('option')[1]!);

    await user.click(screen.getByRole('button', { name: 'Quitar pregunta 1' }));
    await user.click(screen.getByRole('button', { name: 'Quitar' }));

    // Si la rama hubiese quedado apuntando a la pregunta borrada, el aviso de
    // «no se puede publicar» seguiría ahí.
    expect(screen.queryByText(/pregunta inexistente/)).not.toBeInTheDocument();
  });

  it('TEST-TUI-020 en una pregunta de ordenar no se marcan opciones correctas', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));

    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Ordenar');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));
    await user.click(screen.getByRole('button', { name: 'Añadir opción' }));

    // En ordenar, la respuesta es la secuencia, no una casilla por opción.
    expect(screen.queryByRole('checkbox', { name: 'La opción 1 es correcta' })).not.toBeInTheDocument();
    expect(screen.getByText('Orden correcto')).toBeInTheDocument();
  });

  it('TEST-TUI-021 el orden correcto se construye eligiendo opciones', async () => {
    const user = userEvent.setup();
    mount(withQuiz());
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));

    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Ordenar');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));
    await user.click(screen.getByRole('button', { name: 'Añadir opción' }));

    expect(screen.getByText(/sin él la pregunta no se puede acertar/)).toBeInTheDocument();

    const add = screen.getByLabelText('Añadir al orden correcto');
    await user.selectOptions(add, within(add).getAllByRole('option')[1]!);

    expect(screen.queryByText(/sin él la pregunta no se puede acertar/)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Borrado con dependencias
 * ------------------------------------------------------------------ */

describe('ToursModule — borrado', () => {
  it('TEST-TUI-022 borrar una evaluación avisa de los recorridos que la exigen', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const quiz = createQuiz(project.id, 'Seguridad', NOW);
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = { ...tour, requiresQuizId: quiz.id };

    mount({ ...project, tours: [tour], quizzes: [quiz] });
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Eliminar evaluación' }));

    expect(screen.getByText(/dejarán de exigirla/)).toBeInTheDocument();
  });

  it('TEST-TUI-023 al borrarla, el recorrido deja de exigirla en lugar de quedar roto', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const quiz = createQuiz(project.id, 'Seguridad', NOW);
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));
    tour = { ...tour, requiresQuizId: quiz.id };

    mount({ ...project, tours: [tour], quizzes: [quiz] });
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Eliminar evaluación' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));

    await user.click(screen.getByRole('button', { name: /Visita/ }));
    // Sin la limpieza, aquí aparecería «la evaluación que condiciona el
    // recorrido ya no existe» y el autor tendría que adivinar en qué
    // recorrido.
    expect(screen.queryByText('No se puede publicar todavía')).not.toBeInTheDocument();
  });

  it('TEST-TUI-024 borrar un recorrido lo quita de la lista', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const tour = createTour(project.id, 'Visita', NOW);

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));
    await user.click(screen.getByRole('button', { name: 'Eliminar recorrido' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));

    expect(screen.queryByRole('button', { name: /Visita/ })).not.toBeInTheDocument();
    expect(screen.getByText('Sin recorridos ni evaluaciones')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Multimedia, marcadores a buscar y objetivos (O03, O04, O08)
 * ------------------------------------------------------------------ */

/** Marcador mínimo, derivado del esquema. */
function makeHotspot(sceneId: Uuid, name: string) {
  return hotspotSchema.parse({
    id: newUuid(),
    sceneId,
    name,
    anchor: { space: 'spherical', yaw: 0, pitch: 0 },
    geometry: { shape: 'icon' },
    style: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('ToursModule — contenido de las preguntas', () => {
  const withHotspots = (): Project => {
    const project = makeProject();
    const scenes = project.scenes.map((scene) => ({
      ...scene,
      hotspots: [makeHotspot(scene.id, `Extintor de ${scene.title}`)],
    }));
    return { ...project, scenes, quizzes: [createQuiz(project.id, 'Riesgos', NOW)] };
  };

  it('TEST-TUI-025 la pregunta de buscar marcadores lista los del proyecto', async () => {
    const user = userEvent.setup();
    mount(withHotspots());
    await user.click(screen.getByRole('button', { name: /Riesgos/ }));

    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Buscar marcadores');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const add = screen.getByLabelText('Añadir marcador a buscar');
    expect(within(add).getAllByRole('option')).toHaveLength(3); // el vacío y dos marcadores
  });

  it('TEST-TUI-026 añadir un marcador a buscar lo trae con su nombre', async () => {
    const user = userEvent.setup();
    mount(withHotspots());
    await user.click(screen.getByRole('button', { name: /Riesgos/ }));
    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Buscar marcadores');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const add = screen.getByLabelText('Añadir marcador a buscar');
    await user.selectOptions(add, within(add).getAllByRole('option')[1]!);

    const targets = screen.getByRole('list', { name: 'Marcadores a encontrar' });
    expect(within(targets).getByDisplayValue(/Extintor de/)).toBeInTheDocument();
  });

  it('TEST-TUI-027 un marcador ya elegido desaparece del selector', async () => {
    // El mismo marcador dos veces puntuaría dos veces por un solo hallazgo.
    const user = userEvent.setup();
    mount(withHotspots());
    await user.click(screen.getByRole('button', { name: /Riesgos/ }));
    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Buscar marcadores');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const add = screen.getByLabelText('Añadir marcador a buscar');
    await user.selectOptions(add, within(add).getAllByRole('option')[1]!);

    const again = screen.getByLabelText('Añadir marcador a buscar');
    expect(within(again).getAllByRole('option')).toHaveLength(2);
  });

  it('TEST-TUI-028 sin marcadores en el proyecto lo dice en lugar de ofrecer un selector vacío', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    mount({ ...project, quizzes: [createQuiz(project.id, 'Riesgos', NOW)] });
    await user.click(screen.getByRole('button', { name: /Riesgos/ }));
    await user.selectOptions(screen.getByLabelText('Tipo de pregunta nueva'), 'Buscar marcadores');
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    expect(screen.getByText(/No hay marcadores en el proyecto/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Añadir marcador a buscar')).not.toBeInTheDocument();
  });

  it('TEST-TUI-029 la pregunta admite elegir la escena en que se plantea', async () => {
    const user = userEvent.setup();
    mount(withHotspots());
    await user.click(screen.getByRole('button', { name: /Riesgos/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));

    const scene = screen.getByLabelText('Se plantea en la escena');
    expect(within(scene).getAllByRole('option')).toHaveLength(3);
    await user.selectOptions(scene, 'Sala de bombas');
    expect(scene).toHaveValue(
      within(scene).getByRole('option', { name: 'Sala de bombas' }).getAttribute('value'),
    );
  });
});

describe('ToursModule — objetivos de puntuación', () => {
  const scoredQuiz = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    const project = makeProject();
    mount({ ...project, quizzes: [createQuiz(project.id, 'Seguridad', NOW)] });
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir pregunta' }));
    await user.click(screen.getByRole('button', { name: 'Añadir opción' }));

    const points = screen.getByLabelText('Puntos de la opción 1');
    await user.clear(points);
    await user.type(points, '10{Enter}');
  };

  it('TEST-TUI-030 sin preguntas no se pueden crear objetivos', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    mount({ ...project, quizzes: [createQuiz(project.id, 'Seguridad', NOW)] });
    await user.click(screen.getByRole('button', { name: /Seguridad/ }));

    expect(screen.getByText(/añada preguntas primero/)).toBeInTheDocument();
  });

  it('TEST-TUI-031 un objetivo nuevo toma por meta el máximo alcanzable', async () => {
    const user = userEvent.setup();
    await scoredQuiz(user);

    await user.selectOptions(screen.getByLabelText('Clave'), 'general');
    await user.type(screen.getByLabelText('Nombre del objetivo'), 'Apto en seguridad');
    await user.click(screen.getByRole('button', { name: 'Añadir objetivo' }));

    const goals = screen.getByRole('list', { name: 'Objetivos de puntuación' });
    expect(within(goals).getByLabelText('Meta')).toHaveValue('10');
  });

  it('TEST-TUI-032 una meta por encima del máximo se marca y se avisa', async () => {
    // Ni el objetivo ni sus acciones ocurrirían nunca.
    const user = userEvent.setup();
    await scoredQuiz(user);

    await user.selectOptions(screen.getByLabelText('Clave'), 'general');
    await user.type(screen.getByLabelText('Nombre del objetivo'), 'Apto');
    await user.click(screen.getByRole('button', { name: 'Añadir objetivo' }));

    const goals = screen.getByRole('list', { name: 'Objetivos de puntuación' });
    const meta = within(goals).getByLabelText('Meta');
    await user.clear(meta);
    await user.type(meta, '80{Enter}');

    expect(screen.getByText(/El máximo alcanzable es 10/)).toBeInTheDocument();
    expect(screen.getByText(/Piden más puntos de los alcanzables/)).toBeInTheDocument();
  });

  it('TEST-TUI-033 el objetivo no se puede crear sin nombre', async () => {
    const user = userEvent.setup();
    await scoredQuiz(user);
    await user.selectOptions(screen.getByLabelText('Clave'), 'general');

    expect(screen.getByRole('button', { name: 'Añadir objetivo' })).toBeDisabled();
  });

  it('TEST-TUI-034 una clave que ya tiene objetivo deja de ofrecerse', async () => {
    const user = userEvent.setup();
    await scoredQuiz(user);

    await user.selectOptions(screen.getByLabelText('Clave'), 'general');
    await user.type(screen.getByLabelText('Nombre del objetivo'), 'Apto');
    await user.click(screen.getByRole('button', { name: 'Añadir objetivo' }));

    expect(screen.getByText(/ya tiene su objetivo/)).toBeInTheDocument();
  });

  it('TEST-TUI-035 quitar un objetivo lo elimina de la lista', async () => {
    const user = userEvent.setup();
    await scoredQuiz(user);

    await user.selectOptions(screen.getByLabelText('Clave'), 'general');
    await user.type(screen.getByLabelText('Nombre del objetivo'), 'Apto');
    await user.click(screen.getByRole('button', { name: 'Añadir objetivo' }));
    await user.click(screen.getByRole('button', { name: 'Quitar objetivo general' }));

    expect(screen.queryByRole('list', { name: 'Objetivos de puntuación' })).not.toBeInTheDocument();
  });
});

describe('ToursModule — acciones de una parada', () => {
  it('TEST-TUI-036 una parada permite añadir acciones al llegar', async () => {
    // Antes sólo se podían ver; el requisito pide definirlas (J02).
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));
    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    await user.click(within(stops).getAllByRole('button', { expanded: false })[0]!);

    expect(screen.getByText('Acciones al llegar')).toBeInTheDocument();
  });

  it('TEST-TUI-037 una parada sin acciones no se presenta como un error', async () => {
    // Un marcador sin acciones sí lo es; una parada, no.
    const user = userEvent.setup();
    const project = makeProject();
    let tour = createTour(project.id, 'Visita', NOW);
    tour = insertWaypoint(tour, createWaypoint(project.scenes[0]!.id));
    tour = insertWaypoint(tour, createWaypoint(project.scenes[1]!.id));

    mount({ ...project, tours: [tour] });
    await user.click(screen.getByRole('button', { name: /Visita/ }));
    const stops = screen.getByRole('list', { name: 'Puntos de paso' });
    await user.click(within(stops).getAllByRole('button', { expanded: false })[0]!);

    expect(screen.queryByText('Este marcador no hace nada')).not.toBeInTheDocument();
  });
});
