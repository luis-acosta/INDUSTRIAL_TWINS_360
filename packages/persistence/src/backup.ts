/**
 * Respaldo y restauración (X18).
 *
 * Un proyecto de planta es el trabajo de semanas: cientos de panorámicas
 * cosidas, un catálogo de TAG, los recorridos. Perderlo no es perder un
 * archivo, es perder el levantamiento.
 *
 * **Un respaldo es el propio paquete `.ivp`**, con un nombre fechado y una
 * ficha `.json` al lado. No hay un formato nuevo: inventar un contenedor
 * propio significaría mantener dos caminos de empaquetado, y el segundo —el
 * que casi nunca se ejercita— sería el que falla el día que hace falta
 * restaurar. Lo que esta capa aporta sobre «copiar el archivo a otra carpeta»:
 *
 * - **El respaldo se verifica al crearlo**, leyéndolo de vuelta. Una copia que
 *   no se puede restaurar es peor que ninguna, porque además da tranquilidad.
 * - **La rotación conserva por antigüedad, no por número.** Doce copias de la
 *   última hora no protegen de un error que se arrastra desde ayer: todas lo
 *   llevan dentro.
 * - **Restaurar nunca escribe encima.** Se restaura junto al original con un
 *   nombre nuevo. Restaurar sobre el proyecto actual convierte un error de
 *   selección en una segunda pérdida, esta vez sin respaldo del que tirar.
 * - **Lo que falte se dice antes de restaurar**, en lugar de impedirlo: un
 *   respaldo sin algunos medios sigue trayendo el catálogo, las notas y los
 *   recorridos, y eso vale.
 */
import { domainError, err, ok, type Result } from '@it360/domain';
import type { Manifest } from '@it360/domain';
import { readIvp } from './ivp';
import type { Storage } from './storage';

/* ------------------------------------------------------------------ *
 * Ficha del respaldo
 * ------------------------------------------------------------------ */

export const BACKUP_FORMAT = 'it360.backup';
export const BACKUP_VERSION = 1;

/** Extensión de la ficha que acompaña a cada respaldo. */
export const SIDECAR_SUFFIX = '.respaldo.json';

export type BackupReason = 'manual' | 'beforeMigration' | 'beforeImport' | 'scheduled';

export const BACKUP_REASON_LABELS: Readonly<Record<BackupReason, string>> = {
  manual: 'A petición',
  beforeMigration: 'Antes de actualizar el formato',
  beforeImport: 'Antes de importar',
  scheduled: 'Programado',
};

export interface BackupSidecar {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: number;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly byteLength: number;
  readonly sceneCount: number;
  readonly assetCount: number;
  readonly mediaCount: number;
  /** Versión de la aplicación que lo creó, para diagnosticar. */
  readonly appVersion: string;
}

export interface BackupInfo {
  readonly path: string;
  readonly sidecar: BackupSidecar;
}

/* ------------------------------------------------------------------ *
 * Nombres
 * ------------------------------------------------------------------ */

/**
 * Nombre del archivo de respaldo.
 *
 * La fecha va delante y en formato ordenable para que el listado de la carpeta
 * quede en orden cronológico sin depender de la fecha del sistema de archivos,
 * que se pierde al copiar entre discos o al restaurar desde una copia de red.
 */
export function backupFileName(title: string, now: string): string {
  const stamp = now.slice(0, 19).replace(/[:T]/g, '-');
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${stamp}__${slug.length > 0 ? slug : 'proyecto'}.ivp`;
}

/** Ruta de la ficha que acompaña a un respaldo. */
export const sidecarPathFor = (backupPath: string): string => `${backupPath}${SIDECAR_SUFFIX}`;

/* ------------------------------------------------------------------ *
 * Crear
 * ------------------------------------------------------------------ */

export interface CreateBackupOptions {
  /** Paquete `.ivp` ya construido del proyecto. */
  readonly packageBytes: Uint8Array;
  readonly reason: BackupReason;
  readonly appVersion: string;
  readonly now: string;
}

export interface CreatedBackup {
  readonly fileName: string;
  readonly sidecar: BackupSidecar;
  readonly sidecarJson: string;
}

/**
 * Prepara un respaldo y lo verifica.
 *
 * El paquete se vuelve a leer antes de darlo por bueno. Es el paso que separa
 * una copia de una copia que sirve: un paquete corrupto escrito sin comprobar
 * da la misma tranquilidad que uno bueno, y sólo se descubre el día que hace
 * falta restaurar.
 */
export async function createBackup(
  options: CreateBackupOptions,
): Promise<Result<CreatedBackup>> {
  if (options.packageBytes.byteLength === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'No hay nada que respaldar', { path: 'backup' }),
    );
  }

  const read = await readIvp(options.packageBytes);
  if (!read.ok) {
    return err(
      domainError('IO_FAILED', 'El respaldo no se pudo verificar y no se ha guardado', {
        path: 'backup',
        detail: { reason: read.error.message },
        recovery:
          'No borre el proyecto original. Compruebe que hay espacio en el disco y vuelva a intentarlo.',
      }),
    );
  }

  const manifest = read.value.manifest;
  const sidecar: BackupSidecar = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    projectId: manifest.projectId,
    projectTitle: manifest.title,
    createdAt: options.now,
    reason: options.reason,
    byteLength: options.packageBytes.byteLength,
    sceneCount: manifest.scenes.length,
    assetCount: manifest.assets.length,
    mediaCount: manifest.media.length,
    appVersion: options.appVersion,
  };

  return ok({
    fileName: backupFileName(manifest.title, options.now),
    sidecar,
    sidecarJson: JSON.stringify(sidecar, null, 2),
  });
}

/* ------------------------------------------------------------------ *
 * Verificar
 * ------------------------------------------------------------------ */

export interface BackupCheck {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly schemaVersion: number;
  readonly sceneCount: number;
  readonly assetCount: number;
  /** Archivos que el manifiesto nombra y el paquete no trae. */
  readonly missingFiles: readonly string[];
  /** Avisos que dio la lectura del paquete. */
  readonly warnings: readonly string[];
}

/**
 * Lee un respaldo y comprueba qué tiene dentro.
 *
 * No rechaza un paquete al que le faltan medios: el catálogo, las notas y los
 * recorridos siguen valiendo, y lo que hace falta es que el usuario sepa qué
 * se va a encontrar, no que se le impida recuperar lo que sí está.
 */
export async function verifyBackup(bytes: Uint8Array): Promise<Result<BackupCheck>> {
  const read = await readIvp(bytes);
  if (!read.ok) return read;

  const manifest = read.value.manifest;
  const present = new Set(read.value.files.keys());

  const expected = new Set<string>();
  for (const media of manifest.media) {
    const path = mediaPathOf(media);
    if (path !== null) expected.add(path);
  }

  const missingFiles = [...expected].filter((path) => !present.has(path)).sort();

  return ok({
    projectId: manifest.projectId,
    projectTitle: manifest.title,
    schemaVersion: manifest.schemaVersion,
    sceneCount: manifest.scenes.length,
    assetCount: manifest.assets.length,
    missingFiles,
    warnings: read.value.warnings,
  });
}

/**
 * Ruta de un medio dentro del paquete.
 *
 * Se lee de `relativePath`, que es el campo que el formato `.ivp` usa como
 * clave de cada archivo. No se reconstruye a partir del hash y el nombre:
 * recomponerla duplicaría la regla del empaquetador y bastaría un cambio allí
 * para que esta comprobación empezara a inventar ausencias.
 */
function mediaPathOf(media: Manifest['media'][number]): string | null {
  return media.relativePath.length > 0 ? media.relativePath : null;
}

/** Resumen del respaldo, para enseñarlo antes de restaurar. */
export function describeBackup(check: BackupCheck): string {
  const parts = [`${check.sceneCount} escena(s)`, `${check.assetCount} activo(s)`];

  if (check.missingFiles.length > 0) {
    parts.push(`faltan ${check.missingFiles.length} archivo(s) de medios`);
  }
  if (check.warnings.length > 0) {
    parts.push(`${check.warnings.length} aviso(s) al leerlo`);
  }

  return parts.join(', ') + '.';
}

/* ------------------------------------------------------------------ *
 * Rotación
 * ------------------------------------------------------------------ */

export interface RotationPolicy {
  /** Respaldos recientes que se conservan siempre. */
  readonly keepRecent: number;
  /** Uno por día durante estos días. */
  readonly keepDailyDays: number;
  /** Uno por semana durante estas semanas. */
  readonly keepWeeklyWeeks: number;
}

export const DEFAULT_ROTATION: RotationPolicy = {
  keepRecent: 5,
  keepDailyDays: 14,
  keepWeeklyWeeks: 12,
};

export interface RotationPlan {
  readonly keep: readonly BackupInfo[];
  readonly remove: readonly BackupInfo[];
  /** Por qué se conserva cada uno, para poder explicarlo. */
  readonly reasons: ReadonlyMap<string, string>;
}

/**
 * Decide qué respaldos se conservan y cuáles se pueden borrar.
 *
 * Conserva por antigüedad y no por número, porque un error que se arrastra
 * desde la semana pasada no se arregla teniendo doce copias de esta mañana:
 * todas lo llevan dentro. Hacen falta copias repartidas en el tiempo.
 *
 * Nunca propone borrar el más reciente, por vacía que sea la política: quedarse
 * sin ningún respaldo no puede ser el resultado de una limpieza.
 */
export function planRotation(
  backups: readonly BackupInfo[],
  policy: RotationPolicy = DEFAULT_ROTATION,
  now: string = new Date().toISOString(),
): RotationPlan {
  if (backups.length === 0) return { keep: [], remove: [], reasons: new Map() };

  /**
   * Orden: del más reciente al más antiguo, y las fechas ilegibles al final.
   *
   * Ordenar sólo por texto ponía delante a una fecha ilegible —«fecha-rota»
   * empieza por una letra, que va después de cualquier dígito—, de modo que un
   * respaldo con la ficha estropeada pasaba por el más reciente y ocupaba una
   * de las plazas de «los más recientes», desplazando a uno que sí lo era.
   */
  const sorted = [...backups].sort((a, b) => {
    const aMs = Date.parse(a.sidecar.createdAt);
    const bMs = Date.parse(b.sidecar.createdAt);
    const aBad = Number.isNaN(aMs);
    const bBad = Number.isNaN(bMs);

    if (aBad && bBad) return a.path.localeCompare(b.path);
    if (aBad) return 1;
    if (bBad) return -1;
    return bMs - aMs;
  });

  const reasons = new Map<string, string>();
  const nowMs = Date.parse(now);

  const mark = (backup: BackupInfo, reason: string): void => {
    if (!reasons.has(backup.path)) reasons.set(backup.path, reason);
  };

  // Los más recientes, siempre. Al menos uno, aunque la política diga cero.
  for (const backup of sorted.slice(0, Math.max(1, policy.keepRecent))) {
    mark(backup, 'de los más recientes');
  }

  const seenDay = new Set<string>();
  const seenWeek = new Set<string>();

  for (const backup of sorted) {
    const createdMs = Date.parse(backup.sidecar.createdAt);
    if (Number.isNaN(createdMs)) {
      // Sin saber cuándo se hizo, borrarlo podría dejar un hueco justo donde
      // hacía falta. Se conserva y se dice por qué.
      mark(backup, 'sin fecha legible');
      continue;
    }

    const ageDays = (nowMs - createdMs) / 86_400_000;

    if (ageDays <= policy.keepDailyDays) {
      const day = backup.sidecar.createdAt.slice(0, 10);
      if (!seenDay.has(day)) {
        seenDay.add(day);
        mark(backup, `único del día ${day}`);
      }
      continue;
    }

    if (ageDays <= policy.keepWeeklyWeeks * 7) {
      // Ventana de siete días contada desde la época, no semana del
      // calendario: no empieza en lunes ni depende del huso horario, y para
      // conservar «una copia cada siete días» eso da igual y evita que el
      // reparto cambie según dónde esté el equipo.
      const week = `${Math.floor(createdMs / (7 * 86_400_000))}`;
      if (!seenWeek.has(week)) {
        seenWeek.add(week);
        mark(backup, 'único de su semana');
      }
    }
  }

  return {
    keep: sorted.filter((backup) => reasons.has(backup.path)),
    remove: sorted.filter((backup) => !reasons.has(backup.path)),
    reasons,
  };
}

/** Lo que liberaría aplicar la rotación. */
export function bytesFreedBy(plan: RotationPlan): number {
  return plan.remove.reduce((total, backup) => total + backup.sidecar.byteLength, 0);
}

/* ------------------------------------------------------------------ *
 * Restaurar
 * ------------------------------------------------------------------ */

export interface RestorePlan {
  readonly check: BackupCheck;
  /** Ruta en la que se escribirá, siempre distinta del original. */
  readonly targetPath: string;
  readonly warnings: readonly string[];
}

/**
 * Prepara una restauración.
 *
 * El destino nunca es el proyecto actual. Restaurar encima convierte un error
 * de selección —el respaldo equivocado, el de la semana pasada— en una segunda
 * pérdida, esta vez sin respaldo del que tirar.
 */
export function planRestore(
  check: BackupCheck,
  originalPath: string,
  currentSchemaVersion: number,
  now: string = new Date().toISOString(),
): RestorePlan {
  const warnings: string[] = [];

  if (check.missingFiles.length > 0) {
    warnings.push(
      `Al respaldo le faltan ${check.missingFiles.length} archivo(s) de medios. El proyecto se ` +
        'restaurará y esas panorámicas o documentos aparecerán como ausentes.',
    );
  }

  if (check.schemaVersion < currentSchemaVersion) {
    warnings.push(
      `El respaldo viene de un formato anterior (versión ${check.schemaVersion} frente a ` +
        `${currentSchemaVersion}). Se actualizará al abrirlo; revise el resultado antes de ` +
        'seguir trabajando sobre él.',
    );
  }

  if (check.schemaVersion > currentSchemaVersion) {
    warnings.push(
      `El respaldo viene de una versión más nueva de la aplicación (formato ` +
        `${check.schemaVersion}). Actualice la aplicación antes de restaurarlo, o se perderá ` +
        'lo que esta versión no entiende.',
    );
  }

  for (const warning of check.warnings) warnings.push(warning);

  const stamp = now.slice(0, 19).replace(/[:T]/g, '-');
  const dot = originalPath.lastIndexOf('.');
  const base = dot > 0 ? originalPath.slice(0, dot) : originalPath;
  const extension = dot > 0 ? originalPath.slice(dot) : '.ivp';

  return { check, targetPath: `${base}__restaurado-${stamp}${extension}`, warnings };
}

/**
 * `true` si la restauración puede seguir adelante.
 *
 * Sólo lo impide un formato más nuevo que el que la aplicación entiende:
 * abrirlo perdería silenciosamente lo que no sabe leer, y eso es peor que no
 * restaurar.
 */
export function canRestore(check: BackupCheck, currentSchemaVersion: number): boolean {
  return check.schemaVersion <= currentSchemaVersion;
}

/**
 * Escribe el proyecto restaurado junto al original.
 *
 * Se niega a escribir sobre un archivo que ya existe, incluso con el nombre
 * generado: una colisión improbable no es razón para perder un proyecto.
 */
export async function writeRestored(
  storage: Storage,
  plan: RestorePlan,
  bytes: Uint8Array,
): Promise<Result<string>> {
  if (await storage.exists(plan.targetPath)) {
    return err(
      domainError('CONFLICT', 'Ya existe un archivo con ese nombre', {
        path: plan.targetPath,
        recovery: 'Vuelva a intentarlo: el nombre lleva la hora y cambiará.',
      }),
    );
  }

  try {
    await storage.writeFile(plan.targetPath, bytes);
  } catch (error) {
    return err(
      domainError('IO_FAILED', 'No se pudo escribir el proyecto restaurado', {
        path: plan.targetPath,
        detail: { reason: error instanceof Error ? error.message : String(error) },
        recovery: 'Compruebe que hay espacio en el disco y que la carpeta admite escritura.',
      }),
    );
  }

  return ok(plan.targetPath);
}

/**
 * Lee la ficha de un respaldo.
 *
 * Si la ficha falta o está dañada, se devuelve `null` en lugar de fallar: el
 * respaldo sigue siendo válido —la ficha es una comodidad para listarlos sin
 * abrirlos— y ocultarlo por eso dejaría al usuario sin una copia que tiene.
 */
export function parseSidecar(json: string): BackupSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (record['format'] !== BACKUP_FORMAT) return null;
  if (typeof record['createdAt'] !== 'string') return null;
  if (typeof record['projectId'] !== 'string') return null;

  return {
    format: BACKUP_FORMAT,
    version: typeof record['version'] === 'number' ? record['version'] : 1,
    projectId: record['projectId'],
    projectTitle: typeof record['projectTitle'] === 'string' ? record['projectTitle'] : '',
    createdAt: record['createdAt'],
    reason: isReason(record['reason']) ? record['reason'] : 'manual',
    byteLength: typeof record['byteLength'] === 'number' ? record['byteLength'] : 0,
    sceneCount: typeof record['sceneCount'] === 'number' ? record['sceneCount'] : 0,
    assetCount: typeof record['assetCount'] === 'number' ? record['assetCount'] : 0,
    mediaCount: typeof record['mediaCount'] === 'number' ? record['mediaCount'] : 0,
    appVersion: typeof record['appVersion'] === 'string' ? record['appVersion'] : '',
  };
}

function isReason(value: unknown): value is BackupReason {
  return (
    value === 'manual' ||
    value === 'beforeMigration' ||
    value === 'beforeImport' ||
    value === 'scheduled'
  );
}
