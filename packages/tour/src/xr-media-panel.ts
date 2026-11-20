/**
 * Panel de multimedia dentro de la sesión inmersiva (N10).
 *
 * La etapa 13 dejaba la multimedia emergente a medias, y el motivo era una sola
 * frase: mientras la sesión presenta, el navegador dibuja lo que entrega el
 * bucle de WebXR, de modo que una ventana de HTML sigue ahí para quien mire la
 * pantalla del PC y no existe para quien lleva las gafas. El visitante pulsaba
 * un punto de interés, el audio empezaba a sonar y en el visor no pasaba nada.
 *
 * Los tres casos, que no son el mismo:
 *
 *  - **Vídeo**: es imagen, y la imagen tiene que entrar en la escena que se
 *    dibuja. Lo hace `createVideoSurface`, con el mismo elemento que reproduce
 *    la ventana plana.
 *  - **Audio e imagen**: suenan y se cargan igual; lo que falta es decir en el
 *    visor qué está pasando y poder cerrarlo.
 *  - **Documento o página enmarcada**: no se pueden mostrar aquí, y se dice.
 *    Dejar la acción muda es peor, porque el visitante no sabe si el fallo es
 *    del recorrido o suyo.
 *
 * Este módulo resuelve el segundo y el tercero, y acompaña al primero con el
 * título y el progreso. Lo hace **componiendo nodos de piel de verdad** —un
 * contenedor, un texto, una barra y un botón— y no una vía de dibujado nueva:
 * así el panel se maqueta, se pinta, se apunta con el mando y se activa con el
 * mismo código que cualquier otro panel del recorrido, y una mejora en ese
 * código llega también aquí.
 */

import { skinNodeSchema, type SkinNode } from '@it360/domain';
import { unsupportedMediaMessage, xrMediaSupport, type XrMediaSupport } from '@it360/viewer';

import type { TourWindow } from './windows';

/** Identificador del panel y de su botón de cierre. */
export const XR_MEDIA_PANEL_ID = 'xr-media';
export const XR_MEDIA_CLOSE_ID = 'xr-media-close';

export interface XrMediaPanelInput {
  readonly title: string;
  readonly kind: string;
  /** Fracción reproducida, 0-1, o `null` si no procede. */
  readonly fraction: number | null;
}

/**
 * Lo que hay que mostrar de una ventana abierta, o `null` si no hay nada.
 *
 * Una ventana de información o un cuestionario ya tienen su propio panel en VR;
 * esto es sólo para la multimedia y los documentos, que es lo que la sesión no
 * podía mostrar.
 */
export function xrMediaFromWindow(win: TourWindow | null): XrMediaPanelInput | null {
  if (win === null) return null;

  if (win.kind === 'media') {
    const item = win.items[win.index];
    if (item === undefined) return null;
    // El título del álbum describe el conjunto; el pie describe la foto. En un
    // panel de un solo renglón vale más el pie, y el título cuando no hay pie.
    return { title: item.caption || win.title, kind: item.kind, fraction: null };
  }

  if (win.kind === 'document') {
    return { title: win.title, kind: 'document', fraction: null };
  }

  return null;
}

/**
 * Nodos del panel para un estado de multimedia.
 *
 * El vídeo no lleva texto sobre la imagen: su panel es la imagen, y un rótulo
 * encima taparía justo lo que se ha abierto para mirar. Lleva el título debajo
 * y el botón de cerrar, que dentro del visor es la única forma de salir —no hay
 * una tecla de escape que pulsar—.
 */
export function xrMediaPanelNodes(input: XrMediaPanelInput): readonly SkinNode[] {
  const support: XrMediaSupport = xrMediaSupport(input.kind);
  const children: unknown[] = [
    {
      id: 'xr-media-title',
      name: 'Título',
      config: { kind: 'text', template: input.title },
      box: { anchor: 'topLeft', offsetX: 24, offsetY: 24, width: 520 },
      style: {},
    },
  ];

  if (support === 'unsupported') {
    children.push({
      id: 'xr-media-message',
      name: 'Aviso',
      config: { kind: 'text', template: unsupportedMediaMessage(input.kind) },
      box: { anchor: 'topLeft', offsetX: 24, offsetY: 72, width: 520 },
      style: {},
    });
  } else if (support === 'audio' || support === 'video') {
    /* La barra lee la fuente «media», que es la misma que usa la versión
       plana: el progreso lo pone el reproductor, no este panel. */
    children.push({
      id: 'xr-media-progress',
      name: 'Progreso',
      config: { kind: 'progressBar', source: 'media', showLabel: true },
      box: { anchor: 'topLeft', offsetX: 24, offsetY: 76, width: 520, height: 18 },
      style: {},
    });
  }

  children.push({
    id: XR_MEDIA_CLOSE_ID,
    name: 'Cerrar',
    config: { kind: 'button', label: 'Cerrar', variant: 'secondary' },
    box: { anchor: 'topLeft', offsetX: 24, offsetY: 120, width: 180, height: 56 },
    style: {},
  });

  /* Se construye con el esquema del contrato y no a mano: los valores por
     omisión de un nodo de piel son parte del contrato, y copiarlos aquí los
     dejaría desfasados en cuanto alguien añadiera un campo. */
  return [
    skinNodeSchema.parse({
      id: XR_MEDIA_PANEL_ID,
      name: 'Multimedia',
      config: { kind: 'container', direction: 'column', justify: 'start', align: 'start' },
      box: { anchor: 'center', width: 580, height: 200 },
      style: {},
      children,
    }),
  ];
}
