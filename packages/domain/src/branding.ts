/**
 * Marca propia del cliente (S10).
 *
 * El contrato llevaba desde la etapa 00 un bloque de marca —título, color de
 * acento, logotipo e icono— y el exportador ya lo escribía en el paquete: el
 * icono entraba en el HTML, el color en una variable del sistema de diseño y el
 * logotipo se copiaba entre los archivos. Lo que no había era forma de
 * **ponerlo** desde el editor ni sitio donde se **viera** el logotipo, así que
 * el logotipo era un archivo que el paquete llevaba y nadie leía, y el resto
 * sólo llegaba en un proyecto importado.
 *
 * Este módulo es la parte que se puede decidir sin pintar nada: validar el
 * color, avisar cuando no se va a poder leer encima, y resolver qué texto
 * mostrar. La comprobación de contraste es la que más vale: un acento elegido
 * por la identidad corporativa —un amarillo de seguridad, por ejemplo— deja el
 * texto blanco de un botón ilegible, y eso no se descubre mirando el selector
 * de color, sino en la planta y con guantes puestos.
 */

/** Color de acento válido: `#rgb` o `#rrggbb`, sin alfa. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isAccentColor = (value: string): boolean => HEX.test(value.trim());

/**
 * Normaliza un color de acento, o `null` si no es válido.
 *
 * Devolver `null` en lugar de arreglarlo a medias es deliberado: un color
 * escrito a medias («#ff») no tiene una interpretación evidente, y elegir una
 * por el autor haría que el paquete saliera con un color que nadie pidió.
 */
export function normalizeAccent(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!HEX.test(text)) return null;
  if (text.length === 4) {
    const [, r, g, b] = text;
    return `#${r!}${r!}${g!}${g!}${b!}${b!}`;
  }
  return text;
}

/** Componentes 0-255 de un color ya normalizado. */
function channels(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Luminancia relativa según WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const normalized = normalizeAccent(hex);
  if (normalized === null) return 0;

  const [r, g, b] = channels(normalized).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relación de contraste entre dos colores, de 1 a 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Contraste mínimo, nivel AA de WCAG para texto normal.
 *
 * No se baja a 3:1 —el nivel para texto grande— porque las etiquetas de los
 * botones y los enlaces del visor son pequeños, y porque el recorrido se mira
 * en una tableta a plena luz dentro de una planta, que es peor que cualquier
 * oficina.
 */
export const MIN_ACCENT_CONTRAST = 4.5;

/** Blanco y negro, los dos únicos colores de texto que el acento puede llevar. */
const ON_ACCENT = ['#ffffff', '#000000'] as const;

/**
 * Color de texto legible encima del acento.
 *
 * Se elige y no se fija, y esto es un arreglo y no una comodidad: el sistema de
 * diseño trae un color de texto sobre acento por tema —claro en uno, oscuro en
 * otro—, y el acento lo trae el cliente, así que la combinación no la pudo
 * prever nadie. Con el texto de tema fijo, un acento amarillo corporativo daba
 * 1,4:1 contra su etiqueta: un botón en blanco. El exportador escribe este
 * valor junto al acento, y entonces el botón siempre se lee.
 */
export function textOnAccent(accent: string): string {
  const white = contrastRatio(accent, ON_ACCENT[0]);
  const black = contrastRatio(accent, ON_ACCENT[1]);
  return white >= black ? ON_ACCENT[0] : ON_ACCENT[1];
}

/**
 * Aviso sobre el acento elegido, o `null` si no hay nada que decir.
 *
 * **Por qué no hay aviso de contraste.** Lo había al escribir este módulo, y se
 * quitó al medirlo: una vez que el texto sobre el acento se elige en lugar de
 * venir fijo del tema, el peor caso posible de todo el espacio de color es
 * 4,58:1 —por encima del mínimo de 4,5:1—, así que el aviso no podía saltar
 * nunca. Un aviso que no puede saltar es código muerto que da la impresión de
 * una comprobación que no existe.
 *
 * El otro uso del acento, el color de los enlaces, no se toca: el sistema de
 * diseño lo lleva en un token aparte por tema (`accent-onSurface`) y la marca
 * del cliente sólo sustituye el relleno de los botones. Avisar de él sería
 * avisar de algo que no ocurre.
 *
 * Queda, por tanto, lo único que el autor puede equivocar de verdad: escribir
 * algo que no es un color.
 */
export function accentWarning(accent: string): string | null {
  if (normalizeAccent(accent) !== null) return null;
  return 'El color de acento no es un valor hexadecimal válido («#1b5e20» o «#1b5»); se publicará con el color del sistema.';
}

export interface BrandingView {
  /** Texto de la cabecera. */
  readonly title: string;
  /** Ruta del logotipo en el paquete, o `null`. */
  readonly logoPath: string | null;
  /** Texto alternativo del logotipo. */
  readonly logoAlt: string;
  readonly accentColor: string | null;
  readonly textOnAccent: string | null;
}

/**
 * Lo que la cabecera del recorrido tiene que dibujar.
 *
 * El título de marca manda sobre el del proyecto, y el del proyecto es la
 * reserva: un recorrido publicado sin marca propia tiene que seguir diciendo
 * cómo se llama.
 *
 * El texto alternativo del logotipo es el título y no «logotipo»: quien usa un
 * lector de pantalla necesita saber de quién es el recorrido, no que ahí hay
 * una imagen. Y cuando hay logotipo el título se sigue escribiendo en el
 * `alt` en lugar de ocultarse del todo, porque un logotipo que no carga —en un
 * paquete servido desde una carpeta compartida es frecuente— dejaría la
 * cabecera muda.
 */
export function brandingView(
  branding: {
    readonly title: string;
    readonly logoPath: string | null;
    readonly accentColor: string | null;
  },
  projectTitle: string,
): BrandingView {
  const title = branding.title.trim().length > 0 ? branding.title.trim() : projectTitle;
  const accent =
    branding.accentColor === null ? null : normalizeAccent(branding.accentColor);

  return {
    title,
    logoPath: branding.logoPath,
    logoAlt: title,
    accentColor: accent,
    textOnAccent: accent === null ? null : textOnAccent(accent),
  };
}
