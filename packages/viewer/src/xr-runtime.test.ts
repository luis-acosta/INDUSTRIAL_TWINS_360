/**
 * Pruebas del fotograma inmersivo completo.
 *
 * Son las pruebas que más se acercan a «¿se puede usar el visor?» sin un
 * visor: apuntar, resaltar, pulsar, girar y arrastrar, fotograma a fotograma,
 * con las mismas piezas que corren en producción. Lo que queda sin verificar
 * es el aspecto y la comodidad, que exigen hardware.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_VR_PANEL, SNAP_TURN_RAD, type VrPanelMode } from './webxr';
import { XR_BUTTON, type XrInputSnapshot, type XrRay } from './xr-input';
import type { PanelTarget } from './xr-panel';
import { POINTER_FALLBACK_M, XrRuntime, type XrPanelSpec } from './xr-runtime';

const HEAD = { position: [0, 1.6, 0] as const, yaw: 0 };

/** Panel de 1×0,5 m a 2 m, con un botón arriba y otro abajo. */
function panel(id: string, mode: VrPanelMode = 'recentering'): XrPanelSpec {
  const targets: PanelTarget[] = [
    { id: `${id}:arriba`, u0: 0.1, v0: 0.05, u1: 0.9, v1: 0.45 },
    { id: `${id}:abajo`, u0: 0.1, v0: 0.55, u1: 0.9, v1: 0.95 },
  ];
  return {
    id,
    placement: { ...DEFAULT_VR_PANEL, mode, distanceM: 2, widthM: 1, heightM: 0.5, pitchOffset: 0 },
    targets,
  };
}

function pad(options: { readonly buttons?: readonly number[] } = {}): XrInputSnapshot {
  const pressed = new Set(options.buttons ?? []);
  return {
    handedness: 'right',
    buttons: Array.from({ length: 6 }, (_u, index) => pressed.has(index)),
    axes: [0, 0, 0, 0],
  };
}

/** Rayo desde la cabeza hacia el punto dado del panel. */
function rayToward(y: number): XrRay {
  const target = [0, y, -2] as const;
  const origin = HEAD.position;
  const raw = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]] as const;
  const length = Math.hypot(...raw);
  return { origin, direction: [raw[0] / length, raw[1] / length, raw[2] / length] };
}

const CENTER_RAY = rayToward(1.6);
const UPPER_RAY = rayToward(1.75);
const LOWER_RAY = rayToward(1.45);

describe('XrRuntime', () => {
  it('resalta la zona a la que apunta el mando', () => {
    // TEST-XRR-001: sin resalte no se sabe a qué se apunta hasta pulsar, y en
    // una evaluación eso significa responder a ciegas.
    const runtime = new XrRuntime();
    const output = runtime.frame({
      head: HEAD,
      inputs: [pad()],
      rays: [UPPER_RAY],
      panels: [panel('p')],
    });

    expect(output.hovered).toBe('p:arriba');
    expect(output.activated).toEqual([]);
  });

  it('activa con el gatillo la zona apuntada', () => {
    // TEST-XRR-002: la activación usa la misma zona que el resalte, de modo
    // que lo que se ve resaltado y lo que se activa no pueden divergir.
    const runtime = new XrRuntime();
    const output = runtime.frame({
      head: HEAD,
      inputs: [pad({ buttons: [XR_BUTTON.trigger] })],
      rays: [LOWER_RAY],
      panels: [panel('p')],
    });

    expect(output.activated).toEqual(['p:abajo']);
  });

  it('no activa nada apuntando entre dos zonas', () => {
    // TEST-XRR-003: el hueco entre botones existe para que un apuntado impreciso
    // no active el botón equivocado. Si el hueco activara el más cercano,
    // sobraría el hueco.
    const runtime = new XrRuntime();
    const output = runtime.frame({
      head: HEAD,
      inputs: [pad({ buttons: [XR_BUTTON.trigger] })],
      rays: [CENTER_RAY],
      panels: [panel('p')],
    });

    expect(output.hovered).toBeNull();
    expect(output.activated).toEqual([]);
  });

  it('un modal impide activar lo que hay detrás', () => {
    // TEST-XRR-004: es el requisito N05. Un modal que no bloquea deja al
    // visitante cambiando de escena mientras cree estar respondiendo.
    const runtime = new XrRuntime();
    const detras = panel('fondo');
    const modal: XrPanelSpec = {
      ...panel('modal', 'modal'),
      placement: { ...panel('modal', 'modal').placement, distanceM: 1.2 },
    };

    const output = runtime.frame({
      head: HEAD,
      inputs: [pad({ buttons: [XR_BUTTON.trigger] })],
      rays: [UPPER_RAY],
      panels: [detras, modal],
    });

    expect(output.activated).toEqual(['modal:arriba']);
  });

  it('elige el panel más cercano cuando dos se solapan', () => {
    // TEST-XRR-005: el de delante es el que el visitante cree estar pulsando.
    const runtime = new XrRuntime();
    const lejos = panel('lejos');
    const cerca: XrPanelSpec = {
      ...panel('cerca'),
      placement: { ...panel('cerca').placement, distanceM: 1 },
    };

    const output = runtime.frame({
      head: HEAD,
      inputs: [pad()],
      rays: [UPPER_RAY],
      panels: [lejos, cerca],
    });

    expect(output.hovered).toBe('cerca:arriba');
  });

  it('gira por pasos y sólo una vez por cruce', () => {
    // TEST-XRR-006: el giro acumulado es el que gira el decorado. Si cada
    // fotograma con la palanca girase, media vuelta serían tres fotogramas.
    const runtime = new XrRuntime();
    const stick: XrInputSnapshot = { handedness: 'right', buttons: [], axes: [0, 0, 1, 0] };

    const first = runtime.frame({ head: HEAD, inputs: [stick], rays: [], panels: [] });
    const second = runtime.frame({ head: HEAD, inputs: [stick], rays: [], panels: [] });

    expect(first.yawOffset).toBeCloseTo(SNAP_TURN_RAD, 10);
    expect(second.yawOffset).toBeCloseTo(SNAP_TURN_RAD, 10);
  });

  it('transmite la petición de salir', () => {
    // TEST-XRR-007: el botón secundario del mando es la salida de emergencia.
    // Sin ella, quitarse el visor es la única forma de salir.
    const runtime = new XrRuntime();
    const output = runtime.frame({
      head: HEAD,
      inputs: [pad({ buttons: [XR_BUTTON.secondary] })],
      rays: [],
      panels: [],
    });

    expect(output.exitRequested).toBe(true);
  });

  it('coloca el puntero a la distancia de lo apuntado', () => {
    // TEST-XRR-008: un puntero de longitud fija atraviesa el panel y se ve
    // salir por detrás; uno infinito cruza la panorámica entera.
    const runtime = new XrRuntime();
    const pointing = runtime.frame({
      head: HEAD,
      inputs: [pad()],
      rays: [UPPER_RAY],
      panels: [panel('p')],
    });
    const empty = runtime.frame({ head: HEAD, inputs: [pad()], rays: [UPPER_RAY], panels: [] });

    expect(pointing.pointerLengthM).toBeLessThan(2.5);
    expect(empty.pointerLengthM).toBe(POINTER_FALLBACK_M);
  });

  it('da los marcos de todos los paneles abiertos', () => {
    // TEST-XRR-009: quien dibuja necesita un marco por panel; si faltara uno,
    // ese panel se quedaría en el origen, dentro de la cabeza del visitante.
    const runtime = new XrRuntime();
    const output = runtime.frame({
      head: HEAD,
      inputs: [pad()],
      rays: [],
      panels: [panel('a'), panel('b', 'worldFixed')],
    });

    expect([...output.frames.keys()].sort()).toEqual(['a', 'b']);
  });

  it('olvida el ancla de un panel que se cierra', () => {
    // TEST-XRR-010: si se conservara, reabrir un panel arrastrable lo pondría
    // donde lo dejó otra sesión, en un sitio que el visitante no recuerda.
    const runtime = new XrRuntime();
    runtime.frame({ head: HEAD, inputs: [pad()], rays: [], panels: [panel('a')] });
    expect(runtime.anchorOf('a')).toBeDefined();

    runtime.frame({ head: HEAD, inputs: [pad()], rays: [], panels: [] });
    expect(runtime.anchorOf('a')).toBeUndefined();
  });

  it('arrastra un panel arrastrable con el agarre y el giro de cabeza', () => {
    // TEST-XRR-011: es el requisito N05. El arrastre se mide por el giro de la
    // cabeza porque la posición absoluta del mando no es fiable en todos los
    // visores, y mirar a donde se quiere dejar el panel es el gesto natural.
    const runtime = new XrRuntime();
    const draggable = panel('d', 'draggable');
    const squeeze = pad({ buttons: [XR_BUTTON.squeeze] });

    runtime.frame({ head: HEAD, inputs: [squeeze], rays: [], panels: [draggable] });
    runtime.frame({
      head: { position: HEAD.position, yaw: 0.4 },
      inputs: [squeeze],
      rays: [],
      panels: [draggable],
    });

    expect(runtime.anchorOf('d')?.dragYaw).toBeCloseTo(0.4, 6);
  });

  it('no arrastra un panel que no es arrastrable', () => {
    // TEST-XRR-012: arrastrar un panel fijo al mundo lo desancla del sitio al
    // que pertenece, que es justo lo que ese modo promete.
    const runtime = new XrRuntime();
    const fixed = panel('f', 'worldFixed');
    const squeeze = pad({ buttons: [XR_BUTTON.squeeze] });

    runtime.frame({ head: HEAD, inputs: [squeeze], rays: [], panels: [fixed] });
    runtime.frame({
      head: { position: HEAD.position, yaw: 0.4 },
      inputs: [squeeze],
      rays: [],
      panels: [fixed],
    });

    expect(runtime.anchorOf('f')?.dragYaw).toBe(0);
  });

  it('sigue la mano que usó el gatillo', () => {
    // TEST-XRR-013: con dos mandos informando, el puntero tiene que estar en
    // el que el visitante usa; en el otro sería un rayo que no obedece.
    const runtime = new XrRuntime();
    const left: XrInputSnapshot = { handedness: 'left', buttons: [true], axes: [] };
    const right: XrInputSnapshot = { handedness: 'right', buttons: [], axes: [] };

    // El rayo de la izquierda apunta al panel; el de la derecha, al suelo.
    const down: XrRay = { origin: HEAD.position, direction: [0, -1, 0] };
    runtime.frame({ head: HEAD, inputs: [left, right], rays: [UPPER_RAY, down], panels: [panel('p')] });

    const second = runtime.frame({
      head: HEAD,
      inputs: [left, right],
      rays: [UPPER_RAY, down],
      panels: [panel('p')],
    });
    expect(second.hovered).toBe('p:arriba');
  });

  it('un fotograma sin mandos no falla', () => {
    // TEST-XRR-014: ocurre de verdad: al entrar en la sesión, el visor tarda
    // unos fotogramas en informar de los mandos, y con seguimiento de manos
    // puede no informar nunca.
    const runtime = new XrRuntime();
    const output = runtime.frame({ head: HEAD, inputs: [], rays: [], panels: [panel('p')] });

    expect(output.hovered).toBeNull();
    expect(output.activated).toEqual([]);
    expect(output.frames.size).toBe(1);
  });
});
