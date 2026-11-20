/**
 * Pruebas de la entrega del elemento de vídeo a la sesión inmersiva (N10).
 *
 * Es la pieza que conecta las dos mitades: la ventana del recorrido reproduce
 * el vídeo en un elemento del DOM, y la sesión inmersiva necesita **ese mismo
 * elemento** para llevarlo a una textura, porque un vídeo en DOM no se compone
 * sobre la imagen del visor.
 *
 * Se reutiliza en lugar de crear otro elemento, y eso tiene dos consecuencias
 * que estas pruebas fijan: que la referencia llega, y que se retira al cerrar.
 * Sin lo segundo, la sesión seguiría intentando decodificar fotogramas de un
 * elemento que ya no está en el documento.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { WindowHost } from './WindowHost';
import type { TourWindow } from './windows';

function mediaWindow(kind: 'video' | 'audio'): TourWindow {
  return {
    id: 'w1',
    kind: 'media',
    title: 'Arranque de la bomba',
    items: [
      {
        url: kind === 'video' ? 'media/arranque.mp4' : 'media/locucion.m4a',
        caption: 'Secuencia',
        kind,
      },
    ],
    index: 0,
    autoplay: false,
    widthPx: 720,
    heightPx: 480,
    modal: false,
    onClose: [],
  } as unknown as TourWindow;
}

describe('entrega del elemento de vídeo', () => {
  it('entrega el elemento del vídeo en reproducción', () => {
    // TEST-WVE-001: sin esto la sesión inmersiva no tiene nada que llevar a la
    // textura, y el visitante ve el recorrido mientras oye un vídeo que no
    // aparece en ninguna parte.
    const onVideoElement = vi.fn();
    render(
      <WindowHost
        window={mediaWindow('video')}
        onClose={() => undefined}
        onAlbumIndex={() => undefined}
        frameOrigins={[]}
        onVideoElement={onVideoElement}
      />,
    );

    const element = onVideoElement.mock.calls.at(-1)?.[0] as HTMLVideoElement | null;
    expect(element).toBeInstanceOf(HTMLVideoElement);
    expect(element?.getAttribute('src')).toBe('media/arranque.mp4');
  });

  it('retira la referencia al cerrar la ventana', () => {
    // TEST-WVE-002: una textura de vídeo apuntando a un elemento que ya no
    // existe sigue en la escena del visor —en el mejor caso congelada en el
    // último fotograma— y nadie la libera.
    const onVideoElement = vi.fn();
    const { unmount } = render(
      <WindowHost
        window={mediaWindow('video')}
        onClose={() => undefined}
        onAlbumIndex={() => undefined}
        frameOrigins={[]}
        onVideoElement={onVideoElement}
      />,
    );

    unmount();

    expect(onVideoElement).toHaveBeenLastCalledWith(null);
  });

  it('un audio no entrega elemento de vídeo', () => {
    // TEST-WVE-003: el audio no necesita textura —suena desde su elemento,
    // porque el audio del navegador no pasa por el bucle de fotogramas—. Si
    // esto entregara algo, la sesión crearía una textura de un elemento sin
    // imagen y el panel saldría en negro.
    const onVideoElement = vi.fn();
    render(
      <WindowHost
        window={mediaWindow('audio')}
        onClose={() => undefined}
        onAlbumIndex={() => undefined}
        frameOrigins={[]}
        onVideoElement={onVideoElement}
      />,
    );

    expect(onVideoElement).not.toHaveBeenCalled();
  });
});
