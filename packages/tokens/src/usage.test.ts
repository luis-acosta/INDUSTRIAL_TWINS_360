/**
 * TEST-TOK-005 .. TEST-TOK-007
 * Requisito: sistema de diseño sin deriva (etapa 03, F02/F11/F12).
 *
 * Esta prueba recorre todas las hojas de estilo del repositorio y comprueba
 * que cada variable `--it-*` que usan esté definida en `tokens.css`.
 *
 * Existe porque el fallo que detecta es silencioso y caro: una variable mal
 * escrita —`--it-color-text-muted` donde el token es `--it-color-text-secondary`—
 * no rompe la compilación, no rompe ninguna prueba de componente y no se ve en
 * el navegador si el elemento hereda un color parecido. Aparece semanas
 * después, en el portátil de un cliente, como un texto gris sobre gris. El
 * typecheck no puede cogerlo porque el CSS no pasa por TypeScript, así que la
 * comprobación tiene que ser explícita.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tokensCssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));

/** Nombres definidos en el tokens.css generado. */
function definedTokens(): ReadonlySet<string> {
  const source = readFileSync(tokensCssPath, 'utf8');
  return new Set([...source.matchAll(/(--it-[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

/**
 * Variables que una hoja define por su cuenta.
 *
 * Un componente puede declarar su propia variable local —`--it-row-tone`,
 * `--it-slider-fill`— para pasar un valor de un elemento a otro. Eso es
 * legítimo y no tiene por qué estar en el sistema de diseño; lo que no es
 * legítimo es *leer* una que nadie define.
 */
function locallyDefined(source: string): ReadonlySet<string> {
  return new Set([...source.matchAll(/(--it-[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

function sourceFiles(dir: string, extension: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, extension, found);
    else if (entry.endsWith(extension)) found.push(full);
  }
  return found;
}

/**
 * Variables que un componente fija desde TypeScript.
 *
 * `--it-row-tone` y `--it-slider-fill` existen para pasar un valor calculado
 * en React al CSS a través del atributo `style`. No pertenecen al sistema de
 * diseño —no son decisiones de diseño, son canales— y por eso no están en
 * `tokens.css`, pero leerlas desde la hoja es correcto.
 */
function tsxDefined(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(repoRoot, '.tsx')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"](--it-[A-Za-z0-9-]+)['"]\s*(?:as\s+string\s*)?\]?\s*:/g)) {
      names.add(match[1] as string);
    }
  }
  return names;
}

describe('uso de tokens en las hojas de estilo', () => {
  const defined = definedTokens();
  const fromTsx = tsxDefined();
  const files = sourceFiles(repoRoot, '.css');

  it('TEST-TOK-005: hay hojas de estilo que inspeccionar', () => {
    // Si el recorrido dejara de encontrar archivos, las dos pruebas
    // siguientes pasarían sin comprobar nada. Esta las protege.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.endsWith('app.css'))).toBe(true);
  });

  it('TEST-TOK-006: toda variable --it-* leída en CSS está definida', () => {
    const problems: string[] = [];

    for (const file of files) {
      if (file === tokensCssPath) continue;
      const source = readFileSync(file, 'utf8');
      const local = locallyDefined(source);

      const read = new Set(
        [...source.matchAll(/var\(\s*(--it-[A-Za-z0-9-]+)/g)].map((m) => m[1] as string),
      );

      for (const name of read) {
        if (defined.has(name) || local.has(name) || fromTsx.has(name)) continue;
        problems.push(`${relative(repoRoot, file)}: ${name}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('TEST-TOK-008: reconoce las variables que un componente fija desde TypeScript', () => {
    // Si este reconocimiento se rompiera, la prueba anterior empezaría a
    // marcar como error los canales legítimos de React al CSS.
    expect(fromTsx.has('--it-row-tone')).toBe(true);
    expect(fromTsx.has('--it-slider-fill')).toBe(true);
    // Y no debe tragarse cualquier cosa: un token del sistema no se declara así.
    expect(fromTsx.has('--it-color-text-primary')).toBe(false);
  });

  it('TEST-TOK-007: la prueba detecta un nombre inventado', () => {
    // Sin esta comprobación, un fallo en la expresión regular dejaría la
    // prueba anterior pasando siempre y el repositorio sin vigilancia.
    const fake = 'color: var(--it-color-text-muted);';
    const read = [...fake.matchAll(/var\(\s*(--it-[A-Za-z0-9-]+)/g)].map((m) => m[1] as string);

    expect(read).toEqual(['--it-color-text-muted']);
    expect(defined.has('--it-color-text-muted')).toBe(false);
    expect(defined.has('--it-color-text-secondary')).toBe(true);
  });
});
