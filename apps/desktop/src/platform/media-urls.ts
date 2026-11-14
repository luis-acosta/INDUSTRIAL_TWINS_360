/**
 * URLs con las que mostrar los medios de un proyecto abierto del disco (Y01).
 *
 * Existe porque faltaba, y el agujero era grande: al abrir un proyecto se
 * cargaban el modelo de datos y los bytes de los archivos, pero nadie
 * construía las direcciones con las que mostrarlos. El resultado era que
 * guardar un proyecto y volver a abrirlo daba un proyecto con todas sus
 * escenas en blanco: el ciclo básico del producto —crear, guardar, seguir
 * mañana— no se cerraba.
 *
 * Dos decisiones:
 *
 * **Se indexa por identificador de medio, no por ruta.** El resto de la
 * aplicación pide la URL de un medio por su `id`; que esa URL se obtenga de un
 * archivo del paquete es un detalle de esta capa.
 *
 * **Las direcciones anteriores se liberan.** Una URL de objeto mantiene sus
 * bytes en memoria hasta que se revoca. Abrir diez proyectos de doscientos
 * megabytes en una sesión sin revocar deja dos gigabytes retenidos, y el
 * síntoma —la aplicación que se vuelve lenta después de un rato— no apunta a
 * su causa.
 */

import type { Media } from '@it360/domain';

/** Mapa de medios a direcciones, con la forma que espera el editor. */
export type MediaUrlMap = ReadonlyMap<string, string>;

/**
 * Construye una dirección por cada medio cuyo archivo está en el paquete.
 *
 * Los medios cuyo archivo falta se omiten en lugar de recibir una dirección
 * vacía: la interfaz ya sabe decir «falta este archivo» cuando no hay URL, y
 * una cadena vacía produciría una petición a la propia página.
 */
export function buildMediaUrls(
  media: readonly Media[],
  files: ReadonlyMap<string, Uint8Array>,
): Map<string, string> {
  const urls = new Map<string, string>();

  for (const entry of media) {
    const bytes = files.get(entry.relativePath);
    if (bytes === undefined) continue;

    urls.set(entry.id, objectUrlFor(bytes, entry.mime));
  }

  return urls;
}

/**
 * Dirección para unos bytes.
 *
 * Se prefiere la URL de objeto; donde no existe —entornos de prueba y
 * webviews antiguas— se cae en una URL de datos, porque quedarse sin ninguna
 * dejaría el proyecto recién abierto mostrando que faltan todos sus archivos.
 */
export function objectUrlFor(bytes: Uint8Array, mime: string): string {
  const type = mime === '' ? 'application/octet-stream' : mime;
  const blob = new Blob([bytes as BlobPart], { type });

  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob);

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Libera las direcciones que ya no se usan.
 *
 * Sólo se revocan las de objeto: una URL de datos no retiene nada y revocarla
 * no significa nada. Y sólo las que no están en el mapa nuevo, para no tirar
 * por la ventana una dirección que se acaba de reutilizar.
 */
export function releaseMediaUrls(previous: MediaUrlMap, next: MediaUrlMap): void {
  if (typeof URL.revokeObjectURL !== 'function') return;

  const kept = new Set(next.values());
  for (const url of previous.values()) {
    if (url.startsWith('blob:') && !kept.has(url)) URL.revokeObjectURL(url);
  }
}
