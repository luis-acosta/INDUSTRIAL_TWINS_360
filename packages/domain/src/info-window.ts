/**
 * Ventanas de información (E01, con pestañas F08 y texto dinámico F09).
 *
 * Es la vía por la que el contenido técnico llega al visitante: la ficha de
 * una bomba, el procedimiento de arranque, el vídeo de un montaje, el mapa de
 * la planta. La acción `openInfoWindow` existía desde el principio y apuntaba
 * a un identificador que no correspondía a nada; esto es lo que faltaba.
 *
 * Tres decisiones que conviene no reconstruir a mano más adelante.
 *
 * **El texto no es HTML.** Un campo de HTML en manos del autor es una
 * inyección de guiones esperando a que alguien pegue contenido de un correo.
 * Lo que se admite es un subconjunto diminuto —párrafos, negrita, cursiva,
 * código, listas y enlaces https— que se analiza aquí y se pinta como
 * elementos, nunca como marcado. No es Markdown y no se llama Markdown: es
 * texto con formato sencillo, y lo que no esté en la lista sale tal cual.
 *
 * **Las variables se resuelven con lo que hay.** `{{escena}}` y
 * `{{puntuacion}}` dejan al autor escribir un texto que sirve para veinte
 * escenas. Una variable que no existe se queda vacía en el visor —el visitante
 * no tiene por qué leer las llaves— pero la validación del editor la denuncia,
 * que es donde el autor puede arreglarla.
 *
 * **Un bloque roto no vacía la ventana.** Si una imagen falta del paquete, ese
 * bloque avisa y los demás se muestran: una ventana en blanco deja al
 * visitante sin el procedimiento entero por una fotografía que falta.
 */

import { z } from 'zod';
import { actionSchema, type Action } from './action';
import { uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Bloques de contenido
 * ------------------------------------------------------------------ */

export const infoBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    /** Texto con formato sencillo. Admite variables `{{nombre}}`. */
    text: z.string().max(8000).default(''),
  }),
  z.object({
    type: z.literal('image'),
    mediaId: uuidSchema,
    caption: z.string().max(400).default(''),
  }),
  z.object({
    type: z.literal('video'),
    mediaId: uuidSchema,
    caption: z.string().max(400).default(''),
    autoplay: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('audio'),
    mediaId: uuidSchema,
    caption: z.string().max(400).default(''),
  }),
  z.object({
    type: z.literal('document'),
    documentId: uuidSchema,
    page: z.number().int().positive().default(1),
  }),
  /** Ficha del activo: TAG, clase y atributos, sin repetirlos a mano. */
  z.object({
    type: z.literal('asset'),
    assetId: uuidSchema,
  }),
  /**
   * Valor de proceso, sólo lectura.
   *
   * Se identifica por la vinculación de telemetría y no por la serie, para que
   * la ventana no contenga nunca una consulta ni, menos aún, credenciales.
   */
  z.object({
    type: z.literal('telemetry'),
    mappingId: uuidSchema,
  }),
  /** Servicio externo enmarcado: mapa, reproductor, visor de documentos (E09). */
  z.object({
    type: z.literal('webframe'),
    url: z.string().url(),
    heightPx: z.number().int().min(120).max(2048).default(420),
    allowFullscreen: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('sceneLink'),
    sceneId: uuidSchema,
    label: z.string().max(200).default(''),
  }),
]);

export type InfoBlock = z.infer<typeof infoBlockSchema>;
export type InfoBlockType = InfoBlock['type'];

export const infoTabSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(120),
  blocks: z.array(infoBlockSchema).default([]),
});

export type InfoTab = z.infer<typeof infoTabSchema>;

export const infoWindowSchema = z.object({
  id: uuidSchema,
  /** Nombre interno, el que ve el autor en las listas del editor. */
  name: z.string().min(1).max(200),
  /** Título que ve el visitante. Admite variables. */
  title: z.string().max(200).default(''),
  /**
   * Pestañas. Siempre hay al menos una: una ventana sin pestañas y una ventana
   * con una sola pestaña son lo mismo, y tener los dos casos obligaría a cada
   * consumidor a distinguirlos. Con una sola, el visor no dibuja la barra.
   */
  tabs: z.array(infoTabSchema).min(1),
  widthPx: z.number().int().min(240).max(2400).default(720),
  heightPx: z.number().int().min(180).max(2000).default(520),
  /** Modal: bloquea el recorrido hasta que se cierra. */
  modal: z.boolean().default(false),
  /** Acciones al cerrar la ventana (J06). */
  onCloseActions: z.array(actionSchema).default([]),
});

export type InfoWindow = z.infer<typeof infoWindowSchema>;

/* ------------------------------------------------------------------ *
 * Texto con variables (F09)
 * ------------------------------------------------------------------ */

/**
 * Variables que el visor sabe rellenar, con su descripción para el editor.
 *
 * La lista es corta a propósito. Sólo entra aquí lo que el manifiesto publicado
 * lleva de verdad: el cliente y la instalación, por ejemplo, se quedan fuera
 * del paquete —es una proyección con pérdida deliberada— y ofrecer una
 * variable que siempre saldría vacía sería peor que no ofrecerla.
 */
export const INFO_VARIABLES: Readonly<Record<string, string>> = {
  escena: 'Título de la escena actual',
  proyecto: 'Título del proyecto',
  recorrido: 'Nombre del recorrido en curso',
  paso: 'Número del paso actual del recorrido',
  pasos: 'Número total de pasos del recorrido',
  puntuacion: 'Puntuación acumulada de la evaluación',
  tiempo: 'Tiempo transcurrido en el recorrido, en minutos y segundos',
  fecha: 'Fecha de hoy',
};

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.:-]*)\s*\}\}/g;

/** Nombres de variable que aparecen en un texto, sin repetir y en orden. */
export function variablesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Variables de un texto que el visor no sabría rellenar.
 *
 * `var:` es el prefijo de las variables que el propio recorrido define con
 * `setVariable`, y de esas no se puede saber aquí si existirán: no se
 * denuncian.
 */
export function unknownVariables(text: string): string[] {
  return variablesIn(text).filter(
    (name) => !name.startsWith('var:') && INFO_VARIABLES[name] === undefined,
  );
}

/**
 * Sustituye las variables de un texto.
 *
 * Una variable sin valor se queda vacía, no con las llaves a la vista: el
 * visitante no tiene por qué leer la plantilla. El aviso al autor lo da
 * `unknownVariables` en el editor, que es donde se puede corregir.
 */
export function resolveVariables(
  text: string,
  values: Readonly<Record<string, string | number | null | undefined>>,
): string {
  return text.replace(VARIABLE_PATTERN, (_whole, name: string) => {
    const value = values[name];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

/* ------------------------------------------------------------------ *
 * Texto con formato sencillo
 * ------------------------------------------------------------------ */

export type RichSpan =
  | { readonly kind: 'plain'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type RichNode =
  | { readonly kind: 'paragraph'; readonly spans: readonly RichSpan[] }
  | { readonly kind: 'list'; readonly items: readonly (readonly RichSpan[])[] };

/**
 * Enlaces admitidos: sólo `https`.
 *
 * `javascript:` es el caso que importa, pero tampoco se admite `http` —el
 * recorrido se sirve por https y el navegador avisaría— ni `data:`, que
 * permite incrustar una página entera en el propio enlace.
 */
function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url.href : null;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Analiza los tramos con formato de una línea. */
function parseSpans(line: string): RichSpan[] {
  const spans: RichSpan[] = [];
  let index = 0;

  for (const match of line.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const at = match.index;
    if (at > index) spans.push({ kind: 'plain', text: line.slice(index, at) });
    index = at + token.length;

    if (token.startsWith('**')) {
      spans.push({ kind: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const text = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      // Un enlace que no se puede admitir se queda como texto: borrarlo
      // escondería lo que el autor escribió.
      spans.push(href === null ? { kind: 'plain', text } : { kind: 'link', text, href });
    } else {
      spans.push({ kind: 'italic', text: token.slice(1, -1) });
    }
  }

  if (index < line.length) spans.push({ kind: 'plain', text: line.slice(index) });
  return spans;
}

/**
 * Convierte el texto del autor en nodos que la interfaz pinta como elementos.
 *
 * No devuelve HTML en ningún caso, y por eso no hay nada que sanear: el
 * consumidor recibe datos y construye elementos. Lo que no encaje en el
 * subconjunto sale como texto literal.
 */
export function parseRichText(text: string): RichNode[] {
  const nodes: RichNode[] = [];
  let listItems: RichSpan[][] = [];
  let paragraph: string[] = [];

  const flushList = (): void => {
    if (listItems.length > 0) {
      nodes.push({ kind: 'list', items: listItems });
      listItems = [];
    }
  };

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      nodes.push({ kind: 'paragraph', spans: parseSpans(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      listItems.push(parseSpans(bullet[1] ?? ''));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return nodes;
}

/** Texto sin formato, para resúmenes y listas del editor. */
export function richTextSummary(text: string, maxLength = 120): string {
  const flat = parseRichText(text)
    .map((node) =>
      node.kind === 'paragraph'
        ? node.spans.map((span) => span.text).join('')
        : node.items.map((item) => item.map((span) => span.text).join('')).join(' · '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * Creación y edición
 * ------------------------------------------------------------------ */

export function createInfoWindow(
  name: string,
  tabId: string,
  id: string,
  overrides: Partial<Omit<InfoWindow, 'id' | 'name' | 'tabs'>> = {},
): InfoWindow {
  return infoWindowSchema.parse({
    id,
    name,
    title: name,
    tabs: [{ id: tabId, title: 'General', blocks: [] }],
    ...overrides,
  });
}

/** Bloque nuevo del tipo pedido, con sus valores por omisión. */
export function createInfoBlock(
  type: InfoBlockType,
  references: {
    readonly mediaId?: string;
    readonly documentId?: string;
    readonly assetId?: string;
    readonly mappingId?: string;
    readonly sceneId?: string;
  } = {},
): InfoBlock | null {
  switch (type) {
    case 'text':
      return infoBlockSchema.parse({ type: 'text', text: '' });
    case 'image':
    case 'video':
    case 'audio':
      return references.mediaId === undefined
        ? null
        : infoBlockSchema.parse({ type, mediaId: references.mediaId });
    case 'document':
      return references.documentId === undefined
        ? null
        : infoBlockSchema.parse({ type, documentId: references.documentId });
    case 'asset':
      return references.assetId === undefined
        ? null
        : infoBlockSchema.parse({ type, assetId: references.assetId });
    case 'telemetry':
      return references.mappingId === undefined
        ? null
        : infoBlockSchema.parse({ type, mappingId: references.mappingId });
    case 'sceneLink':
      return references.sceneId === undefined
        ? null
        : infoBlockSchema.parse({ type, sceneId: references.sceneId });
    case 'webframe':
      // Nace con una dirección que no existe a propósito: así la validación la
      // denuncia como «sin configurar» en lugar de publicarse apuntando a un
      // sitio real que el autor no eligió.
      return infoBlockSchema.parse({ type: 'webframe', url: 'https://example.invalid/' });
    default:
      return null;
  }
}

/** Mueve un bloque dentro de su pestaña. */
export function moveBlock(tab: InfoTab, from: number, to: number): InfoTab {
  if (from === to || from < 0 || from >= tab.blocks.length) return tab;
  const target = Math.min(Math.max(to, 0), tab.blocks.length - 1);

  const blocks = [...tab.blocks];
  const [moved] = blocks.splice(from, 1);
  if (moved === undefined) return tab;
  blocks.splice(target, 0, moved);
  return { ...tab, blocks };
}

/* ------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------ */

export interface InfoWindowProblem {
  readonly windowId: string;
  readonly tabId: string | null;
  readonly blockIndex: number | null;
  readonly message: string;
  /** `blocking` impide publicar; `warning` se puede publicar. */
  readonly severity: 'blocking' | 'warning';
}

export interface InfoWindowRefs {
  readonly mediaIds: ReadonlySet<string>;
  readonly documentIds: ReadonlySet<string>;
  readonly assetIds: ReadonlySet<string>;
  readonly mappingIds: ReadonlySet<string>;
  readonly sceneIds: ReadonlySet<string>;
}

const BLOCK_LABEL: Readonly<Record<InfoBlockType, string>> = {
  text: 'texto',
  image: 'imagen',
  video: 'vídeo',
  audio: 'audio',
  document: 'documento',
  asset: 'ficha de activo',
  telemetry: 'valor de proceso',
  webframe: 'contenido web',
  sceneLink: 'enlace a escena',
};

/**
 * Problemas de las ventanas, con el detalle para llegar al bloque.
 *
 * Una referencia muerta es `blocking`: el visitante abriría la ventana y
 * encontraría un hueco, y eso se descubre delante de él. Un texto vacío o una
 * variable desconocida son `warning`: el recorrido funciona, pero el autor
 * seguramente no quería eso.
 */
export function validateInfoWindows(
  windows: readonly InfoWindow[],
  refs: InfoWindowRefs,
): InfoWindowProblem[] {
  const problems: InfoWindowProblem[] = [];

  for (const window of windows) {
    const empty = window.tabs.every((tab) => tab.blocks.length === 0);
    if (empty) {
      problems.push({
        windowId: window.id,
        tabId: null,
        blockIndex: null,
        message: `La ventana «${window.name}» no tiene contenido.`,
        severity: 'warning',
      });
    }

    const titles = new Set<string>();
    for (const tab of window.tabs) {
      if (titles.has(tab.title)) {
        problems.push({
          windowId: window.id,
          tabId: tab.id,
          blockIndex: null,
          message: `«${window.name}» tiene dos pestañas llamadas «${tab.title}».`,
          severity: 'warning',
        });
      }
      titles.add(tab.title);

      tab.blocks.forEach((block, index) => {
        const dead = (what: string): void => {
          problems.push({
            windowId: window.id,
            tabId: tab.id,
            blockIndex: index,
            message: `El bloque de ${BLOCK_LABEL[block.type]} de «${window.name}» apunta a ${what} que no está en el proyecto.`,
            severity: 'blocking',
          });
        };

        switch (block.type) {
          case 'text': {
            if (block.text.trim() === '') {
              problems.push({
                windowId: window.id,
                tabId: tab.id,
                blockIndex: index,
                message: `Un bloque de texto de «${window.name}» está vacío.`,
                severity: 'warning',
              });
              break;
            }
            const unknown = unknownVariables(block.text);
            if (unknown.length > 0) {
              problems.push({
                windowId: window.id,
                tabId: tab.id,
                blockIndex: index,
                message: `«${window.name}» usa variables que el visor no sabe rellenar: ${unknown.map((name) => `{{${name}}}`).join(', ')}.`,
                severity: 'warning',
              });
            }
            break;
          }
          case 'image':
          case 'video':
          case 'audio':
            if (!refs.mediaIds.has(block.mediaId)) dead('un medio');
            break;
          case 'document':
            if (!refs.documentIds.has(block.documentId)) dead('un documento');
            break;
          case 'asset':
            if (!refs.assetIds.has(block.assetId)) dead('un activo');
            break;
          case 'telemetry':
            if (!refs.mappingIds.has(block.mappingId)) dead('una variable de proceso');
            break;
          case 'sceneLink':
            if (!refs.sceneIds.has(block.sceneId)) dead('una escena');
            break;
          case 'webframe': {
            const problem = webframeProblem(block.url);
            if (problem !== null) {
              problems.push({
                windowId: window.id,
                tabId: tab.id,
                blockIndex: index,
                message: `El contenido web de «${window.name}» ${problem.message}`,
                severity: problem.severity,
              });
            }
            break;
          }
          default:
            break;
        }
      });
    }
  }

  return problems;
}

/**
 * Direcciones que no se pueden enmarcar, y por qué.
 *
 * Se rechaza lo que apunta a la propia máquina o a una red interna. No es
 * paranoia: el recorrido se abre dentro de la red del cliente, y un marco a
 * `http://192.168.1.1/` o a `localhost` convierte el paquete en una forma de
 * alcanzar equipos desde el navegador de quien lo abra, que es exactamente lo
 * que hay que evitar.
 */
export function webframeProblem(
  raw: string,
): { readonly message: string; readonly severity: 'blocking' | 'warning' } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { message: 'no es una dirección válida.', severity: 'blocking' };
  }

  if (url.hostname === 'example.invalid') {
    return { message: 'sigue sin configurar.', severity: 'warning' };
  }

  if (url.protocol !== 'https:') {
    return {
      message: `usa «${url.protocol}», y sólo se puede enmarcar https.`,
      severity: 'blocking',
    };
  }

  if (isPrivateHost(url.hostname)) {
    return {
      message: 'apunta a una dirección de red interna, que no se puede enmarcar.',
      severity: 'blocking',
    };
  }

  return null;
}

/** Nombres y direcciones que no salen de la red local. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '' || host === '::1' || host === '0.0.0.0') return true;
  // Nombres sin punto: `intranet`, `servidor`. Resuelven sólo dentro.
  if (!host.includes('.') && !host.includes(':')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Enlace local y metadatos de nube.
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  // IPv6 local: `fc00::/7` y enlace local `fe80::/10`.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

export const canPublishInfoWindows = (problems: readonly InfoWindowProblem[]): boolean =>
  !problems.some((problem) => problem.severity === 'blocking');

/** Ventanas a las que apunta alguna acción, para no publicar las huérfanas. */
export function referencedWindowIds(actions: readonly Action[]): Set<string> {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.config.type === 'openInfoWindow') ids.add(action.config.windowId);
  }
  return ids;
}
