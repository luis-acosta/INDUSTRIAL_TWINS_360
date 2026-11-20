/**
 * Pruebas del pintado del panel inmersivo.
 *
 * El lienzo se sustituye por uno que registra las operaciones. No es un atajo
 * por no tener WebGL: lo que se quiere comprobar es que el panel dibuja el
 * contenido correcto en el sitio correcto —el enunciado antes que las
 * respuestas, la puntuación con su valor, el texto recortado en vez de
 * desbordado—, y eso son exactamente las operaciones que se registran. El
 * aspecto final a dos metros dentro de unas gafas no lo puede verificar
 * ninguna prueba automática, y por eso los requisitos que dependen de verlo
 * quedan marcados como experimentales.
 */
import { describe, expect, it } from 'vitest';

import { createNode, type ComponentKind, type SkinNode } from '@it360/domain';

import { EMPTY_SKIN_STATE } from './skin-layout';
import { DEFAULT_PANEL_PALETTE, fillClipped, paintPanel, type Painter2D } from './xr-panel-paint';
import { layoutVrPanel, type PanelContext } from './xr-skin-panel';

interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fill: string;
}

interface RectCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/**
 * Lienzo que registra lo dibujado.
 *
 * `measureText` estima 13 px por carácter, que es lo que mide la fuente del
 * panel a 26 px. No necesita ser exacto: lo que se comprueba es que el recorte
 * ocurre, no cuántos caracteres caben en una tipografía concreta.
 */
function recorder(): Painter2D & { readonly texts: TextCall[]; readonly rects: RectCall[] } {
  const texts: TextCall[] = [];
  const rects: RectCall[] = [];
  return {
    texts,
    rects,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
    clearRect() {},
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, fill: this.fillStyle });
    },
    strokeRect() {},
    fillText(text, x, y) {
      texts.push({ text, x, y, fill: this.fillStyle });
    },
    measureText(text) {
      return { width: text.length * 13 };
    },
    save() {},
    restore() {},
  };
}

let counter = 0;
function node(kind: ComponentKind, overrides: Partial<SkinNode> = {}): SkinNode {
  counter += 1;
  return {
    ...createNode({ kind, taken: new Set<string>(), name: `${kind}-${counter}` }),
    ...overrides,
  };
}

const context: PanelContext = { state: EMPTY_SKIN_STATE, sceneId: null };

describe('paintPanel', () => {
  it('pinta un fondo opaco antes del contenido', () => {
    // TEST-XRD-001: un panel traslúcido sobre una panorámica industrial —que
    // puede ser casi blanca o casi negra según a dónde mire el visitante—
    // deja el texto ilegible la mitad del tiempo.
    const ctx = recorder();
    paintPanel(ctx, layoutVrPanel([node('text')], context));

    expect(ctx.rects[0]).toMatchObject({ x: 0, y: 0, fill: DEFAULT_PANEL_PALETTE.background });
  });

  it('resuelve las variables del recorrido en el texto', () => {
    // TEST-XRD-002: el vocabulario es el del dominio, el mismo que la versión
    // plana. Con otro, el mismo recorrido diría cosas distintas en pantalla y
    // en el visor, que fue un defecto real de este proyecto.
    const ctx = recorder();
    const text = node('text', {
      config: { kind: 'text', template: 'Escena {{scene.index}} de {{scene.total}}', markdown: false },
    });

    paintPanel(ctx, layoutVrPanel([text], context), {
      variables: { 'scene.index': '2', 'scene.total': '7' },
    });

    expect(ctx.texts.map((call) => call.text)).toContain('Escena 2 de 7');
  });

  it('resalta el botón al que apunta el mando', () => {
    // TEST-XRD-003: en VR no hay cursor ni puntero del sistema. Sin resalte,
    // no se sabe a qué botón se apunta hasta haberlo pulsado.
    const base = node('button');
    const button: SkinNode = {
      ...base,
      config: base.config.kind === 'button' ? { ...base.config, label: 'Siguiente' } : base.config,
    };
    const layout = layoutVrPanel([button], context);

    const plain = recorder();
    paintPanel(plain, layout);
    const highlighted = recorder();
    paintPanel(highlighted, layout, { hoveredTargetId: button.id });

    const plainFill = plain.rects.find((rect) => rect.y > 0)?.fill;
    const hoverFill = highlighted.rects.find((rect) => rect.y > 0)?.fill;
    expect(plainFill).toBe(DEFAULT_PANEL_PALETTE.surface);
    expect(hoverFill).toBe(DEFAULT_PANEL_PALETTE.accent);
  });

  it('pinta el enunciado por encima de las respuestas', () => {
    // TEST-XRD-004: es el requisito N08. Las respuestas se pintan en los
    // mismos rectángulos que declaran las zonas pulsables, de modo que lo que
    // se ve y lo que responde al mando no pueden separarse.
    const ctx = recorder();
    const layout = layoutVrPanel([node('quizCard')], {
      ...context,
      quizOptions: ['Parar la línea', 'Avisar al turno'],
    });

    paintPanel(ctx, layout, {
      quizPrompt: '¿Qué se hace primero?',
      quizOptions: ['Parar la línea', 'Avisar al turno'],
    });

    const prompt = ctx.texts.find((call) => call.text.includes('¿Qué se hace primero?'));
    const first = ctx.texts.find((call) => call.text.includes('Parar la línea'));
    const second = ctx.texts.find((call) => call.text.includes('Avisar al turno'));
    expect(prompt).toBeDefined();
    expect(first!.y).toBeGreaterThan(prompt!.y);
    expect(second!.y).toBeGreaterThan(first!.y);
  });

  it('marca la respuesta elegida', () => {
    // TEST-XRD-005: sin marca, el visitante no sabe si su pulsación se
    // registró y vuelve a pulsar, lo que en una evaluación cuenta como otra
    // respuesta.
    const ctx = recorder();
    const layout = layoutVrPanel([node('quizCard')], { ...context, quizOptions: ['A', 'B'] });

    paintPanel(ctx, layout, { quizOptions: ['A', 'B'], quizChosen: 1 });

    const accented = ctx.rects.filter((rect) => rect.fill === DEFAULT_PANEL_PALETTE.accent);
    expect(accented).toHaveLength(1);
  });

  it('muestra cada puntuación con su valor', () => {
    // TEST-XRD-006: es el requisito N09. Una etiqueta sin su valor es un
    // panel que no informa de nada.
    const ctx = recorder();
    const entries = [
      { label: 'Seguridad', value: '8/10' },
      { label: 'Procedimiento', value: '5/10' },
    ];
    const layout = layoutVrPanel([node('scoreBoard')], { ...context, scoreEntries: entries });

    paintPanel(ctx, layout, { scoreEntries: entries });

    const written = ctx.texts.map((call) => call.text);
    expect(written).toContain('Seguridad');
    expect(written).toContain('8/10');
    expect(written).toContain('Procedimiento');
    expect(written).toContain('5/10');
  });

  it('dibuja la barra de avance proporcional al progreso', () => {
    // TEST-XRD-007: una barra que no cambia con el avance es un adorno. Se
    // comprueba la anchura pintada, que es lo que el visitante interpreta.
    const layout = layoutVrPanel([node('progressBar')], context);

    const quarter = recorder();
    paintPanel(quarter, layout, { progress: 0.25 });
    const full = recorder();
    paintPanel(full, layout, { progress: 1 });

    const fill = (ctx: ReturnType<typeof recorder>): number =>
      ctx.rects.filter((rect) => rect.fill === DEFAULT_PANEL_PALETTE.accent)[0]?.w ?? 0;
    expect(fill(full)).toBeGreaterThan(fill(quarter) * 3);
  });

  it('acota el progreso fuera de rango', () => {
    // TEST-XRD-008: una fracción mayor que uno pintaría la barra más allá del
    // panel, y en VR eso se ve como una franja de color flotando en el aire.
    const ctx = recorder();
    const layout = layoutVrPanel([node('progressBar')], context);
    paintPanel(ctx, layout, { progress: 4 });

    const bar = ctx.rects.filter((rect) => rect.fill === DEFAULT_PANEL_PALETTE.accent)[0]!;
    expect(bar.w).toBeLessThanOrEqual(layout.rows[0]!.width);
  });

  it('muestra el cronómetro ya formateado', () => {
    // TEST-XRD-009: el formato lo decide quien lleva el tiempo; el panel no
    // debe inventar un segundo formato que discrepe del de la versión plana.
    const ctx = recorder();
    paintPanel(ctx, layoutVrPanel([node('timer')], context), { timerText: '04:31' });
    expect(ctx.texts.map((call) => call.text)).toContain('04:31');
  });

  it('no pinta las filas que caen fuera de la textura', () => {
    // TEST-XRD-010: dibujar fuera cuesta tiempo de GPU en un visor que tiene
    // que sostener 72 fps, y no se ve.
    const ctx = recorder();
    const layout = layoutVrPanel(Array.from({ length: 40 }, () => node('button')), context);

    paintPanel(ctx, layout);

    for (const rect of ctx.rects) expect(rect.y).toBeLessThan(666);
  });

  it('avisa cuando el contenido no cabe', () => {
    // TEST-XRD-011: un panel que recorta en silencio hace pensar que el
    // recorrido está incompleto.
    const ctx = recorder();
    const layout = layoutVrPanel(Array.from({ length: 40 }, () => node('button')), context);
    paintPanel(ctx, layout);
    expect(ctx.texts.map((call) => call.text)).toContain('···');
  });
});

describe('fillClipped', () => {
  it('escribe el texto completo cuando cabe', () => {
    // TEST-XRD-012: recortar lo que cabe añadiría puntos suspensivos a un
    // texto íntegro, que es una mentira tipográfica.
    const ctx = recorder();
    fillClipped(ctx, 'Bomba P-101', 0, 0, 1000);
    expect(ctx.texts[0]!.text).toBe('Bomba P-101');
  });

  it('recorta con puntos suspensivos cuando no cabe', () => {
    // TEST-XRD-013: en VR el desbordamiento no se ve como texto cortado sino
    // como texto flotando al lado del panel.
    const ctx = recorder();
    fillClipped(ctx, 'Procedimiento de bloqueo y etiquetado de la línea principal', 0, 0, 130);

    const written = ctx.texts[0]!.text;
    expect(written.endsWith('…')).toBe(true);
    expect(written.length).toBeLessThan(20);
  });

  it('no escribe nada con ancho nulo', () => {
    // TEST-XRD-014: un ancho cero o negativo sale de una fila degenerada; la
    // búsqueda del recorte no debe entrar en bucle con él.
    const ctx = recorder();
    fillClipped(ctx, 'texto', 0, 0, 0);
    expect(ctx.texts).toEqual([]);
  });

  it('deja al menos los puntos suspensivos con un ancho mínimo', () => {
    // TEST-XRD-015: con sitio para un solo carácter, lo honesto es el signo
    // de que falta texto y no un carácter suelto sin sentido.
    const ctx = recorder();
    fillClipped(ctx, 'Procedimiento', 0, 0, 12);
    expect(ctx.texts[0]!.text).toBe('…');
  });
});
