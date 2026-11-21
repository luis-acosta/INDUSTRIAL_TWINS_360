/**
 * Vistas previas de las panorámicas (S08).
 *
 * El problema que resuelve, medido en lo que siente quien usa el recorrido: una
 * panorámica de planta pesa entre ocho y veinte megabytes. Hasta que llega
 * entera, la escena está en negro con una barra de progreso. En la red de una
 * oficina son dos segundos; en la de una planta, con el teléfono enganchado al
 * mismo punto de acceso que los terminales de mantenimiento, son quince o
 * veinte. Y eso ocurre en **cada** cambio de escena, que es lo que se hace todo
 * el tiempo en un recorrido.
 *
 * La vista previa es una copia de 1024 px del mismo panorama: pesa unos cien
 * kilobytes y llega en el primer segundo. El visor la muestra, el visitante ya
 * está dentro de la escena y puede girar y mirar, y la imagen completa la
 * sustituye cuando acaba de llegar.
 *
 * Lo que esto **no** es: teselado. La pirámide de teselas sigue sin escribirse y
 * está declarada en LIMITACIONES. Un juego de teselas sirve para ver una zona a
 * máxima resolución sin cargar el resto, y el visor carga la imagen completa por
 * diseño; la vista previa, en cambio, ataca lo que de verdad se sufre, que es el
 * primer segundo.
 *
 * Y la regla que evita el daño de esta clase de función, la misma que en V04 y
 * N12: **no se escribe una vista previa que no aporta**. Si el panorama ya cabe
 * en el tope, no hay copia; dos archivos iguales en el paquete cuestan al autor
 * y no le dan nada.
 */

import type { Media } from './media';
import type { Scene } from './scene';

/**
 * Lado mayor de la vista previa.
 *
 * 1024 px es lo que hace falta para que una panorámica equirrectangular se
 * reconozca al girar: por debajo, las paredes y los equipos se vuelven manchas
 * y el visitante no sabe adónde está mirando, de modo que la vista previa deja
 * de servir para orientarse, que es lo único que tiene que hacer. Por encima,
 * el archivo deja de llegar en el primer segundo y se pierde el motivo.
 */
export const PREVIEW_MAX_EDGE_PX = 1024;

/**
 * Calidad de la vista previa.
 *
 * Más baja que la de la imagen final a propósito: se va a sustituir en
 * segundos, y lo que importa es el tamaño. Un 60 en JPEG sobre una imagen ya
 * reducida a 1024 px no muestra artefactos que se distingan a esa escala.
 */
export const PREVIEW_QUALITY = 60;

export interface PreviewPlan {
  readonly mediaId: string;
  readonly width: number;
  readonly height: number;
  readonly relativePath: string;
  readonly maxEdgePx: number;
  readonly quality: number;
}

export interface PreviewSkip {
  readonly mediaId: string;
  readonly reason: 'cabe' | 'sinDimensiones';
}

export interface PreviewSet {
  readonly previews: readonly PreviewPlan[];
  readonly skipped: readonly PreviewSkip[];
  readonly note: string | null;
}

/** Ruta de la vista previa, junto a su original y en su propia carpeta. */
export function previewPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relativePath.slice(0, slash);
  const file = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot === -1 ? file : file.slice(0, dot);
  // Siempre JPEG: es el formato que todo navegador decodifica rápido, y en una
  // imagen de 1024 px la ventaja de WebP no compensa arrastrar dos rutas de
  // decodificación distintas para el primer segundo de cada escena.
  return `${dir === '' ? '' : `${dir}/`}preview/${stem}.jpg`;
}

function fitted(width: number, height: number): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= PREVIEW_MAX_EDGE_PX) return { width, height };
  const factor = PREVIEW_MAX_EDGE_PX / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Vistas previas que hay que escribir para un proyecto.
 *
 * Sólo de los panoramas de las escenas que se publican: la imagen de un plano o
 * una fotografía de una ventana de información no bloquean la entrada a una
 * escena, que es el momento que esto mejora.
 */
export function planPreviews(media: readonly Media[], scenes: readonly Scene[]): PreviewSet {
  const wanted = new Set<string>();
  for (const scene of scenes) {
    if (scene.excludedFromPublish) continue;
    if (scene.kind !== 'panorama') continue;
    if (scene.mediaId === null) continue;
    wanted.add(scene.mediaId);
  }

  const previews: PreviewPlan[] = [];
  const skipped: PreviewSkip[] = [];

  for (const entry of media) {
    if (!wanted.has(entry.id)) continue;
    if (entry.kind !== 'image') continue;

    if (entry.width === null || entry.height === null) {
      /* Sin dimensiones no se puede saber si hace falta reducir, y reducir a
         ciegas podría agrandar la imagen. La escena cargará como antes: más
         lenta, no rota. */
      skipped.push({ mediaId: entry.id, reason: 'sinDimensiones' });
      continue;
    }

    if (Math.max(entry.width, entry.height) <= PREVIEW_MAX_EDGE_PX) {
      // Ya es pequeña: llega en el primer segundo por sí misma.
      skipped.push({ mediaId: entry.id, reason: 'cabe' });
      continue;
    }

    const size = fitted(entry.width, entry.height);
    previews.push({
      mediaId: entry.id,
      width: size.width,
      height: size.height,
      relativePath: previewPath(entry.relativePath),
      maxEdgePx: PREVIEW_MAX_EDGE_PX,
      quality: PREVIEW_QUALITY,
    });
  }

  return { previews, skipped, note: noteFor(previews, skipped) };
}

function noteFor(previews: readonly PreviewPlan[], skipped: readonly PreviewSkip[]): string | null {
  if (previews.length === 0) {
    return skipped.length === 0
      ? null
      : 'Las panorámicas ya son pequeñas: no se preparan vistas previas.';
  }

  const unmeasured = skipped.filter((entry) => entry.reason === 'sinDimensiones').length;
  const parts = [
    `${previews.length} escena(s) entrarán con una vista previa de ${PREVIEW_MAX_EDGE_PX} px mientras llega la imagen completa.`,
  ];
  if (unmeasured > 0) {
    parts.push(
      `${unmeasured} se quedan sin vista previa porque no se conocen sus dimensiones; esas escenas tardarán en abrirse lo que tarde su imagen.`,
    );
  }
  return parts.join(' ');
}

/**
 * Vista previa de un medio, o `null`.
 *
 * El visor lo consulta en cada cambio de escena. Devolver `null` es el caso
 * correcto y frecuente —una panorámica pequeña no tiene copia—, y el visor
 * carga entonces la imagen completa directamente. Una ruta construida a mano
 * aquí haría que cada escena sin vista previa empezara con un 404.
 */
export function previewFor(
  previews: Readonly<Record<string, string>>,
  mediaId: string | null,
): string | null {
  if (mediaId === null) return null;
  return previews[mediaId] ?? null;
}
