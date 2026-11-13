import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Checkbox, Field, NumberInput, Tab, TabList, TabPanel, Tabs, TextInput } from './primitives';
import { Tree, type TreeNode } from './data';
import { ConfirmDialog, Menu, ToastProvider, useToast } from './overlays';

/**
 * TEST-UI-001 .. TEST-UI-020
 * Requisito: etapa 03, «accesibilidad básica de controles de edición».
 * Lo que se prueba aquí es el comportamiento que un usuario de teclado
 * necesita y que, omitido, no produce ningún error visible.
 */
describe('campo numérico', () => {
  function Harness({ initial = 10 }: { initial?: number }): JSX.Element {
    const [value, setValue] = useState(initial);
    return (
      <>
        <NumberInput value={value} onValueChange={setValue} min={0} max={100} step={1} aria-label="Ángulo" />
        <output data-testid="valor">{value}</output>
      </>
    );
  }

  it('TEST-UI-001: permite escribir estados intermedios sin vaciarse', async () => {
    // Escribir «-» o «0.» es normal a mitad de teclear; convertirlo en NaN
    // borraría el campo bajo los dedos del usuario.
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Ángulo');

    await user.clear(input);
    await user.type(input, '-');
    expect(input).toHaveValue('-');
    await user.type(input, '5');
    expect(input).toHaveValue('-5');
  });

  it('TEST-UI-002: confirma el valor al perder el foco y lo acota al rango', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Ángulo');

    await user.clear(input);
    await user.type(input, '250');
    await user.tab();
    expect(screen.getByTestId('valor')).toHaveTextContent('100');
  });

  it('TEST-UI-003: Escape descarta la edición', async () => {
    const user = userEvent.setup();
    render(<Harness initial={42} />);
    const input = screen.getByLabelText('Ángulo');

    await user.clear(input);
    await user.type(input, '7');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('valor')).toHaveTextContent('42');
  });

  it('TEST-UI-004: las flechas ajustan el valor y Mayús multiplica el paso', async () => {
    const user = userEvent.setup();
    render(<Harness initial={10} />);
    const input = screen.getByLabelText('Ángulo');

    await user.click(input);
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('valor')).toHaveTextContent('11');

    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(screen.getByTestId('valor')).toHaveTextContent('21');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('valor')).toHaveTextContent('20');
  });

  it('TEST-UI-005: acepta la coma decimal', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Ángulo');
    await user.clear(input);
    await user.type(input, '3,5');
    await user.tab();
    expect(screen.getByTestId('valor')).toHaveTextContent('3.5');
  });
});

describe('campo con etiqueta y error', () => {
  it('TEST-UI-006: asocia la etiqueta al control', async () => {
    render(
      <Field label="Título de la escena">
        {({ id }) => <TextInput id={id} defaultValue="Sala de bombas" />}
      </Field>,
    );
    expect(screen.getByLabelText('Título de la escena')).toHaveValue('Sala de bombas');
  });

  it('TEST-UI-007: el error se anuncia y se asocia al control', () => {
    // Un mensaje de error que el lector de pantalla no anuncia es un mensaje
    // que no existe para quien lo necesita.
    render(
      <Field label="TAG" error="El TAG no puede contener espacios">
        {({ id, describedBy, invalid }) => (
          <TextInput id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="P 101" />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('TAG');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('El TAG no puede contener espacios');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('TEST-UI-008: la ayuda se asocia cuando no hay error', () => {
    render(
      <Field label="Inercia" hint="0 detiene la cámara en seco">
        {({ id, describedBy }) => <TextInput id={id} aria-describedby={describedBy} />}
      </Field>,
    );
    const input = screen.getByLabelText('Inercia');
    expect(input.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.getByText('0 detiene la cámara en seco')).toBeInTheDocument();
  });
});

describe('casilla con estado intermedio', () => {
  it('TEST-UI-009: refleja el estado indeterminado en el DOM', () => {
    render(<Checkbox label="Todas las escenas" indeterminate checked={false} readOnly />);
    const input = screen.getByLabelText('Todas las escenas') as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
  });
});

describe('pestañas', () => {
  function Harness(): JSX.Element {
    const [active, setActive] = useState('general');
    return (
      <Tabs value={active} onValueChange={setActive}>
        <TabList label="Propiedades">
          <Tab id="general">General</Tab>
          <Tab id="camara">Cámara</Tab>
          <Tab id="acciones">Acciones</Tab>
        </TabList>
        <TabPanel id="general">Ajustes generales</TabPanel>
        <TabPanel id="camara">Ajustes de cámara</TabPanel>
        <TabPanel id="acciones">Lista de acciones</TabPanel>
      </Tabs>
    );
  }

  it('TEST-UI-010: sólo se muestra el panel activo', () => {
    render(<Harness />);
    expect(screen.getByText('Ajustes generales')).toBeInTheDocument();
    expect(screen.queryByText('Ajustes de cámara')).not.toBeInTheDocument();
  });

  it('TEST-UI-011: las flechas recorren las pestañas', async () => {
    // Sin esto, tabular recorre una a una las pestañas antes de llegar al
    // contenido.
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Cámara' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Ajustes de cámara')).toBeInTheDocument();
  });

  it('TEST-UI-012: las flechas dan la vuelta en los extremos', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Acciones' })).toHaveAttribute('aria-selected', 'true');
  });

  it('TEST-UI-013: sólo la pestaña activa es tabulable', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Cámara' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('árbol', () => {
  const nodes: readonly TreeNode[] = [
    {
      id: 'planta',
      label: 'Planta Norte',
      children: [
        { id: 'u200', label: 'Unidad 200', children: [{ id: 'p101', label: 'P-101A' }] },
        { id: 'u300', label: 'Unidad 300' },
      ],
    },
  ];

  function Harness(): JSX.Element {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['planta']));
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <Tree
        nodes={nodes}
        selectedId={selected}
        onSelect={setSelected}
        expandedIds={expanded}
        onToggle={(id) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        label="Catálogo"
      />
    );
  }

  it('TEST-UI-014: sólo muestra los hijos de los nodos expandidos', () => {
    render(<Harness />);
    expect(screen.getByText('Unidad 200')).toBeInTheDocument();
    expect(screen.queryByText('P-101A')).not.toBeInTheDocument();
  });

  it('TEST-UI-015: la flecha derecha expande y luego desciende', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const unit = screen.getByText('Unidad 200').closest('[role="treeitem"]');
    expect(unit).not.toBeNull();
    if (unit === null) return;

    (unit as HTMLElement).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('P-101A')).toBeInTheDocument();
    expect(unit).toHaveAttribute('aria-expanded', 'true');
  });

  it('TEST-UI-016: la flecha izquierda contrae y luego sube al padre', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const root = screen.getByText('Planta Norte').closest('[role="treeitem"]') as HTMLElement;
    root.focus();
    await user.keyboard('{ArrowLeft}');
    expect(root).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Unidad 200')).not.toBeInTheDocument();
  });

  it('TEST-UI-017: declara el nivel de cada nodo', () => {
    render(<Harness />);
    expect(screen.getByText('Planta Norte').closest('[role="treeitem"]')).toHaveAttribute('aria-level', '1');
    expect(screen.getByText('Unidad 200').closest('[role="treeitem"]')).toHaveAttribute('aria-level', '2');
  });
});

describe('diálogo de confirmación', () => {
  it('TEST-UI-018: el foco inicial NO está en el botón destructivo', async () => {
    // Pulsar Intro por inercia tras abrir un diálogo es demasiado frecuente
    // como para que acabe borrando una escena.
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="Eliminar escena"
        message="Se eliminará la escena y sus marcadores."
        confirmLabel="Eliminar"
        destructive
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('TEST-UI-019: Escape cancela', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog open onCancel={onCancel} onConfirm={vi.fn()} title="Eliminar" message="¿Seguro?" />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('TEST-UI-020: el diálogo declara su título a la tecnología asistiva', () => {
    render(<ConfirmDialog open onCancel={vi.fn()} onConfirm={vi.fn()} title="Eliminar escena" message="x" />);
    expect(screen.getByRole('dialog', { name: 'Eliminar escena' })).toBeInTheDocument();
  });
});

describe('menú', () => {
  it('TEST-UI-021: se abre y ejecuta la opción elegida con teclado', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <Menu
        label="Acciones de escena"
        trigger={(props) => (
          <button type="button" {...props}>
            Acciones
          </button>
        )}
        items={[
          { id: 'duplicate', label: 'Duplicar', onSelect },
          { id: 'delete', label: 'Eliminar', destructive: true, separatorBefore: true },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Acciones' }));
    expect(screen.getByRole('menu', { name: 'Acciones de escena' })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('TEST-UI-022: salta las opciones deshabilitadas al navegar', async () => {
    const onThird = vi.fn();
    const user = userEvent.setup();
    render(
      <Menu
        label="Menú"
        trigger={(props) => (
          <button type="button" {...props}>
            Abrir
          </button>
        )}
        items={[
          { id: 'a', label: 'Primera' },
          { id: 'b', label: 'Deshabilitada', disabled: true },
          { id: 'c', label: 'Tercera', onSelect: onThird },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onThird).toHaveBeenCalledTimes(1);
  });
});

describe('avisos', () => {
  function Harness(): JSX.Element {
    const { push } = useToast();
    return (
      <>
        <button type="button" onClick={() => push({ tone: 'alarm', title: 'No se pudo guardar' })}>
          Fallar
        </button>
        <button type="button" onClick={() => push({ tone: 'nominal', title: 'Guardado' })}>
          Guardar
        </button>
      </>
    );
  }

  it('TEST-UI-023: un error se anuncia como alerta', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Fallar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo guardar');
  });

  it('TEST-UI-024: un aviso correcto se anuncia sin interrumpir', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(screen.getByRole('status')).toHaveTextContent('Guardado');
  });

  it('TEST-UI-025: los errores no desaparecen solos', async () => {
    // Un aviso de «no se pudo guardar» que se esfuma a los cuatro segundos es
    // peor que no mostrarlo: el usuario cree que guardó.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Fallar' }));
      await user.click(screen.getByRole('button', { name: 'Guardar' }));

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByRole('alert')).toHaveTextContent('No se pudo guardar');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
