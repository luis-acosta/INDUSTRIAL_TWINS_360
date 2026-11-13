/**
 * Comprueba que el binario WASM de SQLite servido por la aplicación coincide
 * con el de la versión instalada de sql.js.
 *
 * El desajuste es silencioso y caro: la aplicación carga el JavaScript de una
 * versión y el binario de otra, y el síntoma es un error de instanciación al
 * abrir un proyecto, en el equipo del cliente, con el instalador ya entregado.
 * Compararlos cuesta milisegundos y se hace en cada verificación.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const SOURCE = `${root}node_modules/sql.js/dist/sql-wasm.wasm`;
const VENDORED = `${root}apps/desktop/public/wasm/sql-wasm.wasm`;

const digest = async (path) => {
  const bytes = await readFile(path);
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
};

try {
  const [source, vendored] = await Promise.all([digest(SOURCE), digest(VENDORED)]);

  if (source.hash !== vendored.hash) {
    console.error('El binario WASM servido por la aplicación no coincide con el de sql.js.');
    console.error(`  node_modules: ${source.hash} (${source.bytes} bytes)`);
    console.error(`  public/wasm:  ${vendored.hash} (${vendored.bytes} bytes)`);
    console.error('');
    console.error('Corríjalo copiando el binario de la versión instalada:');
    console.error('  cp node_modules/sql.js/dist/sql-wasm.wasm apps/desktop/public/wasm/');
    process.exit(1);
  }

  console.log(`WASM de SQLite verificado: ${source.hash.slice(0, 16)}… (${source.bytes} bytes)`);
} catch (cause) {
  console.error(`No se pudo verificar el binario WASM: ${String(cause)}`);
  process.exit(1);
}
