/**
 * Panorámicas reducidas para visor inmersivo (N12).
 *
 * Los perfiles por clase de dispositivo existían desde la etapa 13 y sólo
 * servían para avisar en el editor: la publicación entregaba el mismo juego de
 * imágenes para la pantalla y para las gafas. Eso tiene una consecuencia que no
 * se ve en una demostración y sí en una planta: un visor autónomo tiene el
 * presupuesto gráfico de un teléfono de gama media, y una equirrectangular de
 * 12.000 px no le cabe como textura. El controlador la reduce él mismo —si no
 * se queda sin memoria antes—, y el resultado es peor que la reducción que
 * habríamos hecho nosotros con un filtro bueno, además de descargada entera.
 *
 * Lo que este módulo decide es qué variante hace falta y cómo se llama. El
 * reescalado lo ejecuta el contenedor, como en V01/V02: el reparto es el mismo
 * y por el mismo motivo —una imagen de 100 MP no se abre en un lienzo del
 * navegador—.
 *
 * La regla que evita el defecto habitual de esta clase de función: **no se
 * emite una variante que no aporta**. Si la imagen ya cabe en el tope del
 * perfil, no se escribe ninguna copia; duplicar el paquete para entregar dos
 * archivos idénticos es peor que no tener la función, porque el autor paga el
 * tamaño sin recibir nada. Y si el proyecto no tiene ninguna escena visible en
 * VR, no se emite nada en absoluto.
 */

import type { Media, MimeType, PublishQuality } from './media';
import { MIME_EXTENSION } from './media';
import type { Scene } from './scene';

/** Clases de dispositivo para las que se puede publicar un juego propio. */
export const VR_VARIANT_PROFILES = ['standalone', 'tethered'] as const;

export type VrVariantProfile = (typeof VR_VARIANT_PROFILES)[number];

/**
 * Tope de lado mayor por clase de dispositivo.
 *
 * Son los mismos valores que `VR_PROFILES` del visor y están aquí porque el
 * dominio no depende del visor. Que coincidan lo fija una prueba: si alguien
 * cambia uno y no el otro, el editor avisaría de un tope y la publicación
 * escribiría otro.
 */
export const VR_MAX_PANORAMA_EDGE_PX: Readonly<Record<VrVariantProfile, number>> = {
  standalone: 4096,
  tethered: 8192,
};

export interface VrVariantPlan {
  readonly mediaId: string;
  readonly profile: VrVariantProfile;
  /** Lado mayor de salida en píxeles. */
  readonly maxEdgePx: number;
  readonly width: number;
  readonly height: number;
  readonly mime: MimeType;
  readonly quality: number;
  readonly relativePath: string;
}

export interface VrVariantSkip {
  readonly mediaId: string;
  readonly reason: 'cabe' | 'sinDimensiones' | 'noEsPanorámica' | 'noEsEscena';
}

export interface VrPublishPlan {
  readonly profile: VrVariantProfile;
  readonly variants: readonly VrVariantPlan[];
  readonly skipped: readonly VrVariantSkip[];
  /** Explicación para la pantalla de publicación; nunca una cifra inventada. */
  readonly note: string | null;
}

/**
 * Identificadores de los panoramas que una sesión inmersiva puede cargar.
 *
 * Son los de las escenas panorámicas que se publican. La sesión inmersiva
 * recorre el mismo recorrido que la pantalla —no hay un recorrido aparte para
 * VR—, así que cualquiera de ellas puede acabar dentro de las gafas.
 *
 * Lo que sí queda fuera es todo lo demás de la biblioteca: un documento, un
 * audio o la imagen de un plano no se cargan como textura de entorno, y una
 * copia reducida de ellos sería peso que nadie descarga.
 */
export function vrPanoramaMediaIds(scenes: readonly Scene[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const scene of scenes) {
    if (scene.excludedFromPublish) continue;
    if (scene.kind !== 'panorama') continue;
    if (scene.mediaId === null) continue;
    ids.add(scene.mediaId);
  }
  return ids;
}

/** Lado reducido conservando la proporción; nunca se agranda. */
function fitted(
  width: number,
  height: number,
  maxEdgePx: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdgePx) return { width, height };
  const factor = maxEdgePx / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Plan del juego de panorámicas para una clase de dispositivo.
 *
 * El formato y la calidad se heredan de los ajustes de publicación del
 * proyecto: la variante de VR es la misma imagen más pequeña, no otra decisión
 * de codificación que el autor no ha tomado.
 */
export function planVrVariants(
  media: readonly Media[],
  scenes: readonly Scene[],
  quality: PublishQuality,
  profile: VrVariantProfile,
): VrPublishPlan {
  const maxEdgePx = VR_MAX_PANORAMA_EDGE_PX[profile];
  const wanted = vrPanoramaMediaIds(scenes);
  const variants: VrVariantPlan[] = [];
  const skipped: VrVariantSkip[] = [];

  for (const entry of media) {
    if (!wanted.has(entry.id)) {
      // Sólo se registran los panoramas: un documento o un audio no tienen
      // nada que ver con esto y llenarían la lista de ruido.
      if (entry.kind === 'image' && entry.panorama !== null) {
        skipped.push({ mediaId: entry.id, reason: 'noEsEscena' });
      }
      continue;
    }

    if (entry.kind !== 'image' || entry.panorama === null) {
      skipped.push({ mediaId: entry.id, reason: 'noEsPanorámica' });
      continue;
    }

    if (entry.width === null || entry.height === null) {
      /* Sin dimensiones no se puede decidir si hace falta reducir. Reducir a
         ciegas podría agrandar la imagen, que es exactamente lo que el
         contenedor tiene prohibido hacer. */
      skipped.push({ mediaId: entry.id, reason: 'sinDimensiones' });
      continue;
    }

    if (Math.max(entry.width, entry.height) <= maxEdgePx) {
      skipped.push({ mediaId: entry.id, reason: 'cabe' });
      continue;
    }

    const size = fitted(entry.width, entry.height, maxEdgePx);
    variants.push({
      mediaId: entry.id,
      profile,
      maxEdgePx,
      width: size.width,
      height: size.height,
      mime: entry.mime,
      quality: quality.quality,
      relativePath: vrVariantPath(entry.relativePath, profile),
    });
  }

  return {
    profile,
    variants,
    skipped,
    note: noteFor(profile, variants, skipped, maxEdgePx),
  };
}

/**
 * Ruta de la variante.
 *
 * Va en una carpeta por perfil y conserva el nombre del archivo plano, para que
 * quien abra el paquete vea de qué imagen es cada copia sin tener que leer el
 * manifiesto.
 */
export function vrVariantPath(relativePath: string, profile: VrVariantProfile): string {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relativePath.slice(0, slash);
  const file = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  return `${dir === '' ? '' : `${dir}/`}vr/${profile}/${file}`;
}

/** Extensión que corresponde a un tipo, para construir nombres de variante. */
export const extensionForMime = (mime: MimeType): string => MIME_EXTENSION[mime] ?? '';

function noteFor(
  profile: VrVariantProfile,
  variants: readonly VrVariantPlan[],
  skipped: readonly VrVariantSkip[],
  maxEdgePx: number,
): string | null {
  const panoramas = variants.length + skipped.filter((s) => s.reason !== 'noEsEscena').length;

  if (panoramas === 0) {
    return 'El recorrido no publica ninguna escena panorámica: no hay juego de VR que preparar.';
  }

  if (variants.length === 0) {
    return `Todas las panorámicas de VR caben en ${maxEdgePx} px: no se publica ninguna copia reducida.`;
  }

  const unmeasured = skipped.filter((s) => s.reason === 'sinDimensiones').length;
  const parts = [
    `${variants.length} panorámica(s) se reducen a ${maxEdgePx} px para «${profile}».`,
  ];
  if (unmeasured > 0) {
    parts.push(
      `${unmeasured} se publican a tamaño completo porque no se conocen sus dimensiones; el visor tendrá que reducirlas él.`,
    );
  }
  return parts.join(' ');
}

/**
 * Entrada del manifiesto: de qué medio a qué archivo, por perfil.
 *
 * El visor necesita poder resolverlo sin recorrer la lista de variantes en cada
 * cambio de escena, y el manifiesto es lo único que viaja con el paquete.
 */
export function vrVariantMap(
  plans: readonly VrPublishPlan[],
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const map: Record<string, Record<string, string>> = {};
  for (const plan of plans) {
    for (const variant of plan.variants) {
      const forMedia = map[variant.mediaId] ?? {};
      forMedia[variant.profile] = variant.relativePath;
      map[variant.mediaId] = forMedia;
    }
  }
  return map;
}

/**
 * Archivo que debe cargar una sesión inmersiva para un medio.
 *
 * Devuelve la ruta plana cuando no hay variante, que es el caso correcto y
 * frecuente: una panorámica que ya cabe se carga tal cual. Devolver `null` o
 * una ruta inventada dejaría la escena en negro dentro de las gafas, que es el
 * peor sitio para un error.
 */
export function pathForVrProfile(
  map: Readonly<Record<string, Readonly<Record<string, string>>>>,
  mediaId: string,
  profile: VrVariantProfile,
  flatPath: string,
): string {
  return map[mediaId]?.[profile] ?? flatPath;
}
