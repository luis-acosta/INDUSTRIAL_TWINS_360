/**
 * Genera `src/tokens.css` desde los tokens de TypeScript.
 * Uso: `npm run tokens:css --workspace @it360/tokens`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateTokensCss } from '../src/css';

const target = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
writeFileSync(target, generateTokensCss(), 'utf8');
process.stdout.write(`tokens.css generado: ${target}\n`);
