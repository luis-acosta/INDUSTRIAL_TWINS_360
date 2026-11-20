/**
 * Pruebas de los paneles inmersivos.
 *
 * La aritmética se comprueba con cifras que se pueden razonar a mano: un panel
 * a 2 m delante del observador, un rayo recto, un giro de 90°. Si estas
 * pruebas usaran valores arbitrarios comprobarían que el código hace lo que
 * hace, no que hace lo correcto.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_VR_PANEL, type VrPanelPlacement } from './webxr';
import {
  RECENTER_THRESHOLD_RAD,
  anchorFor,
  dragAnchor,
  intersectPanel,
  interactivePanels,
  normalizeAngle,
  panelFrame,
  targetAt,
  updateAnchor,
  type HeadPose,
} from './xr-panel';

const placement = (overrides: Partial<VrPanelPlacement> = {}): VrPanelPlacement => ({
  ...DEFAULT_VR_PANEL,
  distanceM: 2,
  widthM: 1,
  heightM: 0.5,
  yawOffset: 0,
  pitchOffset: 0,
  ...overrides,
});

const head = (yaw: number, y = 0): HeadPose => ({ position: [0, y, 0], yaw });

describe('panelFrame', () => {
  it('coloca el panel delante del observador a la distancia pedida', () => {
    // TEST-XRP-001: yaw 0 mira a −Z en la convención de Three. Un signo
    // equivocado pone el panel a la espalda, donde el visitante no lo
    // encuentra y concluye que la plataforma no abre paneles en VR.
    const frame = panelFrame(placement(), anchorFor(placement(), head(0)));

    expect(frame.center[0]).toBeCloseTo(0, 6);
    expect(frame.center[1]).toBeCloseTo(0, 6);
    expect(frame.center[2]).toBeCloseTo(-2, 6);
    expect(frame.normal[2]).toBeCloseTo(1, 6);
  });

  it('sigue el giro del ancla', () => {
    // TEST-XRP-002: con el observador mirando a 90° a la izquierda, el panel
    // tiene que estar a su izquierda y no seguir clavado al norte.
    const place = placement();
    const frame = panelFrame(place, anchorFor(place, head(Math.PI / 2)));

    expect(frame.center[0]).toBeCloseTo(-2, 6);
    expect(frame.center[2]).toBeCloseTo(0, 6);
  });

  it('respeta el desplazamiento angular y el tamaño', () => {
    // TEST-XRP-003: son los ajustes de N04. Si no se aplicaran, el editor
    // ofrecería campos que no cambian nada, que es el defecto que más veces
    // ha aparecido en este proyecto.
    const place = placement({ widthM: 2, heightM: 1, yawOffset: Math.PI / 2 });
    const frame = panelFrame(place, anchorFor(place, head(0)));

    expect(frame.center[0]).toBeCloseTo(-2, 6);
    expect(Math.hypot(...frame.right)).toBeCloseTo(1, 6);
    expect(Math.hypot(...frame.up)).toBeCloseTo(0.5, 6);
  });

  it('mantiene el eje horizontal a nivel con el panel inclinado', () => {
    // TEST-XRP-004: un panel inclinado hacia abajo debe seguir leyéndose
    // horizontal. Si el eje horizontal se inclinara, el texto saldría
    // escorado aunque el panel mire de frente.
    const place = placement({ pitchOffset: -0.4 });
    const frame = panelFrame(place, anchorFor(place, head(0)));

    expect(frame.right[1]).toBeCloseTo(0, 6);
    expect(frame.center[1]).toBeLessThan(0);
  });

  it('eleva el panel a la altura de la cabeza', () => {
    // TEST-XRP-005: con «local-floor» la cabeza está a 1,6 m del suelo. Un
    // panel colocado en el origen quedaría a la altura de los tobillos.
    const place = placement();
    const frame = panelFrame(place, anchorFor(place, head(0, 1.6)));
    expect(frame.center[1]).toBeCloseTo(1.6, 6);
  });
});

describe('updateAnchor', () => {
  it('un panel fijo en el mundo no se mueve', () => {
    // TEST-XRP-006: el panel pertenece al sitio; es la diferencia entre una
    // etiqueta sobre una bomba y un rótulo flotante.
    const place = placement({ mode: 'worldFixed' });
    const anchor = anchorFor(place, head(0));
    expect(updateAnchor(anchor, head(Math.PI))).toEqual(anchor);
  });

  it('un panel recentrable aguanta el giro cómodo del cuello', () => {
    // TEST-XRP-007: si persiguiera la mirada, no se podría mirar la escena
    // sin el panel delante, y eso marea.
    const place = placement({ mode: 'recentering' });
    const anchor = anchorFor(place, head(0));
    const small = updateAnchor(anchor, head(RECENTER_THRESHOLD_RAD - 0.05));
    expect(small.yaw).toBe(0);
  });

  it('un panel recentrable se recoloca al salir del cono', () => {
    // TEST-XRP-008: y entonces sí se mueve, porque un panel que se queda a la
    // espalda del visitante es un panel perdido.
    const place = placement({ mode: 'recentering' });
    const anchor = anchorFor(place, head(0));
    const big = updateAnchor(anchor, head(RECENTER_THRESHOLD_RAD + 0.2));
    expect(big.yaw).toBeCloseTo(RECENTER_THRESHOLD_RAD + 0.2, 6);
  });

  it('un panel recentrable acompaña al visitante que camina', () => {
    // TEST-XRP-009: el giro no cambia, pero la posición sí: en un visor con
    // seguimiento de sala, dos pasos dejarían el panel detrás.
    const place = placement({ mode: 'recentering' });
    const anchor = anchorFor(place, head(0));
    const moved = updateAnchor(anchor, { position: [1, 1.6, -1], yaw: 0 });
    expect(moved.headPosition).toEqual([1, 1.6, -1]);
    expect(moved.yaw).toBe(0);
  });

  it('un modal está siempre delante', () => {
    // TEST-XRP-010: bloquea el recorrido; si quedara fuera de la vista, el
    // visitante no encontraría el botón de cerrar y se quedaría encerrado.
    const place = placement({ mode: 'modal' });
    const anchor = anchorFor(place, head(0));
    const turned = updateAnchor(anchor, head(2.5));
    expect(turned.yaw).toBeCloseTo(2.5, 6);
  });
});

describe('intersectPanel', () => {
  const place = placement();
  const frame = panelFrame(place, anchorFor(place, head(0)));

  it('corta el centro del panel', () => {
    // TEST-XRP-011: el rayo recto desde el origen da el centro exacto, que es
    // u=0,5 v=0,5 y la distancia pedida.
    const hit = intersectPanel([0, 0, 0], [0, 0, -1], frame);
    expect(hit).not.toBeNull();
    expect(hit?.u).toBeCloseTo(0.5, 6);
    expect(hit?.v).toBeCloseTo(0.5, 6);
    expect(hit?.distanceM).toBeCloseTo(2, 6);
  });

  it('da v=0 arriba, como el lienzo', () => {
    // TEST-XRP-012: las zonas pulsables se declaran en las mismas
    // coordenadas en que se pinta la textura. Invertir el eje vertical
    // haría que pulsar arriba activara el botón de abajo.
    const up = intersectPanel([0, 0.2, 0], [0, 0, -1], frame);
    expect(up?.v).toBeLessThan(0.5);
  });

  it('no corta por detrás del panel', () => {
    // TEST-XRP-013: apuntar a la espalda de un panel no debe activar sus
    // botones, que es lo que ocurriría al ignorar el sentido de la normal.
    expect(intersectPanel([0, 0, -4], [0, 0, 1], frame)).toBeNull();
  });

  it('no corta fuera del rectángulo', () => {
    // TEST-XRP-014: un panel de 1 m de ancho a 2 m acaba a 0,5 m del centro;
    // apuntar a 0,6 m es fallar, y tratarlo como acierto activaría botones
    // apuntando al vacío.
    expect(intersectPanel([0.6, 0, 0], [0, 0, -1], frame)).toBeNull();
    expect(intersectPanel([0.4, 0, 0], [0, 0, -1], frame)).not.toBeNull();
  });

  it('no corta un rayo paralelo', () => {
    // TEST-XRP-015: el denominador se anula y el resultado sería infinito.
    expect(intersectPanel([0, 0, 0], [1, 0, 0], frame)).toBeNull();
  });
});

describe('targetAt', () => {
  const targets = [
    { id: 'fondo', u0: 0, v0: 0, u1: 1, v1: 1 },
    { id: 'aceptar', u0: 0.1, v0: 0.7, u1: 0.45, v1: 0.9 },
    { id: 'cerrar', u0: 0.55, v0: 0.7, u1: 0.9, v1: 0.9, enabled: false },
  ];

  it('devuelve la zona superior cuando se solapan', () => {
    // TEST-XRP-016: el fondo cubre todo el panel. Si ganara, ningún botón
    // sería pulsable.
    const target = targetAt({ distanceM: 2, u: 0.2, v: 0.8 }, targets);
    expect(target?.id).toBe('aceptar');
  });

  it('ignora una zona deshabilitada y cae a la de debajo', () => {
    // TEST-XRP-017: un botón atenuado no se pulsa, pero tampoco debe tragarse
    // la pulsación: lo que hay debajo sigue siendo válido.
    const target = targetAt({ distanceM: 2, u: 0.7, v: 0.8 }, targets);
    expect(target?.id).toBe('fondo');
  });

  it('devuelve null fuera de toda zona', () => {
    // TEST-XRP-018: con una lista sin fondo, apuntar a un hueco no activa
    // nada.
    expect(targetAt({ distanceM: 2, u: 0.5, v: 0.5 }, targets.slice(1))).toBeNull();
  });
});

describe('interactivePanels', () => {
  it('un modal abierto bloquea la entrada del resto', () => {
    // TEST-XRP-019: un «modal» que no bloquea es peor que no tenerlo: el
    // visitante responde una pregunta y a la vez cambia de escena sin saberlo.
    const panels = [
      { id: 'a', placement: placement({ mode: 'recentering' }) },
      { id: 'b', placement: placement({ mode: 'modal' }) },
      { id: 'c', placement: placement({ mode: 'worldFixed' }) },
    ];
    expect(interactivePanels(panels).map((p) => p.id)).toEqual(['b']);
  });

  it('con dos modales manda el último abierto', () => {
    // TEST-XRP-020: una pregunta que abre una confirmación: responde la de
    // encima.
    const panels = [
      { id: 'a', placement: placement({ mode: 'modal' }) },
      { id: 'b', placement: placement({ mode: 'modal' }) },
    ];
    expect(interactivePanels(panels).map((p) => p.id)).toEqual(['b']);
  });

  it('sin modales todos admiten entrada', () => {
    // TEST-XRP-021: varios paneles abiertos a la vez son el caso normal de un
    // panel de datos junto a una ficha de equipo.
    const panels = [
      { id: 'a', placement: placement({ mode: 'recentering' }) },
      { id: 'b', placement: placement({ mode: 'worldFixed' }) },
    ];
    expect(interactivePanels(panels)).toHaveLength(2);
  });
});

describe('dragAnchor', () => {
  it('arrastra sólo los paneles arrastrables', () => {
    // TEST-XRP-022: arrastrar un panel fijo al mundo lo desancla del sitio al
    // que pertenece, y arrastrar un modal lo saca de la vista.
    const fixed = anchorFor(placement({ mode: 'worldFixed' }), head(0));
    expect(dragAnchor(fixed, 0.5, 0.5)).toEqual(fixed);

    const free = anchorFor(placement({ mode: 'draggable' }), head(0));
    expect(dragAnchor(free, 0.5, 0.1).dragYaw).toBeCloseTo(0.5, 6);
  });

  it('limita la inclinación del arrastre', () => {
    // TEST-XRP-023: sin tope, el panel acaba en el cenit o bajo los pies, y
    // recuperarlo desde ahí es imposible con el mando.
    const free = anchorFor(placement({ mode: 'draggable' }), head(0));
    expect(dragAnchor(free, 0, 5).dragPitch).toBeCloseTo(0.9, 6);
    expect(dragAnchor(free, 0, -5).dragPitch).toBeCloseTo(-0.9, 6);
  });

  it('el arrastre horizontal da la vuelta completa', () => {
    // TEST-XRP-024: en horizontal no hay tope porque girar sobre el eje
    // vertical siempre devuelve el panel a la vista.
    const free = anchorFor(placement({ mode: 'draggable' }), head(0));
    const turned = dragAnchor(free, Math.PI * 1.5, 0);
    expect(normalizeAngle(turned.dragYaw)).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('normalizeAngle', () => {
  it('reduce al intervalo [−π, π)', () => {
    // TEST-XRP-025: el umbral de recentrado compara diferencias de giro. Sin
    // normalizar, cruzar el norte daría una diferencia de casi 2π y el panel
    // se recolocaría girando un grado.
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 6);
    expect(normalizeAngle(-3.2 * Math.PI)).toBeCloseTo(0.8 * Math.PI, 6);
    expect(normalizeAngle(0.3)).toBeCloseTo(0.3, 6);
  });
});
