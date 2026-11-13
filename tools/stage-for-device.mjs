#!/usr/bin/env node
/**
 * Prepara el árbol del repositorio para copiarlo al equipo del usuario.
 *
 * El contenedor de trabajo y el disco del usuario son dos sistemas de
 * archivos distintos: el puente sólo copia archivos individuales desde
 * `/mnt/user-data/outputs`. Este script replica ahí el árbol del proyecto
 * —excluyendo lo que no debe viajar— y emite el manifiesto de rutas que el
 * puente necesita, en lotes del tamaño que admite cada llamada.
 *
 * Uso:
 *   node tools/stage-for-device.mjs [--batch 45] [--out /mnt/user-data/outputs/IT360]
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Carpetas y archivos que nunca se copian al equipo del usuario. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-ts',
  'target',
  'coverage',
  '.git',
  '.vite',
  '.turbo',
  'playwright-report',
  'test-results',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.mypy_cache',
  '.ruff_cache',
]);

const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.tsbuildinfo', 'package-lock.json']);

const EXCLUDED_SUFFIXES = ['.log', '.tmp', '.tsbuildinfo'];

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collect(join(dir, entry.name), acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(entry.name)) continue;
    if (EXCLUDED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
    acc.push(join(dir, entry.name));
  }
  return acc;
}

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const outDir = resolve(argValue('--out', '/mnt/user-data/outputs/IT360'));
const batchSize = Number.parseInt(argValue('--batch', '45'), 10);
const devicePrefix = argValue('--device', 'C:\\PROYECTOS_IA\\INDUSTRIAL_TWINS_360');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const files = collect(ROOT).sort();
let totalBytes = 0;

for (const absolute of files) {
  const rel = relative(ROOT, absolute);
  const target = join(outDir, rel);
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(absolute, target);
  totalBytes += statSync(absolute).size;
}

const batches = [];
for (let i = 0; i < files.length; i += batchSize) {
  batches.push(
    files.slice(i, i + batchSize).map((absolute) => {
      const rel = relative(ROOT, absolute);
      return {
        stagedPath: join(outDir, rel),
        devicePath: `${devicePrefix}\\${rel.split('/').join('\\')}`,
      };
    }),
  );
}

const manifestPath = join(outDir, '_sync-manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify({ fileCount: files.length, totalBytes, batchSize, batches }, null, 2),
);

process.stdout.write(
  `${files.length} archivos preparados (${(totalBytes / 1024 / 1024).toFixed(2)} MB) en ${batches.length} lotes\n`,
);
for (const [index, batch] of batches.entries()) {
  process.stdout.write(`  lote ${index + 1}: ${batch.length} archivos\n`);
}
process.stdout.write(`manifiesto: ${manifestPath}\n`);
