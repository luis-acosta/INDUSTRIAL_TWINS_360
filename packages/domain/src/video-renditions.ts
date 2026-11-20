/**
 * Versiones de un vídeo y elección por dispositivo (V04).
 *
 * El problema real: un vídeo de proceso grabado en 4K pesa cientos de
 * megabytes, y en una tableta de planta con red compartida no empieza a
 * reproducirse —se queda cargando y el visitante lo abandona—. La solución que
 * el producto puede dar con honestidad es llevar varias versiones del mismo
 * vídeo y entregar la que corresponde al dispositivo y a la red.
 *
 * **Lo que esta plataforma no hace es transcodificar.** No lleva un codificador
 * de vídeo: añadirlo al contenedor significaría arrastrar una biblioteca de
 * cientos de megabytes con sus propias licencias, y el resultado sería peor que
 * el que da cualquier herramienta de edición. Las versiones las exporta quien
 * hace el vídeo —que ya las exporta— y aquí se validan, se publican y se
 * eligen. Está dicho así en la documentación de limitaciones, porque la
 * diferencia importa a quien prepara el material.
 *
 * Lo que sí se hace, y es lo que faltaba, es que la elección ocurra: sin ella,
 * un proyecto con tres versiones entregaría siempre la primera.
 */

import { z } from 'zod';

import { uuidSchema } from './identity';
import type { Media } from './media';

/**
 * Altura de una versión, en píxeles.
 *
 * La altura y no la anchura: es como se nombran las versiones de vídeo en
 * cualquier herramienta de edición («1080p»), y con material vertical o
 * anamórfico la anchura no ordena la escalera.
 */
export const videoRenditionSchema = z.object({
  mediaId: uuidSchema,
  heightPx: z.number().int().min(144).max(4320),
});

export type VideoRendition = z.infer<typeof videoRenditionSchema>;

/** Altura por debajo de la cual no merece la pena ofrecer otra versión. */
export const MIN_RENDITION_HEIGHT_PX = 240;

/**
 * Altura a partir de la cual una tableta o un teléfono sufren.
 *
 * No es una cifra de catálogo: es el punto donde un vídeo deja de caber en la
 * memoria de decodificación cómoda de un dispositivo móvil de gama media y la
 * reproducción empieza a saltar. Se usa para avisar al autor, no para impedir
 * nada.
 */
export const MOBILE_COMFORT_HEIGHT_PX = 1080;

export type DeviceClass = 'desktop' | 'tablet' | 'mobile' | 'vr';

export interface SelectionContext {
  readonly device: DeviceClass;
  /** Altura útil del elemento de vídeo en píxeles de dispositivo. */
  readonly viewportHeightPx: number;
  /**
   * El sistema pide ahorrar datos.
   *
   * Cuando el visitante lo ha pedido, se le da la versión más pequeña
   * utilizable aunque su pantalla admita más: es una petición explícita y
   * pasarla por encima con un criterio de calidad sería decidir por él.
   */
  readonly saveData: boolean;
  /**
   * Calidad de red declarada por el navegador: `'slow-2g' | '2g' | '3g' | '4g'`
   * o `null` cuando no la informa. `null` no se trata como lenta: suponer lo
   * peor en un equipo de escritorio con fibra entregaría un vídeo borroso a
   * quien tiene red de sobra.
   */
  readonly effectiveType: string | null;
}

/** Techo de altura por clase de dispositivo. */
const DEVICE_CEILING: Readonly<Record<DeviceClass, number>> = {
  desktop: 2160,
  tablet: 1080,
  mobile: 720,
  // En el visor, el vídeo va a una textura de panel: más allá de 1080 no se
  // distingue y cuesta presupuesto de fotograma que hace falta para sostener
  // los 72 fps.
  vr: 1080,
};

const SLOW_TYPES: readonly string[] = ['slow-2g', '2g', '3g'];

/**
 * Escalera ordenada de menor a mayor, sin repeticiones de altura.
 *
 * Se ordena aquí y no se confía en el orden del proyecto: el autor añade las
 * versiones en el orden en que las exporta, y elegir «la primera que cabe»
 * sobre una lista sin ordenar da resultados distintos para el mismo proyecto
 * según cómo se guardó.
 */
export function renditionLadder(
  primary: Media,
  renditions: readonly VideoRendition[],
  byId: ReadonlyMap<string, Media>,
): readonly { readonly media: Media; readonly heightPx: number }[] {
  const steps = new Map<number, Media>();

  for (const rendition of renditions) {
    const media = byId.get(rendition.mediaId);
    if (media === undefined || media.kind !== 'video') continue;
    if (rendition.heightPx < MIN_RENDITION_HEIGHT_PX) continue;
    if (!steps.has(rendition.heightPx)) steps.set(rendition.heightPx, media);
  }

  // El vídeo principal es el escalón más alto por definición: es el original.
  const primaryHeight = primary.height ?? Number.MAX_SAFE_INTEGER;
  steps.set(primaryHeight, primary);

  return [...steps.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([heightPx, media]) => ({ media, heightPx }));
}

/**
 * Versión que hay que entregar.
 *
 * La regla es «la más pequeña que no se vea peor que la pantalla», con dos
 * excepciones declaradas: el ahorro de datos y una red lenta bajan al escalón
 * más bajo. Sin escalera, devuelve el vídeo principal, que es lo correcto: un
 * proyecto con una sola versión no tiene nada que elegir.
 */
export function selectRendition(
  primary: Media,
  renditions: readonly VideoRendition[],
  byId: ReadonlyMap<string, Media>,
  context: SelectionContext,
): Media {
  const ladder = renditionLadder(primary, renditions, byId);
  const lowest = ladder[0];
  if (lowest === undefined) return primary;

  if (context.saveData) return lowest.media;
  if (context.effectiveType !== null && SLOW_TYPES.includes(context.effectiveType)) {
    return lowest.media;
  }

  const ceiling = Math.min(
    DEVICE_CEILING[context.device],
    // Un vídeo con el doble de altura que su hueco no se ve mejor: la pantalla
    // no tiene píxeles donde ponerlo. El factor de 1,5 deja margen para
    // pantallas de densidad alta sin saltar al escalón siguiente por nada.
    Math.max(MIN_RENDITION_HEIGHT_PX, Math.round(context.viewportHeightPx * 1.5)),
  );

  const fitting = ladder.find((step) => step.heightPx >= ceiling);
  // Si ninguna llega al techo, la mayor disponible: es lo mejor que hay.
  return (fitting ?? ladder[ladder.length - 1]!).media;
}

/**
 * Lee el contexto del navegador.
 *
 * Aparte para poder probar la elección sin navegador, que es donde está la
 * regla, y porque `navigator.connection` no existe en todos: su ausencia
 * significa «no sé», no «red lenta».
 */
export function readSelectionContext(
  nav: Navigator,
  device: DeviceClass,
  viewportHeightPx: number,
): SelectionContext {
  const connection = (
    nav as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string } | undefined;
    }
  ).connection;

  return {
    device,
    viewportHeightPx,
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType ?? null,
  };
}

/**
 * Avisos para el autor antes de publicar.
 *
 * Son concretos a propósito: «exporte una versión de 720p» se puede hacer, y
 * «el vídeo es grande» no. Y se avisa de la versión que falta y no del peso del
 * archivo, porque el peso es consecuencia.
 */
export function renditionWarnings(
  primary: Media,
  renditions: readonly VideoRendition[],
  byId: ReadonlyMap<string, Media>,
): readonly string[] {
  const warnings: string[] = [];
  const ladder = renditionLadder(primary, renditions, byId);
  const height = primary.height;

  if (height !== null && height > MOBILE_COMFORT_HEIGHT_PX && ladder.length === 1) {
    warnings.push(
      `«${primary.originalName}» está a ${height}p y es la única versión: en una tableta o un teléfono tardará en empezar o irá a saltos. Exporte también una versión de 720p y añádala al proyecto.`,
    );
  }

  for (const rendition of renditions) {
    const media = byId.get(rendition.mediaId);
    if (media === undefined) {
      warnings.push(
        `«${primary.originalName}» declara una versión que no está en la biblioteca de medios; se publicará sin ella.`,
      );
      continue;
    }
    if (media.kind !== 'video') {
      warnings.push(
        `«${media.originalName}» está declarada como versión de «${primary.originalName}» y no es un vídeo.`,
      );
      continue;
    }
    /* La duración es la comprobación que importa: una versión que no es el
       mismo vídeo cambia lo que se ve según el dispositivo, y eso no se
       descubre hasta que alguien lo abre en el dispositivo equivocado. */
    if (
      primary.durationS !== null &&
      media.durationS !== null &&
      Math.abs(primary.durationS - media.durationS) > 1
    ) {
      warnings.push(
        `«${media.originalName}» dura ${Math.round(media.durationS)} s y «${primary.originalName}» dura ${Math.round(primary.durationS)} s: no parecen el mismo vídeo.`,
      );
    }
  }

  return warnings;
}
