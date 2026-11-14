/**
 * Pruebas del contenido de una ventana de información (E01, F08, F09).
 *
 * La que importa de verdad es TEST-IWB-010: el texto del autor nunca se
 * interpreta como marcado. El recorrido publicado se sirve con un enlace a
 * cualquiera, y un campo del proyecto que llegue a ejecutarse es la vía de
 * inyección más obvia que tiene este producto.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseRichText } from '@it360/domain';
import { InfoWindowBody } from './InfoWindowBody';
import type { ResolvedBlock, ResolvedTab } from './windows';

const text = (raw: string): ResolvedBlock => ({ kind: 'richText', nodes: parseRichText(raw) });

const tab = (title: string, blocks: readonly ResolvedBlock[], id = 'tab-1'): ResolvedTab => ({
  id,
  title,
  blocks,
});

interface MountOptions {
  readonly tabs: readonly ResolvedTab[];
  readonly frameOrigins?: readonly string[];
  readonly telemetryValue?: (mappingId: string) => string | null;
}

function mount(options: MountOptions): { onSceneLink: ReturnType<typeof vi.fn> } {
  const onSceneLink = vi.fn();
  const first = options.tabs[0];

  render(
    <InfoWindowBody
      tabs={options.tabs}
      activeTabId={first?.id ?? ''}
      onTab={() => undefined}
      frameOrigins={options.frameOrigins ?? []}
      onSceneLink={onSceneLink}
      {...(options.telemetryValue !== undefined ? { telemetryValue: options.telemetryValue } : {})}
    />,
  );

  return { onSceneLink };
}

describe('InfoWindowBody', () => {
  it('TEST-IWB-001 con una sola pestaña no se dibuja la barra', () => {
    // Una pestaña única es ruido que roba alto a lo que el visitante vino a
    // leer.
    mount({ tabs: [tab('General', [text('Contenido.')])] });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('Contenido.')).toBeInTheDocument();
  });

  it('TEST-IWB-002 con varias pestañas se ofrecen y se puede cambiar', async () => {
    const user = userEvent.setup();
    const onTab = vi.fn();

    render(
      <InfoWindowBody
        tabs={[
          tab('General', [text('Lo general.')], 'a'),
          tab('Documentos', [text('Los documentos.')], 'b'),
        ]}
        activeTabId="a"
        onTab={onTab}
        frameOrigins={[]}
        onSceneLink={() => undefined}
      />,
    );

    const tablist = screen.getByRole('tablist', { name: 'Secciones' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'General', selected: true })).toBeInTheDocument();
    // Sólo se pinta la pestaña abierta.
    expect(screen.queryByText('Los documentos.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Documentos' }));
    expect(onTab).toHaveBeenCalledWith('b');
  });

  it('TEST-IWB-003 la pestaña abierta se anuncia con su panel', () => {
    // Sin la relación entre pestaña y panel, un lector de pantalla lee la lista
    // de pestañas y luego un texto suelto, sin decir a cuál pertenece.
    mount({ tabs: [tab('General', [text('a')], 'a'), tab('Otra', [text('b')], 'b')] });

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'info-tab-a');
  });

  it('TEST-IWB-004 una pestaña sin bloques lo dice', () => {
    mount({ tabs: [tab('General', [])] });
    expect(screen.getByText('Esta sección no tiene contenido.')).toBeInTheDocument();
  });

  it('TEST-IWB-005 el formato se pinta con elementos de verdad', () => {
    mount({ tabs: [tab('General', [text('Pulse **arranque** y revise `P-101`.')])] });

    expect(screen.getByText('arranque').tagName).toBe('STRONG');
    expect(screen.getByText('P-101').tagName).toBe('CODE');
  });

  it('TEST-IWB-006 las listas se pintan como lista', () => {
    mount({ tabs: [tab('General', [text('- cerrar válvula\n- purgar línea')])] });

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('cerrar válvula');
  });

  it('TEST-IWB-007 un enlace https se abre aparte y sin dejar manipular esta página', () => {
    mount({ tabs: [tab('General', [text('Vea [la norma](https://ejemplo.com/n).')])] });

    const link = screen.getByRole('link', { name: 'la norma' });
    expect(link).toHaveAttribute('href', 'https://ejemplo.com/n');
    expect(link).toHaveAttribute('target', '_blank');
    // Sin `noopener`, la página abierta puede manipular la que la abrió.
    expect(link.getAttribute('rel') ?? '').toContain('noopener');
  });

  it('TEST-IWB-008 un enlace «javascript:» no llega a ser enlace', () => {
    mount({ tabs: [tab('General', [text('[pulse](javascript:alert(1))')])] });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // Queda un paréntesis suelto porque el análisis corta en el primero que
    // cierra; es cosmético y sólo pasa con una entrada hostil. Lo que importa
    // es que no hay enlace y que el texto se ve.
    expect(screen.getByText(/pulse/)).toBeInTheDocument();
  });

  it('TEST-IWB-009 el marcado del autor se ve como texto', () => {
    mount({ tabs: [tab('General', [text('<b>no</b> es negrita')])] });

    expect(screen.getByText('<b>no</b> es negrita')).toBeInTheDocument();
    expect(document.querySelector('.info-window__panel b')).toBeNull();
  });

  it('TEST-IWB-010 un script escrito por el autor no se ejecuta ni se inserta', () => {
    // La prueba que justifica todo el diseño del bloque de texto.
    const spy = vi.fn();
    (globalThis as unknown as { __xss?: () => void }).__xss = spy;

    mount({
      tabs: [
        tab('General', [
          text('<script>window.__xss()</script>'),
          text('<img src=x onerror="window.__xss()">'),
        ]),
      ],
    });

    expect(document.querySelector('.info-window__panel script')).toBeNull();
    expect(document.querySelector('.info-window__panel img')).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    delete (globalThis as unknown as { __xss?: () => void }).__xss;
  });

  it('TEST-IWB-011 una imagen se muestra con su pie', () => {
    mount({
      tabs: [
        tab('General', [
          {
            kind: 'media',
            media: { url: './m/1.jpg', caption: 'bomba.jpg', kind: 'image' },
            caption: 'Vista lateral',
            autoplay: false,
          },
        ]),
      ],
    });

    expect(screen.getByRole('img', { name: 'Vista lateral' })).toBeInTheDocument();
    expect(screen.getByText('Vista lateral')).toBeInTheDocument();
  });

  it('TEST-IWB-012 un documento que no se puede enmarcar ofrece descargarlo', () => {
    // Un recuadro en blanco dentro del recorrido hace creer que algo falló.
    mount({
      tabs: [
        tab('General', [
          {
            kind: 'document',
            title: 'Plano eléctrico.dwg',
            url: './d/1.dwg',
            page: 1,
            embeddable: false,
          },
        ]),
      ],
    });

    expect(screen.getByRole('link', { name: /Descargar Plano eléctrico/ })).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('TEST-IWB-013 un PDF se enmarca en la página que pidió el autor', () => {
    mount({
      tabs: [
        tab('General', [
          { kind: 'document', title: 'Hoja de datos', url: './d/1.pdf', page: 4, embeddable: true },
        ]),
      ],
    });

    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('./d/1.pdf#page=4');
  });

  it('TEST-IWB-014 la ficha del activo muestra TAG, nombre y atributos', () => {
    mount({
      tabs: [
        tab('General', [
          {
            kind: 'asset',
            tag: 'P-101A',
            name: 'Bomba de alimentación',
            className: 'Bomba centrífuga',
            attributes: [{ label: 'Caudal', value: '120 m3/h' }],
          },
        ]),
      ],
    });

    expect(screen.getByText('P-101A')).toBeInTheDocument();
    expect(screen.getByText('Bomba de alimentación')).toBeInTheDocument();
    expect(screen.getByText('Caudal')).toBeInTheDocument();
    expect(screen.getByText('120 m3/h')).toBeInTheDocument();
  });

  it('TEST-IWB-015 un valor de proceso sin dato dice que no hay dato', () => {
    // Un hueco o un cero harían creer al operador que la variable vale eso.
    mount({ tabs: [tab('General', [{ kind: 'telemetry', mappingId: 'm1', label: 'Presión' }])] });

    expect(screen.getByText('Presión')).toBeInTheDocument();
    expect(screen.getByText('sin dato')).toBeInTheDocument();
  });

  it('TEST-IWB-016 con dato se muestra el valor que da el visor', () => {
    mount({
      tabs: [tab('General', [{ kind: 'telemetry', mappingId: 'm1', label: 'Presión' }])],
      telemetryValue: (id) => (id === 'm1' ? '12,40 bar' : null),
    });

    expect(screen.getByText('12,40 bar')).toBeInTheDocument();
  });

  it('TEST-IWB-017 el contenido web declarado se enmarca con permisos mínimos', () => {
    mount({
      tabs: [
        tab('General', [
          { kind: 'webframe', url: 'https://mapa.example.com/x', heightPx: 300, allowFullscreen: false },
        ]),
      ],
      frameOrigins: ['https://mapa.example.com'],
    });

    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('https://mapa.example.com/x');

    // Sin `allow-same-origin`: el marco no debe poder leer nada del recorrido.
    const sandbox = frame?.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).toContain('allow-scripts');
    expect(frame?.getAttribute('referrerPolicy')).toBe('no-referrer');
  });

  it('TEST-IWB-018 el contenido web no declarado se explica y se ofrece aparte', () => {
    // El navegador lo bloquearía en silencio y el visitante vería un hueco.
    mount({
      tabs: [
        tab('General', [
          { kind: 'webframe', url: 'https://otro.example.com/x', heightPx: 300, allowFullscreen: false },
        ]),
      ],
      frameOrigins: ['https://mapa.example.com'],
    });

    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Este contenido no se puede mostrar aquí')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrirla aparte' })).toHaveAttribute(
      'href',
      'https://otro.example.com/x',
    );
  });

  it('TEST-IWB-019 un enlace a escena avisa al visor', async () => {
    const user = userEvent.setup();
    const { onSceneLink } = mount({
      tabs: [
        tab('General', [{ kind: 'sceneLink', sceneId: 's1', label: 'Plataforma superior' }]),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Ir a Plataforma superior' }));
    expect(onSceneLink).toHaveBeenCalledWith('s1');
  });

  it('TEST-IWB-020 un bloque que falta se dice, no se omite', () => {
    mount({
      tabs: [
        tab('General', [
          { kind: 'missing', what: 'un documento que no está en el paquete' },
          text('El resto sigue aquí.'),
        ]),
      ],
    });

    expect(screen.getByText('Falta contenido')).toBeInTheDocument();
    expect(screen.getByText('El resto sigue aquí.')).toBeInTheDocument();
  });
});
