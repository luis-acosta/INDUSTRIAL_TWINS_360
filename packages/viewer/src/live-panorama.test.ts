/**
 * Pruebas de la panorámica en vivo (B06).
 *
 * Lo que esta función aporta en una planta es distinto de lo que aporta en una
 * casa: una fotografía fija de una unidad en operación puede parecer una unidad
 * parada, y un bucle de unos segundos —vapor, llama, aspas— dice que aquello
 * está en marcha. Es información.
 *
 * Y por eso mismo las condiciones para no reproducirla son la parte importante
 * de estas pruebas. La primera, la que no se puede negociar: **un entorno que
 * se mueve es exactamente lo que `prefers-reduced-motion` pide no hacer**, y
 * aquí el movimiento ocupa los 360 grados, así que quien tiene esa preferencia
 * activada por mareo no puede esquivarlo mirando a otro lado.
 */
import { describe, expect, it } from 'vitest';

import { decideLive, readLiveContext, type LiveContext } from './live-panorama';

const MP4 = 'video/mp4';

function context(overrides: Partial<LiveContext> = {}): LiveContext {
  return {
    reducedMotion: false,
    saveData: false,
    canPlay: () => 'probably',
    ...overrides,
  };
}

describe('decideLive', () => {
  it('reproduce cuando se puede y nadie ha pedido lo contrario', () => {
    // TEST-LIV-001
    expect(decideLive(MP4, context())).toEqual({ play: true });
  });

  it('no reproduce con movimiento reducido, y explica por qué', () => {
    // TEST-LIV-002: es la condición que no se negocia. El movimiento ocupa los
    // 360 grados: quien tiene la preferencia activada por mareo no puede
    // esquivarlo mirando a otro lado.
    const decision = decideLive(MP4, context({ reducedMotion: true }));

    expect(decision.play).toBe(false);
    if (decision.play) return;
    expect(decision.reason).toBe('reducedMotion');
    expect(decision.message).toMatch(/360 grados/);
  });

  it('el movimiento reducido manda sobre la capacidad técnica', () => {
    // TEST-LIV-003: el orden de las comprobaciones importa. Al revés, un
    // dispositivo sin ese códec informaría de un problema de códec a alguien
    // que de todas formas había pedido no ver movimiento, y el mensaje le haría
    // buscar solución a algo que no es su caso.
    const decision = decideLive(MP4, context({ reducedMotion: true, canPlay: () => '' }));

    expect(decision.play).toBe(false);
    if (decision.play) return;
    expect(decision.reason).toBe('reducedMotion');
  });

  it('no reproduce con ahorro de datos', () => {
    // TEST-LIV-004: el bucle pesa más que la fotografía, y la fotografía ya
    // cuenta la escena. El visitante lo pidió explícitamente.
    const decision = decideLive(MP4, context({ saveData: true }));

    expect(decision.play).toBe(false);
    if (decision.play) return;
    expect(decision.reason).toBe('saveData');
  });

  it('no reproduce un formato que el dispositivo no admite', () => {
    // TEST-LIV-005: se comprueba antes de pedir el archivo. Pedir veinte
    // megabytes para descubrir que no se puede decodificar es gastar la red de
    // la planta para nada.
    const decision = decideLive('video/av01', context({ canPlay: () => '' }));

    expect(decision.play).toBe(false);
    if (decision.play) return;
    expect(decision.reason).toBe('unsupportedCodec');
    expect(decision.message).toMatch(/video\/av01/);
  });

  it('acepta «maybe» además de «probably»', () => {
    // TEST-LIV-006: «maybe» es lo que contestan muchos navegadores para
    // formatos que luego reproducen bien. Rechazarlo dejaría la función sin
    // usar en la mitad de los dispositivos, y si al final no reproduce, la
    // reserva a la imagen fija lo recoge.
    expect(decideLive(MP4, context({ canPlay: () => 'maybe' }))).toEqual({ play: true });
  });

  it('una escena sin vídeo no es un problema que contar', () => {
    // TEST-LIV-007: es el caso de casi todas las escenas. Un aviso aquí
    // aparecería en todo el recorrido y enseñaría a ignorar los avisos.
    const decision = decideLive(null, context());

    expect(decision.play).toBe(false);
    if (decision.play) return;
    expect(decision.reason).toBe('noVideo');
  });
});

describe('readLiveContext', () => {
  it('lee el ahorro de datos y la preferencia de movimiento', () => {
    // TEST-LIV-008
    const nav = { connection: { saveData: true } } as unknown as Navigator;
    const matchMedia = ((query: string) =>
      ({ matches: query.includes('reduce') })) as unknown as typeof globalThis.matchMedia;

    const read = readLiveContext(nav, matchMedia);

    expect(read.saveData).toBe(true);
    expect(read.reducedMotion).toBe(true);
  });

  it('sin `connection` ni `matchMedia` no inventa nada', () => {
    // TEST-LIV-009: la ausencia es «no sé». Suponer movimiento reducido
    // dejaría la función apagada en los navegadores que no informan, y suponer
    // ahorro de datos también.
    const read = readLiveContext({} as Navigator, undefined);

    expect(read.saveData).toBe(false);
    expect(read.reducedMotion).toBe(false);
  });
});
