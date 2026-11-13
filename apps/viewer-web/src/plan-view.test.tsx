/**
 * Pruebas de la vista de plano del visor (G01–G05).
 *
 * El rumbo y el agrupado están probados en el dominio. Aquí se comprueba lo
 * que sólo falla al montarlo, y sobre todo una cosa: **que el radar no se
 * dibuje cuando no se sabe dónde está el visitante**. Un cono colocado en el
 * centro «por poner algo» afirma una posición falsa, y el visitante se fía del
 * radar: es el único elemento del plano que le dice hacia dónde mira.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { toManifest, type CameraView, type Manifest, type Project } from '@it360/domain';
import {
  ISO_NOW,
  makeMedia,
  makePlan,
  makePlanMarker,
  makeProject,
  makeScene,
  testUuid,
} from '@it360/domain/testing';
import { PlanView } from './PlanView';

const PROJECT = testUuid(1);
const SCENE_A = testUuid(10);
const SCENE_B = testUuid(11);
/** La imagen que `packaged` mete en el paquete; los planos deben apuntar aquí. */
const PLAN_IMAGE = testUuid(80);

const view = (yawDeg: number, fov = 75): CameraView => ({
  yaw: (yawDeg * Math.PI) / 180,
  pitch: 0,
  fov,
});

/** Paquete con los planos y puntos que se le pasen. */
function packaged(options: {
  readonly plans?: readonly ReturnType<typeof makePlan>[];
  readonly markers?: readonly ReturnType<typeof makePlanMarker>[];
  readonly withImage?: boolean;
} = {}): { manifest: Manifest; urls: Map<string, string> } {
  const base = makeProject();
  const image = makeMedia(80, { originalName: 'plano.png', relativePath: 'media/plano.png' });
  // Si un plano apuntara a otra imagen no empaquetada, la vista diría que falta
  // y no dibujaría ningún punto: el fallo parecería del punto y sería del fixture.

  const project: Project = {
    ...base,
    media: [image],
    scenes: [
      makeScene(10, PROJECT, { title: 'Nave principal' }),
      makeScene(11, PROJECT, { title: 'Sala de bombas' }),
    ],
    plans: [...(options.plans ?? [makePlan(80, image.id)])],
    planMarkers: [...(options.markers ?? [])],
  };

  const manifest = toManifest(project, {
    publishedAt: ISO_NOW,
    appVersion: '0.31.0',
    offlineCapable: true,
  });

  const urls = new Map<string, string>();
  if (options.withImage !== false) urls.set(image.id, 'data:image/png;base64,iVBORw0KGgo=');

  return { manifest, urls };
}

const mount = (
  options: Parameters<typeof packaged>[0] = {},
  active: string | null = SCENE_A,
  camera: CameraView | null = view(0),
): { selected: string[]; manifest: Manifest } => {
  const selected: string[] = [];
  const { manifest, urls } = packaged(options);

  render(
    <ToastProvider>
      <PlanView
        manifest={manifest}
        mediaUrls={urls}
        activeSceneId={active}
        view={camera}
        onSelect={(id) => selected.push(id)}
      />
    </ToastProvider>,
  );

  return { selected, manifest };
};

const radar = (): SVGPathElement | null => document.querySelector('.planview__radar path');

/* ------------------------------------------------------------------ *
 * Lo básico
 * ------------------------------------------------------------------ */

describe('PlanView', () => {
  it('TEST-PLV-001 sin planos lo dice', () => {
    const base = makeProject();
    const manifest = toManifest(base, {
      publishedAt: ISO_NOW,
      appVersion: '0.31.0',
      offlineCapable: true,
    });

    render(
      <ToastProvider>
        <PlanView
          manifest={manifest}
          mediaUrls={new Map()}
          activeSceneId={null}
          view={null}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByText('El recorrido no incluye planos')).toBeInTheDocument();
  });

  it('TEST-PLV-002 sin la imagen en el paquete lo dice en lugar de dejar un hueco', () => {
    mount({ withImage: false });
    expect(screen.getByText('Falta la imagen del plano en el paquete')).toBeInTheDocument();
  });

  it('TEST-PLV-003 el rótulo del punto manda sobre el título de la escena', () => {
    // El autor pone el rótulo para decir algo que el título no dice —«acceso
    // norte» frente a «Nave principal»—, así que no se le sobrescribe.
    const { manifest, urls } = packaged();
    const plan = manifest.plans[0]!;
    const withMarker = {
      ...manifest,
      planMarkers: [makePlanMarker(92, plan.id, SCENE_B, { label: 'Acceso norte' })],
    };

    render(
      <ToastProvider>
        <PlanView
          manifest={withMarker}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByRole('button', { name: 'Ir a Acceso norte' })).toBeInTheDocument();
  });

  it('TEST-PLV-003b sin rótulo se usa el título de la escena', () => {
    const { manifest, urls } = packaged();
    const plan = manifest.plans[0]!;
    const withMarker = {
      ...manifest,
      planMarkers: [makePlanMarker(92, plan.id, SCENE_B, { label: '' })],
    };

    render(
      <ToastProvider>
        <PlanView
          manifest={withMarker}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByRole('button', { name: 'Ir a Sala de bombas' })).toBeInTheDocument();
  });

  it('TEST-PLV-004 un punto lleva a su escena al pulsarlo', async () => {
    const user = userEvent.setup();
    const { manifest, urls } = packaged({ markers: [] });
    const plan = manifest.plans[0]!;

    const selected: string[] = [];
    const withMarker = {
      ...manifest,
      planMarkers: [makePlanMarker(92, plan.id, SCENE_B, { label: '' })],
    };

    render(
      <ToastProvider>
        <PlanView
          manifest={withMarker}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={(id) => selected.push(id)}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Ir a Sala de bombas' }));
    expect(selected).toEqual([SCENE_B]);
  });

  it('TEST-PLV-005 el punto de la escena actual se marca como «está aquí»', () => {
    const { manifest, urls } = packaged();
    const plan = manifest.plans[0]!;
    const withMarker = { ...manifest, planMarkers: [makePlanMarker(92, plan.id, SCENE_A)] };

    render(
      <ToastProvider>
        <PlanView
          manifest={withMarker}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByRole('button', { name: /está aquí/ })).toBeInTheDocument();
  });

  it('TEST-PLV-006 cuenta los puntos navegables', () => {
    const { manifest, urls } = packaged();
    const plan = manifest.plans[0]!;
    const withMarkers = {
      ...manifest,
      planMarkers: [
        makePlanMarker(92, plan.id, SCENE_A),
        makePlanMarker(93, plan.id, SCENE_B, { position: { x: 0.7, y: 0.3 } }),
      ],
    };

    render(
      <ToastProvider>
        <PlanView
          manifest={withMarkers}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByText('2 punto(s) navegable(s)')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Radar
 * ------------------------------------------------------------------ */

describe('radar del plano', () => {
  /** Monta con un punto para la escena activa, que es cuando hay radar. */
  const withHere = (
    camera: CameraView | null,
    planOver: Record<string, unknown> = {},
  ): Manifest => {
    const { manifest, urls } = packaged();
    const plan = { ...manifest.plans[0]!, ...planOver };
    const next: Manifest = {
      ...manifest,
      plans: [plan],
      planMarkers: [makePlanMarker(92, plan.id, SCENE_A)],
    };

    render(
      <ToastProvider>
        <PlanView
          manifest={next}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={camera}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    return next;
  };

  it('TEST-PLV-007 con posición y vista se dibuja el cono', () => {
    withHere(view(0));
    expect(radar()).not.toBeNull();
  });

  it('TEST-PLV-008 sin punto para la escena actual NO se dibuja el cono', () => {
    // Es la prueba que más importa: un cono en el centro «por poner algo»
    // afirmaría una posición falsa, y el visitante se fía del radar.
    const { manifest, urls } = packaged({ markers: [] });
    render(
      <ToastProvider>
        <PlanView
          manifest={manifest}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(radar()).toBeNull();
    expect(screen.getByText(/no está situada en este plano/)).toBeInTheDocument();
  });

  it('TEST-PLV-009 sin vista de cámara tampoco se dibuja', () => {
    withHere(null);
    expect(radar()).toBeNull();
  });

  it('TEST-PLV-010 si el autor desactiva el radar, no se dibuja', () => {
    withHere(view(0), { showRadar: false });
    expect(radar()).toBeNull();
  });

  it('TEST-PLV-011 el cono apunta hacia arriba con rumbo cero', () => {
    withHere(view(0, 20), { radarApertureDeg: 20 });
    const svg = radar();
    const path = svg?.getAttribute('d') ?? '';

    // El cono se dibuja en una caja propia centrada en el punto, así que el
    // vértice está en el origen y el arco queda por encima (y negativa).
    const ys = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(ys[0]).toBeCloseTo(0, 5);
    expect(Math.min(...ys)).toBeLessThan(-30);

    // Y la posición la lleva la caja, no el trazo: si no, el cono se dibujaría
    // siempre en el mismo sitio del plano.
    const box = svg?.closest('svg');
    expect(box?.getAttribute('style') ?? '').toContain('50%');
  });

  it('TEST-PLV-011b la caja del cono es cuadrada, para no falsear el ángulo', () => {
    // Estirar el cono con la forma del plano convertiría sesenta grados en
    // cien sobre un plano 2:1, y el ángulo es justo lo que el visitante lee.
    withHere(view(0, 20), { radarApertureDeg: 20 });
    const box = radar()?.closest('svg');

    expect(box?.getAttribute('width')).toBe(box?.getAttribute('height'));
    expect(box?.getAttribute('viewBox')).toBe('-50 -50 100 100');
    expect(box?.getAttribute('preserveAspectRatio')).toBeNull();
  });

  it('TEST-PLV-012 el rumbo se muestra en grados junto al plano', () => {
    withHere(view(90));
    expect(screen.getByText(/rumbo 90°/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Zonas y pisos (G03)
 * ------------------------------------------------------------------ */

describe('zonas', () => {
  it('TEST-PLV-013 con un solo plano no se ofrece selector de zona', () => {
    // Un selector con una sola opción es ruido.
    mount();
    expect(screen.queryByRole('tablist', { name: 'Zonas y planos' })).not.toBeInTheDocument();
  });

  it('TEST-PLV-014 con varias zonas se ofrecen, en el orden declarado', () => {
    const image = PLAN_IMAGE;
    const plans = [
      makePlan(80, image, { name: 'Este', floor: 'Planta 1', floorOrder: 2 }),
      makePlan(81, image, { name: 'Oeste', floor: 'Planta baja', floorOrder: 1 }),
    ];

    const { manifest, urls } = packaged({ plans });
    render(
      <ToastProvider>
        <PlanView
          manifest={manifest}
          mediaUrls={urls}
          activeSceneId={null}
          view={null}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    const tabs = screen.getByRole('tablist', { name: 'Zonas y planos' });
    const labels = within(tabs)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);

    expect(labels).toEqual(['Planta baja · Oeste', 'Planta 1 · Este']);
  });

  it('TEST-PLV-015 se abre por el plano donde está la escena actual', async () => {
    // Abrir siempre por el primero obligaría al visitante a buscar en qué zona
    // está, que es justo lo que venía a averiguar.
    const image = PLAN_IMAGE;
    const plans = [
      makePlan(80, image, { name: 'Este', floor: 'Planta 1', floorOrder: 1 }),
      makePlan(81, image, { name: 'Oeste', floor: 'Planta 2', floorOrder: 2 }),
    ];
    const markers = [makePlanMarker(92, plans[1]!.id, SCENE_A)];

    const { manifest, urls } = packaged({ plans, markers });
    render(
      <ToastProvider>
        <PlanView
          manifest={manifest}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByRole('tab', { name: 'Planta 2 · Oeste', selected: true })).toBeInTheDocument();
  });

  it('TEST-PLV-016 se puede cambiar de plano', async () => {
    const user = userEvent.setup();
    const image = PLAN_IMAGE;
    const plans = [
      makePlan(80, image, { name: 'Este', floor: 'Planta 1', floorOrder: 1 }),
      makePlan(81, image, { name: 'Oeste', floor: 'Planta 2', floorOrder: 2 }),
    ];
    const markers = [
      makePlanMarker(92, plans[0]!.id, SCENE_A),
      makePlanMarker(93, plans[1]!.id, SCENE_B, { position: { x: 0.2, y: 0.8 }, label: '' }),
    ];

    const { manifest, urls } = packaged({ plans, markers });
    render(
      <ToastProvider>
        <PlanView
          manifest={manifest}
          mediaUrls={urls}
          activeSceneId={SCENE_A}
          view={view(0)}
          onSelect={() => undefined}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('tab', { name: 'Planta 2 · Oeste' }));

    // El punto del otro plano es el que se ve ahora.
    expect(screen.getByRole('button', { name: 'Ir a Sala de bombas' })).toBeInTheDocument();
    // Y el radar desaparece, porque la escena actual no está en ese plano.
    expect(radar()).toBeNull();
  });
});
