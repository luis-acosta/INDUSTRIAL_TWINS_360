/**
 * Ventanas del recorrido publicado (E01, E02, E03, E05, E06, E07, E08).
 *
 * Hasta ahora todo lo que un marcador abría —una foto, un PDF, un enlace— se
 * abría en una pestaña nueva. Funcionaba a medias y perdía lo importante: el
 * visitante salía del recorrido, y un álbum de fotografías era imposible,
 * porque en una pestaña nueva no hay «siguiente».
 *
 * Este módulo es la parte decidible de las ventanas: qué ventana abre cada
 * acción, cómo se navega un álbum y qué se puede mostrar embebido sin romper
 * la política de seguridad del paquete. La parte que pinta está en
 * `WindowHost.tsx`, y es delgada a propósito.
 */
import {
  parseRichText,
  resolveVariables,
  type Action,
  type InfoWindow,
  type Manifest,
  type RichNode,
} from '@it360/domain';

/* ------------------------------------------------------------------ *
 * Qué ventana se abre
 * ------------------------------------------------------------------ */

export type TourWindow =
  /** Ventana que el autor compuso, con sus pestañas y bloques (E01, F08). */
  | {
      readonly kind: 'info';
      readonly title: string;
      readonly tabs: readonly ResolvedTab[];
      readonly widthPx: number;
      readonly heightPx: number;
      readonly modal: boolean;
      /** Acciones a ejecutar al cerrarla (J06). */
      readonly onClose: readonly Action[];
    }
  /** Una imagen o un vídeo, con posibilidad de álbum (E02, E03). */
  | {
      readonly kind: 'media';
      readonly title: string;
      /** URLs del álbum; una sola entrada es una foto de detalle. */
      readonly items: readonly MediaItem[];
      readonly index: number;
      readonly autoplay: boolean;
    }
  /** Documento del paquete, embebido (E05). */
  | {
      readonly kind: 'document';
      readonly title: string;
      readonly url: string;
      readonly page: number;
      /** `true` si el navegador puede mostrarlo embebido. */
      readonly embeddable: boolean;
    }
  /** Página de tercero, embebida si la política lo admite (E08, D06). */
  | {
      readonly kind: 'webframe';
      readonly title: string;
      readonly url: string;
      readonly widthPx: number;
      readonly heightPx: number;
      readonly allowFullscreen: boolean;
    };

/** Pestaña con sus bloques ya resueltos contra el paquete. */
export interface ResolvedTab {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly ResolvedBlock[];
}

/**
 * Bloque listo para pintar.
 *
 * Las referencias del proyecto ya están resueltas aquí —URL del medio, ficha
 * del activo, texto con las variables sustituidas— para que la capa que pinta
 * no tenga que buscar nada en el manifiesto. Un bloque cuya referencia falta
 * se convierte en `missing` y no desaparece: el visitante tiene que poder
 * distinguir «aquí falta algo» de «aquí no había nada», y el autor que prueba
 * su recorrido necesita verlo.
 */
export type ResolvedBlock =
  | { readonly kind: 'richText'; readonly nodes: readonly RichNode[] }
  | {
      readonly kind: 'media';
      readonly media: MediaItem;
      readonly caption: string;
      readonly autoplay: boolean;
    }
  | {
      readonly kind: 'document';
      readonly title: string;
      readonly url: string;
      readonly page: number;
      readonly embeddable: boolean;
    }
  | {
      readonly kind: 'asset';
      readonly tag: string;
      readonly name: string;
      readonly className: string;
      readonly attributes: readonly { readonly label: string; readonly value: string }[];
    }
  | { readonly kind: 'telemetry'; readonly mappingId: string; readonly label: string }
  | {
      readonly kind: 'webframe';
      readonly url: string;
      readonly heightPx: number;
      readonly allowFullscreen: boolean;
    }
  | { readonly kind: 'sceneLink'; readonly sceneId: string; readonly label: string }
  | { readonly kind: 'missing'; readonly what: string };

export interface MediaItem {
  readonly url: string;
  readonly caption: string;
  readonly kind: 'image' | 'video' | 'audio' | 'other';
}

/* ------------------------------------------------------------------ *
 * Navegación del álbum (E03)
 * ------------------------------------------------------------------ */

/**
 * Avanza o retrocede en un álbum.
 *
 * **No da la vuelta.** Un álbum que vuelve al principio sin avisar hace que el
 * visitante no sepa si ya lo ha visto entero, y en un recorrido de inspección
 * eso significa no saber si ha visto todas las fotos del equipo. Llegar al
 * final se nota porque el botón se desactiva.
 */
export function stepAlbum(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, index + delta));
}

export const canStepAlbum = (index: number, total: number, delta: number): boolean =>
  total > 1 && stepAlbum(index, total, delta) !== index;

/** Posición legible dentro del álbum: «3 de 12». */
export function albumPosition(index: number, total: number): string {
  if (total <= 1) return '';
  return `${index + 1} de ${total}`;
}

/* ------------------------------------------------------------------ *
 * Qué se puede mostrar embebido
 * ------------------------------------------------------------------ */

/**
 * Tipos de documento que el navegador muestra embebido.
 *
 * Sólo PDF. Un .docx o un .dwg en un `iframe` produce una descarga o una
 * página en blanco según el navegador, y un recuadro en blanco dentro del
 * recorrido es peor que un botón que dice «descargar»: el visitante cree que
 * algo ha fallado.
 */
const EMBEDDABLE_MIME = new Set(['application/pdf']);

export const isEmbeddableDocument = (mime: string): boolean => EMBEDDABLE_MIME.has(mime);

/**
 * Clasifica un medio por su tipo declarado.
 *
 * Se mira el `mime` y no la extensión: el nombre del archivo lo pone quien lo
 * exportó y puede mentir, mientras que el `mime` lo verificó la importación.
 */
export function mediaKindOf(mime: string): MediaItem['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

/**
 * `true` si una URL se puede enmarcar con la política del paquete.
 *
 * La política lleva los orígenes que el autor declaró. Comprobarlo aquí deja
 * mostrar un aviso con el motivo, en lugar de un marco que el navegador
 * bloquea en silencio y que el visitante ve como un hueco.
 */
export function isFrameAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, globalThis.location?.href ?? 'https://localhost/');
  } catch {
    return false;
  }

  // Mismo origen: es contenido del propio paquete.
  if (globalThis.location !== undefined && parsed.origin === globalThis.location.origin) {
    return true;
  }
  return allowedOrigins.includes(parsed.origin);
}

/* ------------------------------------------------------------------ *
 * Construcción de ventanas desde el manifiesto
 * ------------------------------------------------------------------ */

export interface WindowContext {
  readonly manifest: Manifest;
  readonly mediaUrls: ReadonlyMap<string, string>;
}

/** Ventana de un medio, con su álbum si lo tiene (E02, E03). */
export function mediaWindow(
  context: WindowContext,
  mediaId: string,
  albumMediaIds: readonly string[],
  autoplay: boolean,
): TourWindow | null {
  const ids = albumMediaIds.length > 0 ? albumMediaIds : [mediaId];

  const items: MediaItem[] = [];
  for (const id of ids) {
    const url = context.mediaUrls.get(id);
    const media = context.manifest.media.find((candidate) => candidate.id === id);
    // Un medio ausente se omite en lugar de dejar un hueco negro en el álbum:
    // el visitante no tiene forma de saber que ahí debía haber algo, y una
    // tarjeta vacía parece un fallo del recorrido.
    if (url === undefined || media === undefined) continue;

    items.push({
      url,
      caption: media.originalName,
      kind: mediaKindOf(media.mime),
    });
  }

  if (items.length === 0) return null;

  const index = Math.max(
    0,
    ids.findIndex((id) => id === mediaId),
  );

  return {
    kind: 'media',
    title: items[Math.min(index, items.length - 1)]?.caption ?? '',
    items,
    index: Math.min(index, items.length - 1),
    autoplay,
  };
}

/**
 * Valores de las variables del recorrido (F09).
 *
 * Se pasan ya calculados en lugar de calcularse aquí: el tiempo transcurrido y
 * la puntuación los lleva la reproducción del recorrido, y pedirle a este
 * módulo que los averigüe lo ataría a ella.
 */
export interface VariableValues {
  readonly [name: string]: string | number | null | undefined;
}

/** Ventana compuesta por el autor, con sus referencias ya resueltas (E01). */
export function infoWindow(
  context: WindowContext,
  window: InfoWindow,
  variables: VariableValues,
): TourWindow {
  const tabs: ResolvedTab[] = window.tabs.map((tab) => ({
    id: tab.id,
    title: resolveVariables(tab.title, variables),
    blocks: tab.blocks.map((block) => resolveBlock(context, block, variables)),
  }));

  return {
    kind: 'info',
    title: resolveVariables(window.title === '' ? window.name : window.title, variables),
    tabs,
    widthPx: window.widthPx,
    heightPx: window.heightPx,
    modal: window.modal,
    onClose: window.onCloseActions,
  };
}

/** Resuelve un bloque contra el paquete. */
function resolveBlock(
  context: WindowContext,
  block: InfoWindow['tabs'][number]['blocks'][number],
  variables: VariableValues,
): ResolvedBlock {
  switch (block.type) {
    case 'text':
      return { kind: 'richText', nodes: parseRichText(resolveVariables(block.text, variables)) };

    case 'image':
    case 'video':
    case 'audio': {
      const url = context.mediaUrls.get(block.mediaId);
      const media = context.manifest.media.find((candidate) => candidate.id === block.mediaId);
      if (url === undefined || media === undefined) {
        return { kind: 'missing', what: 'una imagen o vídeo que no está en el paquete' };
      }
      return {
        kind: 'media',
        media: { url, caption: media.originalName, kind: mediaKindOf(media.mime) },
        caption: resolveVariables(block.caption, variables),
        autoplay: block.type === 'video' ? block.autoplay : false,
      };
    }

    case 'document': {
      const resolved = documentWindow(context, block.documentId, block.page);
      if (resolved === null || resolved.kind !== 'document') {
        return { kind: 'missing', what: 'un documento que no está en el paquete' };
      }
      return {
        kind: 'document',
        title: resolved.title,
        url: resolved.url,
        page: resolved.page,
        embeddable: resolved.embeddable,
      };
    }

    case 'asset': {
      const asset = context.manifest.assets.find((candidate) => candidate.id === block.assetId);
      if (asset === undefined) {
        return { kind: 'missing', what: 'un activo que no está en el paquete' };
      }
      const assetClass = context.manifest.assetClasses.find(
        (candidate) => candidate.id === asset.classId,
      );

      return {
        kind: 'asset',
        tag: asset.tag,
        name: asset.name,
        className: assetClass?.name ?? '',
        attributes: Object.entries(asset.attributes).map(([label, value]) => ({
          label,
          value: formatAttribute(value),
        })),
      };
    }

    case 'telemetry': {
      const mapping = context.manifest.telemetryMappings.find(
        (candidate) => candidate.id === block.mappingId,
      );
      if (mapping === undefined) {
        return { kind: 'missing', what: 'una variable de proceso que no está en el paquete' };
      }
      return { kind: 'telemetry', mappingId: mapping.id, label: mapping.variable };
    }

    case 'webframe':
      return {
        kind: 'webframe',
        url: block.url,
        heightPx: block.heightPx,
        allowFullscreen: block.allowFullscreen,
      };

    case 'sceneLink': {
      const scene = context.manifest.scenes.find((candidate) => candidate.id === block.sceneId);
      if (scene === undefined) {
        return { kind: 'missing', what: 'una escena que no está en el paquete' };
      }
      return {
        kind: 'sceneLink',
        sceneId: scene.id,
        label: block.label !== '' ? resolveVariables(block.label, variables) : scene.title,
      };
    }

    default:
      return { kind: 'missing', what: 'un bloque que esta versión del visor no sabe mostrar' };
  }
}

/** Valor de un atributo del activo, tal como se lee. */
function formatAttribute(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown; unit?: unknown }).value;
    const unit = (value as { unit?: unknown }).unit;
    return unit === undefined || unit === null || unit === ''
      ? String(inner)
      : `${String(inner)} ${String(unit)}`;
  }
  return String(value);
}

/** Ventana de un documento del paquete (E05). */
export function documentWindow(
  context: WindowContext,
  documentId: string,
  page: number,
): TourWindow | null {
  const document = context.manifest.documents.find((candidate) => candidate.id === documentId);
  if (document === undefined) return null;

  const url = context.mediaUrls.get(document.mediaId);
  if (url === undefined) return null;

  const media = context.manifest.media.find((candidate) => candidate.id === document.mediaId);

  return {
    kind: 'document',
    title: document.title,
    url,
    page: Math.max(1, page),
    embeddable: media !== undefined && isEmbeddableDocument(media.mime),
  };
}

/**
 * Dirección del documento con la página inicial.
 *
 * El fragmento `#page=` es la forma que entienden los visores de PDF de los
 * navegadores. Si el visor lo ignora, se abre en la primera página: peor que
 * lo pedido, pero nunca un error.
 */
export function documentUrlWithPage(url: string, page: number): string {
  return page > 1 ? `${url}#page=${page}` : url;
}

/** Nombre seguro para una descarga (E06). */
export function safeDownloadName(suggested: string | undefined, fallback: string): string {
  const raw = (suggested ?? '').trim();
  const source = raw.length > 0 ? raw : fallback;

  // Se corta cualquier ruta: un nombre sugerido con `../` escrito en el
  // proyecto no debe poder decidir dónde se guarda el archivo.
  const base = source.split(/[/\\]/).pop() ?? fallback;

  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);

  return cleaned.length > 0 ? cleaned : fallback;
}
