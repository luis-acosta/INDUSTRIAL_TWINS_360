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
import type { Manifest } from '@it360/domain';

/* ------------------------------------------------------------------ *
 * Qué ventana se abre
 * ------------------------------------------------------------------ */

export type TourWindow =
  /** Texto con multimedia opcional (E01). */
  | {
      readonly kind: 'info';
      readonly title: string;
      readonly body: string;
      readonly mediaUrl: string | null;
      readonly modal: boolean;
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
