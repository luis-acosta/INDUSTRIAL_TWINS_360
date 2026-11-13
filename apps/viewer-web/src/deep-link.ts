/**
 * Enlaces a una escena y una vista concretas (S09).
 *
 * Quien enseña una planta por videollamada necesita decir «mira esto»: un
 * enlace que abra la escena correcta mirando hacia donde él mira. Hasta ahora
 * el visor ignoraba la dirección por completo y todos los enlaces abrían la
 * escena de entrada.
 *
 * Tres decisiones que vienen de cómo se usan estos enlaces:
 *
 *  - **Van en el fragmento (`#`), no en la consulta (`?`).** El fragmento no
 *    viaja al servidor, y el paquete publicado se sirve desde el servidor web
 *    del cliente, a veces con registro de accesos: la escena que alguien mira
 *    no tiene por qué quedar anotada en un registro ajeno. Además así el
 *    enlace funciona igual abierto como archivo local.
 *  - **La escena va por su identificador, no por su título.** Un título se
 *    cambia y el enlace que alguien guardó en un correo dejaría de funcionar;
 *    el identificador no cambia al renombrar.
 *  - **Un enlace roto no rompe el recorrido.** Si la escena ya no está en el
 *    paquete —porque se republicó sin ella—, el visor abre la de entrada y lo
 *    dice, en lugar de quedarse en negro.
 */
import type { CameraView } from '@it360/domain';

export interface DeepLink {
  readonly sceneId: string | null;
  readonly view: CameraView | null;
}

export const EMPTY_LINK: DeepLink = { sceneId: null, view: null };

/** Redondeo a una décima de grado: más precisión no se percibe y alarga el enlace. */
const round = (value: number): number => Math.round(value * 10) / 10;

const radToDeg = (rad: number): number => (rad * 180) / Math.PI;
const degToRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Construye el fragmento de un enlace.
 *
 * Los ángulos van en grados porque un enlace es algo que una persona copia,
 * pega y a veces lee: «yaw=47.3» se entiende y «yaw=0.8255» no.
 */
export function buildDeepLink(sceneId: string, view?: CameraView | null): string {
  const parts = [`escena=${encodeURIComponent(sceneId)}`];

  if (view != null) {
    parts.push(`yaw=${round(radToDeg(view.yaw))}`);
    parts.push(`pitch=${round(radToDeg(view.pitch))}`);
    parts.push(`fov=${round(view.fov)}`);
  }

  return `#${parts.join('&')}`;
}

/** Enlace absoluto, a partir de la dirección actual del visor. */
export function buildShareUrl(baseHref: string, sceneId: string, view?: CameraView | null): string {
  const withoutFragment = baseHref.split('#')[0] ?? baseHref;
  return `${withoutFragment}${buildDeepLink(sceneId, view)}`;
}

/**
 * Lee el fragmento.
 *
 * Tolera lo que una persona puede estropear al copiar: el `#` de más, los
 * parámetros en otro orden, un ángulo sin número. Lo que no se entiende se
 * ignora en lugar de invalidar el enlace entero: abrir la escena correcta sin
 * la orientación es mejor que no abrir nada.
 */
export function parseDeepLink(fragment: string): DeepLink {
  const raw = fragment.replace(/^#+/, '').trim();
  if (raw === '') return EMPTY_LINK;

  const params = new URLSearchParams(raw);
  const sceneId = params.get('escena');

  const yaw = numberOf(params.get('yaw'));
  const pitch = numberOf(params.get('pitch'));
  const fov = numberOf(params.get('fov'));

  // La vista necesita los tres ángulos: con dos, el tercero sería inventado y
  // el visitante vería algo que el autor del enlace no estaba mirando.
  const view =
    yaw !== null && pitch !== null && fov !== null
      ? {
          yaw: degToRad(yaw),
          pitch: degToRad(clamp(pitch, -90, 90)),
          fov: clamp(fov, 20, 120),
        }
      : null;

  return { sceneId: sceneId === null || sceneId === '' ? null : sceneId, view };
}

function numberOf(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/* ------------------------------------------------------------------ *
 * Resolución contra el paquete
 * ------------------------------------------------------------------ */

export type LinkResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'resolved'; readonly sceneId: string; readonly view: CameraView | null }
  /** La escena del enlace no está en el paquete publicado. */
  | { readonly kind: 'missing'; readonly sceneId: string };

/**
 * Resuelve un enlace contra las escenas que el paquete trae.
 *
 * Una escena ausente se informa en lugar de ignorarse: quien recibió el enlace
 * merece saber que apuntaba a algo que ya no está, y no creer que su
 * interlocutor le mandó mal la dirección.
 */
export function resolveDeepLink(link: DeepLink, sceneIds: ReadonlySet<string>): LinkResolution {
  if (link.sceneId === null) return { kind: 'none' };
  if (!sceneIds.has(link.sceneId)) return { kind: 'missing', sceneId: link.sceneId };

  return { kind: 'resolved', sceneId: link.sceneId, view: link.view };
}
