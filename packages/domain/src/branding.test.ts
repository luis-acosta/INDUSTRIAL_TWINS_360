/**
 * Pruebas de la marca propia del cliente (S10).
 *
 * La comprobación que justifica este módulo es la de contraste. Un color de
 * acento lo elige el departamento de marca del cliente —un amarillo de
 * seguridad, un naranja corporativo— y con texto blanco encima deja las
 * etiquetas de los botones ilegibles. Eso no se ve en un selector de color: se
 * descubre en la planta, en una tableta a plena luz y con guantes puestos.
 *
 * Y la regla que lo acompaña: se avisa, no se impide. El color no es nuestro
 * para rechazarlo; lo que se puede hacer es decir cuánto contraste da y en qué
 * dirección pedir otro tono.
 */
import { describe, expect, it } from 'vitest';

import {
  MIN_ACCENT_CONTRAST,
  accentWarning,
  brandingView,
  contrastRatio,
  isAccentColor,
  normalizeAccent,
  relativeLuminance,
  textOnAccent,
} from './branding';

describe('normalizeAccent', () => {
  it('acepta las dos formas y las deja en seis dígitos', () => {
    // TEST-BRN-001: la forma corta es la que escribe la gente a mano.
    expect(normalizeAccent('#1B5E20')).toBe('#1b5e20');
    expect(normalizeAccent('  #1b5  ')).toBe('#11bb55');
  });

  it('rechaza lo que no es un color en lugar de arreglarlo a medias', () => {
    // TEST-BRN-002: «#ff» no tiene una interpretación evidente, y elegir una
    // por el autor haría que el paquete saliera con un color que nadie pidió.
    expect(normalizeAccent('#ff')).toBeNull();
    expect(normalizeAccent('rojo')).toBeNull();
    expect(normalizeAccent('#1b5e2')).toBeNull();
    // Sin alfa: el acento pinta fondos de botón y un acento translúcido
    // dependería de lo que haya debajo.
    expect(normalizeAccent('#1b5e2080')).toBeNull();
    expect(isAccentColor('#1b5e20')).toBe(true);
    expect(isAccentColor('verde')).toBe(false);
  });
});

describe('contrastRatio', () => {
  it('blanco contra negro da el máximo', () => {
    // TEST-BRN-003: fija la escala; sin esto, un error de fórmula pasaría
    // desapercibido en los casos intermedios.
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('un color contra sí mismo da uno', () => {
    // TEST-BRN-004
    expect(contrastRatio('#1b5e20', '#1b5e20')).toBeCloseTo(1, 5);
  });

  it('la luminancia sigue la curva de WCAG y no el promedio de canales', () => {
    // TEST-BRN-005: el verde pesa casi tres veces más que el rojo en la
    // percepción. Promediar canales daría el mismo contraste a un verde y a un
    // azul del mismo valor numérico, y el azul es mucho más oscuro a la vista.
    expect(relativeLuminance('#00ff00')).toBeGreaterThan(relativeLuminance('#0000ff'));
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });
});

describe('textOnAccent', () => {
  it('elige negro sobre un acento claro y blanco sobre uno oscuro', () => {
    // TEST-BRN-006: es el arreglo, no una comodidad. El sistema de diseño trae
    // un texto sobre acento fijo por tema y el acento lo trae el cliente: con
    // un amarillo corporativo y el texto claro del tema, la etiqueta del botón
    // quedaba a 1,4:1 de contraste, que es un botón en blanco.
    expect(textOnAccent('#ffd600')).toBe('#000000');
    expect(textOnAccent('#1b5e20')).toBe('#ffffff');
  });

  it('el peor acento posible sigue siendo legible con el texto elegido', () => {
    // TEST-BRN-007: es la medición que decidió que no haya aviso de contraste.
    // Recorrido el espacio de color, el peor caso —un azul grisáceo medio— da
    // 4,58:1 eligiendo el texto, por encima del mínimo de 4,5:1. Un aviso de
    // contraste no podría saltar nunca, y uno que no salta es código muerto
    // que aparenta una comprobación que no existe.
    const worst = '#4b7d87';

    expect(contrastRatio(worst, textOnAccent(worst))).toBeGreaterThanOrEqual(
      MIN_ACCENT_CONTRAST,
    );
  });
});

describe('accentWarning', () => {
  it('calla con cualquier color válido', () => {
    // TEST-BRN-008: por la medición anterior. Un aviso que aparece siempre
    // —o que aparece sin que haya nada que hacer— enseña a ignorar los avisos.
    expect(accentWarning('#1b5e20')).toBeNull();
    expect(accentWarning('#ffd600')).toBeNull();
    expect(accentWarning('#4b7d87')).toBeNull();
  });

  it('avisa de lo único que el autor puede equivocar: que no sea un color', () => {
    // TEST-BRN-009: el campo es de texto libre. Sin el ejemplo, el autor no
    // sabe si se espera «rgb(...)», un nombre o un hexadecimal; y sin decir
    // qué pasa entonces, creería que su color se ha aplicado.
    const warning = accentWarning('verde corporativo');

    expect(warning).toMatch(/#1b5e20/);
    expect(warning).toMatch(/color del sistema/);
  });
});

describe('brandingView', () => {
  it('el título de marca manda y el del proyecto es la reserva', () => {
    // TEST-BRN-010: un recorrido publicado sin marca propia tiene que seguir
    // diciendo cómo se llama.
    expect(
      brandingView({ title: 'Planta Norte', logoPath: null, accentColor: null }, 'Proyecto 12')
        .title,
    ).toBe('Planta Norte');
    expect(
      brandingView({ title: '   ', logoPath: null, accentColor: null }, 'Proyecto 12').title,
    ).toBe('Proyecto 12');
  });

  it('el texto alternativo del logotipo es el título, no «logotipo»', () => {
    // TEST-BRN-011: quien usa un lector de pantalla necesita saber de quién es
    // el recorrido, no que ahí hay una imagen. Y si el logotipo no carga —algo
    // frecuente en un paquete servido desde una carpeta compartida—, es lo
    // único que queda escrito en la cabecera.
    const view = brandingView(
      { title: 'Planta Norte', logoPath: 'media/logo.png', accentColor: null },
      'Proyecto 12',
    );

    expect(view.logoAlt).toBe('Planta Norte');
    expect(view.logoPath).toBe('media/logo.png');
  });

  it('resuelve el acento y el texto que va encima', () => {
    // TEST-BRN-012: los dos juntos, porque uno sin el otro no sirve para
    // pintar nada.
    const view = brandingView(
      { title: 'x', logoPath: null, accentColor: '#FFD600' },
      'Proyecto 12',
    );

    expect(view.accentColor).toBe('#ffd600');
    expect(view.textOnAccent).toBe('#000000');
  });

  it('un acento inválido queda en nada y no en un color inventado', () => {
    // TEST-BRN-013: publicar con un color que el autor no eligió es peor que
    // publicar con el del sistema, porque nadie sabría de dónde salió.
    const view = brandingView(
      { title: 'x', logoPath: null, accentColor: 'verde' },
      'Proyecto 12',
    );

    expect(view.accentColor).toBeNull();
    expect(view.textOnAccent).toBeNull();
  });
});
