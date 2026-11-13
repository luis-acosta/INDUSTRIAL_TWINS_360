/**
 * Espacio de trabajo: abrir, guardar, duplicar y recuperar proyectos.
 *
 * Es la capa que el editor usa directamente, y la que implementa los
 * requisitos Y01 (crear, guardar y reabrir), Y02 (exportar con sus medios),
 * Y03 (guardar una copia con otro nombre) y la recuperación tras cierre
 * abrupto que la etapa 00 exige.
 *
 * Todo lo que tiene que ver con el orden de las operaciones de disco está
 * aquí y no repartido por la interfaz, de modo que se puede probar la
 * secuencia completa —incluido el fallo a mitad— con almacenamiento en
 * memoria.
 */
import {
  checkIntegrity,
  createProject,
  CURRENT_SCHEMA_VERSION,
  domainError,
  err,
  isErr,
  newUuid,
  ok,
  toManifest,
  type IntegrityProblem,
  type Project,
  type Result,
} from '@it360/domain';
import { migrate } from './migrations';
import { loadProject, saveProject, type LoadWarning } from './repository';
import { openDatabase, type SqlDatabase } from './sql';
import {
  findBackups,
  findInterruptedWrites,
  writeAtomic,
  type FileStat,
  type Storage,
} from './storage';
import { IVP_PATHS, isContentPath, readIvp, writeIvp } from './ivp';

export interface WorkspaceOptions {
  readonly storage: Storage;
  readonly appVersion: string;
  /** Reloj inyectable: las pruebas necesitan tiempos deterministas. */
  readonly now: () => Date;
  readonly locateSqlWasm?: (file: string) => string;
}

export interface OpenProjectResult {
  readonly project: Project;
  /** Archivos de medios y documentos del paquete, por ruta relativa. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly warnings: readonly string[];
  readonly loadWarnings: readonly LoadWarning[];
  readonly integrity: readonly IntegrityProblem[];
  /** Migraciones aplicadas al abrir. */
  readonly migrated: ReadonlyArray<{ version: number; name: string }>;
}

export interface SaveProjectResult {
  readonly path: string;
  readonly byteSize: number;
  readonly backupsKept: number;
}

export interface RecoveryCandidate {
  readonly path: string;
  readonly kind: 'backup' | 'interrupted';
  readonly modifiedAtMs: number;
  readonly byteSize: number;
}

export class Workspace {
  constructor(private readonly options: WorkspaceOptions) {}

  private iso(): string {
    return this.options.now().toISOString();
  }

  /* ---------------------------------------------------------------- *
   * Crear (Y01)
   * ---------------------------------------------------------------- */

  createEmptyProject(input: { title: string; client?: string; site?: string }): Project {
    return createProject({
      id: newUuid(),
      title: input.title,
      client: input.client,
      site: input.site,
      now: this.iso(),
      appVersion: this.options.appVersion,
    });
  }

  /* ---------------------------------------------------------------- *
   * Abrir (Y01)
   * ---------------------------------------------------------------- */

  /**
   * Abre un proyecto desde el disco.
   *
   * Secuencia: leer bytes → validar el ZIP y su integridad → abrir la base →
   * migrar → cargar y validar → comprobar integridad referencial.
   *
   * Nótese que la migración ocurre EN MEMORIA y no se escribe al archivo. El
   * usuario abre un proyecto de una versión anterior, trabaja, y sólo cuando
   * guarda queda convertido. Migrar el archivo al abrirlo dejaría al usuario
   * sin posibilidad de volver a la versión previa de la aplicación si
   * descubre que algo no le funciona.
   */
  async openProject(
    path: string,
    options: { allowChecksumMismatch?: boolean } = {},
  ): Promise<Result<OpenProjectResult>> {
    let bytes: Uint8Array;
    try {
      bytes = await this.options.storage.readFile(path);
    } catch (cause) {
      return err(
        domainError('NOT_FOUND', 'No se pudo leer el archivo del proyecto', {
          detail: { file: this.options.storage.basename(path), cause: String(cause) },
          recovery: 'Compruebe que el archivo existe y que tiene permiso de lectura.',
        }),
      );
    }

    const pkg = await readIvp(bytes, {
      verifyIntegrity: true,
      ...(options.allowChecksumMismatch !== undefined
        ? { allowChecksumMismatch: options.allowChecksumMismatch }
        : {}),
    });
    if (isErr(pkg)) return pkg;

    const dbResult = await openDatabase(
      pkg.value.database,
      this.options.locateSqlWasm !== undefined
        ? { locateFile: this.options.locateSqlWasm }
        : {},
    );
    if (isErr(dbResult)) return dbResult;
    const db = dbResult.value;

    try {
      const migration = migrate(db, { now: this.iso() });
      if (isErr(migration)) return migration;

      const loaded = loadProject(db);
      if (isErr(loaded)) return loaded;

      const integrity = checkIntegrity(loaded.value.project);

      return ok({
        project: loaded.value.project,
        files: new Map([...pkg.value.files].filter(([p]) => isContentPath(p))),
        warnings: pkg.value.warnings,
        loadWarnings: loaded.value.warnings,
        integrity,
        migrated: migration.value.applied,
      });
    } finally {
      db.close();
    }
  }

  /* ---------------------------------------------------------------- *
   * Guardar (Y01, Y02, Y03)
   * ---------------------------------------------------------------- */

  /**
   * Guarda el proyecto con sus medios en un paquete `.ivp`.
   *
   * Se niega a guardar si la integridad referencial tiene errores
   * bloqueantes, salvo que se fuerce. La razón: guardar un proyecto con
   * referencias rotas lo propaga, y la siguiente apertura vuelve a
   * encontrarse el mismo problema sin que nadie sepa cuándo apareció. El
   * modo forzado existe porque a veces hay que guardar para no perder
   * trabajo, y entonces conviene registrar por qué.
   */
  /**
   * Construye el paquete en memoria, sin escribirlo.
   *
   * Es el mismo camino que `saveProject` hasta el último paso, y a propósito:
   * un respaldo construido por una vía distinta sería un respaldo que no se
   * ejercita nunca, y el día que hiciera falta restaurarlo se descubriría que
   * esa segunda vía tenía un fallo. Aquí el paquete es exactamente el que se
   * guardaría; lo único que cambia es que no toca el disco.
   */
  async buildPackage(
    project: Project,
    files: ReadonlyMap<string, Uint8Array>,
    options: { force?: boolean } = {},
  ): Promise<Result<Uint8Array>> {
    const integrity = checkIntegrity(project);
    const blocking = integrity.filter((p) => p.severity === 'error');
    if (blocking.length > 0 && options.force !== true) {
      return err(
        domainError('VALIDATION_FAILED', 'El proyecto tiene referencias que no se pueden resolver', {
          detail: {
            problems: blocking.slice(0, 5).map((p) => `${p.entity}: ${p.message}`),
            total: blocking.length,
          },
          recovery:
            'Corrija las referencias antes de respaldar, o respalde de todas formas si prefiere conservar el estado actual.',
        }),
      );
    }

    const dbResult = await openDatabase(
      null,
      this.options.locateSqlWasm !== undefined
        ? { locateFile: this.options.locateSqlWasm }
        : {},
    );
    if (isErr(dbResult)) return dbResult;
    const db = dbResult.value;

    try {
      const migration = migrate(db, { now: this.iso() });
      if (isErr(migration)) return migration;

      const written = saveProject(db, project, {
        appVersion: this.options.appVersion,
        now: this.iso(),
        allowDanglingReferences: options.force === true,
      });
      if (isErr(written)) return written;

      const manifest = toManifest(project, {
        publishedAt: this.iso(),
        appVersion: this.options.appVersion,
        offlineCapable: true,
      });

      return writeIvp({ manifest, database: db.export(), files });
    } finally {
      db.close();
    }
  }

  async saveProject(
    path: string,
    project: Project,
    files: ReadonlyMap<string, Uint8Array>,
    options: { force?: boolean; backupCount?: number } = {},
  ): Promise<Result<SaveProjectResult>> {
    const integrity = checkIntegrity(project);
    const blocking = integrity.filter((p) => p.severity === 'error');
    if (blocking.length > 0 && options.force !== true) {
      return err(
        domainError('VALIDATION_FAILED', 'El proyecto tiene referencias que no se pueden resolver', {
          detail: {
            problems: blocking.slice(0, 5).map((p) => `${p.entity}: ${p.message}`),
            total: blocking.length,
          },
          recovery:
            'Corrija los problemas señalados en el panel de integridad, o guarde de todas formas si necesita conservar el trabajo.',
        }),
      );
    }

    const dbResult = await openDatabase(
      null,
      this.options.locateSqlWasm !== undefined
        ? { locateFile: this.options.locateSqlWasm }
        : {},
    );
    if (isErr(dbResult)) return dbResult;
    const db = dbResult.value;

    try {
      const migration = migrate(db, { now: this.iso() });
      if (isErr(migration)) return migration;

      const written = saveProject(db, project, {
        appVersion: this.options.appVersion,
        now: this.iso(),
        allowDanglingReferences: options.force === true,
      });
      if (isErr(written)) return written;

      const manifest = toManifest(project, {
        publishedAt: this.iso(),
        appVersion: this.options.appVersion,
        offlineCapable: true,
      });

      const packaged = await writeIvp({
        manifest,
        database: db.export(),
        files,
      });
      if (isErr(packaged)) return packaged;

      const stored = await writeAtomic(this.options.storage, path, packaged.value, {
        backupCount: options.backupCount ?? project.settings.backupCount,
      });
      if (isErr(stored)) return stored;

      return ok({
        path,
        byteSize: packaged.value.length,
        backupsKept: stored.value.backupsKept,
      });
    } finally {
      db.close();
    }
  }

  /**
   * Guarda una copia con otro nombre (Y03).
   *
   * La copia recibe un identificador de proyecto NUEVO. Conservar el mismo
   * haría que dos archivos distintos se identificaran igual, y a partir de
   * ahí la auditoría de la etapa 11, la caché de telemetría y cualquier
   * referencia externa dejarían de poder distinguirlos.
   */
  async saveProjectAs(
    path: string,
    project: Project,
    files: ReadonlyMap<string, Uint8Array>,
    options: { title?: string } = {},
  ): Promise<Result<SaveProjectResult & { project: Project }>> {
    const now = this.iso();
    const copy: Project = {
      ...project,
      id: newUuid(),
      title: options.title ?? `${project.title} (copia)`,
      publicationState: 'draft',
      createdAt: now,
      updatedAt: now,
      // Una copia arranca con su propio registro: los eventos del original
      // describen cambios sobre otro proyecto.
      auditLog: [],
      scenes: project.scenes.map((s) => ({ ...s, projectId: newUuid() as never })),
    };

    // Las escenas conservan su propio identificador pero deben apuntar al
    // proyecto nuevo; se reasigna en bloque para no romper los marcadores.
    const reparented: Project = {
      ...copy,
      scenes: project.scenes.map((s) => ({ ...s, projectId: copy.id })),
      assets: project.assets.map((a) => ({ ...a, projectId: copy.id })),
      notes: project.notes.map((n) => ({ ...n, projectId: copy.id })),
      tours: project.tours.map((t) => ({ ...t, projectId: copy.id })),
      quizzes: project.quizzes.map((q) => ({ ...q, projectId: copy.id })),
    };

    const saved = await this.saveProject(path, reparented, files);
    if (isErr(saved)) return saved;
    return ok({ ...saved.value, project: reparented });
  }

  /* ---------------------------------------------------------------- *
   * Recuperación
   * ---------------------------------------------------------------- */

  /**
   * Candidatos a recuperación de un proyecto, del más reciente al más antiguo.
   *
   * Incluye los respaldos rotados y los temporales de un guardado
   * interrumpido. Los temporales van primero: si existen, la aplicación murió
   * mientras guardaba y ese archivo contiene trabajo más reciente que
   * cualquier respaldo.
   */
  async findRecoveryCandidates(path: string): Promise<readonly RecoveryCandidate[]> {
    const toCandidate = (stat: FileStat, kind: 'backup' | 'interrupted'): RecoveryCandidate => ({
      path: stat.path,
      kind,
      modifiedAtMs: stat.modifiedAtMs,
      byteSize: stat.byteSize,
    });

    const interrupted = (await findInterruptedWrites(this.options.storage, path)).map((s) =>
      toCandidate(s, 'interrupted'),
    );
    const backups = (
      await findBackups(this.options.storage, path, { backupCount: 20 })
    ).map((s) => toCandidate(s, 'backup'));

    return [...interrupted, ...backups];
  }

  /**
   * Intenta abrir el primer candidato que cargue correctamente.
   *
   * Recorre los candidatos en orden y devuelve el primero válido junto con la
   * lista de los que se descartaron, para que el editor pueda decirle al
   * usuario de qué momento viene lo que ha recuperado.
   */
  async recoverProject(path: string): Promise<
    Result<{
      readonly recovered: OpenProjectResult;
      readonly from: RecoveryCandidate;
      readonly skipped: readonly RecoveryCandidate[];
    }>
  > {
    const candidates = await this.findRecoveryCandidates(path);
    if (candidates.length === 0) {
      return err(
        domainError('NOT_FOUND', 'No se han encontrado copias de recuperación del proyecto', {
          detail: { file: this.options.storage.basename(path) },
          recovery:
            'Las copias de respaldo acompañan al archivo del proyecto con la extensión .bak1, .bak2 y así sucesivamente.',
        }),
      );
    }

    const skipped: RecoveryCandidate[] = [];
    for (const candidate of candidates) {
      const opened = await this.openProject(candidate.path);
      if (!isErr(opened)) {
        return ok({ recovered: opened.value, from: candidate, skipped });
      }
      skipped.push(candidate);
    }

    return err(
      domainError('CHECKSUM_MISMATCH', 'Ninguna copia de recuperación se ha podido abrir', {
        detail: { tried: candidates.length },
        recovery:
          'Conserve el archivo y las copias .bak, y comunique el problema indicando la versión de la aplicación.',
      }),
    );
  }

  /* ---------------------------------------------------------------- *
   * Diagnóstico
   * ---------------------------------------------------------------- */

  /** Abre una base en memoria ya migrada. Lo usan las pruebas y las herramientas. */
  async openBlankDatabase(): Promise<Result<SqlDatabase>> {
    const dbResult = await openDatabase(
      null,
      this.options.locateSqlWasm !== undefined
        ? { locateFile: this.options.locateSqlWasm }
        : {},
    );
    if (isErr(dbResult)) return dbResult;
    const migration = migrate(dbResult.value, { now: this.iso() });
    if (isErr(migration)) {
      dbResult.value.close();
      return migration;
    }
    return ok(dbResult.value);
  }

  get schemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  get manifestPath(): string {
    return IVP_PATHS.manifest;
  }
}
