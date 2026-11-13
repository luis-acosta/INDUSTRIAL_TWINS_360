/**
 * Acceso a SQLite.
 *
 * Se usa SQLite compilado a WebAssembly (`sql.js`) en lugar de un módulo
 * nativo, y la decisión tiene consecuencias que conviene dejar escritas:
 *
 *  - **El mismo código corre en los tres sitios**: el WebView de Tauri, el
 *    visor web y las pruebas en Node. Un módulo nativo obligaría a compilar
 *    por plataforma y a mantener dos rutas de persistencia, una para la
 *    aplicación y otra para las pruebas, que es precisamente donde se
 *    esconden los fallos de guardado.
 *  - **No hay toolchain de C en la máquina del usuario**. Un `better-sqlite3`
 *    falla en instalación en un Windows sin herramientas de compilación, y
 *    eso convierte «npm install» en un problema de soporte.
 *  - **La base vive en memoria y se persiste como un archivo de bytes.** Es
 *    perfectamente adecuado para un proyecto de recorrido, que se abre, se
 *    edita y se guarda como documento. No lo sería para una base multiusuario
 *    con escrituras concurrentes, y por eso la etapa 11 usa PostgreSQL en el
 *    servidor en vez de compartir este archivo por red.
 */
import { domainError, err, ok, type Result } from '@it360/domain';

/** Valor que SQLite puede almacenar. */
export type SqlValue = number | string | Uint8Array | null;

export interface SqlRow {
  readonly [column: string]: SqlValue;
}

export interface SqlStatement {
  run(params?: readonly SqlValue[] | Readonly<Record<string, SqlValue>>): void;
  all(params?: readonly SqlValue[] | Readonly<Record<string, SqlValue>>): SqlRow[];
  get(params?: readonly SqlValue[] | Readonly<Record<string, SqlValue>>): SqlRow | null;
  free(): void;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  run(sql: string, params?: readonly SqlValue[]): void;
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  get(sql: string, params?: readonly SqlValue[]): SqlRow | null;
  /** Serializa la base completa a bytes, para guardarla como archivo. */
  export(): Uint8Array;
  close(): void;
  /** Ejecuta una función dentro de una transacción, revirtiendo si lanza. */
  transaction<T>(fn: () => T): T;
}

/* ------------------------------------------------------------------ *
 * Adaptador sobre sql.js
 * ------------------------------------------------------------------ */

interface SqlJsStatement {
  bind(params?: unknown): boolean;
  step(): boolean;
  getAsObject(): Record<string, SqlValue>;
  free(): boolean;
  reset(): void;
  run(params?: unknown): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown): void;
  exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsModule {
  Database: new (data?: Uint8Array | null) => SqlJsDatabase;
}

let modulePromise: Promise<SqlJsModule> | null = null;

/**
 * Carga el módulo WASM una sola vez por proceso.
 *
 * `locateFile` permite que el WebView de Tauri y el visor web resuelvan el
 * `.wasm` desde sus propios recursos. En Node se resuelve por `require`,
 * que es lo que hace el paquete por defecto.
 */
export function loadSqlJs(options: { locateFile?: (file: string) => string } = {}): Promise<SqlJsModule> {
  if (modulePromise === null) {
    modulePromise = (async () => {
      const mod = (await import('sql.js')) as unknown as {
        default: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsModule>;
      };
      const init = mod.default;
      return options.locateFile !== undefined
        ? init({ locateFile: options.locateFile })
        : init();
    })();
  }
  return modulePromise;
}

/** Sólo para pruebas: olvida el módulo cargado. */
export function resetSqlJsForTests(): void {
  modulePromise = null;
}

class SqlJsAdapter implements SqlDatabase {
  private transactionDepth = 0;

  constructor(private readonly db: SqlJsDatabase) {}

  exec(sql: string): void {
    this.db.run(sql);
  }

  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (params) => {
        stmt.reset();
        stmt.run(params as unknown);
      },
      all: (params) => {
        stmt.reset();
        if (params !== undefined) stmt.bind(params as unknown);
        const rows: SqlRow[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      },
      get: (params) => {
        stmt.reset();
        if (params !== undefined) stmt.bind(params as unknown);
        return stmt.step() ? stmt.getAsObject() : null;
      },
      free: () => {
        stmt.free();
      },
    };
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    this.db.run(sql, params as unknown[]);
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params as unknown[]);
      const rows: SqlRow[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | null {
    const rows = this.all(sql, params);
    return rows[0] ?? null;
  }

  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Transacción con soporte de anidamiento mediante puntos de retorno.
   *
   * Sin el anidamiento, un caso de uso que llama a otro —guardar un activo
   * que a su vez registra un evento de auditoría— abriría dos transacciones
   * y SQLite rechazaría la segunda. Con `SAVEPOINT`, la interna revierte sólo
   * su parte y la externa decide el destino del conjunto.
   */
  transaction<T>(fn: () => T): T {
    const isOuter = this.transactionDepth === 0;
    const name = `sp_${this.transactionDepth}`;
    this.transactionDepth += 1;

    this.db.run(isOuter ? 'BEGIN' : `SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.run(isOuter ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (cause) {
      try {
        this.db.run(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      } catch {
        // Si el rollback falla, el error original es más informativo.
      }
      throw cause;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

/**
 * Abre una base: vacía, o desde los bytes de un archivo guardado.
 *
 * Los `PRAGMA` se aplican en cada apertura y no se guardan en el archivo.
 * `foreign_keys` está activado porque, sin él, SQLite acepta en silencio
 * referencias a filas que no existen, y la integridad referencial pasaría a
 * depender por completo del código de la aplicación.
 */
export async function openDatabase(
  data?: Uint8Array | null,
  options: { locateFile?: (file: string) => string } = {},
): Promise<Result<SqlDatabase>> {
  try {
    const sqljs = await loadSqlJs(options);
    const raw = new sqljs.Database(data ?? null);
    const db = new SqlJsAdapter(raw);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    return ok(db);
  } catch (cause) {
    return err(
      domainError('STORAGE_FAILED', 'No se pudo abrir la base de datos del proyecto', {
        detail: { cause: String(cause) },
        recovery:
          'El archivo puede estar dañado. Pruebe a abrir una de las copias de respaldo que acompañan al proyecto.',
      }),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

/** Lee una columna como texto, o `null`. */
export function asText(value: SqlValue): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return new TextDecoder().decode(value);
}

/** Lee una columna como número, o `null` si no lo es. */
export function asNumber(value: SqlValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Lee una columna JSON.
 *
 * Devuelve `fallback` si el contenido no es JSON válido, en vez de lanzar: un
 * proyecto con una columna JSON corrupta debe poder abrirse para que el
 * usuario rescate el resto, y el problema se reporta como aviso de
 * integridad.
 */
export function asJson<T>(value: SqlValue, fallback: T): T {
  const text = asText(value);
  if (text === null || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Convierte un booleano a la representación entera de SQLite. */
export const toInt = (value: boolean): number => (value ? 1 : 0);

/** Interpreta un entero de SQLite como booleano. */
export const toBool = (value: SqlValue): boolean => asNumber(value) === 1;

/** Serializa a JSON para una columna de texto. */
export const toJson = (value: unknown): string => JSON.stringify(value ?? null);
