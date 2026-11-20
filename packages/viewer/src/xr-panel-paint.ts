/**
 * Pintado del panel inmersivo sobre la textura (N03, N08, N09, N10).
 *
 * El panel que ve el visitante en el visor es una imagen: este módulo la
 * dibuja. Trabaja contra una interfaz estrecha de lienzo 2D y no contra
 * `CanvasRenderingContext2D` entero, por dos razones. La primera es que así se
 * puede comprobar **qué** se dibuja —que el enunciado de una pregunta sale
 * antes que sus respuestas, que el texto se recorta en vez de desbordar, que
 * una puntuación muestra su valor— sin un lienzo real, que en el entorno de
 * pruebas no existe. La segunda es que deja a la vista la superficie que se
 * usa, que son nueve operaciones de dibujo: todo lo que entra en un panel
 * legible a dos metros.
 *
 * Las variables de texto se resuelven con el vocabulario del dominio, el mismo
 * que usa la versión plana: si aquí se escribiera otro, el mismo recorrido
 * diría cosas distintas en pantalla y en el visor.
 */
import { resolveVariables } from '@it360/domain';

import type { PanelLayout, PanelRow } from './xr-skin-panel';
import { PANEL_METRICS, PANEL_TEXTURE_HEIGHT, PANEL_TEXTURE_WIDTH } from './xr-skin-panel';

/**
 * Operaciones de lienzo que usa el panel.
 *
 * `CanvasRenderingContext2D` las cumple todas, de modo que en producción se le
 * pasa el contexto real sin adaptador.
 */
export interface Painter2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
  save(): void;
  restore(): void;
}

/** Colores del panel. Se derivan de la piel; aquí están los de reserva. */
export interface PanelPalette {
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentText: string;
}

/**
 * Paleta de reserva.
 *
 * Opaca y de contraste alto a propósito: un panel traslúcido sobre una
 * panorámica industrial —que puede ser blanca o casi negra según a dónde mire
 * el visitante— deja el texto ilegible la mitad del tiempo.
 */
export const DEFAULT_PANEL_PALETTE: PanelPalette = {
  background: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  textMuted: '#9aa7b2',
  accent: '#2f6feb',
  accentText: '#ffffff',
};

export interface PaintOptions {
  readonly palette?: PanelPalette;
  readonly width?: number;
  readonly height?: number;
  /** Variables del recorrido para las plantillas de texto. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Respuestas de la pregunta activa, en el orden de las zonas pulsables. */
  readonly quizOptions?: readonly string[];
  /** Enunciado de la pregunta activa. */
  readonly quizPrompt?: string;
  /** Respuesta ya elegida, para marcarla. */
  readonly quizChosen?: number | null;
  readonly scoreEntries?: readonly { readonly label: string; readonly value: string }[];
  /** Fracción de avance 0..1 para las barras. */
  readonly progress?: number;
  /** Texto del cronómetro ya formateado (N09). */
  readonly timerText?: string;
  /** Lecturas de telemetría, ya formateadas con su unidad. */
  readonly telemetryRows?: readonly { readonly label: string; readonly value: string }[];
  /** Zona a la que apunta el mando, para resaltarla. */
  readonly hoveredTargetId?: string | null;
}

const FONT_TITLE = '600 30px system-ui, sans-serif';
const FONT_BODY = '400 26px system-ui, sans-serif';
const FONT_LABEL = '500 24px system-ui, sans-serif';

/**
 * Pinta el panel completo.
 *
 * El orden importa: fondo, filas en orden de la pila y, dentro de cada fila,
 * su propio contenido. No se pinta nada fuera de la textura, porque la zona
 * pulsable correspondiente tampoco existe.
 */
export function paintPanel(ctx: Painter2D, layout: PanelLayout, options: PaintOptions = {}): void {
  const width = options.width ?? PANEL_TEXTURE_WIDTH;
  const height = options.height ?? PANEL_TEXTURE_HEIGHT;
  const palette = options.palette ?? DEFAULT_PANEL_PALETTE;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  for (const row of layout.rows) {
    if (row.y >= height) continue;
    paintRow(ctx, row, palette, options, height);
  }

  if (layout.overflow) {
    // Un panel que recorta contenido sin decirlo hace pensar que el recorrido
    // está incompleto. La marca es discreta pero está.
    ctx.fillStyle = palette.textMuted;
    ctx.font = FONT_LABEL;
    ctx.textAlign = 'center';
    ctx.fillText('···', width / 2, height - 18);
  }

  ctx.restore();
}

function paintRow(
  ctx: Painter2D,
  row: PanelRow,
  palette: PanelPalette,
  options: PaintOptions,
  height: number,
): void {
  const hovered = options.hoveredTargetId ?? null;

  switch (row.kind) {
    case 'text': {
      const config = row.node.config;
      const template = config.kind === 'text' ? config.template : '';
      ctx.fillStyle = palette.text;
      ctx.font = FONT_BODY;
      ctx.textAlign = 'left';
      fillClipped(ctx, resolve(template, options), row.x, row.y + row.height / 2, row.width);
      return;
    }

    case 'button': {
      const config = row.node.config;
      const label = config.kind === 'button' ? config.label : row.node.name;
      const isHovered = hovered === row.node.id;
      // El resalte del apuntado no es decoración: en VR, sin él no se sabe a
      // qué botón apunta el mando hasta que se pulsa.
      ctx.fillStyle = isHovered ? palette.accent : palette.surface;
      ctx.fillRect(row.x, row.y, row.width, row.height);
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 2;
      ctx.strokeRect(row.x, row.y, row.width, row.height);
      ctx.fillStyle = isHovered ? palette.accentText : palette.text;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      fillClipped(ctx, resolve(label, options), row.x + row.width / 2, row.y + row.height / 2, row.width - 24);
      return;
    }

    case 'image': {
      // La imagen se dibuja fuera, con `drawImage`, cuando el medio ya está
      // descargado; aquí queda su hueco, que es lo que evita que la pila baile
      // cuando la imagen llega tarde.
      ctx.fillStyle = palette.surface;
      ctx.fillRect(row.x, row.y, row.width, row.height);
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 2;
      ctx.strokeRect(row.x, row.y, row.width, row.height);
      return;
    }

    case 'progressBar': {
      const fraction = clamp01(options.progress ?? 0);
      const barHeight = 18;
      const top = row.y + (row.height - barHeight) / 2;
      ctx.fillStyle = palette.surface;
      ctx.fillRect(row.x, top, row.width, barHeight);
      ctx.fillStyle = palette.accent;
      ctx.fillRect(row.x, top, row.width * fraction, barHeight);
      const config = row.node.config;
      if (config.kind === 'progressBar' && config.showLabel) {
        ctx.fillStyle = palette.textMuted;
        ctx.font = FONT_LABEL;
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(fraction * 100)} %`, row.x + row.width, row.y + 14);
      }
      return;
    }

    case 'quizCard': {
      ctx.fillStyle = palette.text;
      ctx.font = FONT_TITLE;
      ctx.textAlign = 'left';
      fillClipped(
        ctx,
        options.quizPrompt ?? 'Pregunta',
        row.x,
        row.y + PANEL_METRICS.titleHeight / 2,
        row.width,
      );

      const options_ = options.quizOptions ?? [];
      for (const [index, hit] of row.hits.entries()) {
        if (hit.y >= height) break;
        const chosen = options.quizChosen === index;
        const isHovered = hovered === hit.id;
        ctx.fillStyle = chosen ? palette.accent : isHovered ? palette.border : palette.surface;
        ctx.fillRect(hit.x, hit.y, hit.width, hit.height);
        ctx.fillStyle = chosen ? palette.accentText : palette.text;
        ctx.font = FONT_BODY;
        ctx.textAlign = 'left';
        fillClipped(
          ctx,
          `${String.fromCharCode(65 + index)}.  ${options_[index] ?? ''}`,
          hit.x + 18,
          hit.y + hit.height / 2,
          hit.width - 36,
        );
      }
      return;
    }

    case 'scoreBoard': {
      ctx.fillStyle = palette.textMuted;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'left';
      ctx.fillText('Puntuación', row.x, row.y + PANEL_METRICS.titleHeight / 2);

      const entries = options.scoreEntries ?? [];
      entries.forEach((entry, index) => {
        const top = row.y + PANEL_METRICS.titleHeight + index * PANEL_METRICS.rowHeight;
        if (top >= height) return;
        ctx.fillStyle = palette.text;
        ctx.font = FONT_BODY;
        ctx.textAlign = 'left';
        fillClipped(ctx, entry.label, row.x, top + PANEL_METRICS.rowHeight / 2, row.width * 0.7);
        ctx.textAlign = 'right';
        ctx.fillText(entry.value, row.x + row.width, top + PANEL_METRICS.rowHeight / 2);
      });
      return;
    }

    case 'timer': {
      ctx.fillStyle = palette.text;
      ctx.font = FONT_TITLE;
      ctx.textAlign = 'center';
      ctx.fillText(options.timerText ?? '00:00', row.x + row.width / 2, row.y + row.height / 2);
      return;
    }

    case 'telemetryPanel':
    case 'assetPanel': {
      ctx.fillStyle = palette.textMuted;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'left';
      fillClipped(ctx, row.node.name, row.x, row.y + PANEL_METRICS.titleHeight / 2, row.width);

      const rows = options.telemetryRows ?? [];
      rows.slice(0, 2).forEach((entry, index) => {
        const top = row.y + PANEL_METRICS.titleHeight + index * PANEL_METRICS.rowHeight;
        ctx.fillStyle = palette.text;
        ctx.font = FONT_BODY;
        ctx.textAlign = 'left';
        fillClipped(ctx, entry.label, row.x, top + PANEL_METRICS.rowHeight / 2, row.width * 0.6);
        ctx.textAlign = 'right';
        ctx.fillText(entry.value, row.x + row.width, top + PANEL_METRICS.rowHeight / 2);
      });
      return;
    }

    case 'thumbnailList': {
      const isHovered = hovered === row.node.id;
      ctx.fillStyle = isHovered ? palette.border : palette.surface;
      ctx.fillRect(row.x, row.y, row.width, row.height);
      ctx.fillStyle = palette.textMuted;
      ctx.font = FONT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('Escenas', row.x + row.width / 2, row.y + row.height / 2);
      return;
    }

    default:
      // `spacer` y el resto del subconjunto no pintan nada: ocupan sitio.
      return;
  }
}

/**
 * Escribe recortando por ancho.
 *
 * Sin recorte, un texto largo se sale del panel y en VR el desbordamiento no
 * se ve como un texto cortado sino como texto flotando en el aire al lado del
 * panel, que es desconcertante. El recorte añade puntos suspensivos para que
 * se sepa que falta texto.
 */
export function fillClipped(ctx: Painter2D, text: string, x: number, y: number, maxWidth: number): void {
  if (maxWidth <= 0) return;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, middle).trimEnd()}…`;
    if (ctx.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  ctx.fillText(low > 0 ? `${text.slice(0, low).trimEnd()}…` : '…', x, y);
}

function resolve(template: string, options: PaintOptions): string {
  const variables = options.variables;
  if (variables === undefined) return template;
  return resolveVariables(template, variables);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
