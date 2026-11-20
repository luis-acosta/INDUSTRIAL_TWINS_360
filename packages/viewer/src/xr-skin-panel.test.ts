/**
 * Pruebas de la maquetación de la piel dentro del visor.
 *
 * Lo que se verifica es que la pila respeta las decisiones del autor donde VR
 * puede respetarlas —qué se ve, en qué orden, qué se puede pulsar— y que no
 * promete lo que no puede: un componente sin equivalente en VR no aparece, y
 * una zona pulsable demasiado pequeña se puede avisar antes de publicar.
 */
import { describe, expect, it } from 'vitest';

import { createNode, type ComponentKind, type SkinNode } from '@it360/domain';

import { EMPTY_SKIN_STATE } from './skin-layout';
import {
  PANEL_METRICS,
  PANEL_TEXTURE_HEIGHT,
  PANEL_TEXTURE_WIDTH,
  layoutVrPanel,
  panelTargets,
  smallTargets,
  type PanelContext,
} from './xr-skin-panel';

let counter = 0;
function node(kind: ComponentKind, overrides: Partial<SkinNode> = {}): SkinNode {
  counter += 1;
  return {
    ...createNode({ kind, taken: new Set<string>(), name: `${kind}-${counter}` }),
    ...overrides,
  };
}

const context: PanelContext = { state: EMPTY_SKIN_STATE, sceneId: null };

describe('layoutVrPanel', () => {
  it('apila las filas en orden de declaración', () => {
    // TEST-XRK-001: el orden es la única variable de posición que VR conserva,
    // de modo que tiene que ser exactamente el que compuso el autor.
    const layout = layoutVrPanel([node('text'), node('button'), node('text')], context);

    expect(layout.rows.map((row) => row.kind)).toEqual(['text', 'button', 'text']);
    expect(layout.rows[0]!.y).toBe(PANEL_METRICS.padding);
    expect(layout.rows[1]!.y).toBe(
      PANEL_METRICS.padding + PANEL_METRICS.rowHeight + PANEL_METRICS.gap,
    );
  });

  it('descarta los componentes sin equivalente en VR', () => {
    // TEST-XRK-002: un desplegable o una vista de plano no se manejan con un
    // mando a tres metros. Dibujarlos daría una interfaz que parece completa y
    // no responde, que es peor que una interfaz reducida y honesta.
    const layout = layoutVrPanel([node('dropdown'), node('planView'), node('text')], context);
    expect(layout.rows.map((row) => row.kind)).toEqual(['text']);
  });

  it('respeta la visibilidad por dispositivo que fijó el autor', () => {
    // TEST-XRK-003: es el requisito N06. Un componente excluido de VR no
    // aparece aunque su tipo sea compatible.
    const excluded = node('text', {
      visibility: { desktop: true, tablet: true, mobile: true, vr: false },
    });
    const layout = layoutVrPanel([excluded, node('button')], context);
    expect(layout.rows.map((row) => row.kind)).toEqual(['button']);
  });

  it('sangra los hijos de un contenedor sin dejar una franja vacía', () => {
    // TEST-XRK-004: en una pila vertical, un contenedor con alto propio sería
    // un hueco. Lo que aporta es la agrupación, y eso se lee en el sangrado.
    const container = node('container', {
      children: [node('text'), node('button')],
    });
    const layout = layoutVrPanel([container], context);

    expect(layout.rows.map((row) => row.kind)).toEqual(['text', 'button']);
    expect(layout.rows[0]!.x).toBeGreaterThan(PANEL_METRICS.padding);
    expect(layout.rows[0]!.depth).toBe(1);
  });

  it('un contenedor oculto se lleva a sus hijos', () => {
    // TEST-XRK-005: si los hijos siguieran apareciendo, ocultar un grupo en VR
    // no ocultaría nada.
    const container = node('container', {
      visibility: { desktop: true, tablet: true, mobile: true, vr: false },
      children: [node('text')],
    });
    expect(layoutVrPanel([container], context).rows).toEqual([]);
  });

  it('dimensiona la tarjeta de pregunta según sus respuestas', () => {
    // TEST-XRK-006: es el requisito N08. Un alto fijo dejaría las últimas
    // respuestas fuera del panel, es decir, sin poder contestarse.
    const quiz = node('quizCard');
    const withOptions = layoutVrPanel([quiz], {
      ...context,
      quizOptions: ['Parada de emergencia', 'Bloqueo y etiquetado', 'Aviso al supervisor'],
    });

    expect(withOptions.rows[0]!.height).toBeGreaterThan(PANEL_METRICS.titleHeight);
    expect(withOptions.rows[0]!.hits).toHaveLength(3);
    expect(withOptions.rows[0]!.hits.map((hit) => hit.id)).toEqual([
      `${quiz.id}:0`,
      `${quiz.id}:1`,
      `${quiz.id}:2`,
    ]);
  });

  it('las respuestas no se solapan entre sí', () => {
    // TEST-XRK-007: con rectángulos solapados, apuntar a una respuesta podría
    // contestar la de al lado, y el visitante no sabría por qué ha fallado.
    const layout = layoutVrPanel([node('quizCard')], {
      ...context,
      quizOptions: ['A', 'B', 'C', 'D'],
    });
    const hits = layout.rows[0]!.hits;
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i]!.y).toBeGreaterThanOrEqual(hits[i - 1]!.y + hits[i - 1]!.height);
    }
  });

  it('dimensiona la puntuación según las entradas mostradas', () => {
    // TEST-XRK-008: es el requisito N09. Con tres puntuaciones y el alto de
    // una, dos quedarían recortadas.
    const layout = layoutVrPanel([node('scoreBoard')], {
      ...context,
      scoreEntries: [
        { label: 'Seguridad', value: '8' },
        { label: 'Procedimiento', value: '5' },
      ],
    });
    expect(layout.rows[0]!.height).toBe(PANEL_METRICS.titleHeight + PANEL_METRICS.rowHeight * 2);
  });

  it('un botón siempre es pulsable y un texto sin acciones no', () => {
    // TEST-XRK-009: una zona pulsable sin acción enseña al visitante a
    // apuntar a sitios que no responden, y entonces deja de apuntar.
    const layout = layoutVrPanel([node('button'), node('text')], context);
    expect(layout.rows[0]!.hits).toHaveLength(1);
    expect(layout.rows[1]!.hits).toHaveLength(0);
  });

  it('señala el desbordamiento del panel', () => {
    // TEST-XRK-010: en pantalla la piel se desplaza; en VR el panel tiene el
    // tamaño que el autor le dio. Saber que el contenido no cabe permite
    // avisarlo en el editor en lugar de recortarlo en silencio.
    const many = Array.from({ length: 20 }, () => node('button'));
    const layout = layoutVrPanel(many, context);
    expect(layout.overflow).toBe(true);
    expect(layout.contentHeight).toBeGreaterThan(PANEL_TEXTURE_HEIGHT);
  });
});

describe('panelTargets', () => {
  it('normaliza las zonas al rectángulo del panel', () => {
    // TEST-XRK-011: el corte del rayo llega en 0..1 y la textura trabaja en
    // píxeles. Si la conversión estuviera repartida entre los dos módulos,
    // bastaría cambiar el tamaño de la textura para descuadrar los botones.
    const layout = layoutVrPanel([node('button')], context);
    const [target] = panelTargets(layout);

    expect(target!.u0).toBeCloseTo(PANEL_METRICS.padding / PANEL_TEXTURE_WIDTH, 6);
    expect(target!.v0).toBeCloseTo(PANEL_METRICS.padding / PANEL_TEXTURE_HEIGHT, 6);
    expect(target!.u1).toBeLessThanOrEqual(1);
    expect(target!.v1).toBeLessThanOrEqual(1);
  });

  it('descarta las zonas que quedan fuera de la textura', () => {
    // TEST-XRK-012: lo que no se pinta no se puede pulsar; un botón invisible
    // pero activo es la peor combinación posible.
    const many = Array.from({ length: 30 }, () => node('button'));
    const layout = layoutVrPanel(many, context);
    const targets = panelTargets(layout);

    expect(targets.length).toBeLessThan(30);
    for (const target of targets) expect(target.v0).toBeLessThan(1);
  });

  it('recorta la zona que cruza el borde inferior', () => {
    // TEST-XRK-013: la mitad visible sigue siendo pulsable, pero no más allá
    // del panel: el rayo no corta fuera del rectángulo.
    const layout = layoutVrPanel(Array.from({ length: 9 }, () => node('button')), context);
    for (const target of panelTargets(layout)) expect(target.v1).toBeLessThanOrEqual(1);
  });
});

describe('smallTargets', () => {
  it('no señala nada con las medidas por defecto', () => {
    // TEST-XRK-014: si las propias medidas del módulo produjeran objetivos
    // inalcanzables, el aviso sería ruido en todos los recorridos.
    const layout = layoutVrPanel([node('button'), node('quizCard')], {
      ...context,
      quizOptions: ['A', 'B'],
    });
    expect(smallTargets(layout)).toEqual([]);
  });

  it('señala una zona más baja que el umbral del mando', () => {
    // TEST-XRK-015: medio centímetro aparente a dos metros no se acierta con
    // el temblor natural de la mano.
    const layout = layoutVrPanel([node('thumbnailList')], context);
    const tiny = {
      ...layout,
      rows: [{ ...layout.rows[0]!, hits: [{ ...layout.rows[0]!.hits[0]!, height: 20 }] }],
    };
    expect(smallTargets(tiny)).toHaveLength(1);
  });
});
