/**
 * Pruebas del adaptador de realidad virtual (etapa 13, grupo N).
 *
 * El principio que gobierna el módulo es no ofrecer nunca un botón de VR que
 * no funcione: un visitante con las gafas puestas que pulsa «Entrar en VR» y
 * se queda en negro no vuelve a intentarlo. Estas pruebas comprueban las dos
 * mitades de eso: que la detección de capacidades no prometa de más, y que los
 * avisos del editor señalen lo que en VR no se va a poder usar **antes** de
 * publicar.
 *
 * Lo demás que se verifica aquí es comodidad física: el giro por pasos y los
 * límites de legibilidad y distancia de los paneles no son preferencias
 * estéticas, son lo que separa una sesión de veinte minutos de un mareo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyVrInput,
  DEFAULT_VR_PANEL,
  DESKTOP_ONLY,
  detectXrCapabilities,
  IDLE_VR_SESSION,
  isHotspotVrCompatible,
  isPanelReadable,
  isVrCompatible,
  SNAP_TURN_RAD,
  VR_MIN_TEXT_HEIGHT_M,
  VR_PROFILES,
  VR_SUPPORTED_COMPONENTS,
  vrCompatibilityWarnings,
  type VrPanelPlacement,
} from './webxr';
import { makeHotspot, testUuid } from '@it360/domain/testing';
import type { ComponentKind, Hotspot } from '@it360/domain';

/* ------------------------------------------------------------------ *
 * Detección de capacidades (N01)
 * ------------------------------------------------------------------ */

/** Sustituye `navigator.xr` por un doble. */
function installXr(xr: unknown): void {
  Object.defineProperty(globalThis.navigator, 'xr', {
    configurable: true,
    value: xr,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'xr', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  vi.restoreAllMocks();
});

describe('detectXrCapabilities', () => {
  it('TEST-VR-001 sin WebXR dice que no y explica qué hace falta', async () => {
    installXr(undefined);
    const caps = await detectXrCapabilities();

    expect(caps.apiAvailable).toBe(false);
    expect(caps.immersiveVrSupported).toBe(false);
    expect(caps.unavailableReason).toContain('WebXR');
  });

  it('TEST-VR-002 con visor conectado no da ningún motivo', async () => {
    installXr({ isSessionSupported: async () => true });
    const caps = await detectXrCapabilities();

    expect(caps.apiAvailable).toBe(true);
    expect(caps.immersiveVrSupported).toBe(true);
    expect(caps.unavailableReason).toBeNull();
  });

  it('TEST-VR-003 con la API pero sin visor lo dice así', async () => {
    // Es el caso frecuente: Chrome en un portátil sin gafas. Decir «no admite
    // VR» sería falso y mandaría al usuario a cambiar de navegador para nada.
    installXr({ isSessionSupported: async (mode: string) => mode === 'immersive-ar' });
    const caps = await detectXrCapabilities();

    expect(caps.apiAvailable).toBe(true);
    expect(caps.immersiveVrSupported).toBe(false);
    expect(caps.unavailableReason).toContain('visor');
  });

  it('TEST-VR-004 una consulta que rechaza no se propaga como excepción', async () => {
    // `isSessionSupported` rechaza en navegadores con la API a medias; sin
    // esto, el botón de VR reventaría la página entera al cargar.
    installXr({
      isSessionSupported: async () => {
        throw new Error('no permitido en este contexto');
      },
    });

    const caps = await detectXrCapabilities();
    expect(caps.immersiveVrSupported).toBe(false);
    expect(caps.unavailableReason).not.toBeNull();
  });

  it('TEST-VR-005 una API que lanza al llamarla tampoco rompe nada', async () => {
    installXr({
      isSessionSupported: () => {
        throw new Error('roto');
      },
    });

    const caps = await detectXrCapabilities();
    expect(caps.apiAvailable).toBe(true);
    expect(caps.immersiveVrSupported).toBe(false);
    expect(caps.unavailableReason).toContain('No se pudo consultar');
  });

  it('TEST-VR-006 detecta la realidad aumentada sin usarla', async () => {
    installXr({ isSessionSupported: async () => true });
    expect((await detectXrCapabilities()).immersiveArSupported).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Subconjunto compatible (N03, N06, N07)
 * ------------------------------------------------------------------ */

describe('isVrCompatible', () => {
  it('TEST-VR-007 admite los componentes que se manejan con un mando', () => {
    for (const kind of ['button', 'text', 'image', 'quizCard', 'scoreBoard'] as const) {
      expect(isVrCompatible(kind), kind).toBe(true);
    }
  });

  it('TEST-VR-008 excluye lo que no se maneja a tres metros', () => {
    // No están olvidados: un menú desplegable o una página web embebida no se
    // usan con un puntero láser a distancia.
    for (const kind of ['dropdown', 'webframe', 'carousel', 'tabs'] as const) {
      expect(isVrCompatible(kind), kind).toBe(false);
    }
  });

  it('TEST-VR-009 la lista no tiene duplicados', () => {
    expect(new Set(VR_SUPPORTED_COMPONENTS).size).toBe(VR_SUPPORTED_COMPONENTS.length);
  });
});

/** Marcador con la forma y la visibilidad indicadas. */
function hotspot(shape: string, vrVisible = true, name = 'Marcador'): Hotspot {
  const base = makeHotspot(1, testUuid(2));
  return {
    ...base,
    name,
    geometry: { ...base.geometry, shape } as Hotspot['geometry'],
    visibility: { ...base.visibility, vr: vrVisible },
  };
}

describe('isHotspotVrCompatible', () => {
  it('TEST-VR-010 admite las formas que se pueden apuntar o mirar', () => {
    for (const shape of ['icon', 'text', 'polygon']) {
      expect(isHotspotVrCompatible(hotspot(shape)), shape).toBe(true);
    }
  });

  it('TEST-VR-011 rechaza el contenido web embebido', () => {
    // Una página dentro de una sesión inmersiva no recibe los eventos del
    // mando y no hay forma de escribir en ella: enseñarla sería mostrar algo
    // con lo que no se puede interactuar.
    expect(isHotspotVrCompatible(hotspot('webframe'))).toBe(false);
  });

  it('TEST-VR-012 un marcador oculto en VR no cuenta como utilizable', () => {
    // La función responde «¿se va a poder usar esto en VR?», no «¿es de un
    // tipo admitido?»: un marcador de tipo válido pero oculto tampoco se usa.
    expect(isHotspotVrCompatible(hotspot('icon', false))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Paneles (N04, N05)
 * ------------------------------------------------------------------ */

describe('DEFAULT_VR_PANEL', () => {
  it('TEST-VR-013 se coloca a una distancia que no fuerza la vista', () => {
    // Más cerca de un metro fuerza la convergencia ocular y cansa en minutos.
    expect(DEFAULT_VR_PANEL.distanceM).toBeGreaterThanOrEqual(1.2);
    expect(DEFAULT_VR_PANEL.distanceM).toBeLessThanOrEqual(3);
  });

  it('TEST-VR-014 ocupa una parte del campo visual que se lee sin girar la cabeza', () => {
    // Ángulo horizontal que abarca el panel a su distancia.
    const anguloRad = 2 * Math.atan(DEFAULT_VR_PANEL.widthM / 2 / DEFAULT_VR_PANEL.distanceM);
    const anguloDeg = (anguloRad * 180) / Math.PI;

    expect(anguloDeg).toBeGreaterThan(25);
    expect(anguloDeg).toBeLessThan(50);
  });

  it('TEST-VR-015 queda ligeramente por debajo de la mirada', () => {
    // Un panel centrado en la línea de visión tapa la escena; algo más abajo
    // es donde cae la mirada en reposo.
    expect(DEFAULT_VR_PANEL.pitchOffset).toBeLessThan(0);
    expect(DEFAULT_VR_PANEL.pitchOffset).toBeGreaterThan(-0.5);
  });

  it('TEST-VR-016 nace recentrándose, no fijo en el mundo', () => {
    // Un panel fijo obliga a buscarlo girando el cuerpo; uno que sigue la
    // mirada con retardo está siempre a mano sin perseguir al visitante.
    expect(DEFAULT_VR_PANEL.mode).toBe('recentering');
  });
});

describe('isPanelReadable', () => {
  const panel = (over: Partial<VrPanelPlacement> = {}): VrPanelPlacement => ({
    ...DEFAULT_VR_PANEL,
    ...over,
  });

  it('TEST-VR-017 acepta un texto proporcionado al tamaño del panel', () => {
    // 1,2 m de ancho sobre 1200 px de diseño: 1 mm por píxel. Un texto de 24 px
    // mide 24 mm, por encima del mínimo.
    expect(isPanelReadable(panel(), 24, 1200)).toBe(true);
  });

  it('TEST-VR-018 rechaza un panel de pantalla llevado a VR sin ajustar', () => {
    // Es el caso real: una interfaz diseñada para 1920 px con texto de 14 px
    // queda con letras de poco más de medio centímetro a casi dos metros.
    expect(isPanelReadable(panel(), 14, 1920)).toBe(false);
  });

  it('TEST-VR-019 exige más tamaño cuanto más lejos está el panel', () => {
    const texto = 20;
    expect(isPanelReadable(panel({ distanceM: 1.2 }), texto, 1200)).toBe(true);
    expect(isPanelReadable(panel({ distanceM: 6 }), texto, 1200)).toBe(false);
  });

  it('TEST-VR-020 un panel más ancho en metros admite el mismo texto en píxeles', () => {
    expect(isPanelReadable(panel({ widthM: 0.5 }), 20, 1200)).toBe(false);
    expect(isPanelReadable(panel({ widthM: 2.5 }), 20, 1200)).toBe(true);
  });

  it('TEST-VR-021 un ancho en píxeles de cero no divide por cero', () => {
    expect(() => isPanelReadable(panel(), 20, 0)).not.toThrow();
    expect(isPanelReadable(panel(), 20, 0)).toBe(true);
  });

  it('TEST-VR-022 el mínimo declarado es coherente con lo que acepta', () => {
    // A la distancia de referencia, un carácter justo del mínimo pasa.
    const metrosPorPixel = DEFAULT_VR_PANEL.widthM / 1200;
    const pixelesMinimos = VR_MIN_TEXT_HEIGHT_M / metrosPorPixel;

    expect(isPanelReadable(panel(), Math.ceil(pixelesMinimos), 1200)).toBe(true);
    expect(isPanelReadable(panel(), Math.floor(pixelesMinimos) - 1, 1200)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Mandos (N11)
 * ------------------------------------------------------------------ */

describe('applyVrInput', () => {
  it('TEST-VR-023 el giro es por pasos, no continuo', () => {
    // El giro continuo es la causa principal del malestar en VR: el oído
    // interno no registra la rotación que los ojos ven.
    const girado = applyVrInput({ ...IDLE_VR_SESSION, active: true }, 'rotateRight');
    expect(girado.yawOffset).toBe(SNAP_TURN_RAD);
    expect(SNAP_TURN_RAD).toBeCloseTo(Math.PI / 6, 10);
  });

  it('TEST-VR-024 el paso de giro es de treinta grados', () => {
    expect((SNAP_TURN_RAD * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it('TEST-VR-025 girar a un lado y al otro vuelve al punto de partida', () => {
    let state = { ...IDLE_VR_SESSION, active: true };
    state = applyVrInput(state, 'rotateRight');
    state = applyVrInput(state, 'rotateLeft');
    expect(state.yawOffset).toBeCloseTo(0, 10);
  });

  it('TEST-VR-026 doce pasos completan la vuelta', () => {
    let state = { ...IDLE_VR_SESSION, active: true };
    for (let i = 0; i < 12; i += 1) state = applyVrInput(state, 'rotateRight');
    expect(state.yawOffset).toBeCloseTo(Math.PI * 2, 10);
  });

  it('TEST-VR-027 salir deja la sesión en reposo y sin rotación acumulada', () => {
    const state = applyVrInput(
      { active: true, yawOffset: 3, activeHand: 'right' },
      'exit',
    );
    expect(state).toEqual(IDLE_VR_SESSION);
  });

  it('TEST-VR-028 las acciones sin efecto sobre el estado lo dejan intacto', () => {
    const state = { active: true, yawOffset: 1, activeHand: 'left' } as const;
    for (const action of ['select', 'teleport', 'menu'] as const) {
      expect(applyVrInput(state, action)).toBe(state);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Perfiles de publicación (N12)
 * ------------------------------------------------------------------ */

describe('VR_PROFILES', () => {
  it('TEST-VR-029 el visor autónomo es más exigente que el conectado a PC', () => {
    // Un visor autónomo tiene el presupuesto gráfico de un teléfono de gama
    // media y debe sostener 72 fps: cualquier caída se siente en el estómago.
    const autonomo = VR_PROFILES['standalone'];
    const conectado = VR_PROFILES['tethered'];

    expect(autonomo).toBeDefined();
    expect(conectado).toBeDefined();
    if (autonomo === undefined || conectado === undefined) return;

    expect(autonomo.maxPanoramaEdgePx).toBeLessThan(conectado.maxPanoramaEdgePx);
    expect(autonomo.maxVisibleHotspots).toBeLessThan(conectado.maxVisibleHotspots);
  });

  it('TEST-VR-030 ambos perfiles piden una tasa que evita el malestar', () => {
    // Por debajo de 72 fps la sensación de latencia se nota físicamente.
    for (const [key, profile] of Object.entries(VR_PROFILES)) {
      expect(profile.targetFps, key).toBeGreaterThanOrEqual(72);
      expect(profile.name.length, key).toBeGreaterThan(0);
    }
  });
});

describe('vrCompatibilityWarnings', () => {
  const profile = VR_PROFILES['standalone'] ?? {
    name: 'X',
    maxPanoramaEdgePx: 4096,
    targetFps: 72,
    maxVisibleHotspots: 24,
  };

  it('TEST-VR-031 una escena compatible no genera avisos', () => {
    const hotspots = [hotspot('icon'), hotspot('text')];
    expect(vrCompatibilityWarnings(hotspots, ['button', 'text'], profile)).toEqual([]);
  });

  it('TEST-VR-032 avisa del marcador visible en VR con tipo incompatible', () => {
    // Es el aviso que evita publicar un recorrido en el que, con las gafas
    // puestas, falta justo el marcador que lleva a la siguiente escena.
    const hotspots = [hotspot('icon'), hotspot('webframe', true, 'Panel web')];
    const warnings = vrCompatibilityWarnings(hotspots, [], profile);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Panel web');
  });

  it('TEST-VR-033 no avisa de un marcador incompatible que ya está oculto en VR', () => {
    // Ocultarlo es precisamente la forma correcta de resolverlo; seguir
    // avisando convertiría la solución en un aviso permanente.
    const hotspots = [hotspot('webframe', false)];
    expect(vrCompatibilityWarnings(hotspots, [], profile)).toEqual([]);
  });

  it('TEST-VR-034 avisa cuando hay más marcadores de los que el perfil aguanta', () => {
    const hotspots = Array.from({ length: profile.maxVisibleHotspots + 5 }, (_, i) =>
      hotspot('icon', true, `M${i}`),
    );
    const warnings = vrCompatibilityWarnings(hotspots, [], profile);

    expect(warnings.some((w) => w.includes(String(profile.maxVisibleHotspots)))).toBe(true);
    expect(warnings.some((w) => w.includes(profile.name))).toBe(true);
  });

  it('TEST-VR-035 avisa de los componentes sin equivalente en VR, sin repetirlos', () => {
    const components: ComponentKind[] = ['button', 'dropdown', 'dropdown', 'webframe'];
    const warnings = vrCompatibilityWarnings([], components, profile);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dropdown');
    expect(warnings[0]).toContain('webframe');
    // Una sola vez cada uno: repetirlos haría ilegible el aviso.
    expect(warnings[0]?.match(/dropdown/g)).toHaveLength(1);
  });

  it('TEST-VR-036 nombra como mucho tres marcadores y no vuelca la lista entera', () => {
    const hotspots = Array.from({ length: 20 }, (_, i) =>
      hotspot('webframe', true, `Panel ${i}`),
    );
    const warnings = vrCompatibilityWarnings(hotspots, [], profile);
    const primero = warnings[0] ?? '';

    expect(primero).toContain('20 marcador(es)');
    expect(primero.match(/Panel \d+/g)?.length).toBe(3);
  });

  it('TEST-VR-037 acumula los avisos de distinta clase', () => {
    const hotspots = [hotspot('webframe', true, 'Panel web')];
    const warnings = vrCompatibilityWarnings(hotspots, ['dropdown'], profile);
    expect(warnings).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Visibilidad
 * ------------------------------------------------------------------ */

describe('DESKTOP_ONLY', () => {
  it('TEST-VR-038 excluye VR y deja el resto de dispositivos', () => {
    expect(DESKTOP_ONLY.vr).toBe(false);
    expect(DESKTOP_ONLY.desktop).toBe(true);
    expect(DESKTOP_ONLY.tablet).toBe(true);
    expect(DESKTOP_ONLY.mobile).toBe(true);
  });
});
