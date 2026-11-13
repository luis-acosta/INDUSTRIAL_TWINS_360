/**
 * Pruebas de la disposición del skin.
 *
 * Los casos se concentran en el anclaje, que es donde está la trampa: con el
 * desplazamiento aplicado siempre en la misma dirección, «16 px» separa del
 * borde en una esquina y expulsa de la pantalla en la opuesta, y el autor
 * descubre que tiene que escribir números negativos en la mitad de los casos.
 */
import { describe, expect, it } from 'vitest';
import type { Box, Skin, SkinNode, SkinStyle } from '@it360/domain';
import { makeSkin, testUuid } from '@it360/domain/testing';
import {
  activeTabOf,
  applyVisibilityAction,
  carouselIndexOf,
  designArea,
  EMPTY_SKIN_STATE,
  fixedScale,
  isNodeVisible,
  progressFraction,
  resolveBox,
  styleToCss,
  type SkinState,
} from './skin-layout';

const VIEWPORT = { width: 1600, height: 900 };

function box(overrides: Partial<Box> = {}): Box {
  return {
    anchor: 'topLeft',
    offsetX: 0,
    offsetY: 0,
    width: null,
    height: null,
    widthPercent: null,
    heightPercent: null,
    minWidth: 0,
    minHeight: 0,
    padding: 0,
    gap: 8,
    ...overrides,
  };
}

function style(overrides: Partial<SkinStyle> = {}): SkinStyle {
  return {
    background: { kind: 'none' },
    backdropBlur: 0,
    borderRadius: 4,
    borderWidth: 0,
    borderColor: null,
    shadow: 'none',
    opacity: 1,
    fontMediaId: null,
    fontSize: null,
    fontWeight: null,
    textColor: null,
    textAlign: 'left',
    ...overrides,
  };
}

function node(overrides: Partial<SkinNode> = {}): SkinNode {
  return {
    id: 'n1',
    name: 'Componente',
    config: { kind: 'spacer' },
    box: box(),
    style: style(),
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

/* ------------------------------------------------------------------ *
 * Modo fijo y adaptable (F05)
 * ------------------------------------------------------------------ */

describe('fixedScale', () => {
  // TEST-SKL-001
  it('el modo adaptable no escala nada', () => {
    const fluido: Skin = { ...makeSkin(1), layoutMode: 'fluid' };
    expect(fixedScale(fluido, VIEWPORT)).toBe(1);
  });

  // TEST-SKL-002
  it('el modo fijo escala por el lado que más limita', () => {
    // Con el lado mayor, parte de la interfaz quedaría fuera de la pantalla, y
    // un botón que no se ve es un botón que no existe.
    const fijo: Skin = {
      ...makeSkin(1),
      layoutMode: 'fixed',
      designWidth: 1920,
      designHeight: 1080,
    };

    // 1600/1920 = 0,833 frente a 900/1080 = 0,833: cuadra en 16:9.
    expect(fixedScale(fijo, { width: 1600, height: 900 })).toBeCloseTo(0.8333, 3);
    // En una ventana más ancha manda la altura.
    expect(fixedScale(fijo, { width: 2560, height: 900 })).toBeCloseTo(0.8333, 3);
    // Y en una más alta, la anchura.
    expect(fixedScale(fijo, { width: 1280, height: 1440 })).toBeCloseTo(0.6667, 3);
  });

  // TEST-SKL-003
  it('una ventana de tamaño cero no produce una escala absurda', () => {
    const fijo: Skin = { ...makeSkin(1), layoutMode: 'fixed' };
    expect(fixedScale(fijo, { width: 0, height: 0 })).toBe(1);
  });

  // TEST-SKL-004
  it('el área de diseño del modo fijo conserva la relación de aspecto', () => {
    const fijo: Skin = {
      ...makeSkin(1),
      layoutMode: 'fixed',
      designWidth: 1920,
      designHeight: 1080,
    };
    const area = designArea(fijo, { width: 2560, height: 900 });

    expect(area.height).toBeCloseTo(900, 1);
    expect(area.width / area.height).toBeCloseTo(1920 / 1080, 3);
  });

  // TEST-SKL-005
  it('el área del modo adaptable es la ventana entera', () => {
    const fluido: Skin = { ...makeSkin(1), layoutMode: 'fluid' };
    expect(designArea(fluido, VIEWPORT)).toEqual(VIEWPORT);
  });
});

/* ------------------------------------------------------------------ *
 * Anclaje
 * ------------------------------------------------------------------ */

describe('resolveBox', () => {
  const container = { width: 1000, height: 600 };

  // TEST-SKL-006
  it('anclado arriba a la izquierda, el desplazamiento se suma', () => {
    const resolved = resolveBox(
      box({ anchor: 'topLeft', offsetX: 16, offsetY: 24, width: 200, height: 100 }),
      container,
    );

    expect(resolved.left).toBe(16);
    expect(resolved.top).toBe(24);
  });

  // TEST-SKL-007
  it('anclado abajo a la derecha, el desplazamiento separa del borde hacia dentro', () => {
    // Es el caso que delata el error: sumando siempre, el componente se iría
    // fuera de la pantalla y el autor tendría que escribir -16.
    const resolved = resolveBox(
      box({ anchor: 'bottomRight', offsetX: 16, offsetY: 16, width: 200, height: 100 }),
      container,
    );

    expect(resolved.left).toBe(1000 - 200 - 16);
    expect(resolved.top).toBe(600 - 100 - 16);
  });

  // TEST-SKL-008
  it('centrado, el componente queda en el medio', () => {
    const resolved = resolveBox(
      box({ anchor: 'center', width: 200, height: 100 }),
      container,
    );

    expect(resolved.left).toBe(400);
    expect(resolved.top).toBe(250);
  });

  // TEST-SKL-009
  it('anclado arriba al centro, se centra en horizontal y pega arriba', () => {
    const resolved = resolveBox(box({ anchor: 'top', offsetY: 12, width: 300 }), container);

    expect(resolved.left).toBe(350);
    expect(resolved.top).toBe(12);
  });

  // TEST-SKL-010
  it('el porcentaje tiene prioridad sobre el tamaño absoluto', () => {
    const resolved = resolveBox(
      box({ width: 200, widthPercent: 0.5, height: 100, heightPercent: 0.25 }),
      container,
    );

    expect(resolved.width).toBe(500);
    expect(resolved.height).toBe(150);
  });

  // TEST-SKL-011
  it('respeta el tamaño mínimo', () => {
    const resolved = resolveBox(box({ widthPercent: 0.05, minWidth: 120 }), container);
    expect(resolved.width).toBe(120);
  });

  // TEST-SKL-012
  it('sin tamaño declarado se ajusta al contenido', () => {
    const resolved = resolveBox(box({ anchor: 'topLeft' }), container);

    expect(resolved.width).toBeNull();
    expect(resolved.height).toBeNull();
  });

  // TEST-SKL-013
  it('un componente sin tamaño anclado a la derecha se alinea con el borde', () => {
    // Sin tamaño, el anclaje no puede descontar nada: queda pegado al borde y
    // el navegador lo encoge al contenido desde ahí.
    const resolved = resolveBox(box({ anchor: 'topRight', offsetX: 20 }), container);
    expect(resolved.left).toBe(1000 - 20);
  });
});

/* ------------------------------------------------------------------ *
 * Visibilidad (J05)
 * ------------------------------------------------------------------ */

describe('isNodeVisible', () => {
  const base = { device: 'desktop' as const, sceneId: testUuid(5), state: EMPTY_SKIN_STATE };

  // TEST-SKL-014
  it('un componente normal se ve', () => {
    expect(isNodeVisible({ ...base, node: node() })).toBe(true);
  });

  // TEST-SKL-015
  it('respeta la visibilidad por dispositivo', () => {
    const soloEscritorio = node({
      visibility: { desktop: true, tablet: false, mobile: false, vr: false },
    });

    expect(isNodeVisible({ ...base, node: soloEscritorio, device: 'mobile' })).toBe(false);
  });

  // TEST-SKL-016
  it('la lista de escenas vacía significa «en todas»', () => {
    // Es lo que espera quien pone una barra de navegación: no repetirla escena
    // por escena.
    expect(isNodeVisible({ ...base, node: node({ sceneIds: [] }) })).toBe(true);
  });

  // TEST-SKL-017
  it('con lista de escenas, sólo aparece en las declaradas', () => {
    const limitado = node({ sceneIds: [testUuid(9)] });

    expect(isNodeVisible({ ...base, node: limitado })).toBe(false);
    expect(isNodeVisible({ ...base, node: limitado, sceneId: testUuid(9) })).toBe(true);
  });

  // TEST-SKL-018
  it('un hijo de pestañas sólo se ve en su pestaña', () => {
    const enPestana = node({ tabId: 'detalles' });

    expect(isNodeVisible({ ...base, node: enPestana, parentActiveTab: 'detalles' })).toBe(true);
    expect(isNodeVisible({ ...base, node: enPestana, parentActiveTab: 'resumen' })).toBe(false);
  });

  // TEST-SKL-019
  it('lo oculto al cargar no se ve hasta que una acción lo muestre', () => {
    const oculto = node({ initiallyVisible: false });
    expect(isNodeVisible({ ...base, node: oculto })).toBe(false);

    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['n1'], true, [oculto]);
    expect(isNodeVisible({ ...base, node: oculto, state })).toBe(true);
  });

  // TEST-SKL-020
  it('mostrar por acción no salta la exclusión por dispositivo', () => {
    // La acción gobierna el estado, no la declaración del autor: un panel que
    // no cabe en un móvil no debe aparecer en un móvil porque un botón lo pida.
    const soloEscritorio = node({
      visibility: { desktop: true, tablet: false, mobile: false, vr: false },
    });
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['n1'], true, [soloEscritorio]);

    expect(isNodeVisible({ ...base, node: soloEscritorio, device: 'mobile', state })).toBe(false);
  });
});

describe('applyVisibilityAction', () => {
  const tree = [node({ id: 'a' }), node({ id: 'b', children: [node({ id: 'c' })] })];

  // TEST-SKL-021
  it('alterna el estado de un componente visible', () => {
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['a'], 'toggle', tree);
    expect(state.hidden.has('a')).toBe(true);

    const back = applyVisibilityAction(state, ['a'], 'toggle', tree);
    expect(back.hidden.has('a')).toBe(false);
    expect(back.shown.has('a')).toBe(true);
  });

  // TEST-SKL-022
  it('encuentra componentes anidados', () => {
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['c'], false, tree);
    expect(state.hidden.has('c')).toBe(true);
  });

  // TEST-SKL-023
  it('ignora un identificador que no existe', () => {
    // Guardar estado para algo que no existe dejaría basura que nadie limpia.
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['inexistente'], false, tree);
    expect(state.hidden.size).toBe(0);
  });

  // TEST-SKL-024
  it('varios componentes en una sola acción', () => {
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['a', 'c'], false, tree);
    expect(state.hidden.has('a')).toBe(true);
    expect(state.hidden.has('c')).toBe(true);
  });

  // TEST-SKL-025
  it('no muta el estado anterior', () => {
    const state = applyVisibilityAction(EMPTY_SKIN_STATE, ['a'], false, tree);

    expect(EMPTY_SKIN_STATE.hidden.size).toBe(0);
    expect(state.hidden.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Pestañas y carruseles
 * ------------------------------------------------------------------ */

describe('activeTabOf', () => {
  const tabs = [{ id: 'resumen' }, { id: 'detalles' }];

  // TEST-SKL-026
  it('sin estado, la primera pestaña', () => {
    // Un contenedor sin pestaña activa mostraría un marco vacío, que el
    // visitante lee como un error de carga.
    expect(activeTabOf(node(), EMPTY_SKIN_STATE, tabs)).toBe('resumen');
  });

  // TEST-SKL-027
  it('respeta la pestaña elegida', () => {
    const state: SkinState = { ...EMPTY_SKIN_STATE, activeTab: new Map([['n1', 'detalles']]) };
    expect(activeTabOf(node(), state, tabs)).toBe('detalles');
  });

  // TEST-SKL-028
  it('una pestaña guardada que ya no existe cae a la primera', () => {
    // Pasa al editar el skin: el estado de la sesión apunta a algo borrado.
    const state: SkinState = { ...EMPTY_SKIN_STATE, activeTab: new Map([['n1', 'borrada']]) };
    expect(activeTabOf(node(), state, tabs)).toBe('resumen');
  });

  // TEST-SKL-029
  it('sin pestañas no inventa ninguna', () => {
    expect(activeTabOf(node(), EMPTY_SKIN_STATE, [])).toBeNull();
  });
});

describe('carouselIndexOf', () => {
  // TEST-SKL-030
  it('empieza en el primero', () => {
    expect(carouselIndexOf(node(), EMPTY_SKIN_STATE, 5)).toBe(0);
  });

  // TEST-SKL-031
  it('da la vuelta al pasar del último', () => {
    // Un carrusel que se detiene obliga a volver pulsando atrás tantas veces
    // como se avanzó, y nadie lo hace.
    const state: SkinState = { ...EMPTY_SKIN_STATE, carouselIndex: new Map([['n1', 7]]) };
    expect(carouselIndexOf(node(), state, 5)).toBe(2);
  });

  // TEST-SKL-032
  it('da la vuelta hacia atrás', () => {
    const state: SkinState = { ...EMPTY_SKIN_STATE, carouselIndex: new Map([['n1', -1]]) };
    expect(carouselIndexOf(node(), state, 5)).toBe(4);
  });

  // TEST-SKL-033
  it('un carrusel vacío no divide por cero', () => {
    expect(carouselIndexOf(node(), EMPTY_SKIN_STATE, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Estilos (F11, F12)
 * ------------------------------------------------------------------ */

describe('styleToCss', () => {
  // TEST-SKL-034
  it('un color con opacidad se mezcla con transparente', () => {
    const css = styleToCss(
      style({ background: { kind: 'color', color: '#112233', opacity: 0.6 } }),
    );
    expect(String(css['background'])).toContain('color-mix');
    expect(String(css['background'])).toContain('60%');
  });

  // TEST-SKL-035
  it('un color opaco se usa tal cual', () => {
    const css = styleToCss(style({ background: { kind: 'color', color: '#112233', opacity: 1 } }));
    expect(css['background']).toBe('#112233');
  });

  // TEST-SKL-036
  it('un token de fondo se traduce a variable del sistema', () => {
    const css = styleToCss(style({ background: { kind: 'token', token: 'overlay' } }));
    expect(css['background']).toBe('var(--it-color-surface-overlay)');
  });

  // TEST-SKL-037
  it('una imagen de fondo que falta del paquete no deja una URL rota', () => {
    const css = styleToCss(
      style({ background: { kind: 'image', mediaId: testUuid(3), fit: 'cover' } }),
      { mediaUrls: new Map() },
    );
    expect(css['backgroundImage']).toBeUndefined();
  });

  // TEST-SKL-038
  it('el desenfoque se omite con movimiento reducido', () => {
    // Tiene coste de GPU y en equipos sin aceleración produce el tirón que esa
    // preferencia pide evitar.
    const conDesenfoque = style({ backdropBlur: 12 });

    expect(styleToCss(conDesenfoque)['backdropFilter']).toBe('blur(12px)');
    expect(styleToCss(conDesenfoque, { reducedMotion: true })['backdropFilter']).toBeUndefined();
  });

  // TEST-SKL-039
  it('una fuente propia sin registrar no se escribe', () => {
    // Un nombre que el navegador no conoce hace caer el texto a la fuente
    // genérica del sistema, que es peor que la del sistema de diseño.
    const conFuente = style({ fontMediaId: testUuid(4) });

    expect(styleToCss(conFuente)['fontFamily']).toBeUndefined();
    expect(
      styleToCss(conFuente, { fontFamily: () => 'PlantaSans' })['fontFamily'],
    ).toBe('PlantaSans, var(--it-font-sans)');
  });

  // TEST-SKL-040
  it('el borde sólo se declara cuando tiene grosor', () => {
    expect(styleToCss(style({ borderWidth: 0 }))['borderStyle']).toBeUndefined();
    expect(styleToCss(style({ borderWidth: 2 }))['borderStyle']).toBe('solid');
  });

  // TEST-SKL-041
  it('un borde sin color usa el del sistema de diseño', () => {
    const css = styleToCss(style({ borderWidth: 1, borderColor: null }));
    expect(css['borderColor']).toBe('var(--it-color-border-default)');
  });
});

/* ------------------------------------------------------------------ *
 * Progreso (F10)
 * ------------------------------------------------------------------ */

describe('progressFraction', () => {
  // TEST-SKL-042
  it('calcula la fracción', () => {
    expect(progressFraction(3, 10)).toBeCloseTo(0.3, 6);
  });

  // TEST-SKL-043
  it('acota en lugar de dibujar una barra que sobresale', () => {
    expect(progressFraction(15, 10)).toBe(1);
    expect(progressFraction(-5, 10)).toBe(0);
  });

  // TEST-SKL-044
  it('un total inválido no rompe la barra', () => {
    expect(progressFraction(5, 0)).toBe(0);
    expect(progressFraction(Number.NaN, 10)).toBe(0);
    expect(progressFraction(5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
