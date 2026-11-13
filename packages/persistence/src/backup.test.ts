/**
 * Pruebas de respaldo y restauración (X18).
 *
 * Lo que se vigila aquí no es que la copia se escriba, sino que **no se pueda
 * perder el proyecto con ella**: que una copia corrupta no se dé por buena, que
 * restaurar no escriba encima del original y que una limpieza no deje al
 * usuario sin ningún respaldo.
 */
import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  BACKUP_FORMAT,
  bytesFreedBy,
  canRestore,
  createBackup,
  DEFAULT_ROTATION,
  describeBackup,
  parseSidecar,
  planRestore,
  planRotation,
  sidecarPathFor,
  verifyBackup,
  writeRestored,
  type BackupCheck,
  type BackupInfo,
  type BackupSidecar,
} from './backup';
import { writeIvp } from './ivp';
import { toManifest } from '@it360/domain';
import { makeFullProject } from '@it360/domain/testing';
import type { Storage } from './storage';

const NOW = '2026-08-01T10:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Material de prueba
 * ------------------------------------------------------------------ */

/** Paquete `.ivp` real, construido con el empaquetador de producción. */
async function realPackage(): Promise<Uint8Array> {
  const project = makeFullProject();
  const manifest = toManifest(project, {
    publishedAt: NOW,
    appVersion: '0.21.0',
    offlineCapable: true,
  });

  const written = await writeIvp({
    manifest,
    database: new TextEncoder().encode('base de datos de prueba'),
    files: new Map(),
  });

  if (!written.ok) throw new Error(`No se pudo construir el paquete: ${written.error.message}`);
  return written.value;
}

function sidecar(over: Partial<BackupSidecar> = {}): BackupSidecar {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    projectId: 'proyecto-1',
    projectTitle: 'Planta Norte',
    createdAt: NOW,
    reason: 'manual',
    byteLength: 1_000_000,
    sceneCount: 12,
    assetCount: 30,
    mediaCount: 40,
    appVersion: '0.21.0',
    ...over,
  };
}

const info = (path: string, createdAt: string, byteLength = 1_000_000): BackupInfo => ({
  path,
  sidecar: sidecar({ createdAt, byteLength }),
});

/** Almacenamiento en memoria que imita al del disco. */
function memoryStorage(initial: readonly string[] = []): Storage & {
  readonly written: Map<string, Uint8Array>;
} {
  const written = new Map<string, Uint8Array>();
  for (const path of initial) written.set(path, new Uint8Array(0));

  return {
    written,
    kind: 'memory',
    exists: async (path: string) => written.has(path),
    readFile: async (path: string) => written.get(path) ?? new Uint8Array(0),
    writeFile: async (path: string, data: Uint8Array) => {
      written.set(path, data);
    },
    remove: async (path: string) => {
      written.delete(path);
    },
    list: async () => [...written.keys()],
    sync: async () => undefined,
  } as unknown as Storage & { readonly written: Map<string, Uint8Array> };
}

/* ------------------------------------------------------------------ *
 * Nombres
 * ------------------------------------------------------------------ */

describe('backupFileName', () => {
  it('TEST-BKP-001 pone la fecha delante, en formato ordenable', () => {
    // El listado de la carpeta queda en orden cronológico sin depender de la
    // fecha del sistema de archivos, que se pierde al copiar entre discos.
    const name = backupFileName('Planta Norte', '2026-08-01T10:30:45.000Z');
    expect(name.startsWith('2026-08-01-10-30-45__')).toBe(true);
    expect(name.endsWith('.ivp')).toBe(true);
  });

  it('TEST-BKP-002 los nombres ordenan cronológicamente como texto', () => {
    const antes = backupFileName('Planta', '2026-08-01T09:00:00.000Z');
    const despues = backupFileName('Planta', '2026-08-01T10:00:00.000Z');
    expect([despues, antes].sort()).toEqual([antes, despues]);
  });

  it('TEST-BKP-003 limpia acentos y caracteres que el sistema de archivos rechaza', () => {
    const name = backupFileName('Unidad U-200 / Revisión Anual: Fase 1', NOW);
    expect(name).not.toMatch(/[/:ó]/);
    expect(name).toContain('unidad-u-200-revision-anual-fase-1');
  });

  it('TEST-BKP-004 un título sin caracteres usables no deja el nombre colgando', () => {
    expect(backupFileName('···', NOW)).toContain('__proyecto.ivp');
  });

  it('TEST-BKP-005 la ficha acompaña al respaldo con su mismo nombre', () => {
    expect(sidecarPathFor('/copias/2026-08-01__planta.ivp')).toBe(
      '/copias/2026-08-01__planta.ivp.respaldo.json',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Crear
 * ------------------------------------------------------------------ */

describe('createBackup', () => {
  it('TEST-BKP-006 crea la ficha a partir del paquete real', async () => {
    const bytes = await realPackage();
    const result = await createBackup({
      packageBytes: bytes,
      reason: 'manual',
      appVersion: '0.21.0',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sidecar.format).toBe(BACKUP_FORMAT);
    expect(result.value.sidecar.byteLength).toBe(bytes.byteLength);
    expect(result.value.sidecar.sceneCount).toBeGreaterThan(0);
    expect(result.value.sidecar.appVersion).toBe('0.21.0');
    expect(result.value.fileName.endsWith('.ivp')).toBe(true);
  });

  it('TEST-BKP-007 la ficha es JSON legible y vuelve a leerse', async () => {
    const result = await createBackup({
      packageBytes: await realPackage(),
      reason: 'beforeMigration',
      appVersion: '0.21.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseSidecar(result.value.sidecarJson);
    expect(parsed?.reason).toBe('beforeMigration');
    expect(parsed?.createdAt).toBe(NOW);
  });

  it('TEST-BKP-008 no da por bueno un paquete corrupto', async () => {
    // Una copia que no se puede restaurar es peor que ninguna, porque además
    // da tranquilidad. Se descubre al crearla, no el día que hace falta.
    const bytes = await realPackage();
    const corrupto = bytes.slice(0, Math.floor(bytes.byteLength / 2));

    const result = await createBackup({
      packageBytes: corrupto,
      reason: 'manual',
      appVersion: '0.21.0',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain('No borre el proyecto original');
  });

  it('TEST-BKP-009 no respalda un paquete vacío', async () => {
    const result = await createBackup({
      packageBytes: new Uint8Array(0),
      reason: 'manual',
      appVersion: '0.21.0',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Verificar
 * ------------------------------------------------------------------ */

describe('verifyBackup', () => {
  it('TEST-BKP-010 lee un respaldo bueno y resume su contenido', async () => {
    const result = await verifyBackup(await realPackage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sceneCount).toBeGreaterThan(0);
    expect(result.value.projectTitle.length).toBeGreaterThan(0);
    expect(result.value.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('TEST-BKP-011 rechaza un archivo que no es un paquete', async () => {
    const basura = new TextEncoder().encode('esto no es un zip ni de lejos');
    expect((await verifyBackup(basura)).ok).toBe(false);
  });

  it('TEST-BKP-012 rechaza un paquete truncado', async () => {
    const bytes = await realPackage();
    expect((await verifyBackup(bytes.slice(0, 50))).ok).toBe(false);
  });

  it('TEST-BKP-012b detecta los medios que el paquete no trae', async () => {
    // Es la comprobación que da sentido a verificar: un respaldo al que le
    // faltan panorámicas se puede restaurar, pero el usuario tiene que saberlo
    // antes y no al abrir la escena. La ruta se lee de `relativePath`, que es
    // la clave real del formato; buscarla en un campo que no existe hacía que
    // nunca se detectara ninguna ausencia.
    const project = makeFullProject();
    expect(project.media.length).toBeGreaterThan(0);

    const manifest = toManifest(project, {
      publishedAt: NOW,
      appVersion: '0.21.0',
      offlineCapable: true,
    });
    expect(manifest.media.length).toBeGreaterThan(0);

    // Se empaqueta sin ninguno de los archivos que el manifiesto nombra.
    const written = await writeIvp({
      manifest,
      database: new TextEncoder().encode('base de datos'),
      files: new Map(),
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const result = await verifyBackup(written.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.missingFiles.length).toBe(manifest.media.length);
    expect(describeBackup(result.value)).toContain('faltan');
  });

  it('TEST-BKP-013 el resumen es legible y dice lo que hay', async () => {
    const result = await verifyBackup(await realPackage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = describeBackup(result.value);
    expect(summary).toContain('escena(s)');
    expect(summary).toContain('activo(s)');
    expect(summary.endsWith('.')).toBe(true);
  });

  it('TEST-BKP-014 el resumen avisa de los medios que faltan', () => {
    const check: BackupCheck = {
      projectId: 'p1',
      projectTitle: 'Planta',
      schemaVersion: 1,
      sceneCount: 10,
      assetCount: 5,
      missingFiles: ['medios/a.jpg', 'medios/b.jpg'],
      warnings: [],
    };
    expect(describeBackup(check)).toContain('faltan 2 archivo(s)');
  });
});

/* ------------------------------------------------------------------ *
 * Rotación
 * ------------------------------------------------------------------ */

describe('planRotation', () => {
  it('TEST-BKP-015 sin respaldos no propone nada', () => {
    const plan = planRotation([]);
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('TEST-BKP-016 conserva siempre el más reciente, con política vacía', () => {
    // Quedarse sin ningún respaldo no puede ser el resultado de una limpieza.
    const backups = [info('/a.ivp', '2026-08-01T10:00:00.000Z')];
    const plan = planRotation(backups, { keepRecent: 0, keepDailyDays: 0, keepWeeklyWeeks: 0 }, NOW);

    expect(plan.keep).toHaveLength(1);
    expect(plan.remove).toEqual([]);
  });

  it('TEST-BKP-017 doce copias de la última hora no se conservan todas', () => {
    // Un error que se arrastra desde ayer no se arregla con doce copias de esta
    // mañana: todas lo llevan dentro.
    const backups = Array.from({ length: 12 }, (_, i) =>
      info(`/h${i}.ivp`, `2026-08-01T${String(9 - Math.floor(i / 2)).padStart(2, '0')}:00:00.000Z`),
    );

    const plan = planRotation(backups, DEFAULT_ROTATION, '2026-08-01T10:00:00.000Z');
    expect(plan.keep.length).toBeLessThan(12);
    expect(plan.remove.length).toBeGreaterThan(0);
  });

  it('TEST-BKP-018 conserva uno por día dentro de la ventana diaria', () => {
    const backups = [
      info('/d1a.ivp', '2026-07-30T08:00:00.000Z'),
      info('/d1b.ivp', '2026-07-30T18:00:00.000Z'),
      info('/d2a.ivp', '2026-07-29T08:00:00.000Z'),
      info('/d2b.ivp', '2026-07-29T18:00:00.000Z'),
    ];

    const plan = planRotation(
      backups,
      { keepRecent: 1, keepDailyDays: 14, keepWeeklyWeeks: 0 },
      '2026-08-01T10:00:00.000Z',
    );

    // Uno de cada día: dos días, dos copias.
    expect(plan.keep).toHaveLength(2);
    const dias = new Set(plan.keep.map((b) => b.sidecar.createdAt.slice(0, 10)));
    expect(dias.size).toBe(2);
  });

  it('TEST-BKP-019 conserva uno por semana más allá de la ventana diaria', () => {
    const backups = [
      info('/reciente.ivp', '2026-08-01T08:00:00.000Z'),
      info('/mes1.ivp', '2026-07-03T08:00:00.000Z'),
      info('/mes1b.ivp', '2026-07-05T08:00:00.000Z'),
      info('/mes2.ivp', '2026-06-01T08:00:00.000Z'),
    ];

    // Con `keepRecent` a uno se aísla la regla semanal: los dos de principios
    // de julio caen en la misma semana, así que se guarda uno.
    const plan = planRotation(
      backups,
      { keepRecent: 1, keepDailyDays: 14, keepWeeklyWeeks: 12 },
      '2026-08-01T10:00:00.000Z',
    );

    const julio = plan.keep.filter((b) => b.sidecar.createdAt.startsWith('2026-07-0'));
    expect(julio).toHaveLength(1);
    expect(plan.keep.some((b) => b.path === '/reciente.ivp')).toBe(true);
  });

  it('TEST-BKP-020 descarta lo anterior a la ventana semanal', () => {
    const backups = [
      info('/reciente.ivp', '2026-08-01T08:00:00.000Z'),
      info('/antiguo.ivp', '2024-01-01T08:00:00.000Z'),
    ];

    const plan = planRotation(
      backups,
      { keepRecent: 1, keepDailyDays: 14, keepWeeklyWeeks: 12 },
      '2026-08-01T10:00:00.000Z',
    );

    expect(plan.remove.map((b) => b.path)).toEqual(['/antiguo.ivp']);
  });

  it('TEST-BKP-021 un respaldo sin fecha legible se conserva y se explica', () => {
    // Sin saber cuándo se hizo, borrarlo podría dejar un hueco justo donde
    // hacía falta.
    const backups = [
      info('/bueno.ivp', '2026-08-01T08:00:00.000Z'),
      info('/raro.ivp', 'fecha-ilegible'),
    ];

    // Con `keepRecent` a uno, lo único que puede salvar al de fecha ilegible
    // es la regla que lo contempla expresamente.
    const plan = planRotation(
      backups,
      { keepRecent: 1, keepDailyDays: 14, keepWeeklyWeeks: 12 },
      '2026-08-01T10:00:00.000Z',
    );

    expect(plan.remove).toEqual([]);
    expect(plan.keep.map((b) => b.path).sort()).toEqual(['/bueno.ivp', '/raro.ivp']);
    expect(plan.reasons.get('/raro.ivp')).toContain('sin fecha');
  });

  it('TEST-BKP-022 cada respaldo conservado lleva su motivo', () => {
    const backups = [
      info('/a.ivp', '2026-08-01T08:00:00.000Z'),
      info('/b.ivp', '2026-07-20T08:00:00.000Z'),
    ];

    const plan = planRotation(backups, DEFAULT_ROTATION, '2026-08-01T10:00:00.000Z');
    for (const backup of plan.keep) {
      expect(plan.reasons.get(backup.path)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('TEST-BKP-023 informa de cuánto espacio liberaría', () => {
    const backups = [
      info('/reciente.ivp', '2026-08-01T08:00:00.000Z', 1_000_000),
      info('/antiguo.ivp', '2024-01-01T08:00:00.000Z', 5_000_000),
    ];

    const plan = planRotation(
      backups,
      { keepRecent: 1, keepDailyDays: 14, keepWeeklyWeeks: 12 },
      '2026-08-01T10:00:00.000Z',
    );
    expect(bytesFreedBy(plan)).toBe(5_000_000);
  });

  it('TEST-BKP-024 lo conservado y lo descartado suman el total, sin solaparse', () => {
    const backups = Array.from({ length: 30 }, (_, i) =>
      info(`/b${i}.ivp`, new Date(Date.parse(NOW) - i * 86_400_000 * 3).toISOString()),
    );

    const plan = planRotation(backups, DEFAULT_ROTATION, NOW);
    expect(plan.keep.length + plan.remove.length).toBe(30);

    const rutas = new Set([...plan.keep, ...plan.remove].map((b) => b.path));
    expect(rutas.size).toBe(30);
  });
});

/* ------------------------------------------------------------------ *
 * Restaurar
 * ------------------------------------------------------------------ */

const check = (over: Partial<BackupCheck> = {}): BackupCheck => ({
  projectId: 'p1',
  projectTitle: 'Planta Norte',
  schemaVersion: 3,
  sceneCount: 12,
  assetCount: 30,
  missingFiles: [],
  warnings: [],
  ...over,
});

describe('planRestore', () => {
  it('TEST-BKP-025 nunca propone escribir sobre el original', () => {
    // Restaurar encima convierte un error de selección en una segunda pérdida,
    // esta vez sin respaldo del que tirar.
    const plan = planRestore(check(), '/proyectos/planta.ivp', 3, NOW);

    expect(plan.targetPath).not.toBe('/proyectos/planta.ivp');
    expect(plan.targetPath).toContain('__restaurado-');
    expect(plan.targetPath.endsWith('.ivp')).toBe(true);
  });

  it('TEST-BKP-026 conserva la carpeta del original', () => {
    const plan = planRestore(check(), '/proyectos/planta norte/planta.ivp', 3, NOW);
    expect(plan.targetPath.startsWith('/proyectos/planta norte/')).toBe(true);
  });

  it('TEST-BKP-027 una ruta sin extensión recibe .ivp', () => {
    expect(planRestore(check(), '/proyectos/planta', 3, NOW).targetPath).toContain('.ivp');
  });

  it('TEST-BKP-028 avisa de los medios ausentes sin impedir la restauración', () => {
    const plan = planRestore(
      check({ missingFiles: ['medios/a.jpg', 'medios/b.jpg'] }),
      '/p/planta.ivp',
      3,
      NOW,
    );

    expect(plan.warnings.some((w) => w.includes('2 archivo(s)'))).toBe(true);
    expect(canRestore(plan.check, 3)).toBe(true);
  });

  it('TEST-BKP-029 avisa de un formato anterior y de que se actualizará', () => {
    const plan = planRestore(check({ schemaVersion: 1 }), '/p/planta.ivp', 3, NOW);
    expect(plan.warnings.some((w) => w.includes('formato anterior'))).toBe(true);
    expect(canRestore(plan.check, 3)).toBe(true);
  });

  it('TEST-BKP-030 impide restaurar un formato más nuevo del que entiende', () => {
    // Abrirlo perdería en silencio lo que esta versión no sabe leer, y eso es
    // peor que no restaurar.
    const plan = planRestore(check({ schemaVersion: 9 }), '/p/planta.ivp', 3, NOW);

    expect(plan.warnings.some((w) => w.includes('Actualice la aplicación'))).toBe(true);
    expect(canRestore(plan.check, 3)).toBe(false);
  });

  it('TEST-BKP-031 arrastra los avisos de la lectura del paquete', () => {
    const plan = planRestore(
      check({ warnings: ['Una entrada del paquete tenía una ruta sospechosa y se omitió.'] }),
      '/p/planta.ivp',
      3,
      NOW,
    );
    expect(plan.warnings.some((w) => w.includes('ruta sospechosa'))).toBe(true);
  });

  it('TEST-BKP-032 un respaldo íntegro y del mismo formato no genera avisos', () => {
    expect(planRestore(check(), '/p/planta.ivp', 3, NOW).warnings).toEqual([]);
  });
});

describe('writeRestored', () => {
  it('TEST-BKP-033 escribe en el destino y devuelve la ruta', async () => {
    const storage = memoryStorage();
    const plan = planRestore(check(), '/p/planta.ivp', 3, NOW);

    const result = await writeRestored(storage, plan, new TextEncoder().encode('contenido'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(plan.targetPath);
    expect(storage.written.has(plan.targetPath)).toBe(true);
  });

  it('TEST-BKP-034 no escribe sobre un archivo que ya existe', async () => {
    // Una colisión improbable no es razón para perder un proyecto.
    const plan = planRestore(check(), '/p/planta.ivp', 3, NOW);
    const storage = memoryStorage([plan.targetPath]);

    const result = await writeRestored(storage, plan, new TextEncoder().encode('contenido'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFLICT');
  });

  it('TEST-BKP-035 no deja el original tocado', async () => {
    const storage = memoryStorage(['/p/planta.ivp']);
    const original = storage.written.get('/p/planta.ivp');
    const plan = planRestore(check(), '/p/planta.ivp', 3, NOW);

    await writeRestored(storage, plan, new TextEncoder().encode('contenido nuevo'));
    expect(storage.written.get('/p/planta.ivp')).toBe(original);
  });

  it('TEST-BKP-036 informa del fallo de escritura con qué comprobar', async () => {
    const storage = memoryStorage();
    const roto = {
      ...storage,
      writeFile: async () => {
        throw new Error('disco lleno');
      },
    } as unknown as Storage;

    const plan = planRestore(check(), '/p/planta.ivp', 3, NOW);
    const result = await writeRestored(roto, plan, new Uint8Array(10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recovery).toContain('espacio en el disco');
  });
});

/* ------------------------------------------------------------------ *
 * Ficha
 * ------------------------------------------------------------------ */

describe('parseSidecar', () => {
  it('TEST-BKP-037 lee una ficha completa', () => {
    const parsed = parseSidecar(JSON.stringify(sidecar()));
    expect(parsed?.projectTitle).toBe('Planta Norte');
    expect(parsed?.sceneCount).toBe(12);
  });

  it('TEST-BKP-038 una ficha dañada devuelve null en lugar de fallar', () => {
    // La ficha es una comodidad para listar sin abrir los paquetes; ocultar el
    // respaldo por ella dejaría al usuario sin una copia que sí tiene.
    expect(parseSidecar('{ roto')).toBeNull();
    expect(parseSidecar('null')).toBeNull();
    expect(parseSidecar('[]')).toBeNull();
  });

  it('TEST-BKP-039 rechaza una ficha de otro formato', () => {
    expect(parseSidecar(JSON.stringify({ format: 'otra-cosa', createdAt: NOW }))).toBeNull();
  });

  it('TEST-BKP-040 rellena lo que falte sin inventar la fecha ni el proyecto', () => {
    const parsed = parseSidecar(
      JSON.stringify({ format: 'it360.backup', createdAt: NOW, projectId: 'p1' }),
    );
    expect(parsed?.reason).toBe('manual');
    expect(parsed?.sceneCount).toBe(0);

    // Sin fecha o sin proyecto no hay ficha que valga.
    expect(parseSidecar(JSON.stringify({ format: 'it360.backup', projectId: 'p1' }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ format: 'it360.backup', createdAt: NOW }))).toBeNull();
  });

  it('TEST-BKP-041 un motivo desconocido no se propaga', () => {
    const parsed = parseSidecar(
      JSON.stringify({ ...sidecar(), reason: 'lo-que-sea' }),
    );
    expect(parsed?.reason).toBe('manual');
  });
});
