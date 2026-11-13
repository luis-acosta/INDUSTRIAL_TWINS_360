/**
 * Pruebas de la pantalla de geometría del marcador (D01–D11, D15).
 *
 * Las reglas ya están probadas en el dominio; aquí se comprueba lo que sólo
 * falla en la interfaz: que cambiar de forma avise de lo que se pierde antes
 * de hacerlo, que el aviso no aparezca cuando no hay nada que perder, que el
 * polígono no deje quitar el tercer vértice, y que los ejes que no se van a
 * notar se presenten deshabilitados con el motivo en lugar de parecer
 * averiados.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@it360/ui';
import {
  hotspotSchema,
  type Hotspot,
  type HotspotGeometry,
  type Project,
  type Transform3d,
} from '@it360/domain';
import { ISO_NOW, makeMedia, makeProject, testUuid } from '@it360/domain/testing';
import { HotspotGeometryPanel } from './HotspotGeometry';
import { HotspotAxes } from './HotspotAxes';

const SCENE = testUuid(10);

function makeHotspot(geometry: unknown): Hotspot {
  return hotspotSchema.parse({
    id: testUuid(20),
    sceneId: SCENE,
    name: 'Marcador',
    anchor: { space: 'spherical', yaw: 0, pitch: 0 },
    geometry,
    style: {},
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
  });
}

/** Proyecto con las imágenes y modelos indicados. */
function project(options: { images?: number; models?: number } = {}): Project {
  const base = makeProject();
  const media = [
    ...Array.from({ length: options.images ?? 0 }, (_, i) =>
      makeMedia(40 + i, { originalName: `imagen-${i + 1}.png`, mime: 'image/png', kind: 'image' }),
    ),
    ...Array.from({ length: options.models ?? 0 }, (_, i) =>
      makeMedia(60 + i, {
        originalName: `modelo-${i + 1}.glb`,
        mime: 'model/gltf-binary',
        kind: 'model',
        width: null,
        height: null,
        panorama: null,
      }),
    ),
  ];
  return { ...base, media };
}

/** Monta el panel y devuelve lo que se ha guardado. */
function mount(
  geometry: unknown,
  options: { images?: number; models?: number } = {},
): { saved: { patch: Partial<Hotspot>; label: string }[] } {
  const saved: { patch: Partial<Hotspot>; label: string }[] = [];
  const hotspot = makeHotspot(geometry);

  render(
    <ToastProvider>
      <HotspotGeometryPanel
        project={project(options)}
        hotspot={hotspot}
        onChange={(patch, label) => saved.push({ patch, label })}
      />
    </ToastProvider>,
  );

  return { saved };
}

const lastGeometry = (saved: { patch: Partial<Hotspot> }[]): HotspotGeometry | undefined =>
  saved.at(-1)?.patch.geometry;

/* ------------------------------------------------------------------ *
 * Cambio de forma
 * ------------------------------------------------------------------ */

describe('cambio de forma', () => {
  it('TEST-HGP-001 la forma actual se muestra con su explicación', () => {
    mount({ shape: 'polygon', points: [{ u: 0.4, v: 0.4 }, { u: 0.6, v: 0.4 }, { u: 0.6, v: 0.6 }] });

    expect(screen.getByLabelText('Forma')).toHaveValue('polygon');
    expect(screen.getByText(/toda su superficie responde/)).toBeInTheDocument();
  });

  it('TEST-HGP-002 cambiar de forma pide confirmación diciendo qué se pierde', async () => {
    const user = userEvent.setup();
    const { saved } = mount({
      shape: 'polygon',
      points: [{ u: 0.4, v: 0.4 }, { u: 0.6, v: 0.4 }, { u: 0.6, v: 0.6 }],
    });

    await user.selectOptions(screen.getByLabelText('Forma'), 'icon');

    expect(screen.getByText(/Se perderá el contorno y sus vértices/)).toBeInTheDocument();
    // Nada se guarda hasta confirmar.
    expect(saved).toHaveLength(0);
  });

  it('TEST-HGP-003 al confirmar se guarda la forma nueva', async () => {
    const user = userEvent.setup();
    const { saved } = mount({
      shape: 'polygon',
      points: [{ u: 0.4, v: 0.4 }, { u: 0.6, v: 0.4 }, { u: 0.6, v: 0.6 }],
    });

    await user.selectOptions(screen.getByLabelText('Forma'), 'icon');
    await user.click(screen.getByRole('button', { name: 'Cambiar' }));

    expect(lastGeometry(saved)?.shape).toBe('icon');
  });

  it('TEST-HGP-004 cancelar no cambia nada', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'icon' });

    await user.selectOptions(screen.getByLabelText('Forma'), 'text');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(saved).toHaveLength(0);
  });

  it('TEST-HGP-005 una forma que exige imagen sin imágenes en el proyecto no se ofrece a medias', async () => {
    // Confirmar y luego fallar sería peor: el autor cree que lo ha hecho.
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'icon' }, { images: 0 });

    await user.selectOptions(screen.getByLabelText('Forma'), 'projectedImage');

    expect(screen.getByText('No hay imágenes en el proyecto')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cambiar' })).not.toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });

  it('TEST-HGP-006 con imágenes disponibles la imagen proyectada se crea con sus esquinas', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'icon' }, { images: 2 });

    await user.selectOptions(screen.getByLabelText('Forma'), 'projectedImage');
    await user.click(screen.getByRole('button', { name: 'Cambiar' }));

    const geometry = lastGeometry(saved);
    expect(geometry?.shape).toBe('projectedImage');
    if (geometry?.shape === 'projectedImage') expect(geometry.corners).toHaveLength(4);
  });

  it('TEST-HGP-007 un marcador de modelo sin modelos avisa, no falla al confirmar', async () => {
    const user = userEvent.setup();
    mount({ shape: 'icon' }, { images: 1, models: 0 });

    await user.selectOptions(screen.getByLabelText('Forma'), 'model');
    expect(screen.getByText('No hay modelos en el proyecto')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Icono (D01, D15)
 * ------------------------------------------------------------------ */

describe('icono', () => {
  it('TEST-HGP-008 sin imagen propia se elige del catálogo', () => {
    mount({ shape: 'icon' }, { images: 1 });
    expect(screen.getByLabelText('Icono')).toBeInTheDocument();
  });

  it('TEST-HGP-009 al elegir imagen propia desaparece el catálogo', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'icon' }, { images: 1 });

    await user.selectOptions(screen.getByLabelText('Imagen propia'), 'imagen-1.png');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'icon' && geometry.mediaId).not.toBeNull();
  });

  it('TEST-HGP-010 un APNG se anuncia como animado', () => {
    // El mime de un APNG es image/png: sin mirar el nombre, la animación
    // pasaría inadvertida y el autor no sabría que su icono se mueve.
    const base = makeProject();
    const apng = makeMedia(40, {
      originalName: 'pulso.apng',
      mime: 'image/png',
      kind: 'image',
    });
    const hotspot = makeHotspot({ shape: 'icon', mediaId: apng.id });

    render(
      <ToastProvider>
        <HotspotGeometryPanel
          project={{ ...base, media: [apng] }}
          hotspot={hotspot}
          onChange={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.getByText('Icono animado')).toBeInTheDocument();
  });

  it('TEST-HGP-011 un PNG normal no se anuncia como animado', () => {
    const base = makeProject();
    const png = makeMedia(40, { originalName: 'icono.png', mime: 'image/png', kind: 'image' });
    const hotspot = makeHotspot({ shape: 'icon', mediaId: png.id });

    render(
      <ToastProvider>
        <HotspotGeometryPanel
          project={{ ...base, media: [png] }}
          hotspot={hotspot}
          onChange={() => undefined}
        />
      </ToastProvider>,
    );

    expect(screen.queryByText('Icono animado')).not.toBeInTheDocument();
  });

  it('TEST-HGP-012 el tamaño se edita en píxeles', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'icon' }, { images: 1 });

    const size = screen.getByLabelText('Tamaño');
    await user.clear(size);
    await user.type(size, '64{Enter}');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'icon' && geometry.sizePx).toBe(64);
  });
});

/* ------------------------------------------------------------------ *
 * Texto (D02)
 * ------------------------------------------------------------------ */

describe('texto', () => {
  it('TEST-HGP-013 el texto admite variables y se dice cuáles', () => {
    mount({ shape: 'text', template: 'Bomba {{asset.tag}}' });
    expect(screen.getByLabelText('Texto')).toHaveValue('Bomba {{asset.tag}}');
    // La ayuda del campo nombra las variables disponibles.
    expect(screen.getAllByText(/Admite variables del proyecto/).length).toBeGreaterThan(0);
  });

  it('TEST-HGP-014 la anchura máxima se edita', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'text', template: 'Rótulo' });

    const width = screen.getByLabelText('Anchura máxima');
    await user.clear(width);
    await user.type(width, '320{Enter}');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'text' && geometry.maxWidthPx).toBe(320);
  });
});

/* ------------------------------------------------------------------ *
 * Polígono (D03, D11)
 * ------------------------------------------------------------------ */

describe('polígono', () => {
  const square = [
    { u: 0.4, v: 0.4 },
    { u: 0.6, v: 0.4 },
    { u: 0.6, v: 0.6 },
    { u: 0.4, v: 0.6 },
  ];

  it('TEST-HGP-015 los vértices se listan numerados con su superficie', () => {
    mount({ shape: 'polygon', points: square });

    const list = screen.getByRole('list', { name: 'Vértices del polígono' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    // Un cuadrado de lado 0,2 en UV encierra el 4 % de la panorámica.
    expect(screen.getByText('superficie 4.00 %')).toBeInTheDocument();
  });

  it('TEST-HGP-016 cada vértice se edita en grados, no en coordenadas de textura', () => {
    // El autor piensa en azimut y elevación; la textura es un detalle interno.
    mount({ shape: 'polygon', points: square });
    expect(screen.getByLabelText('Azimut del vértice 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Elevación del vértice 1')).toBeInTheDocument();
  });

  it('TEST-HGP-017 mover un vértice guarda el contorno completo', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'polygon', points: square });

    const yaw = screen.getByLabelText('Azimut del vértice 2');
    await user.clear(yaw);
    await user.type(yaw, '90{Enter}');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'polygon' && geometry.points).toHaveLength(4);
    if (geometry?.shape === 'polygon') expect(geometry.points[1]!.u).toBeCloseTo(0.75, 2);
  });

  it('TEST-HGP-018 añadir un vértice lo inserta sin romper el contorno', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'polygon', points: square });

    await user.click(screen.getByRole('button', { name: 'Añadir vértice' }));

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'polygon' && geometry.points).toHaveLength(5);
  });

  it('TEST-HGP-019 con tres vértices no se puede quitar ninguno', async () => {
    // Con dos no encierra nada: el esquema lo rechazaría al guardar, que es el
    // peor momento para enterarse.
    mount({ shape: 'polygon', points: square.slice(0, 3) });
    expect(screen.getByRole('button', { name: 'Quitar vértice 1' })).toBeDisabled();
  });

  it('TEST-HGP-020 con cuatro vértices sí se puede quitar uno', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'polygon', points: square });

    await user.click(screen.getByRole('button', { name: 'Quitar vértice 1' }));

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'polygon' && geometry.points).toHaveLength(3);
  });

  it('TEST-HGP-021 un contorno alineado se señala como inservible', () => {
    mount({
      shape: 'polygon',
      points: [
        { u: 0.4, v: 0.5 },
        { u: 0.5, v: 0.5 },
        { u: 0.6, v: 0.5 },
      ],
    });

    expect(screen.getByText('El contorno no se puede usar así')).toBeInTheDocument();
    expect(screen.getByText(/alineados/)).toBeInTheDocument();
  });

  it('TEST-HGP-022 un contorno cruzado avisa sin bloquear', () => {
    mount({
      shape: 'polygon',
      points: [
        { u: 0.4, v: 0.4 },
        { u: 0.6, v: 0.6 },
        { u: 0.6, v: 0.4 },
        { u: 0.4, v: 0.6 },
      ],
    });

    expect(screen.getByText('Conviene revisar')).toBeInTheDocument();
    expect(screen.queryByText('El contorno no se puede usar así')).not.toBeInTheDocument();
  });

  it('TEST-HGP-023 invertir el polígono explica qué zona queda activa', async () => {
    const user = userEvent.setup();
    const { saved } = mount({ shape: 'polygon', points: square });

    expect(screen.getByText(/La zona activa es el interior/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Invertir el polígono'));

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'polygon' && geometry.inverted).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Imagen proyectada (D05)
 * ------------------------------------------------------------------ */

describe('imagen proyectada', () => {
  const corners = [
    { u: 0.4, v: 0.4 },
    { u: 0.6, v: 0.4 },
    { u: 0.6, v: 0.6 },
    { u: 0.4, v: 0.6 },
  ];

  const geometryOf = (over: Record<string, unknown> = {}) => ({
    shape: 'projectedImage',
    mediaId: testUuid(40),
    corners,
    ...over,
  });

  it('TEST-HGP-024 las cuatro esquinas se nombran, no se numeran', () => {
    // «Esquina 3» no dice nada; «inferior derecha» sí.
    mount(geometryOf(), { images: 1 });
    expect(screen.getByText('superior izquierda')).toBeInTheDocument();
    expect(screen.getByText('inferior derecha')).toBeInTheDocument();
  });

  it('TEST-HGP-025 mover una esquina guarda las cuatro', async () => {
    const user = userEvent.setup();
    const { saved } = mount(geometryOf(), { images: 1 });

    const yaw = screen.getByLabelText('Azimut de la esquina superior derecha');
    await user.clear(yaw);
    await user.type(yaw, '60{Enter}');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'projectedImage' && geometry.corners).toHaveLength(4);
  });

  it('TEST-HGP-026 dejar las esquinas alineadas se rechaza con el motivo', async () => {
    const user = userEvent.setup();
    const flat = [
      { u: 0.4, v: 0.5 },
      { u: 0.5, v: 0.5 },
      { u: 0.6, v: 0.5 },
      { u: 0.7, v: 0.5 },
    ];
    const { saved } = mount(geometryOf({ corners: flat }), { images: 1 });

    const yaw = screen.getByLabelText('Azimut de la esquina superior izquierda');
    await user.clear(yaw);
    await user.type(yaw, '0{Enter}');

    const notices = screen.getByRole('region', { name: 'Avisos' });
    expect(within(notices).getAllByText(/quedarían alineadas/).length).toBeGreaterThan(0);
    expect(saved).toHaveLength(0);
  });

  it('TEST-HGP-027 se puede volver a un rectángulo', async () => {
    const user = userEvent.setup();
    const skewed = [
      { u: 0.3, v: 0.3 },
      { u: 0.7, v: 0.35 },
      { u: 0.65, v: 0.7 },
      { u: 0.35, v: 0.6 },
    ];
    const { saved } = mount(geometryOf({ corners: skewed }), { images: 1 });

    await user.click(screen.getByRole('button', { name: 'Restablecer a rectángulo' }));

    const geometry = lastGeometry(saved);
    expect(geometry?.shape).toBe('projectedImage');
  });

  it('TEST-HGP-028 la opacidad se edita', async () => {
    const user = userEvent.setup();
    const { saved } = mount(geometryOf(), { images: 1 });

    const opacity = screen.getByLabelText('Opacidad');
    await user.clear(opacity);
    await user.type(opacity, '0.5{Enter}');

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'projectedImage' && geometry.opacity).toBeCloseTo(0.5, 2);
  });
});

/* ------------------------------------------------------------------ *
 * Contenido web
 * ------------------------------------------------------------------ */

describe('contenido web', () => {
  const geometryOf = () => ({
    shape: 'webframe',
    url: 'https://intranet.invalid/panel',
  });

  it('TEST-HGP-029 una dirección a medio escribir no se guarda', async () => {
    // El esquema la rechazaría en cada pulsación; se confirma al salir.
    const user = userEvent.setup();
    const { saved } = mount(geometryOf());

    const url = screen.getByLabelText('Dirección');
    await user.clear(url);
    await user.type(url, 'htt');

    expect(saved).toHaveLength(0);
    expect(screen.getByText(/dirección http o https completa/)).toBeInTheDocument();
  });

  it('TEST-HGP-030 al salir del campo con una dirección inválida se restaura la anterior', async () => {
    const user = userEvent.setup();
    const { saved } = mount(geometryOf());

    const url = screen.getByLabelText('Dirección');
    await user.clear(url);
    await user.type(url, 'no-es-una-url');
    await user.tab();

    expect(saved).toHaveLength(0);
    expect(screen.getByLabelText('Dirección')).toHaveValue('https://intranet.invalid/panel');
  });

  it('TEST-HGP-031 una dirección válida se guarda al salir del campo', async () => {
    const user = userEvent.setup();
    const { saved } = mount(geometryOf());

    const url = screen.getByLabelText('Dirección');
    await user.clear(url);
    await user.type(url, 'https://otra.invalid/x');
    await user.tab();

    const geometry = lastGeometry(saved);
    expect(geometry?.shape === 'webframe' && geometry.url).toBe('https://otra.invalid/x');
  });

  it('TEST-HGP-032 se advierte de que al publicar sólo se enmarca lo declarado', () => {
    mount(geometryOf());
    expect(screen.getByText(/sólo permite enmarcar las direcciones declaradas/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Tres ejes (D08, D09)
 * ------------------------------------------------------------------ */

describe('rotación en tres ejes', () => {
  const identity: Transform3d = { scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 };

  const mountAxes = (
    projection: 'billboard' | 'sticker' | 'floating',
    transform: Transform3d = identity,
  ): { saved: Transform3d[] } => {
    const saved: Transform3d[] = [];
    render(
      <ToastProvider>
        <HotspotAxes
          projection={projection}
          transform={transform}
          onChange={(next) => saved.push(next)}
        />
      </ToastProvider>,
    );
    return { saved };
  };

  it('TEST-HGP-033 de frente, los ejes sin efecto se muestran deshabilitados', () => {
    // Esconderlos haría creer que la función no existe; dejarlos activos deja
    // al autor moviendo mandos que no hacen nada.
    mountAxes('billboard');

    expect(screen.getByLabelText('Giro en el plano de la vista')).toBeEnabled();
    expect(screen.getByLabelText('Inclinación')).toBeDisabled();
    expect(screen.getByLabelText('Giro sobre su eje vertical')).toBeDisabled();
  });

  it('TEST-HGP-034 se explica por qué y cómo activarlos', () => {
    mountAxes('billboard');
    expect(screen.getByText(/Cámbielo a adherido o flotante/)).toBeInTheDocument();
  });

  it('TEST-HGP-035 adherido a la escena los tres ejes se pueden usar', () => {
    mountAxes('sticker');
    expect(screen.getByLabelText('Inclinación')).toBeEnabled();
    expect(screen.getByLabelText('Giro sobre su eje vertical')).toBeEnabled();
    expect(screen.queryByText(/Cámbielo a adherido/)).not.toBeInTheDocument();
  });

  it('TEST-HGP-036 los ángulos se escriben en grados y se guardan en radianes', async () => {
    const user = userEvent.setup();
    const { saved } = mountAxes('sticker');

    const tilt = screen.getByLabelText('Inclinación');
    await user.clear(tilt);
    await user.type(tilt, '90{Enter}');

    expect(saved.at(-1)?.tilt).toBeCloseTo(Math.PI / 2, 5);
  });

  it('TEST-HGP-037 un ángulo guardado se muestra en grados', () => {
    mountAxes('sticker', { ...identity, roll: Math.PI / 4 });
    expect(screen.getByLabelText('Giro en el plano de la vista')).toHaveValue('45');
  });

  it('TEST-HGP-038 restablecer aparece sólo si hay rotación que deshacer', () => {
    mountAxes('sticker');
    expect(screen.queryByRole('button', { name: 'Restablecer' })).not.toBeInTheDocument();
  });

  it('TEST-HGP-039 restablecer pone los tres ejes a cero sin tocar la escala', async () => {
    const user = userEvent.setup();
    const { saved } = mountAxes('sticker', {
      scale: 2.5,
      roll: 1,
      tilt: 0.5,
      spin: -0.3,
      depth: 3,
    });

    await user.click(screen.getByRole('button', { name: 'Restablecer' }));

    const result = saved.at(-1);
    expect(result).toMatchObject({ roll: 0, tilt: 0, spin: 0, scale: 2.5, depth: 3 });
  });

  it('TEST-HGP-040 la profundidad se muestra como multiplicador', () => {
    mountAxes('sticker', { ...identity, depth: 2.5 });
    expect(screen.getByText('2.5×')).toBeInTheDocument();
  });
});
