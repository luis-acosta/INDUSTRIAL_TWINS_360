/**
 * Emisor de variables CSS.
 *
 * Los tokens de TypeScript son la única fuente de verdad. Este módulo los
 * convierte en custom properties `--it-*`. El archivo `src/tokens.css` del
 * paquete se genera con `npm run tokens:css` y `css.test.ts` falla si el
 * archivo versionado deja de coincidir con los tokens, de modo que no puede
 * haber deriva silenciosa entre el código y la hoja de estilos.
 */
import { themes, type SemanticColors, type ThemeName } from './semantic';
import {
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  textStyles,
} from './typography';
import { borderWidth, duration, easing, elevation, frame, radius, space, zIndex } from './layout';

const px = (n: number): string => `${n}px`;

const flatten = (prefix: string, obj: Record<string, unknown>, out: string[][]): void => {
  for (const [key, value] of Object.entries(obj)) {
    const name = `${prefix}-${key.replace(/[._]/g, '-')}`;
    if (value !== null && typeof value === 'object') {
      flatten(name, value as Record<string, unknown>, out);
    } else {
      out.push([name, String(value)]);
    }
  }
};

/** Variables de color de un tema concreto. */
export function colorVariables(colors: SemanticColors): string[][] {
  const out: string[][] = [];
  flatten('--it-color', colors as unknown as Record<string, unknown>, out);
  return out;
}

/** Variables invariantes al tema: tipografía, retícula, movimiento, capas. */
export function structuralVariables(): string[][] {
  const out: string[][] = [];

  out.push(['--it-font-sans', fontFamily.sans]);
  out.push(['--it-font-mono', fontFamily.mono]);
  for (const [k, v] of Object.entries(fontSize)) out.push([`--it-text-${k}`, px(v)]);
  for (const [k, v] of Object.entries(fontWeight)) out.push([`--it-weight-${k}`, String(v)]);
  for (const [k, v] of Object.entries(lineHeight)) out.push([`--it-leading-${k}`, String(v)]);
  for (const [k, v] of Object.entries(letterSpacing)) out.push([`--it-tracking-${k}`, v]);

  for (const [k, v] of Object.entries(space)) {
    out.push([`--it-space-${k.replace('.', '_')}`, px(v)]);
  }
  for (const [k, v] of Object.entries(radius)) {
    out.push([`--it-radius-${k}`, typeof v === 'number' ? px(v) : v]);
  }
  for (const [k, v] of Object.entries(borderWidth)) out.push([`--it-border-${k}`, px(v)]);
  for (const [k, v] of Object.entries(elevation)) out.push([`--it-elevation-${k}`, v]);
  for (const [k, v] of Object.entries(duration)) out.push([`--it-duration-${k}`, `${v}ms`]);
  for (const [k, v] of Object.entries(easing)) out.push([`--it-ease-${k}`, v]);
  for (const [k, v] of Object.entries(zIndex)) out.push([`--it-z-${k}`, String(v)]);
  for (const [k, v] of Object.entries(frame)) out.push([`--it-frame-${k}`, px(v)]);

  return out;
}

const block = (selector: string, vars: string[][], comment?: string): string => {
  const head = comment ? `/* ${comment} */\n` : '';
  const body = vars.map(([name, value]) => `  ${name}: ${value};`).join('\n');
  return `${head}${selector} {\n${body}\n}`;
};

/** Clases utilitarias de texto, generadas desde `textStyles`. */
function textStyleClasses(): string {
  return Object.entries(textStyles)
    .map(([name, style]) => {
      const kebab = name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      const lines = [
        `  font-family: ${style.fontFamily === fontFamily.mono ? 'var(--it-font-mono)' : 'var(--it-font-sans)'};`,
        `  font-size: ${px(style.fontSize)};`,
        `  font-weight: ${style.fontWeight};`,
        `  line-height: ${style.lineHeight};`,
        `  letter-spacing: ${style.letterSpacing};`,
      ];
      if ('textTransform' in style && style.textTransform) {
        lines.push(`  text-transform: ${style.textTransform};`);
      }
      return `.it-text-${kebab} {\n${lines.join('\n')}\n}`;
    })
    .join('\n\n');
}

/**
 * Genera la hoja completa de tokens.
 *
 * Estrategia de tema: el tema oscuro es el predeterminado en `:root` porque
 * es el que se usa en sala de control; `[data-theme='light']` lo sobreescribe.
 * `prefers-color-scheme` sólo aplica cuando el usuario no ha elegido tema
 * explícitamente (`[data-theme='system']`).
 */
export function generateTokensCss(): string {
  const header = [
    '/*',
    ' * INDUSTRIAL TWINS 360 — tokens de diseño.',
    ' *',
    ' * ARCHIVO GENERADO. No editar a mano.',
    ' * Fuente: packages/tokens/src/*.ts — regenerar con `npm run tokens:css`.',
    ' */',
  ].join('\n');

  const sections = [
    header,
    block(':root', structuralVariables(), 'Estructura: tipografía, retícula, movimiento y capas'),
    block(':root, [data-theme="dark"]', colorVariables(themes.dark), 'Tema oscuro (predeterminado)'),
    block('[data-theme="light"]', colorVariables(themes.light), 'Tema claro'),
    [
      '/* Tema del sistema: sólo cuando el usuario no ha fijado preferencia */',
      '@media (prefers-color-scheme: light) {',
      block('  [data-theme="system"]', colorVariables(themes.light))
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
      '}',
    ].join('\n'),
    [
      '/* Movimiento reducido: se respeta la preferencia del sistema operativo */',
      '@media (prefers-reduced-motion: reduce) {',
      '  :root {',
      '    --it-duration-fast: 0ms;',
      '    --it-duration-normal: 0ms;',
      '    --it-duration-slow: 0ms;',
      '    --it-duration-deliberate: 0ms;',
      '    --it-duration-sceneTransition: 0ms;',
      '  }',
      '}',
    ].join('\n'),
    [
      '/* Estilos de texto con nombre de uso */',
      textStyleClasses(),
    ].join('\n'),
  ];

  return `${sections.join('\n\n')}\n`;
}

export const themeNames: readonly ThemeName[] = ['dark', 'light'];
