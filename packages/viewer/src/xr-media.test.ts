/**
 * Pruebas de la multimedia dentro de la sesión inmersiva (N10).
 *
 * El defecto que esto cierra: un vídeo o un audio abiertos desde un punto de
 * interés se reproducían en una ventana de HTML que, mientras la sesión
 * presenta, no se compone sobre la imagen del visor. El visitante pulsaba, el
 * sonido empezaba y en las gafas no pasaba nada.
 *
 * Lo que se comprueba aquí es la clasificación —que decide qué se puede mostrar
 * y qué se dice que no— y la aritmética del panel. La textura de vídeo en sí
 * necesita un contexto WebGL que jsdom no tiene; lo que se puede comprobar sin
 * GPU es que la proporción del panel sale del vídeo y no de una suposición.
 */
import { describe, expect, it } from 'vitest';

import {
  unsupportedMediaMessage,
  videoAspect,
  xrMediaPanelState,
  xrMediaSupport,
} from './xr-media';

describe('xrMediaSupport', () => {
  it('separa lo que se puede mostrar de lo que no', () => {
    // TEST-XRM-001: la distinción no es cosmética. El vídeo necesita textura,
    // el audio no la necesita —suena igual desde su elemento, porque el audio
    // no pasa por el bucle de fotogramas— y un documento no se puede mostrar.
    expect(xrMediaSupport('video')).toBe('video');
    expect(xrMediaSupport('audio')).toBe('audio');
    expect(xrMediaSupport('image')).toBe('image');
    expect(xrMediaSupport('document')).toBe('unsupported');
    expect(xrMediaSupport('other')).toBe('unsupported');
  });
});

describe('unsupportedMediaMessage', () => {
  it('dice qué hacer y no sólo que no se puede', () => {
    // TEST-XRM-002: quien tiene unas gafas puestas necesita saber que la salida
    // es quitárselas. Un «no disponible» a secas se lee como una avería.
    expect(unsupportedMediaMessage('document')).toMatch(/quítese las gafas/i);
    expect(unsupportedMediaMessage('model')).toMatch(/escena propia/i);
    expect(unsupportedMediaMessage('otra cosa')).toMatch(/no se puede mostrar/i);
  });
});

describe('videoAspect', () => {
  it('usa las dimensiones reales del vídeo', () => {
    // TEST-XRM-003
    expect(videoAspect({ videoWidth: 1920, videoHeight: 1080 })).toBeCloseTo(16 / 9, 5);
    expect(videoAspect({ videoWidth: 1080, videoHeight: 1920 })).toBeCloseTo(9 / 16, 5);
  });

  it('antes de cargar los metadatos supone apaisado y lo corrige después', () => {
    // TEST-XRM-004: un vídeo recién abierto no conoce su tamaño. Estirar un
    // vídeo vertical para llenar un panel apaisado molesta más dentro del visor
    // que en una pantalla, porque no hay nada alrededor con lo que comparar;
    // por eso el panel se recalcula cuando el dato llega.
    expect(videoAspect({ videoWidth: 0, videoHeight: 0 })).toBeCloseTo(16 / 9, 5);
  });
});

describe('xrMediaPanelState', () => {
  it('calcula la fracción reproducida', () => {
    // TEST-XRM-005
    const state = xrMediaPanelState({
      title: 'Procedimiento de arranque',
      kind: 'audio',
      playing: true,
      positionS: 30,
      durationS: 120,
    });

    expect(state.fraction).toBeCloseTo(0.25, 5);
    expect(state.support).toBe('audio');
    expect(state.message).toBeNull();
  });

  it('recorta la fracción a uno', () => {
    // TEST-XRM-006: un vídeo puede declarar una duración ligeramente menor que
    // su último instante, y una barra que se pasa del final parece averiada.
    const state = xrMediaPanelState({
      title: 'Vídeo',
      kind: 'video',
      playing: false,
      positionS: 121,
      durationS: 120,
    });

    expect(state.fraction).toBe(1);
  });

  it('sin duración conocida la barra queda a cero y no a NaN', () => {
    // TEST-XRM-007: una emisión sin duración declarada daría una división por
    // cero, y `NaN` en la anchura de la barra la hace desaparecer sin motivo
    // visible.
    expect(
      xrMediaPanelState({
        title: 'En directo',
        kind: 'video',
        playing: true,
        positionS: 42,
        durationS: null,
      }).fraction,
    ).toBe(0);
  });

  it('un documento trae el mensaje de que no se puede mostrar', () => {
    // TEST-XRM-008: es la alternativa a dejar la acción muda, que es lo que
    // ocurría antes.
    const state = xrMediaPanelState({
      title: 'Manual de la bomba',
      kind: 'document',
      playing: false,
      positionS: 0,
      durationS: null,
    });

    expect(state.support).toBe('unsupported');
    expect(state.message).toMatch(/quítese las gafas/i);
  });
});
