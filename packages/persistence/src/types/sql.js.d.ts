/**
 * Declaraciones de `sql.js`.
 *
 * El paquete no publica tipos y `@types/sql.js` está desactualizado respecto
 * a la versión que se usa. Se declara aquí la superficie que este producto
 * consume —y sólo esa—, de modo que si una versión futura cambia la API, el
 * compilador lo señale en lugar de fallar en tiempo de ejecución.
 */
declare module 'sql.js' {
  export type SqlJsValue = number | string | Uint8Array | null;

  export interface Statement {
    bind(params?: unknown): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlJsValue>;
    get(params?: unknown): SqlJsValue[];
    free(): boolean;
    reset(): void;
    run(params?: unknown): void;
    getColumnNames(): string[];
  }

  export interface Database {
    run(sql: string, params?: unknown): void;
    exec(sql: string): Array<{ columns: string[]; values: SqlJsValue[][] }>;
    prepare(sql: string, params?: unknown): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
