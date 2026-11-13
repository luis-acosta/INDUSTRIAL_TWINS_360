import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_DELTA_E_MIN,
  contrastRatio,
  deltaE2000,
  meetsContrast,
  NEUTRAL_VS_CHROMATIC_DELTA_E_MIN,
  NON_TEXT_CONTRAST_MIN,
  parseColor,
  requiredRatio,
  toLab,
} from './contrast';
import { darkColors, lightColors, type SemanticColors } from './semantic';

/**
 * TEST-A11Y-001 .. TEST-A11Y-006
 * Requisito: accesibilidad básica de controles (etapa 03) y distinción
 * inequívoca de estado de telemetría (etapa 07, X12).
 *
 * Estas pruebas son la red que impide que un ajuste estético degrade la
 * legibilidad: cualquier cambio de paleta que rompa AA falla el build.
 */
describe('contraste WCAG 2.1', () => {
  it('TEST-A11Y-001: el cálculo reproduce los valores de referencia de la norma', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 4);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 4);
    // Valor canónico ampliamente citado para #777 sobre blanco.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('TEST-A11Y-002: compone el alfa sobre el fondo antes de medir', () => {
    const opaque = contrastRatio('#ffffff', '#000000');
    const semi = contrastRatio('#ffffff80', '#000000');
    expect(semi).toBeLessThan(opaque);
    expect(parseColor('#ffffff80').a).toBeCloseTo(0.502, 2);
  });

  const textPairs = (c: SemanticColors): Array<[string, string, string, 'normal' | 'large']> => [
    ['texto primario sobre canvas', c.text.primary, c.surface.canvas, 'normal'],
    ['texto primario sobre base', c.text.primary, c.surface.base, 'normal'],
    ['texto primario sobre elevado', c.text.primary, c.surface.raised, 'normal'],
    ['texto primario sobre overlay', c.text.primary, c.surface.overlay, 'normal'],
    ['texto secundario sobre base', c.text.secondary, c.surface.base, 'normal'],
    ['texto secundario sobre elevado', c.text.secondary, c.surface.raised, 'normal'],
    ['texto terciario sobre base', c.text.tertiary, c.surface.base, 'large'],
    ['acento sobre base', c.accent.onSurface, c.surface.base, 'normal'],
    ['acento sobre elevado', c.accent.onSurface, c.surface.raised, 'normal'],
    ['texto sobre acento', c.text.onAccent, c.accent.default, 'normal'],
  ];

  describe.each([
    ['oscuro', darkColors],
    ['claro', lightColors],
  ])('tema %s', (themeName, colors) => {
    it(`TEST-A11Y-003: el texto cumple AA en el tema ${themeName}`, () => {
      for (const [label, fg, bg, size] of textPairs(colors)) {
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${label}: ${ratio.toFixed(2)}:1 < ${requiredRatio('AA', size)}:1`,
        ).toBeGreaterThanOrEqual(requiredRatio('AA', size));
      }
    });

    it(`TEST-A11Y-004: los estados de telemetría cumplen AA en el tema ${themeName}`, () => {
      const bg = colors.surface.raised;
      for (const [name, color] of Object.entries(colors.telemetry)) {
        const ratio = contrastRatio(color, bg);
        expect(ratio, `telemetry.${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`TEST-A11Y-005: los estados de proceso cumplen AA en el tema ${themeName}`, () => {
      const bg = colors.surface.base;
      for (const key of ['nominal', 'warning', 'alarm', 'info', 'experimental'] as const) {
        const ratio = contrastRatio(colors.status[key], bg);
        expect(ratio, `status.${key}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`TEST-A11Y-006: el borde de control y el foco cumplen 3:1 en el tema ${themeName}`, () => {
      // WCAG 1.4.11 aplica a lo que identifica un control, no a divisores
      // decorativos: por eso se mide `border.control` y no `border.default`.
      for (const bg of [colors.surface.base, colors.surface.raised]) {
        expect(
          contrastRatio(colors.border.control, bg),
          `borde de control sobre ${bg}`,
        ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
        expect(
          contrastRatio(colors.border.focus, bg),
          `anillo de foco sobre ${bg}`,
        ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
        expect(
          contrastRatio(colors.accent.default, bg),
          `relleno de acento sobre ${bg}`,
        ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
      }
    });
  });

  it('TEST-A11Y-007: ΔE CIEDE2000 reproduce valores de referencia conocidos', () => {
    // Pares de referencia del conjunto de validación de Sharma et al. (2005).
    expect(deltaE2000('#ffffff', '#ffffff')).toBeCloseTo(0, 6);
    // Negro frente a blanco: distancia máxima en el eje de claridad.
    expect(deltaE2000('#000000', '#ffffff')).toBeGreaterThan(95);
    // Lab del blanco de referencia D65.
    const white = toLab('#ffffff');
    expect(white.l).toBeCloseTo(100, 1);
    expect(white.a).toBeCloseTo(0, 1);
    expect(white.b).toBeCloseTo(0, 1);
  });

  describe.each([
    ['oscuro', darkColors],
    ['claro', lightColors],
  ])('separación categórica en el tema %s', (themeName, colors) => {
    it(`TEST-A11Y-008: los cuatro estados de X12 son distinguibles entre sí (${themeName})`, () => {
      // X12 exige diferenciar fresco, obsoleto, ausente y error. La razón de
      // contraste no sirve aquí: un verde y un ámbar de la misma claridad dan
      // ~1.2:1 y sin embargo se distinguen sin esfuerzo. Lo que debe medirse
      // es distancia perceptual.
      const quartet = ['fresh', 'stale', 'missing', 'error'] as const;
      for (let i = 0; i < quartet.length; i += 1) {
        for (let j = i + 1; j < quartet.length; j += 1) {
          const nameA = quartet[i]!;
          const nameB = quartet[j]!;
          const distance = deltaE2000(colors.telemetry[nameA], colors.telemetry[nameB]);
          expect(
            distance,
            `${nameA} vs ${nameB}: ΔE ${distance.toFixed(1)} < ${CATEGORICAL_DELTA_E_MIN}`,
          ).toBeGreaterThanOrEqual(CATEGORICAL_DELTA_E_MIN);
        }
      }
    });

    it(`TEST-A11Y-009: un dato de caché no puede confundirse con una lectura en vivo (${themeName})`, () => {
      // Confundir caché con dato nominal es el error con consecuencia
      // operativa: el resto de pares de `cached` sólo necesita separación
      // suficiente, porque siempre va rotulado.
      const { cached, fresh, stale, missing, error } = colors.telemetry;
      expect(deltaE2000(cached, fresh)).toBeGreaterThanOrEqual(CATEGORICAL_DELTA_E_MIN);
      for (const [name, other] of Object.entries({ stale, missing, error })) {
        const distance = deltaE2000(cached, other);
        expect(
          distance,
          `cached vs ${name}: ΔE ${distance.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(NEUTRAL_VS_CHROMATIC_DELTA_E_MIN);
      }
    });
  });

  it('TEST-A11Y-010: meetsContrast aplica el umbral correcto por tamaño y nivel', () => {
    expect(meetsContrast('#767676', '#ffffff', 'AA', 'normal')).toBe(true);
    expect(meetsContrast('#949494', '#ffffff', 'AA', 'normal')).toBe(false);
    expect(meetsContrast('#949494', '#ffffff', 'AA', 'large')).toBe(true);
    expect(meetsContrast('#595959', '#ffffff', 'AAA', 'normal')).toBe(true);
  });
});
