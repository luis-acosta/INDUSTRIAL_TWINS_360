/**
 * Pruebas de la asignación y organización de etiquetas (Y08).
 *
 * Las reglas están probadas en el dominio. Aquí se comprueba lo que sólo falla
 * en la interfaz: que al escribir una etiqueta parecida a otra se avise en vez
 * de crear la duplicada en silencio, y que antes de renombrar sobre una
 * existente se diga que eso funde las dos y cuántos elementos afecta.
 *
 * Ese aviso es el que distingue una herramienta utilizable de una que acumula
 * «crítico», «critico» y «Crítico» hasta que el filtro deja de servir.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import { allTags, type Project } from '@it360/domain';
import { makeHotspot, makeProject, makeScene, testUuid } from '@it360/domain/testing';
import { TagField } from './TagField';
import { TagManager } from './TagManager';

const PROJECT = testUuid(1);

/** Proyecto con etiquetas repartidas entre escenas y marcadores. */
function tagged(): Project {
  const base = makeProject();
  return {
    ...base,
    scenes: [
      makeScene(10, PROJECT, {
        title: 'Nave principal',
        tags: ['planta-baja', 'crítico'],
        hotspots: [makeHotspot(20, testUuid(10), { name: 'Bomba', tags: ['crítico'] })],
      }),
      makeScene(11, PROJECT, { title: 'Sala de bombas', tags: ['planta-baja'] }),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Campo de etiquetas
 * ------------------------------------------------------------------ */

describe('TagField', () => {
  const mount = (
    tags: readonly string[],
    available: readonly string[] = [],
  ): { saved: { tags: readonly string[]; label: string }[] } => {
    const saved: { tags: readonly string[]; label: string }[] = [];
    render(
      <ToastProvider>
        <TagField
          tags={tags}
          available={available}
          onChange={(next, label) => saved.push({ tags: next, label })}
        />
      </ToastProvider>,
    );
    return { saved };
  };

  it('TEST-TGU-001 las etiquetas asignadas se listan', () => {
    mount(['bombas', 'crítico']);
    const list = screen.getByRole('list', { name: 'Etiquetas asignadas' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('TEST-TGU-002 sin etiquetas no se dibuja lista vacía', () => {
    mount([]);
    expect(screen.queryByRole('list', { name: 'Etiquetas asignadas' })).not.toBeInTheDocument();
  });

  it('TEST-TGU-003 se añade con Intro, en forma canónica', async () => {
    const user = userEvent.setup();
    const { saved } = mount([]);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'Zona Norte{Enter}');

    expect(saved.at(-1)?.tags).toEqual(['zona-norte']);
  });

  it('TEST-TGU-004 añadir una que ya está no la duplica', async () => {
    const user = userEvent.setup();
    const { saved } = mount(['crítico']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'CRÍTICO{Enter}');

    expect(saved).toHaveLength(0);
  });

  it('TEST-TGU-005 una etiqueta en blanco no se añade', async () => {
    const user = userEvent.setup();
    const { saved } = mount([]);

    await user.type(screen.getByLabelText('Añadir etiqueta'), '   {Enter}');

    expect(saved).toHaveLength(0);
  });

  it('TEST-TGU-006 avisa de la etiqueta que sólo se diferencia en la tilde', async () => {
    // Es el fallo que hace inútil un filtro por etiquetas: «critico» y
    // «crítico» conviviendo sin que nadie se entere.
    const user = userEvent.setup();
    mount([], ['crítico', 'bombas']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'critico');

    expect(screen.getByText(/¿Se refería a ésa\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'crítico' })).toBeInTheDocument();
  });

  it('TEST-TGU-007 al aceptar el aviso se usa la etiqueta que ya existía', async () => {
    const user = userEvent.setup();
    const { saved } = mount([], ['crítico']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'critico');
    await user.click(screen.getByRole('button', { name: 'crítico' }));

    expect(saved.at(-1)?.tags).toEqual(['crítico']);
  });

  it('TEST-TGU-008 no se funden solas: la duplicada se puede crear si se insiste', async () => {
    // Puede que el autor quiera las dos; deshacer una fusión que nadie pidió
    // cuesta más que confirmarla.
    const user = userEvent.setup();
    const { saved } = mount([], ['crítico']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'critico{Enter}');

    expect(saved.at(-1)?.tags).toEqual(['critico']);
  });

  it('TEST-TGU-009 sugiere las etiquetas del proyecto mientras se escribe', async () => {
    const user = userEvent.setup();
    mount([], ['crítico', 'equipo-critico', 'bombas']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'cri');

    const suggestions = screen.getByRole('list', { name: 'Etiquetas del proyecto' });
    expect(within(suggestions).getAllByRole('listitem')).toHaveLength(2);
  });

  it('TEST-TGU-010 no sugiere las que el elemento ya tiene', async () => {
    const user = userEvent.setup();
    mount(['crítico'], ['crítico', 'equipo-critico']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'cri');

    const suggestions = screen.getByRole('list', { name: 'Etiquetas del proyecto' });
    expect(within(suggestions).getAllByRole('listitem')).toHaveLength(1);
  });

  it('TEST-TGU-011 se quita con su botón', async () => {
    const user = userEvent.setup();
    const { saved } = mount(['bombas', 'crítico']);

    await user.click(screen.getByRole('button', { name: 'Quitar la etiqueta bombas' }));

    expect(saved.at(-1)?.tags).toEqual(['crítico']);
  });

  it('TEST-TGU-012 Retroceso en el campo vacío quita la última', async () => {
    // Es lo que hace cualquier campo de etiquetas y lo que se intenta sin
    // pensar.
    const user = userEvent.setup();
    const { saved } = mount(['bombas', 'crítico']);

    await user.click(screen.getByLabelText('Añadir etiqueta'));
    await user.keyboard('{Backspace}');

    expect(saved.at(-1)?.tags).toEqual(['bombas']);
  });

  it('TEST-TGU-013 Retroceso con texto escrito no quita ninguna', async () => {
    const user = userEvent.setup();
    const { saved } = mount(['bombas']);

    await user.type(screen.getByLabelText('Añadir etiqueta'), 'zo');
    await user.keyboard('{Backspace}');

    expect(saved).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Organizador
 * ------------------------------------------------------------------ */

describe('TagManager', () => {
  const mount = (
    project: Project = tagged(),
  ): { applied: { project: Project; label: string }[] } => {
    const applied: { project: Project; label: string }[] = [];
    render(
      <ToastProvider>
        <TagManager
          open
          project={project}
          onClose={() => undefined}
          onApply={(next, label) => applied.push({ project: next, label })}
        />
      </ToastProvider>,
    );
    return { applied };
  };

  it('TEST-TGU-014 lista las etiquetas con su uso en escenas y marcadores', () => {
    mount();
    const list = screen.getByRole('list', { name: 'Etiquetas del proyecto' });

    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('2 escena(s)')).toBeInTheDocument();
    expect(screen.getByText('1 marcador(es)')).toBeInTheDocument();
  });

  it('TEST-TGU-015 sin etiquetas explica dónde se asignan', () => {
    mount(makeProject());
    expect(screen.getByText('Ninguna etiqueta todavía')).toBeInTheDocument();
    expect(screen.getByText(/se asignan desde la escena o el marcador/)).toBeInTheDocument();
  });

  it('TEST-TGU-016 renombrar dice a cuántos elementos afecta', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('button', { name: 'crítico' }));
    const input = screen.getByLabelText('Nuevo nombre para crítico');
    await user.clear(input);
    await user.type(input, 'prioritario{Enter}');

    expect(screen.getByText(/en 2 elemento\(s\)/)).toBeInTheDocument();
  });

  it('TEST-TGU-017 renombrar sobre una existente avisa de que las funde', async () => {
    // El autor casi siempre quiere eso, pero debe saber que la otra deja de
    // existir.
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('button', { name: 'crítico' }));
    const input = screen.getByLabelText('Nuevo nombre para crítico');
    await user.clear(input);
    await user.type(input, 'planta-baja{Enter}');

    expect(screen.getByText(/quedarán fundidas/)).toBeInTheDocument();
    expect(screen.getByText(/ya existe en 2 elemento\(s\)/)).toBeInTheDocument();
  });

  it('TEST-TGU-018 al confirmar, el renombrado alcanza escenas y marcadores', async () => {
    const user = userEvent.setup();
    const { applied } = mount();

    await user.click(screen.getByRole('button', { name: 'crítico' }));
    const input = screen.getByLabelText('Nuevo nombre para crítico');
    await user.clear(input);
    await user.type(input, 'prioritario{Enter}');
    await user.click(screen.getByRole('button', { name: 'Renombrar' }));

    const result = applied.at(-1)?.project;
    expect(result).toBeDefined();
    if (result !== undefined) {
      expect(allTags(result)).toEqual(['planta-baja', 'prioritario']);
    }
  });

  it('TEST-TGU-019 renombrar a lo mismo no pide confirmación', async () => {
    const user = userEvent.setup();
    const { applied } = mount();

    await user.click(screen.getByRole('button', { name: 'crítico' }));
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
    expect(applied).toHaveLength(0);
  });

  it('TEST-TGU-020 quitar dice de cuántos elementos desaparece', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(
      screen.getByRole('button', { name: 'Quitar la etiqueta crítico de todo el proyecto' }),
    );

    expect(screen.getByText(/desaparecerá de 2 elemento\(s\)/)).toBeInTheDocument();
  });

  it('TEST-TGU-021 al confirmar, la etiqueta desaparece del proyecto', async () => {
    const user = userEvent.setup();
    const { applied } = mount();

    await user.click(
      screen.getByRole('button', { name: 'Quitar la etiqueta crítico de todo el proyecto' }),
    );
    await user.click(screen.getByRole('button', { name: 'Quitar' }));

    const result = applied.at(-1)?.project;
    if (result !== undefined) expect(allTags(result)).toEqual(['planta-baja']);
  });

  it('TEST-TGU-022 fundir aparece al seleccionar dos o más', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta crítico' }));
    expect(screen.queryByRole('button', { name: 'Fundir' })).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta planta-baja' }),
    );
    expect(screen.getByRole('button', { name: 'Fundir' })).toBeInTheDocument();
  });

  it('TEST-TGU-023 fundir dice cuántas y cuántos elementos', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta crítico' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta planta-baja' }),
    );
    await user.click(screen.getByRole('button', { name: 'Fundir' }));

    expect(screen.getByText(/2 etiquetas pasarán a ser/)).toBeInTheDocument();
    expect(screen.getByText(/en 4 elemento\(s\)/)).toBeInTheDocument();
  });

  it('TEST-TGU-024 al confirmar la fusión queda una sola etiqueta', async () => {
    const user = userEvent.setup();
    const { applied } = mount();

    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta crítico' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Seleccionar la etiqueta planta-baja' }),
    );
    await user.type(screen.getByLabelText('Fundir en'), 'zona-proceso');
    await user.click(screen.getByRole('button', { name: 'Fundir' }));
    await user.click(screen.getAllByRole('button', { name: 'Fundir' }).at(-1)!);

    const result = applied.at(-1)?.project;
    if (result !== undefined) expect(allTags(result)).toEqual(['zona-proceso']);
  });
});
