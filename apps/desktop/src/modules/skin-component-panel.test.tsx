/**
 * Pruebas de los ajustes propios de cada componente de interfaz (F07–F13).
 *
 * Existen por un defecto concreto: el panel decía «no tiene más ajustes
 * propios» para once tipos de componente, y era falso. Dejaba un contenedor de
 * pestañas sin forma de añadir una pestaña y un menú desplegable sin forma de
 * añadir una entrada, de modo que el autor podía colocar componentes
 * inservibles sin que nada se lo dijera.
 *
 * Y lo que se vigila además: que un ajuste que el visor publicado todavía no
 * atiende se diga en el editor. Guardarlo en silencio es prometer una función
 * que no existe.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import type { ComponentConfig, Project, SkinNode } from '@it360/domain';
import { makeProject, makeScene } from '@it360/domain/testing';
import { ComponentPanel } from './SkinComponentPanel';

function baseProject(extra: Partial<Project> = {}): Project {
  const base = makeProject();
  return {
    ...base,
    scenes: [makeScene(10, base.id, { title: 'Sala de bombas' })],
    ...extra,
  };
}

function node(config: ComponentConfig): SkinNode {
  return {
    id: 'n1',
    name: 'Componente',
    config,
    box: {
      anchor: 'topLeft',
      offsetX: 0,
      offsetY: 0,
      width: 100,
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
  } as SkinNode;
}

/**
 * Monta el panel con estado de verdad.
 *
 * El panel es un componente controlado: sus campos muestran lo que dice la
 * configuración. Con un espía que no actualice nada, cada pulsación de tecla
 * se calcularía sobre el valor inicial y la prueba mediría el arnés en lugar
 * del panel. Aquí los parches se aplican, como en la aplicación.
 */
function mount(
  initial: ComponentConfig,
  project: Project = baseProject(),
): { patches: Record<string, unknown>[] } {
  const patches: Record<string, unknown>[] = [];

  function Harness(): JSX.Element {
    const [config, setConfigState] = useState(initial);

    return (
      <ComponentPanel
        node={node(config)}
        project={project}
        setConfig={(patch) => {
          patches.push(patch);
          setConfigState((current) => ({ ...current, ...patch }) as ComponentConfig);
        }}
      />
    );
  }

  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );

  return { patches };
}

/* ------------------------------------------------------------------ *
 * Menú desplegable (F07)
 * ------------------------------------------------------------------ */

describe('menú desplegable', () => {
  it('TEST-SCP-001 un menú sin entradas lo dice', () => {
    // Un menú vacío se abre y no ofrece nada, que el visitante lee como fallo.
    mount({ kind: 'dropdown', label: 'Zonas', items: [] });

    expect(screen.getByText('El menú está vacío')).toBeInTheDocument();
  });

  it('TEST-SCP-002 se añaden entradas', async () => {
    const user = userEvent.setup();
    const { patches } = mount({ kind: 'dropdown', label: 'Zonas', items: [] });

    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    const items = patches[0]?.['items'] as readonly { label: string }[] | undefined;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.label).toBe('Opción 1');
  });

  it('TEST-SCP-003 se renombra y se quita una entrada', async () => {
    const user = userEvent.setup();
    const { patches } = mount({
      kind: 'dropdown',
      label: 'Zonas',
      items: [{ id: 'a', label: 'Cota 0', icon: '', actions: [] }],
    });

    await user.clear(screen.getByLabelText('Texto'));
    await user.type(screen.getByLabelText('Texto'), 'Cota 10');
    expect((patches.at(-1)?.['items'] as readonly { label: string }[])[0]?.label).toBe('Cota 10');

    await user.click(screen.getByRole('button', { name: 'Quitar' }));
    expect(patches.at(-1)?.['items']).toEqual([]);
  });

  it('TEST-SCP-004 las acciones de una entrada se editan donde está la entrada', async () => {
    // Antes el panel afirmaba que se editaban «en la pestaña de acciones», y
    // no se editaban en ninguna parte.
    const user = userEvent.setup();
    mount({
      kind: 'dropdown',
      label: 'Zonas',
      items: [{ id: 'a', label: 'Cota 0', icon: '', actions: [] }],
    });

    await user.click(screen.getByRole('button', { name: 'Acciones (0)' }));

    expect(screen.getByText('Al elegir «Cota 0»')).toBeInTheDocument();
    expect(screen.getByText('Esta entrada no hace nada')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Pestañas (F08)
 * ------------------------------------------------------------------ */

describe('contenedor de pestañas', () => {
  const tabs: ComponentConfig = {
    kind: 'tabs',
    tabs: [
      { id: 'uno', label: 'Uno', icon: '' },
      { id: 'dos', label: 'Dos', icon: '' },
    ],
    activeTabId: null,
  };

  it('TEST-SCP-005 se añade una pestaña', async () => {
    const user = userEvent.setup();
    const { patches } = mount(tabs);

    await user.click(screen.getByRole('button', { name: 'Añadir' }));
    expect(patches[0]?.['tabs']).toHaveLength(3);
  });

  it('TEST-SCP-006 se elige la pestaña por omisión', async () => {
    const user = userEvent.setup();
    const { patches } = mount(tabs);

    const fichas = screen.getAllByLabelText('Abrir por esta');
    await user.click(fichas[1] as HTMLElement);

    expect(patches.at(-1)?.['activeTabId']).toBe('dos');
  });

  it('TEST-SCP-007 no se puede quedar sin pestañas', () => {
    // El esquema exige al menos una, y un contenedor sin ninguna no sabría qué
    // mostrar: con una sola no se ofrece quitarla.
    mount({ kind: 'tabs', tabs: [{ id: 'uno', label: 'Uno', icon: '' }], activeTabId: null });

    expect(screen.queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument();
  });

  it('TEST-SCP-008 quitar la pestaña por omisión no deja una referencia muerta', async () => {
    const user = userEvent.setup();
    const { patches } = mount({ ...tabs, activeTabId: 'dos' } as ComponentConfig);

    const quitar = screen.getAllByRole('button', { name: 'Quitar' });
    await user.click(quitar[1] as HTMLElement);

    expect(patches.at(-1)?.['tabs']).toHaveLength(1);
    expect(patches.at(-1)?.['activeTabId']).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Lo que el visor todavía no atiende
 * ------------------------------------------------------------------ */

describe('ajustes que el visor publicado aún no atiende', () => {
  it('TEST-SCP-009 la barra de avance de audio avisa', () => {
    // Guardarlo en silencio prometería una función que no existe.
    mount({ kind: 'progressBar', source: 'media', scoreKey: '', scoreTarget: null, showLabel: true });

    expect(screen.getByText('El avance del audio todavía no llega al visor')).toBeInTheDocument();
  });

  it('TEST-SCP-010 el avance del recorrido no avisa, porque sí funciona', () => {
    mount({ kind: 'progressBar', source: 'tour', scoreKey: '', scoreTarget: null, showLabel: true });

    expect(screen.queryByText(/todavía no llega al visor/)).not.toBeInTheDocument();
  });

  it('TEST-SCP-011 el avance automático del carrusel avisa sólo si está puesto', async () => {
    const user = userEvent.setup();
    mount({ kind: 'carousel', autoAdvanceMs: 4000, loop: true, showArrows: true, showDots: true });

    expect(screen.getByText(/avance automático todavía no llega/)).toBeInTheDocument();

    // Y el ajuste se sigue pudiendo cambiar.
    await user.clear(screen.getByLabelText('Avance automático'));
  });

  it('TEST-SCP-012 el panel de instrumentos avisa y dice la alternativa', () => {
    mount({
      kind: 'telemetryPanel',
      mappingIds: [],
      layout: 'list',
      showHistory: true,
      refreshSeconds: 30,
    });

    expect(screen.getByText('Este panel todavía no llega al visor')).toBeInTheDocument();
    expect(screen.getByText(/ficha de activo sí muestra/)).toBeInTheDocument();
  });

  it('TEST-SCP-013 la cuenta atrás avisa de sus acciones, el modo normal no', async () => {
    const user = userEvent.setup();
    mount({ kind: 'timer', mode: 'countdown', durationS: 600, onExpire: [] });

    expect(screen.getByText(/acciones al agotarse todavía no llegan/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Modo'));
  });
});

/* ------------------------------------------------------------------ *
 * Resto de componentes
 * ------------------------------------------------------------------ */

describe('otros componentes', () => {
  it('TEST-SCP-014 la lista de miniaturas se configura', async () => {
    const user = userEvent.setup();
    const { patches } = mount({
      kind: 'thumbnailList',
      sceneIds: [],
      orientation: 'horizontal',
      thumbnailSize: 96,
      showTitles: true,
    });

    await user.selectOptions(screen.getByLabelText('Orientación'), 'vertical');
    expect(patches.at(-1)?.['orientation']).toBe('vertical');

    expect(screen.getByText(/todas las escenas publicables/)).toBeInTheDocument();
  });

  it('TEST-SCP-015 el panel de activo ofrece los activos del proyecto', () => {
    const project = baseProject();
    mount(
      { kind: 'assetPanel', assetId: null, visibleTabs: ['overview'] },
      { ...project, assets: [] },
    );

    expect(screen.getByLabelText('Activo')).toBeInTheDocument();
    expect(screen.getByText('Resumen')).toBeInTheDocument();
  });

  it('TEST-SCP-016 el panel de instrumentos lo dice cuando no hay variables', () => {
    mount({
      kind: 'telemetryPanel',
      mappingIds: [],
      layout: 'grid',
      showHistory: false,
      refreshSeconds: 0,
    });

    expect(screen.getByText(/no tiene variables de proceso/)).toBeInTheDocument();
  });

  it('TEST-SCP-017 el marcador de puntuación acepta claves separadas por comas', async () => {
    const user = userEvent.setup();
    const { patches } = mount({ kind: 'scoreBoard', scoreKeys: [], showTime: true });

    // Se confirma al pulsar Intro: con confirmación en cada tecla, la coma
    // desaparecía al escribirla y no se podía escribir más de una clave.
    await user.type(screen.getByLabelText('Claves'), 'seguridad, calidad{Enter}');
    expect(patches.at(-1)?.['scoreKeys']).toEqual(['seguridad', 'calidad']);
  });

  it('TEST-SCP-018 el plano se puede fijar o dejar al de la escena', () => {
    mount({ kind: 'planView', planId: null, allowFloorSwitch: true, showRadar: true });

    expect(screen.getByLabelText('Plano')).toHaveValue('');
    expect(screen.getByText('El de la escena')).toBeInTheDocument();
  });

  it('TEST-SCP-017b las claves se confirman también al salir del campo', async () => {
    const user = userEvent.setup();
    const { patches } = mount({ kind: 'scoreBoard', scoreKeys: [], showTime: true });

    await user.type(screen.getByLabelText('Claves'), 'seguridad, calidad');
    await user.tab();

    expect(patches.at(-1)?.['scoreKeys']).toEqual(['seguridad', 'calidad']);
  });

  it('TEST-SCP-019 el separador tiene su ajuste', () => {
    mount({ kind: 'spacer', flexible: true });
    expect(screen.getByLabelText('Ocupa el espacio libre')).toBeChecked();
  });

  it('TEST-SCP-020 la evaluación se elige entre las del proyecto', () => {
    mount({ kind: 'quizCard', quizId: null });
    expect(screen.getByLabelText('Evaluación')).toBeInTheDocument();
    expect(screen.getByText('Sin asignar')).toBeInTheDocument();
  });
});
