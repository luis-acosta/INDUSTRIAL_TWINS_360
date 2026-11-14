/**
 * Pruebas de la clase de dispositivo (D14).
 *
 * Importan porque el autor excluye componentes del móvil, y hasta ahora el
 * visor declaraba «escritorio» siempre: la exclusión no se aplicaba nunca.
 */
import { describe, expect, it } from 'vitest';
import { classifyDevice, currentDeviceSignals } from './device';

describe('classifyDevice', () => {
  it('TEST-DEV-001 con ratón y ventana amplia, escritorio', () => {
    expect(classifyDevice({ width: 1600, coarsePointer: false })).toBe('desktop');
  });

  it('TEST-DEV-002 con ratón y ventana a media pantalla, sigue siendo escritorio', () => {
    // Quien oculta algo en el móvil lo hace porque no se puede pulsar con el
    // dedo, no porque la ventana sea angosta.
    expect(classifyDevice({ width: 800, coarsePointer: false })).toBe('desktop');
  });

  it('TEST-DEV-003 con ratón y ventana muy angosta, tableta', () => {
    expect(classifyDevice({ width: 500, coarsePointer: false })).toBe('tablet');
  });

  it('TEST-DEV-004 con dedo y pantalla pequeña, móvil', () => {
    expect(classifyDevice({ width: 390, coarsePointer: true })).toBe('mobile');
  });

  it('TEST-DEV-005 con dedo y pantalla mediana o grande, tableta', () => {
    expect(classifyDevice({ width: 820, coarsePointer: true })).toBe('tablet');
    expect(classifyDevice({ width: 1400, coarsePointer: true })).toBe('tablet');
  });

  it('TEST-DEV-006 en sesión inmersiva manda el visor de realidad virtual', () => {
    expect(classifyDevice({ width: 1600, coarsePointer: false, inVr: true })).toBe('vr');
    expect(classifyDevice({ width: 390, coarsePointer: true, inVr: true })).toBe('vr');
  });

  it('TEST-DEV-007 las señales del entorno se leen sin romperse', () => {
    // En jsdom no hay `matchMedia`: el valor prudente es puntero fino.
    const signals = currentDeviceSignals();
    expect(signals.width).toBeGreaterThan(0);
    expect(typeof signals.coarsePointer).toBe('boolean');
  });
});
