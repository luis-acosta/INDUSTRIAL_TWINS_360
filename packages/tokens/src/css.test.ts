import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateTokensCss, colorVariables, structuralVariables } from './css';
import { themes } from './semantic';

/**
 * TEST-TOK-001 .. TEST-TOK-004
 * Requisito: sistema de diseño coherente y sin deriva (etapa 03, F02/F11/F12).
 */
describe('emisor de tokens CSS', () => {
  it('TEST-TOK-001: el tokens.css versionado coincide con los tokens de TypeScript', () => {
    const path = fileURLToPath(new URL('./tokens.css', import.meta.url));
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toBe(generateTokensCss());
  });

  it('TEST-TOK-002: ambos temas exponen exactamente el mismo conjunto de variables', () => {
    const dark = colorVariables(themes.dark).map(([n]) => n);
    const light = colorVariables(themes.light).map(([n]) => n);
    expect(new Set(light)).toEqual(new Set(dark));
    expect(dark.length).toBeGreaterThan(30);
  });

  it('TEST-TOK-003: no hay nombres de variable duplicados', () => {
    const names = [...structuralVariables(), ...colorVariables(themes.dark)].map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('TEST-TOK-004: ninguna variable queda vacía o con "undefined"', () => {
    const all = [...structuralVariables(), ...colorVariables(themes.dark)];
    for (const [name, value] of all) {
      expect(value, `variable ${name}`).not.toBe('');
      expect(value, `variable ${name}`).not.toContain('undefined');
      expect(value, `variable ${name}`).not.toContain('NaN');
    }
  });
});
