#!/usr/bin/env node
/**
 * Calcula qué archivos han cambiado desde la última sincronización.
 *
 * Copiar el árbol entero en cada hito es caro y la mayor parte no ha
 * cambiado. Este script mantiene un registro de huellas y emite sólo la
 * diferencia, en lotes del tamaño que admite el puente.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = '/tmp/it360-sync-state.json';
const manifest = JSON.parse(readFileSync('/mnt/user-data/outputs/IT360/_sync-manifest.json', 'utf8'));
const previous = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const current = {};
const changed = [];

for (const batch of manifest.batches) {
  for (const file of batch) {
    const hash = createHash('sha256').update(readFileSync(file.stagedPath)).digest('hex');
    current[file.devicePath] = hash;
    if (previous[file.devicePath] !== hash) {
      changed.push({ stagedPath: file.stagedPath, devicePath: file.devicePath });
    }
  }
}

writeFileSync(STATE, JSON.stringify(current));

/**
 * Los lotes se escriben también a disco.
 *
 * Antes sólo iban a la salida estándar, y como el script actualiza el registro
 * de huellas al terminar, una segunda ejecución devolvía cero cambios: si la
 * salida de la primera se perdía, no había forma de recuperar la lista sin
 * borrar el registro y recalcular todo el árbol.
 */
const size = Number.parseInt(process.argv[2] ?? '48', 10);
const batches = [];
for (let i = 0; i < changed.length; i += size) batches.push(changed.slice(i, i + size));

process.stdout.write(`${changed.length} archivos nuevos o modificados de ${Object.keys(current).length}\n`);
writeFileSync('/tmp/it360-sync-batches.json', JSON.stringify(batches));

for (const [i, batch] of batches.entries()) {
  process.stdout.write(`=== LOTE ${i} (${batch.length}) ===\n`);
  process.stdout.write(JSON.stringify(batch) + '\n');
}
process.stdout.write('lotes guardados en /tmp/it360-sync-batches.json\n');
