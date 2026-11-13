/**
 * Pruebas del módulo de planos (G01–G05).
 *
 * Lo que se vigila aquí es la correspondencia entre lo que el autor pulsa y
 * dónde queda el punto. Un plano con los puntos desplazados es peor que no
 * tener plano: el visitante se guía por él.
 *
 * En jsdom una imagen no se carga ni tiene tamaño, así que el rectángulo de la
 * imagen se fija a mano. Es una medida de laboratorio, no un disfraz: la
 * conversión de píxeles a coordenadas del plano es exactamente lo que se
 * quiere comprobar, y es lo único que no se puede probar en el dominio.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { createPlan, createPlanMarker, type Project } from '@it360/domain';
import { ISO_NOW, makeMedia, makeProject, makeScene, testUuid } from '@it360/domain/testing';
import { PlansModule } from './PlansModule';
import { useProjectStore } from '../state/project-store';

const SCENE_A = testUuid(10);
const SCENE_B = testUuid(11);

const PLAN_MEDIA = makeMedia(80, {
  originalName: 'plano.png',
  relativePath: 'media/planos/plano.png',
  mime: 'image/png',
});

function baseProject(extra: Partial<Project> = {}): Project {
  return {
    ...makeProject(),
    media: [PLAN_MEDIA],
    scenes: [
      makeScene(10, testUuid(1), { title: 'Nave principal' }),
      makeScene(11, testUuid(1), { title: 'Sala de bombas' }),
    ],
    ...extra,
  };
}

/** Monta el módulo sobre un almacén real: las órdenes pasan por el historial. */
function Harness({
  project,
  activeSceneId = SCENE_A,
  onProject,
}: {
  readonly project: Project;
  readonly activeSceneId?: string | null;
  readonly onProject?: (project: Project) => void;
}): JSX.Element {
  const store = useProjectStore(project);
  const [scene, setScene] = [activeSceneId, () => undefined] as const;
  onProject?.(store.project);

  return (
    <PlansModule
      store={store}
      mediaUrls={new Map([[PLAN_MEDIA.id, 'data:image/png;base64,iVBORw0KGgo=']])}
      onMediaUrl={() => undefined}
      activeSceneId={scene}
      onSelectScene={setScene}
    />
  );
}

/**
 * Da tamaño al plano: 400 × 200 px empezando en (100, 50).
 *
 * Devuelve la función para calcular las coordenadas de pantalla de una
 * posición del plano, para no repetir la aritmética en cada prueba.
 */
function sizePlan(): (x: number, y: number) => { clientX: number; clientY: number } {
  const image = document.querySelector('.plans__image');
  if (image === null) throw new Error('no hay imagen de plano montada');

  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 500,
    bottom: 250,
    width: 400,
    height: 200,
    toJSON: () => ({}),
  });

  return (x, y) => ({ clientX: 100 + x * 400, clientY: 50 + y * 200 });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PlansModule', () => {
  it('TEST-PLM-001 sin planos invita a elegir la imagen', () => {
    render(
      <ToastProvider>
        <Harness project={baseProject()} />
      </ToastProvider>,
    );

    expect(screen.getByText('Sin planos')).toBeInTheDocument();
    expect(screen.getByLabelText('Imagen del plano')).toBeInTheDocument();
  });

  it('TEST-PLM-002 el punto queda donde se pulsó', async () => {
    // La prueba del módulo: 25 % a la derecha y 75 % abajo del plano.
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={baseProject({ plans: [plan] })}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    const at = sizePlan();
    const surface = screen.getByRole('button', { name: /Situar la escena en el plano/ });
    await user.pointer({ target: surface, keys: '[MouseLeft]', coords: at(0.25, 0.75) });

    await waitFor(() => expect(latest.planMarkers).toHaveLength(1));
    const marker = latest.planMarkers[0]!;
    expect(marker.sceneId).toBe(SCENE_A);
    expect(marker.position.x).toBeCloseTo(0.25, 5);
    expect(marker.position.y).toBeCloseTo(0.75, 5);
  });

  it('TEST-PLM-003 un clic fuera del plano se acota al borde', async () => {
    // El rectángulo de la imagen se redondea: un clic en el borde puede dar
    // 1.002, y un punto fuera del plano no se dibujaría.
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={baseProject({ plans: [plan] })}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    sizePlan();
    const surface = screen.getByRole('button', { name: /Situar la escena en el plano/ });
    await user.pointer({
      target: surface,
      keys: '[MouseLeft]',
      coords: { clientX: 900, clientY: 10 },
    });

    await waitFor(() => expect(latest.planMarkers).toHaveLength(1));
    expect(latest.planMarkers[0]!.position).toEqual({ x: 1, y: 0 });
  });

  it('TEST-PLM-004 volver a pulsar mueve el punto, no añade otro', async () => {
    // Una escena situada en dos sitios del plano es una contradicción.
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const existing = createPlanMarker(plan.id, SCENE_A, { x: 0.1, y: 0.1 });
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={baseProject({ plans: [plan], planMarkers: [existing] })}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    const at = sizePlan();
    await user.pointer({
      target: screen.getByRole('button', { name: /Situar la escena en el plano/ }),
      keys: '[MouseLeft]',
      coords: at(0.5, 0.5),
    });

    await waitFor(() => expect(latest.planMarkers[0]!.position.x).toBeCloseTo(0.5, 5));
    expect(latest.planMarkers).toHaveLength(1);
    expect(latest.planMarkers[0]!.id).toBe(existing.id);
  });

  it('TEST-PLM-005 sin escena elegida no se coloca nada y se dice por qué', async () => {
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={baseProject({ plans: [plan] })}
          activeSceneId={null}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    const at = sizePlan();
    await user.pointer({
      target: screen.getByRole('button', { name: /Situar la escena en el plano/ }),
      keys: '[MouseLeft]',
      coords: at(0.5, 0.5),
    });

    expect(latest.planMarkers).toHaveLength(0);
    expect(
      await screen.findByText('Elija primero la escena que quiere situar'),
    ).toBeInTheDocument();
  });

  it('TEST-PLM-006 las escenas sin situar están a la vista', () => {
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const placed = createPlanMarker(plan.id, SCENE_A, { x: 0.5, y: 0.5 });

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [plan], planMarkers: [placed] })} />
      </ToastProvider>,
    );

    const list = screen.getByText('Escenas sin situar').parentElement;
    expect(list).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Sala de bombas' })).toBeInTheDocument();
  });

  it('TEST-PLM-007 un plano sin imagen en el proyecto se denuncia', () => {
    // Pasa al abrir un proyecto cuyo paquete perdió el archivo.
    const plan = createPlan(testUuid(199), 'Planta 1');

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [plan] })} />
      </ToastProvider>,
    );

    expect(screen.getByText('Falta la imagen de este plano')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Situar la escena/ })).not.toBeInTheDocument();
  });

  it('TEST-PLM-008 el radar del punto seleccionado se dibuja sobre el plano', async () => {
    // Es la única forma de orientar un plano: ver hacia dónde apunta el cono.
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const marker = createPlanMarker(plan.id, SCENE_A, { x: 0.5, y: 0.5 });

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [plan], planMarkers: [marker] })} />
      </ToastProvider>,
    );

    expect(document.querySelector('.plans__radar')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Nave principal' }));

    const radar = document.querySelector('.plans__radar');
    expect(radar).not.toBeNull();
    const points = radar?.querySelector('polygon')?.getAttribute('points') ?? '';
    // El vértice del cono está en el punto, no en el centro del plano.
    expect(points.startsWith('50.00,50.00')).toBe(true);
  });

  it('TEST-PLM-009 los planos se agrupan por zona en la lista', () => {
    const a = createPlan(PLAN_MEDIA.id, 'Este', { floor: 'Planta 1', floorOrder: 2 });
    const b = createPlan(PLAN_MEDIA.id, 'Oeste', { floor: 'Planta baja', floorOrder: 1 });

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [a, b] })} />
      </ToastProvider>,
    );

    const names = Array.from(document.querySelectorAll('.plans__floor-name')).map(
      (node) => node.textContent,
    );
    expect(names).toEqual(['Planta baja', 'Planta 1']);
  });

  it('TEST-PLM-010 eliminar un plano avisa de los puntos que se van con él', async () => {
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const markers = [
      createPlanMarker(plan.id, SCENE_A, { x: 0.2, y: 0.2 }),
      createPlanMarker(plan.id, SCENE_B, { x: 0.8, y: 0.8 }),
    ];
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={baseProject({ plans: [plan], planMarkers: markers })}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Eliminar plano' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/los 2 puntos/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Eliminar plano' }));

    await waitFor(() => expect(latest.plans).toHaveLength(0));
    expect(latest.planMarkers).toHaveLength(0);
    // La imagen se conserva: puede ser el único original que tiene el autor.
    expect(latest.media).toHaveLength(1);
  });

  it('TEST-PLM-011 el rótulo vacío cae en el título de la escena', async () => {
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const marker = createPlanMarker(plan.id, SCENE_B, { x: 0.5, y: 0.5 });

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [plan], planMarkers: [marker] })} />
      </ToastProvider>,
    );

    expect(screen.getByRole('button', { name: 'Sala de bombas' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sala de bombas' }));
    const label = screen.getByLabelText('Rótulo');
    await user.type(label, 'Acceso norte');

    expect(await screen.findByRole('button', { name: 'Acceso norte' })).toBeInTheDocument();
  });

  it('TEST-PLM-012 el rumbo mostrado usa la orientación del punto', async () => {
    const user = userEvent.setup();
    const plan = createPlan(PLAN_MEDIA.id, 'Planta 1');
    const marker = createPlanMarker(plan.id, SCENE_A, { x: 0.5, y: 0.5 }, { headingRad: Math.PI / 2 });

    render(
      <ToastProvider>
        <Harness project={baseProject({ plans: [plan], planMarkers: [marker] })} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Nave principal' }));
    expect(screen.getByText('Rumbo del radar: 90°')).toBeInTheDocument();
  });
});

describe('alta de la imagen', () => {
  it('TEST-PLM-013 un PDF no se acepta como plano y se explica', async () => {
    render(
      <ToastProvider>
        <Harness project={baseProject()} />
      </ToastProvider>,
    );

    // Con `user.upload` el archivo no llegaría: `userEvent` filtra por el
    // atributo `accept` del campo. Un selector del sistema con «todos los
    // archivos», o soltar el archivo encima, sí lo entregan, así que la
    // comprobación del módulo tiene que existir y se prueba entregándolo.
    const file = new File([new Uint8Array([1, 2, 3])], 'plano.pdf', { type: 'application/pdf' });
    const input = screen.getByLabelText('Imagen del plano');
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('No se pudo añadir el plano')).toBeInTheDocument();
    expect(screen.getByText(/no es una imagen reconocida/)).toBeInTheDocument();
  });

  it('TEST-PLM-014 una imagen válida crea el plano con el nombre del archivo', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    let latest: Project = baseProject();

    render(
      <ToastProvider>
        <Harness
          project={{ ...baseProject(), media: [] }}
          onProject={(p) => {
            latest = p;
          }}
        />
      </ToastProvider>,
    );

    // PNG mínimo real: la firma basta, no se decodifica en estas pruebas.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], 'Planta baja.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Imagen del plano'), file);

    // En jsdom ninguna imagen carga, así que la medición agota su plazo antes
    // de dar el alta: se le deja margen en lugar de reducir el plazo real.
    await waitFor(() => expect(latest.plans).toHaveLength(1), { timeout: 6000 });
    expect(latest.plans[0]!.name).toBe('Planta baja');
    expect(latest.media).toHaveLength(1);
    expect(latest.media[0]!.relativePath).toBe('media/planos/planta-baja.png');
    expect(latest.media[0]!.createdAt).not.toBe('');
  });
});

/* `ISO_NOW` se usa en los proyectos de prueba a través de `makeProject`. */
void ISO_NOW;
