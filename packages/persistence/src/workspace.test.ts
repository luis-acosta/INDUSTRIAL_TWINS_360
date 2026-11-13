import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, isErr, isOk, unwrap, type Project } from '@it360/domain';
import { makeFullProject, makeNote, makeScene, testUuid } from '@it360/domain/testing';
import { zipSync } from 'fflate';
import { MemoryStorage } from './storage';
import { Workspace } from './workspace';
import { IVP_PATHS, readIvp } from './ivp';
import { currentVersion, migrate, MIGRATIONS, assertSchemaVersionsAligned } from './migrations';
import { openDatabase } from './sql';
import { loadProject, saveProject } from './repository';

const PATH = '/proyectos/planta-norte.ivp';
const APP_VERSION = '0.14.0';

let clock = Date.parse('2026-11-12T19:00:00.000Z');
const now = (): Date => {
  clock += 60_000;
  return new Date(clock);
};

function makeWorkspace(storage: MemoryStorage): Workspace {
  return new Workspace({ storage, appVersion: APP_VERSION, now });
}

/**
 * TEST-WS-001 .. TEST-WS-024
 *
 * Esta suite incluye la «regresión mínima» que el plan exige en TODAS las
 * etapas: crear → guardar → cerrar → abrir → modificar → guardar → reabrir,
 * cierre forzado → recuperar, y archivo inválido → mensaje sin corrupción.
 */
describe('ciclo de vida del proyecto', () => {
  let storage: MemoryStorage;
  let ws: Workspace;

  beforeEach(() => {
    clock = Date.parse('2026-11-12T19:00:00.000Z');
    storage = new MemoryStorage();
    ws = makeWorkspace(storage);
  });

  it('TEST-WS-001: las versiones de esquema del dominio y de las migraciones coinciden', () => {
    // Se comprueba contra la constante del dominio y no contra un número
    // escrito aquí: una migración nueva no debe obligar a tocar la prueba, y
    // lo que importa es justamente que las dos cuentas no se separen.
    expect(() => assertSchemaVersionsAligned()).not.toThrow();
    expect(MIGRATIONS).toHaveLength(CURRENT_SCHEMA_VERSION);
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('TEST-WS-002: crea un proyecto vacío válido', () => {
    const project = ws.createEmptyProject({ title: 'Planta Norte', client: 'ACME' });
    expect(project.title).toBe('Planta Norte');
    expect(project.client).toBe('ACME');
    expect(project.schemaVersion).toBe(ws.schemaVersion);
  });

  it('TEST-WS-003: REGRESIÓN — crear, guardar, cerrar, abrir', async () => {
    const project = ws.createEmptyProject({ title: 'Planta Norte' });
    const saved = await ws.saveProject(PATH, project, new Map());
    expect(isOk(saved), JSON.stringify(isErr(saved) ? saved.error : '')).toBe(true);

    const opened = await ws.openProject(PATH);
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;
    expect(opened.value.project.id).toBe(project.id);
    expect(opened.value.project.title).toBe('Planta Norte');
    expect(opened.value.integrity).toEqual([]);
  });

  it('TEST-WS-004: REGRESIÓN — un proyecto completo sobrevive a la ida y vuelta', async () => {
    const project = makeFullProject();
    expect(isOk(await ws.saveProject(PATH, project, new Map()))).toBe(true);

    const opened = unwrap(await ws.openProject(PATH));
    const reopened = opened.project;

    expect(reopened.scenes).toHaveLength(project.scenes.length);
    expect(reopened.assets).toHaveLength(project.assets.length);
    expect(reopened.notes).toHaveLength(project.notes.length);
    expect(reopened.telemetryMappings).toHaveLength(project.telemetryMappings.length);
    expect(reopened.plans).toHaveLength(project.plans.length);
    expect(reopened.documents).toHaveLength(project.documents.length);
    expect(reopened.scenes[0]?.hotspots).toHaveLength(project.scenes[0]?.hotspots.length ?? 0);
    expect(opened.loadWarnings).toEqual([]);
  });

  it('TEST-WS-005: conserva la orientación y los límites de cámara de cada escena', async () => {
    // Es el fallo clásico de una capa de persistencia con conversión de
    // unidades: el proyecto se reabre mirando a otro lado.
    const base = makeFullProject();
    const scene = base.scenes[0];
    if (scene === undefined) throw new Error('fixture inválido');
    const tuned = {
      ...base,
      scenes: [
        {
          ...scene,
          camera: {
            ...scene.camera,
            initialView: { yaw: 1.2345678, pitch: -0.4321, fov: 63.5 },
            zoom: { minFovDeg: 25, maxFovDeg: 95 },
            inertia: 0.73,
          },
        },
        ...base.scenes.slice(1),
      ],
    };

    await ws.saveProject(PATH, tuned, new Map());
    const opened = unwrap(await ws.openProject(PATH));
    const camera = opened.project.scenes[0]?.camera;

    expect(camera?.initialView.yaw).toBeCloseTo(1.2345678, 10);
    expect(camera?.initialView.pitch).toBeCloseTo(-0.4321, 10);
    expect(camera?.initialView.fov).toBeCloseTo(63.5, 10);
    expect(camera?.zoom.minFovDeg).toBe(25);
    expect(camera?.inertia).toBeCloseTo(0.73, 10);
  });

  it('TEST-WS-006: REGRESIÓN — modificar y volver a guardar conserva los cambios', async () => {
    const project = makeFullProject();
    await ws.saveProject(PATH, project, new Map());

    const opened = unwrap(await ws.openProject(PATH));
    const modified: Project = {
      ...opened.project,
      title: 'Planta Norte revisada',
      notes: [
        ...opened.project.notes,
        makeNote(900, opened.project.id, { title: 'Fuga en brida', priority: 'urgent' }),
      ],
    };

    expect(isOk(await ws.saveProject(PATH, modified, new Map()))).toBe(true);
    const reopened = unwrap(await ws.openProject(PATH));

    expect(reopened.project.title).toBe('Planta Norte revisada');
    expect(reopened.project.notes).toHaveLength(project.notes.length + 1);
    expect(reopened.project.notes.some((n) => n.title === 'Fuga en brida')).toBe(true);
  });

  it('TEST-WS-007: guardar conserva la copia anterior', async () => {
    const project = ws.createEmptyProject({ title: 'v1' });
    await ws.saveProject(PATH, project, new Map());
    await ws.saveProject(PATH, { ...project, title: 'v2' }, new Map());

    expect(await storage.exists(`${PATH}.bak1`)).toBe(true);
    const backup = unwrap(await ws.openProject(`${PATH}.bak1`));
    expect(backup.project.title).toBe('v1');
  });

  it('TEST-WS-008: Y03 — guardar una copia con otro nombre crea un proyecto distinto', async () => {
    // Conservar el mismo identificador haría que dos archivos distintos se
    // identificaran igual, y la auditoría dejaría de poder distinguirlos.
    const project = makeFullProject();
    await ws.saveProject(PATH, project, new Map());

    const copyPath = '/proyectos/planta-norte-copia.ivp';
    const copy = unwrap(await ws.saveProjectAs(copyPath, project, new Map(), { title: 'Copia' }));

    expect(copy.project.id).not.toBe(project.id);
    expect(copy.project.title).toBe('Copia');
    expect(copy.project.publicationState).toBe('draft');
    expect(copy.project.auditLog).toEqual([]);

    const opened = unwrap(await ws.openProject(copyPath));
    expect(opened.project.scenes).toHaveLength(project.scenes.length);
    // Las escenas apuntan al proyecto nuevo, no al original.
    expect(opened.project.scenes.every((s) => s.projectId === copy.project.id)).toBe(true);
    expect(opened.integrity.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('TEST-WS-009: guardar rechaza un proyecto con referencias rotas', async () => {
    const base = makeFullProject();
    const broken = { ...base, media: [] };

    const result = await ws.saveProject(PATH, broken, new Map());
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.recovery).toContain('integridad');
    }
    expect(await storage.exists(PATH)).toBe(false);
  });

  it('TEST-WS-010: el modo forzado permite guardar pese a las referencias rotas', async () => {
    // A veces hay que guardar para no perder trabajo; lo que no puede pasar
    // es que ocurra sin que nadie lo decida.
    const broken = { ...makeFullProject(), media: [] };
    expect(isOk(await ws.saveProject(PATH, broken, new Map(), { force: true }))).toBe(true);

    const opened = unwrap(await ws.openProject(PATH));
    expect(opened.integrity.filter((p) => p.severity === 'error').length).toBeGreaterThan(0);
  });

  it('TEST-WS-011: Y02 — los medios viajan dentro del paquete', async () => {
    const project = makeFullProject();
    const files = new Map<string, Uint8Array>([
      ['media/pano-a.jpg', new TextEncoder().encode('bytes de panorama')],
      ['documents/eq-001-ds.pdf', new TextEncoder().encode('%PDF-1.7 contenido')],
    ]);

    await ws.saveProject(PATH, project, files);
    const opened = unwrap(await ws.openProject(PATH));

    expect(opened.files.size).toBe(2);
    expect(new TextDecoder().decode(opened.files.get('media/pano-a.jpg'))).toBe('bytes de panorama');
  });
});

describe('paquete .ivp', () => {
  let storage: MemoryStorage;
  let ws: Workspace;

  beforeEach(() => {
    storage = new MemoryStorage();
    ws = makeWorkspace(storage);
  });

  it('TEST-WS-012: el paquete contiene manifiesto, base y verificación', async () => {
    await ws.saveProject(PATH, makeFullProject(), new Map());
    const bytes = await storage.readFile(PATH);
    const pkg = unwrap(await readIvp(bytes));

    expect(pkg.files.has(IVP_PATHS.manifest)).toBe(true);
    expect(pkg.files.has(IVP_PATHS.database)).toBe(true);
    expect(pkg.files.has(IVP_PATHS.checksums)).toBe(true);
    expect(pkg.warnings).toEqual([]);
  });

  it('TEST-WS-013: el manifiesto del paquete no contiene credenciales', async () => {
    // El proyecto de referencia SÍ tiene una conexión con referencia a token.
    await ws.saveProject(PATH, makeFullProject(), new Map());
    const bytes = await storage.readFile(PATH);
    const pkg = unwrap(await readIvp(bytes));

    const manifestText = new TextDecoder().decode(pkg.files.get(IVP_PATHS.manifest));
    expect(manifestText).not.toContain('tokenRef');
    expect(manifestText).not.toContain('token_key_id');
    expect(manifestText).not.toContain('it360.influx');
  });

  it('TEST-WS-014: detecta un paquete alterado', async () => {
    await ws.saveProject(PATH, makeFullProject(), new Map());
    const bytes = await storage.readFile(PATH);
    const pkg = unwrap(await readIvp(bytes));

    // Se reconstruye el ZIP con un archivo modificado y los checksums viejos.
    const tampered: Record<string, Uint8Array> = {};
    for (const [path, data] of pkg.files) tampered[path] = data;
    tampered['media/intruso.txt'] = new TextEncoder().encode('contenido añadido');
    const manifest = pkg.files.get(IVP_PATHS.manifest);
    if (manifest !== undefined) {
      const altered = new TextDecoder().decode(manifest).replace('"title"', '"titulo_alterado"');
      tampered[IVP_PATHS.manifest] = new TextEncoder().encode(altered);
    }

    const result = await readIvp(zipSync(tampered));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('CHECKSUM_MISMATCH');
      expect(result.error.recovery).toContain('rescate');
    }
  });

  it('TEST-WS-015: el modo de rescate abre un paquete alterado con aviso', async () => {
    await ws.saveProject(PATH, makeFullProject(), new Map());
    const pkg = unwrap(await readIvp(await storage.readFile(PATH)));
    const tampered: Record<string, Uint8Array> = {};
    for (const [path, data] of pkg.files) tampered[path] = data;
    tampered['media/intruso.txt'] = new TextEncoder().encode('añadido');

    const rescued = await readIvp(zipSync(tampered), { allowChecksumMismatch: true });
    expect(isOk(rescued)).toBe(true);
    if (isOk(rescued)) {
      expect(rescued.value.warnings.join(' ')).toContain('no figuran');
    }
  });

  it('TEST-WS-016: rechaza una ruta que escapa de la carpeta (ZIP slip)', async () => {
    const malicious = zipSync({
      'manifest.json': new TextEncoder().encode('{}'),
      '../../AppData/Roaming/arranque.cmd': new TextEncoder().encode('@echo off'),
    });

    const result = await readIvp(malicious);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('UNSAFE_PATH');
      expect(result.error.recovery).toContain('No se extraerá');
    }
  });

  it('TEST-WS-017: rechaza un archivo que no es un paquete', async () => {
    await storage.writeFile(PATH, new TextEncoder().encode('esto no es un ZIP'));
    const result = await ws.openProject(PATH);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('TEST-WS-018: rechaza un ZIP sin manifiesto', async () => {
    const result = await readIvp(zipSync({ 'cualquier.txt': new TextEncoder().encode('x') }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain('manifiesto');
  });

  it('TEST-WS-019: rechaza un proyecto de una versión futura sin tocarlo', async () => {
    await ws.saveProject(PATH, makeFullProject(), new Map());
    const pkg = unwrap(await readIvp(await storage.readFile(PATH)));
    const manifestBytes = pkg.files.get(IVP_PATHS.manifest);
    if (manifestBytes === undefined) throw new Error('falta el manifiesto');

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    manifest['schemaVersion'] = 999;

    const future: Record<string, Uint8Array> = {};
    for (const [path, data] of pkg.files) future[path] = data;
    future[IVP_PATHS.manifest] = new TextEncoder().encode(JSON.stringify(manifest));

    const result = await readIvp(zipSync(future), { verifyIntegrity: false });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('SCHEMA_TOO_NEW');
      expect(result.error.recovery).toContain('Actualice');
    }
  });

  it('TEST-WS-020: rechaza una relación de compresión anómala', async () => {
    // Una bomba de descompresión: un paquete pequeño que al abrirse agota la
    // memoria del equipo.
    const huge = new Uint8Array(40 * 1024 * 1024);
    const bomb = zipSync({ 'manifest.json': new TextEncoder().encode('{}'), 'relleno.bin': huge });
    const result = await readIvp(bomb);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('UNSUPPORTED_FORMAT');
      expect(result.error.message).toContain('compresión');
    }
  });
});

describe('recuperación tras cierre abrupto', () => {
  let storage: MemoryStorage;
  let ws: Workspace;

  beforeEach(() => {
    clock = Date.parse('2026-11-12T19:00:00.000Z');
    storage = new MemoryStorage();
    ws = makeWorkspace(storage);
  });

  it('TEST-WS-021: REGRESIÓN — tras un cierre forzado se recupera el respaldo', async () => {
    const project = makeFullProject();
    await ws.saveProject(PATH, project, new Map());
    await ws.saveProject(PATH, { ...project, title: 'Segunda versión' }, new Map());

    // El archivo principal queda ilegible, como tras un corte de corriente.
    await storage.writeFile(PATH, new TextEncoder().encode('\u0000\u0000basura'));

    const recovered = unwrap(await ws.recoverProject(PATH));
    expect(recovered.from.kind).toBe('backup');
    expect(recovered.recovered.project.title).toBe('Planta de prueba');
  });

  it('TEST-WS-022: prefiere el temporal de un guardado interrumpido al respaldo', async () => {
    const project = makeFullProject();
    await ws.saveProject(PATH, project, new Map());

    storage.failOn = { op: 'rename', path: '.tmp-' };
    await ws.saveProject(PATH, { ...project, title: 'Trabajo sin guardar' }, new Map());

    const candidates = await ws.findRecoveryCandidates(PATH);
    expect(candidates[0]?.kind).toBe('interrupted');

    const recovered = unwrap(await ws.recoverProject(PATH));
    expect(recovered.from.kind).toBe('interrupted');
    expect(recovered.recovered.project.title).toBe('Trabajo sin guardar');
  });

  it('TEST-WS-023: descarta los candidatos ilegibles y sigue con el siguiente', async () => {
    const project = makeFullProject();
    await ws.saveProject(PATH, project, new Map());
    await ws.saveProject(PATH, { ...project, title: 'v2' }, new Map());
    await ws.saveProject(PATH, { ...project, title: 'v3' }, new Map());

    // El respaldo más reciente también está dañado.
    await storage.writeFile(`${PATH}.bak1`, new TextEncoder().encode('dañado'));

    const recovered = unwrap(await ws.recoverProject(PATH));
    expect(recovered.skipped.length).toBeGreaterThan(0);
    expect(recovered.from.path).toBe(`${PATH}.bak2`);
  });

  it('TEST-WS-024: sin candidatos devuelve un error explicativo', async () => {
    const result = await ws.recoverProject('/proyectos/inexistente.ivp');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.recovery).toContain('.bak1');
    }
  });
});

describe('migraciones', () => {
  it('TEST-WS-025: una base vacía llega a la versión actual', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      expect(currentVersion(db)).toBe(0);
      const report = unwrap(migrate(db, { now: '2026-11-12T19:00:00.000Z' }));
      expect(report.from).toBe(0);
      expect(report.to).toBe(CURRENT_SCHEMA_VERSION);
      expect(report.applied).toHaveLength(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-025b: una base en la versión 1 se actualiza sin perder lo guardado', async () => {
    // Es el caso real: hay proyectos guardados con la versión 1. La prueba
    // escribe algo con sólo la primera migración aplicada, aplica el resto y
    // comprueba que sigue estando. Sin esto, una migración podría recrear una
    // tabla y vaciarla sin que ninguna prueba se enterase.
    const db = unwrap(await openDatabase(null));
    try {
      const soloLaPrimera = MIGRATIONS.filter((m) => m.version === 1);
      unwrap(migrate(db, { now: '2026-11-12T19:00:00.000Z', migrations: soloLaPrimera }));
      expect(currentVersion(db)).toBe(1);

      db.run(
        `INSERT INTO skin (id, name, description, layout_mode, design_width, design_height,
           root_json, template_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          '00000000-0000-4000-8000-000000000001',
          'Interfaz de la planta',
          '',
          'fluid',
          1920,
          1080,
          '[]',
          null,
          '2026-11-12T19:00:00.000Z',
          '2026-11-12T19:00:00.000Z',
        ],
      );

      const report = unwrap(migrate(db, { now: '2026-11-12T19:05:00.000Z' }));
      expect(report.from).toBe(1);
      expect(report.to).toBe(CURRENT_SCHEMA_VERSION);

      const row = db.get('SELECT name FROM skin');
      expect(row?.['name']).toBe('Interfaz de la planta');
      // Y la tabla nueva existe y está vacía, no ausente.
      expect(db.get('SELECT COUNT(*) AS n FROM info_window')?.['n']).toBe(0);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-025c: la migración 3 renombra los fondos ya guardados', async () => {
    // Un proyecto guardado antes trae `token` en los fondos del sistema, y con
    // ese nombre no se podía publicar. La migración lo arregla sin tocar nada
    // más de la interfaz.
    const db = unwrap(await openDatabase(null));
    try {
      const hastaLaDos = MIGRATIONS.filter((m) => m.version <= 2);
      unwrap(migrate(db, { now: '2026-11-12T19:00:00.000Z', migrations: hastaLaDos }));

      const root = JSON.stringify([
        {
          id: 'n1',
          name: 'Barra',
          style: { background: { kind: 'token', token: 'overlay' }, textAlign: 'left' },
          children: [
            { id: 'n2', style: { background: { kind: 'color', color: '#112233' } } },
          ],
        },
      ]);

      db.run(
        `INSERT INTO skin (id, name, description, layout_mode, design_width, design_height,
           root_json, template_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          '00000000-0000-4000-8000-000000000002',
          'Interfaz',
          '',
          'fluid',
          1920,
          1080,
          root,
          null,
          '2026-11-12T19:00:00.000Z',
          '2026-11-12T19:00:00.000Z',
        ],
      );

      unwrap(migrate(db, { now: '2026-11-12T19:10:00.000Z' }));

      const after = String(db.get('SELECT root_json FROM skin')?.['root_json'] ?? '');
      expect(after).toContain('"surfaceToken":"overlay"');
      expect(after).not.toContain('"token":"overlay"');
      // Lo que no era un fondo del sistema se queda igual.
      expect(after).toContain('"color":"#112233"');
      expect(after).toContain('"name":"Barra"');
    } finally {
      db.close();
    }
  });

  it('TEST-WS-026: migrar dos veces no hace nada la segunda', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      const second = unwrap(migrate(db, { now: '2026-11-12T19:01:00.000Z' }));
      expect(second.applied).toEqual([]);
      expect(second.from).toBe(second.to);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-027: el motor aplica migraciones sucesivas en orden', async () => {
    // Se usan migraciones de prueba para ejercitar el motor en sí, no el
    // esquema: así la maquinaria queda probada antes de que exista la
    // primera migración real de una etapa futura.
    const db = unwrap(await openDatabase(null));
    try {
      const order: number[] = [];
      const report = unwrap(
        migrate(db, {
          now: '2026-11-12T19:00:00.000Z',
          migrations: [
            {
              version: 1,
              name: 'base',
              description: '',
              up: (d) => {
                order.push(1);
                d.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE t (a TEXT)');
              },
            },
            {
              version: 2,
              name: 'añade-columna',
              description: '',
              up: (d) => {
                order.push(2);
                d.exec('ALTER TABLE t ADD COLUMN b TEXT');
              },
            },
          ],
        }),
      );
      expect(order).toEqual([1, 2]);
      expect(report.to).toBe(2);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-028: una migración que falla deja la base en la versión anterior', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      const result = migrate(db, {
        now: '2026-11-12T19:00:00.000Z',
        migrations: [
          {
            version: 1,
            name: 'base',
            description: '',
            up: (d) =>
              d.exec(
                'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE t (a TEXT)',
              ),
          },
          {
            version: 2,
            name: 'rota',
            description: '',
            up: (d) => d.exec('ESTO NO ES SQL VÁLIDO'),
          },
        ],
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe('MIGRATION_FAILED');
        expect(result.error.recovery).toContain('no se ha modificado');
      }
      // La versión 1 quedó aplicada; la 2 no dejó rastro.
      expect(currentVersion(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-029: una base de versión futura no se toca', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, ?, ?)', [
        'futura',
        '2027-01-01T00:00:00.000Z',
      ]);

      const result = migrate(db, { now: '2026-11-12T19:02:00.000Z' });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.code).toBe('SCHEMA_TOO_NEW');
      expect(currentVersion(db)).toBe(99);
    } finally {
      db.close();
    }
  });
});

describe('garantías del esquema', () => {
  it('TEST-WS-030: la auditoría no admite modificación ni borrado', async () => {
    // Un registro de auditoría que se puede editar no sirve como registro de
    // auditoría; los disparadores lo hacen cumplir en la propia base.
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      db.run(
        `INSERT INTO audit_event (id, actor, actor_name, action, entity, entity_id, summary, timestamp)
         VALUES (?,?,?,?,?,?,?,?)`,
        [testUuid(1), 'u-ana', 'Ana', 'update', 'scene', testUuid(40), 'cambio', '2026-11-12T19:00:00.000Z'],
      );

      expect(() =>
        db.run('UPDATE audit_event SET summary = ? WHERE id = ?', ['manipulado', testUuid(1)]),
      ).toThrow();
      expect(() => db.run('DELETE FROM audit_event WHERE id = ?', [testUuid(1)])).toThrow();

      const row = db.get('SELECT summary FROM audit_event WHERE id = ?', [testUuid(1)]);
      expect(row?.['summary']).toBe('cambio');
    } finally {
      db.close();
    }
  });

  it('TEST-WS-031: un archivo de proyecto no puede contener dos proyectos', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      const insert = (id: string): void => {
        db.run(
          `INSERT INTO project (id, singleton, schema_version, title, settings_json, created_at, updated_at)
           VALUES (?, 1, 1, ?, '{}', ?, ?)`,
          [id, 'Proyecto', '2026-11-12T19:00:00.000Z', '2026-11-12T19:00:00.000Z'],
        );
      };
      insert(testUuid(1));
      expect(() => insert(testUuid(2))).toThrow();
    } finally {
      db.close();
    }
  });

  it('TEST-WS-032: las claves externas están activas', async () => {
    // Sin ellas, SQLite aceptaría en silencio referencias a filas que no
    // existen y la integridad dependería por completo del código.
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      expect(() =>
        db.run(
          `INSERT INTO hotspot (id, scene_id, name, anchor_json, geometry_json, style_json,
             visibility_json, created_at, updated_at)
           VALUES (?,?,?,'{}','{}','{}','{}',?,?)`,
          [testUuid(1), testUuid(999), 'Huérfano', '2026-11-12T19:00:00.000Z', '2026-11-12T19:00:00.000Z'],
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('TEST-WS-033: una escritura que falla a mitad no deja la base a medias', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      const base = makeFullProject();
      // Un activo que referencia una clase inexistente rompe la clave externa
      // a mitad del volcado.
      const corrupt = {
        ...base,
        assets: [...base.assets, { ...base.assets[0]!, id: testUuid(777), classId: testUuid(888) }],
      };

      const result = saveProject(db, corrupt, {
        appVersion: APP_VERSION,
        now: '2026-11-12T19:00:00.000Z',
      });
      expect(isErr(result)).toBe(true);

      // Nada se escribió: la transacción revirtió por completo.
      const count = db.get('SELECT COUNT(*) AS n FROM scene');
      expect(count?.['n']).toBe(0);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-034: una fila que no valida se descarta con aviso en vez de impedir la apertura', async () => {
    // Si una de cuatrocientas notas tiene una prioridad que ya no existe, el
    // usuario preferirá abrir el proyecto y perder esa nota antes que no
    // poder abrirlo.
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      const base = makeFullProject();
      saveProject(db, base, { appVersion: APP_VERSION, now: '2026-11-12T19:00:00.000Z' });

      db.run('UPDATE note SET priority = ? WHERE id = ?', ['prioridad_inexistente', base.notes[0]!.id]);

      const loaded = unwrap(loadProject(db));
      expect(loaded.project.notes).toHaveLength(0);
      expect(loaded.warnings).toHaveLength(1);
      expect(loaded.warnings[0]?.table).toBe('note');
      // El resto del proyecto sigue intacto.
      expect(loaded.project.scenes).toHaveLength(base.scenes.length);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-035: la jerarquía de activos se guarda en orden de dependencia', async () => {
    const db = unwrap(await openDatabase(null));
    try {
      migrate(db, { now: '2026-11-12T19:00:00.000Z' });
      const base = makeFullProject();
      // Se invierte el orden: el hijo queda antes que el padre en la lista.
      const reversed = { ...base, assets: [...base.assets].reverse() };
      const result = saveProject(db, reversed, {
        appVersion: APP_VERSION,
        now: '2026-11-12T19:00:00.000Z',
      });
      expect(isOk(result)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('TEST-WS-036: una escena excluida de publicación se conserva en el proyecto', async () => {
    const storage = new MemoryStorage();
    const ws = makeWorkspace(storage);
    const base = makeFullProject();
    const withExcluded = {
      ...base,
      scenes: [
        ...base.scenes,
        makeScene(500, base.id, { title: 'Borrador', excludedFromPublish: true, mediaId: base.media[0]!.id }),
      ],
    };

    await ws.saveProject(PATH, withExcluded, new Map());
    const opened = unwrap(await ws.openProject(PATH));

    expect(opened.project.scenes).toHaveLength(base.scenes.length + 1);
    expect(opened.project.scenes.some((s) => s.excludedFromPublish)).toBe(true);
    // Pero el manifiesto publicado dentro del paquete sólo lleva las publicables.
    const pkg = unwrap(await readIvp(await storage.readFile(PATH)));
    expect(pkg.manifest.scenes).toHaveLength(base.scenes.length);
  });
});
