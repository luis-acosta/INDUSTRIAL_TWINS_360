#!/usr/bin/env node
/**
 * Genera el modelo de permisos para el servidor Python a partir del dominio.
 *
 * El plan exige que los permisos se verifiquen en el servidor y no sólo en la
 * interfaz. Eso obliga a que la misma tabla de roles exista en TypeScript y en
 * Python, y dos tablas escritas a mano divergen: alguien añade una operación en
 * el editor, se olvida del servidor, y queda un permiso que la interfaz oculta
 * pero la API concede. Es la clase de fallo que nadie encuentra probando la
 * aplicación, porque la aplicación no ofrece el botón.
 *
 * Por eso se genera. El archivo resultante lleva la huella del contenido, y
 * `tools/verify-access-model.mjs` falla si el generado no corresponde al
 * dominio actual: el desajuste se detecta en la verificación, no en
 * producción.
 *
 * Uso:
 *   node tools/emit-access-model.mjs            # escribe el archivo
 *   node tools/emit-access-model.mjs --check    # sólo comprueba
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TARGET = `${root}apps/server/app/access_model.py`;

/**
 * Las constantes se leen del archivo fuente con expresiones regulares en lugar
 * de importarse.
 *
 * Importar el módulo exigiría compilar TypeScript o cargar un transpilador en
 * un script de herramientas, y la estructura que se necesita —tres listas y un
 * diccionario de listas— es lo bastante simple para extraerla del texto sin
 * ambigüedad. Si el formato del fuente cambiara, la extracción falla con un
 * error claro en lugar de producir una tabla incompleta.
 */
const source = readFileSync(`${root}packages/domain/src/access.ts`, 'utf8');

function extractStringArray(name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (match === null) throw new Error(`No se encontró la constante ${name} en access.ts`);
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (values.length === 0) throw new Error(`La constante ${name} quedó vacía al extraerla`);
  return values;
}

function extractRolePermissions(operations) {
  const block = source.match(
    /export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Operation\[\]>> = \{([\s\S]*?)\n\};/,
  );
  if (block === null) throw new Error('No se encontró ROLE_PERMISSIONS en access.ts');

  const table = {};
  /**
   * Cada entrada es `rol: [ ... ],` y puede ocupar varias líneas.
   *
   * El corchete de cierre puede ir seguido de salto de línea o del final del
   * bloque —la última entrada no lleva línea después—, así que el patrón
   * acepta las dos formas. Exigir el salto dejaba fuera al último rol, que
   * resultaba ser `administrator`: el generador habría emitido una tabla sin
   * el rol que más permisos concede.
   */
  const entries = block[1].matchAll(/(\w+):\s*\[([\s\S]*?)\],(?=\s*(?:\w+:|$))/g);

  for (const [, role, body] of entries) {
    if (body.includes('...OPERATIONS')) {
      table[role] = [...operations];
      continue;
    }
    table[role] = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  if (Object.keys(table).length === 0) throw new Error('ROLE_PERMISSIONS quedó vacío al extraerlo');
  return table;
}

const operations = extractStringArray('OPERATIONS');
const roles = [...(source.match(/roleSchema = z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? '')]
  .join('')
  .match(/'([^']+)'/g)
  ?.map((value) => value.replaceAll("'", ''));

if (roles === undefined || roles.length === 0) {
  throw new Error('No se encontraron los roles en access.ts');
}

const rolePermissions = extractRolePermissions(operations);

for (const role of roles) {
  if (rolePermissions[role] === undefined) {
    throw new Error(`El rol ${role} no tiene permisos declarados en ROLE_PERMISSIONS`);
  }
}

/* --- Emisión --- */

const fingerprint = createHash('sha256')
  .update(JSON.stringify({ operations, roles, rolePermissions }))
  .digest('hex');

const py = `"""Modelo de permisos. ARCHIVO GENERADO: no editar a mano.

Lo genera "tools/emit-access-model.mjs" a partir de
"packages/domain/src/access.ts", que es la única fuente de verdad de los
permisos. Editar este archivo haría que el servidor concediera o negara cosas
distintas de las que la aplicación cree, y el desajuste no se vería probando la
interfaz: la interfaz oculta el botón, la API seguiría respondiendo.

"npm run verify" comprueba que esta copia corresponde al dominio actual.

Huella del modelo: ${fingerprint}
"""

from __future__ import annotations

from typing import Final

MODEL_FINGERPRINT: Final[str] = "${fingerprint}"

OPERATIONS: Final[tuple[str, ...]] = (
${operations.map((op) => `    "${op}",`).join('\n')}
)

ROLES: Final[tuple[str, ...]] = (
${roles.map((role) => `    "${role}",`).join('\n')}
)

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
${roles
  .map(
    (role) =>
      `    "${role}": frozenset(\n        {\n${rolePermissions[role]
        .map((op) => `            "${op}",`)
        .join('\n')}\n        }\n    ),`,
  )
  .join('\n')}
}
`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    console.error('El modelo de permisos del servidor no existe. Ejecute:');
    console.error('  node tools/emit-access-model.mjs');
    process.exit(1);
  }

  if (current !== py) {
    console.error('El modelo de permisos del servidor no corresponde al dominio.');
    console.error('Alguien cambió los roles u operaciones sin regenerarlo. Ejecute:');
    console.error('  node tools/emit-access-model.mjs');
    process.exit(1);
  }

  console.log(`Modelo de permisos verificado: ${operations.length} operaciones, ${roles.length} roles`);
} else {
  writeFileSync(TARGET, py);
  console.log(
    `Modelo de permisos generado: ${operations.length} operaciones, ${roles.length} roles → ${TARGET}`,
  );
}
