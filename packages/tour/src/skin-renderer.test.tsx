/**
 * Pruebas de la interfaz del autor dibujada en el visor (F05–F13, J05, J10).
 *
 * Hasta ahora el *skin* no se dibujaba en ninguna parte: el autor componía una
 * interfaz y el visitante no la veía. Lo que se vigila aquí es que lo que el
 * autor declaró se respete —dispositivo, escena, pestaña, visibilidad— y que
 * un componente que esta versión no dibuja se declare en su sitio en lugar de
 * dejar un hueco.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  actionSchema,
  toManifest,
  type Action,
  type ComponentConfig,
  type Manifest,
  type Skin,
  type SkinNode,
} from '@it360/domain';
import { makeMedia, makeProject, makeScene, makeSkin, testUuid } from '@it360/domain/testing';
import { EMPTY_SKIN_STATE, type SkinState } from '@it360/viewer';
import { SkinRenderer, type SkinHost } from './SkinRenderer';

const SCENE_A = testUuid(10);
const SCENE_B = testUuid(11);

/** Nodo con lo mínimo, para no repetir doce campos en cada caso. */
function node(config: ComponentConfig, overrides: Partial<SkinNode> = {}): SkinNode {
  return {
    id: 'n1',
    name: 'Componente',
    config,
    box: {
      anchor: 'topLeft',
      offsetX: 10,
      offsetY: 10,
      width: 200,
      height: 40,
      widthPercent: null,
      heightPercent: null,
      minWidth: 0,
      minHeight: 0,
      padding: 0,
      gap: 0,
    },
    style: {
      background: { kind: 'none' },
      backdropBlur: 0,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: null,
      shadow: 'none',
      opacity: 1,
      fontMediaId: null,
      fontSize: null,
      fontWeight: null,
      textColor: null,
      textAlign: 'left',
    },
    visibility: { desktop: true, tablet: true, mobile: true, vr: true },
    initiallyVisible: true,
    actions: [],
    tabId: null,
    sceneIds: [],
    children: [],
    locked: false,
    ...overrides,
  } as SkinNode;
}

function manifestWith(): Manifest {
  const base = makeProject();
  const media = makeMedia(80, { originalName: 'pano.jpg' });

  return toManifest(
    {
      ...base,
      media: [media],
      scenes: [
        makeScene(10, base.id, { title: 'Sala de bombas', mediaId: media.id, order: 0 }),
        makeScene(11, base.id, { title: 'Plataforma superior', mediaId: media.id, order: 1 }),
      ],
    },
    { publishedAt: '2026-11-13T10:00:00.000Z', appVersion: '0.33.0', offlineCapable: true },
  );
}

interface MountOptions {
  readonly nodes: readonly SkinNode[];
  readonly state?: SkinState;
  readonly sceneId?: string | null;
  readonly device?: SkinHost['device'];
  readonly layoutMode?: Skin['layoutMode'];
  readonly variables?: SkinHost['variables'];
  readonly progress?: SkinHost['progress'];
  readonly slots?: SkinHost['slots'];
}

interface Mounted {
  readonly actions: ReturnType<typeof vi.fn>;
  readonly tabs: ReturnType<typeof vi.fn>;
  readonly carousel: ReturnType<typeof vi.fn>;
  readonly scenes: ReturnType<typeof vi.fn>;
}

function mount(options: MountOptions): Mounted {
  const manifest = manifestWith();
  const skin: Skin = {
    ...makeSkin(95, { layoutMode: options.layoutMode ?? 'fluid' }),
    root: [...options.nodes],
  };

  const actions = vi.fn();
  const tabs = vi.fn();
  const carousel = vi.fn();
  const scenes = vi.fn();

  const urls = new Map<string, string>();
  for (const media of manifest.media) urls.set(media.id, `./medios/${media.id}.jpg`);

  render(
    <SkinRenderer
      skin={skin}
      viewport={{ width: 1200, height: 800 }}
      host={{
        manifest,
        mediaUrls: urls,
        device: options.device ?? 'desktop',
        sceneId: options.sceneId === undefined ? SCENE_A : options.sceneId,
        state: options.state ?? EMPTY_SKIN_STATE,
        variables: options.variables ?? {},
        onActions: actions,
        onTab: tabs,
        onCarousel: carousel,
        onSelectScene: scenes,
        progress: options.progress ?? (() => null),
        timerText: (mode, durationS) => (mode === 'countdown' ? `quedan ${durationS} s` : '42 s'),
        scoreLines: (keys) =>
          keys.length === 0 ? [{ label: 'score.total', value: '30' }] : [],
        ...(options.slots !== undefined ? { slots: options.slots } : {}),
      }}
    />,
  );

  return { actions, tabs, carousel, scenes };
}

const clickAction = (): Action =>
  actionSchema.parse({ id: testUuid(90), event: 'click', config: { type: 'stopTour' } });

/* ------------------------------------------------------------------ *
 * Visibilidad
 * ------------------------------------------------------------------ */

describe('visibilidad', () => {
  it('TEST-SKR-001 un componente excluido del dispositivo no se dibuja', () => {
    mount({
      nodes: [
        node({ kind: 'text', template: 'Sólo en escritorio', markdown: false }, {
          visibility: { desktop: false, tablet: true, mobile: true, vr: true },
        }),
      ],
    });

    expect(screen.queryByText('Sólo en escritorio')).not.toBeInTheDocument();
  });

  it('TEST-SKR-002 un componente limitado a otra escena no se dibuja', () => {
    mount({
      nodes: [
        node({ kind: 'text', template: 'Sólo en la plataforma', markdown: false }, {
          sceneIds: [SCENE_B],
        }),
      ],
      sceneId: SCENE_A,
    });

    expect(screen.queryByText('Sólo en la plataforma')).not.toBeInTheDocument();
  });

  it('TEST-SKR-003 sin lista de escenas, aparece en todas', () => {
    // Es lo que espera quien pone una barra de navegación y no quiere
    // repetirla escena por escena.
    mount({ nodes: [node({ kind: 'text', template: 'En todas', markdown: false })] });
    expect(screen.getByText('En todas')).toBeInTheDocument();
  });

  it('TEST-SKR-004 lo que una acción ocultó no se dibuja', () => {
    const state: SkinState = { ...EMPTY_SKIN_STATE, hidden: new Set(['n1']) };
    mount({ nodes: [node({ kind: 'text', template: 'Oculto', markdown: false })], state });

    expect(screen.queryByText('Oculto')).not.toBeInTheDocument();
  });

  it('TEST-SKR-005 lo que nace oculto y una acción mostró sí se dibuja', () => {
    const state: SkinState = { ...EMPTY_SKIN_STATE, shown: new Set(['n1']) };
    mount({
      nodes: [
        node({ kind: 'text', template: 'Mostrado', markdown: false }, { initiallyVisible: false }),
      ],
      state,
    });

    expect(screen.getByText('Mostrado')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Componentes
 * ------------------------------------------------------------------ */

describe('componentes', () => {
  it('TEST-SKR-006 el texto resuelve las variables del recorrido', () => {
    mount({
      nodes: [node({ kind: 'text', template: 'Está en {{scene.title}}', markdown: false })],
      variables: { 'scene.title': 'Sala de bombas' },
    });

    expect(screen.getByText('Está en Sala de bombas')).toBeInTheDocument();
  });

  it('TEST-SKR-007 con formato activado se pinta con elementos, no con marcado', () => {
    mount({
      nodes: [node({ kind: 'text', template: 'Pulse **arranque**', markdown: true })],
    });

    expect(screen.getByText('arranque').tagName).toBe('STRONG');
  });

  it('TEST-SKR-008 el marcado HTML del autor sale como texto', () => {
    mount({
      nodes: [node({ kind: 'text', template: '<b>no</b> es negrita', markdown: true })],
    });

    expect(screen.getByText('<b>no</b> es negrita')).toBeInTheDocument();
    expect(document.querySelector('.skin b')).toBeNull();
  });

  it('TEST-SKR-009 un botón ejecuta sus acciones al pulsarlo', async () => {
    const user = userEvent.setup();
    const { actions } = mount({
      nodes: [
        node({
          kind: 'button',
          label: 'Siguiente',
          icon: '',
          variant: 'primary',
          imageMediaId: null,
          imageHoverMediaId: null,
          tooltip: '',
        }, { actions: [clickAction()] }),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(actions).toHaveBeenCalledTimes(1);
    expect(actions.mock.calls[0]?.[1]).toBe('n1');
  });

  it('TEST-SKR-010 el rótulo del botón admite variables', () => {
    mount({
      nodes: [
        node({
          kind: 'button',
          label: 'Ir a {{scene.title}}',
          icon: '',
          variant: 'secondary',
          imageMediaId: null,
          imageHoverMediaId: null,
          tooltip: '',
        }),
      ],
      variables: { 'scene.title': 'la plataforma' },
    });

    expect(screen.getByRole('button', { name: 'Ir a la plataforma' })).toBeInTheDocument();
  });

  it('TEST-SKR-011 una imagen que falta del paquete se declara', () => {
    // Un hueco haría creer al autor que el componente no está colocado.
    mount({
      nodes: [node({ kind: 'image', mediaId: testUuid(199), fit: 'contain', alt: '' })],
    });

    expect(screen.getByText(/Falta la imagen/)).toBeInTheDocument();
  });

  it('TEST-SKR-012 un menú desplegable ofrece sus opciones y ejecuta la elegida', async () => {
    const user = userEvent.setup();
    const { actions } = mount({
      nodes: [
        node({
          kind: 'dropdown',
          label: 'Zonas',
          items: [
            { id: 'a', label: 'Cota 0', icon: '', actions: [clickAction()] },
            { id: 'b', label: 'Cota 10', icon: '', actions: [] },
          ],
        }),
      ],
    });

    await user.click(screen.getByText('Zonas'));
    await user.click(screen.getByRole('button', { name: 'Cota 0' }));

    expect(actions).toHaveBeenCalledTimes(1);
  });

  it('TEST-SKR-013 las pestañas muestran sólo los hijos de la activa', async () => {
    const user = userEvent.setup();
    const { tabs } = mount({
      nodes: [
        node(
          {
            kind: 'tabs',
            tabs: [
              { id: 'uno', label: 'Uno', icon: '' },
              { id: 'dos', label: 'Dos', icon: '' },
            ],
            activeTabId: null,
          },
          {
            children: [
              node({ kind: 'text', template: 'Contenido uno', markdown: false }, {
                id: 'c1',
                tabId: 'uno',
              }),
              node({ kind: 'text', template: 'Contenido dos', markdown: false }, {
                id: 'c2',
                tabId: 'dos',
              }),
            ],
          },
        ),
      ],
    });

    expect(screen.getByText('Contenido uno')).toBeInTheDocument();
    expect(screen.queryByText('Contenido dos')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Dos' }));
    expect(tabs).toHaveBeenCalledWith('n1', 'dos');
  });

  it('TEST-SKR-014 la pestaña declarada por el autor es la que se abre', () => {
    mount({
      nodes: [
        node(
          {
            kind: 'tabs',
            tabs: [
              { id: 'uno', label: 'Uno', icon: '' },
              { id: 'dos', label: 'Dos', icon: '' },
            ],
            activeTabId: 'dos',
          },
          {
            children: [
              node({ kind: 'text', template: 'Contenido dos', markdown: false }, {
                id: 'c2',
                tabId: 'dos',
              }),
            ],
          },
        ),
      ],
    });

    expect(screen.getByRole('tab', { name: 'Dos', selected: true })).toBeInTheDocument();
    expect(screen.getByText('Contenido dos')).toBeInTheDocument();
  });

  it('TEST-SKR-015 una barra sin nada en curso no se dibuja al cero', () => {
    // Una barra vacía dice «empezado y sin avance», que es distinto de «no
    // empezado».
    mount({
      nodes: [node({ kind: 'progressBar', source: 'tour', scoreKey: '', scoreTarget: null, showLabel: true })],
    });

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('TEST-SKR-016 con avance en curso la barra se dibuja y se anuncia', () => {
    mount({
      nodes: [node({ kind: 'progressBar', source: 'tour', scoreKey: '', scoreTarget: null, showLabel: true })],
      progress: () => 0.4,
    });

    const bar = screen.getByRole('progressbar', { name: 'Componente' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('40 %')).toBeInTheDocument();
  });

  it('TEST-SKR-017 la lista de miniaturas lleva a su escena y marca la actual', async () => {
    const user = userEvent.setup();
    const { scenes } = mount({
      nodes: [
        node({
          kind: 'thumbnailList',
          sceneIds: [],
          orientation: 'horizontal',
          thumbnailSize: 96,
          showTitles: true,
        }),
      ],
      sceneId: SCENE_A,
    });

    const list = screen.getByRole('list');
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-current', 'true');

    await user.click(buttons[1] as HTMLElement);
    expect(scenes).toHaveBeenCalledWith(SCENE_B);
  });

  it('TEST-SKR-018 el carrusel muestra un hijo y permite avanzar', async () => {
    const user = userEvent.setup();
    const { carousel } = mount({
      nodes: [
        node(
          { kind: 'carousel', autoAdvanceMs: 0, loop: true, showArrows: true, showDots: true },
          {
            children: [
              node({ kind: 'text', template: 'Uno', markdown: false }, { id: 'c1' }),
              node({ kind: 'text', template: 'Dos', markdown: false }, { id: 'c2' }),
            ],
          },
        ),
      ],
    });

    expect(screen.getByText('Uno')).toBeInTheDocument();
    expect(screen.queryByText('Dos')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(carousel).toHaveBeenCalledWith('n1', 1);
  });

  it('TEST-SKR-019 el marcador de puntuación muestra las líneas del anfitrión', () => {
    mount({ nodes: [node({ kind: 'scoreBoard', scoreKeys: [], showTime: true })] });

    expect(screen.getByText('score.total')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('TEST-SKR-020 el temporizador muestra lo que calcula el anfitrión', () => {
    mount({ nodes: [node({ kind: 'timer', mode: 'elapsed', durationS: 600, onExpire: [] })] });
    expect(screen.getByText('42 s')).toBeInTheDocument();
  });

  it('TEST-SKR-021 un panel que el visor no monta se declara, no se deja en blanco', () => {
    mount({
      nodes: [
        node({ kind: 'telemetryPanel', mappingIds: [], layout: 'list', showHistory: true, refreshSeconds: 30 }),
      ],
    });

    expect(screen.getByText(/no muestra el panel de instrumentos/)).toBeInTheDocument();
  });

  it('TEST-SKR-022 un panel que el visor sí monta llega por su ranura', () => {
    mount({
      nodes: [node({ kind: 'planView', planId: null, allowFloorSwitch: true, showRadar: true })],
      slots: { planView: () => <p>el plano de verdad</p> },
    });

    expect(screen.getByText('el plano de verdad')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Disposición
 * ------------------------------------------------------------------ */

describe('disposición', () => {
  it('TEST-SKR-023 el modo fijo escala el diseño completo', () => {
    // 1200×800 sobre un diseño de 1920×1080: manda el menor cociente, 0,625,
    // para que la composición entre completa.
    mount({
      nodes: [node({ kind: 'text', template: 'Escalado', markdown: false })],
      layoutMode: 'fixed',
    });

    const canvas = document.querySelector('.skin');
    expect(canvas?.getAttribute('style') ?? '').toContain('scale(0.625)');
  });

  it('TEST-SKR-024 el modo adaptable no escala', () => {
    mount({ nodes: [node({ kind: 'text', template: 'Fluido', markdown: false })] });

    const canvas = document.querySelector('.skin');
    expect(canvas?.getAttribute('style') ?? '').not.toContain('scale(');
  });

  it('TEST-SKR-025 el anclaje del componente se respeta', () => {
    // Abajo a la derecha con desplazamiento (10, 10) queda a diez píxeles del
    // borde, no fuera: 1200 - 200 - 10 = 990.
    mount({
      nodes: [
        node({ kind: 'text', template: 'Esquina', markdown: false }, {
          box: {
            anchor: 'bottomRight',
            offsetX: 10,
            offsetY: 10,
            width: 200,
            height: 40,
            widthPercent: null,
            heightPercent: null,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            gap: 0,
          },
        }),
      ],
    });

    const el = document.querySelector('[data-node="n1"]');
    const style = el?.getAttribute('style') ?? '';
    expect(style).toContain('left: 990px');
    expect(style).toContain('top: 750px');
  });

  it('TEST-SKR-026 los hijos de un contenedor se sitúan dentro de él', () => {
    mount({
      nodes: [
        node(
          { kind: 'container', direction: 'free', justify: 'start', align: 'start', scrollable: false },
          {
            box: {
              anchor: 'topLeft',
              offsetX: 0,
              offsetY: 0,
              width: 400,
              height: 300,
              widthPercent: null,
              heightPercent: null,
              minWidth: 0,
              minHeight: 0,
              padding: 20,
              gap: 0,
            },
            children: [
              node({ kind: 'text', template: 'Dentro', markdown: false }, {
                id: 'c1',
                box: {
                  anchor: 'bottomRight',
                  offsetX: 0,
                  offsetY: 0,
                  width: 100,
                  height: 20,
                  widthPercent: null,
                  heightPercent: null,
                  minWidth: 0,
                  minHeight: 0,
                  padding: 0,
                  gap: 0,
                },
              }),
            ],
          },
        ),
      ],
    });

    // Contenedor de 400×300 con 20 de relleno: el área interior es 360×260, así
    // que el hijo anclado abajo a la derecha queda en (260, 240) y no en la
    // esquina de la ventana.
    const child = document.querySelector('[data-node="c1"]');
    const style = child?.getAttribute('style') ?? '';
    expect(style).toContain('left: 260px');
    expect(style).toContain('top: 240px');
  });
});
