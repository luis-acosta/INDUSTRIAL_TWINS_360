/**
 * Almacenamiento de bytes, abstraído.
 *
 * Todo lo que escribe a disco en este producto pasa por `Storage`. Hay tres
 * implementaciones —memoria para pruebas, Node para la herramienta de línea
 * de comandos y el servidor, y Tauri para la aplicación de escritorio— y la
 * lógica de guardado, respaldo y recuperación es la misma en las tres. Eso
 * permite probar el guardado atómico y la recuperación tras cierre abrupto
 * con pruebas unitarias, en vez de intentar provocar un corte de luz.
 */
import { domainError, err, ok, type Result } from '@it360/domain';

export interface FileStat {
  readonly path: string;
  readonly byteSize: number;
  /** Última modificación en ms desde época. */
  readonly modifiedAtMs: number;
  readonly isDirectory: boolean;
}

/**
 * Contrato de almacenamiento.
 *
 * Nótese que `rename` es parte del contrato y no un detalle: el guardado
 * atómico depende de que renombrar sobre un archivo existente sea una
 * operación indivisible en el sistema de archivos subyacente. Una
 * implementación que no pueda ofrecerlo debe decirlo, no simularlo con
 * copiar y borrar, porque un fallo a mitad de esa simulación deja al usuario
 * sin proyecto.
 */
export interface Storage {
  readonly kind: 'memory' | 'node' | 'tauri';
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Vuelca a disco los datos pendientes del archivo. */
  sync?(path: string): Promise<void>;
  /** Renombra de forma atómica, sobreescribiendo el destino si existe. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readDir(path: string): Promise<readonly FileStat[]>;
  /** Une segmentos con el separador del sistema destino. */
  join(...segments: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
}

/* ------------------------------------------------------------------ *
 * Guardado atómico
 * ------------------------------------------------------------------ */

export interface AtomicWriteOptions {
  /** Número de respaldos a conservar. 0 desactiva el respaldo. */
  readonly backupCount?: number;
  /** Sufijo de los respaldos. `proyecto.ivp.bak1`, `.bak2`, … */
  readonly backupSuffix?: string;
}

/**
 * Escribe un archivo de forma atómica, conservando respaldos.
 *
 * Secuencia: escribir en temporal → volcar a disco → rotar respaldos →
 * renombrar el temporal sobre el destino.
 *
 * El orden importa. Si se escribiera directamente sobre el destino, un corte
 * a mitad dejaría un archivo truncado: ni el proyecto viejo ni el nuevo. Con
 * esta secuencia, en todo momento existe al menos una copia completa, y el
 * renombrado final es indivisible, de modo que el destino nunca se observa a
 * medio escribir.
 *
 * La rotación va ANTES del renombrado y no después porque, si el proceso
 * muere entre rotar y renombrar, el usuario conserva el original intacto en
 * `.bak1` y el nuevo en el temporal. Al revés —renombrar primero— habría un
 * instante sin ningún respaldo del estado anterior.
 */
export async function writeAtomic(
  storage: Storage,
  path: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<Result<{ backupsKept: number }>> {
  const backupCount = options.backupCount ?? 3;
  const suffix = options.backupSuffix ?? '.bak';
  const temp = `${path}.tmp-${Date.now().toString(36)}`;

  /**
   * Si el temporal llegó a escribirse completo, contiene datos válidos y no
   * debe borrarse aunque el guardado falle después: es el estado más reciente
   * del trabajo del usuario y la recuperación lo ofrecerá al reabrir. Sólo se
   * limpia el temporal cuando el fallo ocurrió *durante* su escritura, porque
   * entonces es un archivo truncado que no sirve para nada.
   */
  let tempIsComplete = false;

  try {
    await storage.mkdirp(storage.dirname(path));
    await storage.writeFile(temp, data);
    if (storage.sync !== undefined) await storage.sync(temp);
    tempIsComplete = true;

    if (backupCount > 0 && (await storage.exists(path))) {
      // Rotar de atrás hacia delante: bak2 -> bak3, bak1 -> bak2.
      for (let i = backupCount - 1; i >= 1; i -= 1) {
        const from = `${path}${suffix}${i}`;
        const to = `${path}${suffix}${i + 1}`;
        if (await storage.exists(from)) {
          if (i + 1 > backupCount) {
            await storage.remove(from);
          } else {
            await storage.rename(from, to);
          }
        }
      }
      await storage.rename(path, `${path}${suffix}1`);
    }

    await storage.rename(temp, path);

    let kept = 0;
    for (let i = 1; i <= backupCount; i += 1) {
      if (await storage.exists(`${path}${suffix}${i}`)) kept += 1;
    }
    return ok({ backupsKept: kept });
  } catch (cause) {
    if (!tempIsComplete) {
      try {
        if (await storage.exists(temp)) await storage.remove(temp);
      } catch {
        // Si tampoco se puede limpiar, el error original es el que importa.
      }
    }
    return err(
      domainError('STORAGE_FAILED', 'No se pudo guardar el archivo', {
        detail: {
          file: storage.basename(path),
          cause: String(cause),
          recoverableTemp: tempIsComplete ? storage.basename(temp) : null,
        },
        recovery: tempIsComplete
          ? 'Los cambios quedaron escritos en un archivo temporal junto al proyecto y se ofrecerán al volver a abrirlo. Compruebe que hay espacio en disco y que ningún otro programa tiene el archivo abierto.'
          : 'Compruebe que hay espacio en disco y que ningún otro programa tiene el archivo abierto. Los respaldos anteriores siguen disponibles.',
      }),
    );
  }
}

/**
 * Localiza los respaldos de un archivo, del más reciente al más antiguo.
 *
 * La recuperación tras un cierre abrupto los recorre en ese orden y se queda
 * con el primero que abra correctamente; por eso devuelve la lista y no sólo
 * el primero.
 */
export async function findBackups(
  storage: Storage,
  path: string,
  options: { backupCount?: number; backupSuffix?: string } = {},
): Promise<readonly FileStat[]> {
  const backupCount = options.backupCount ?? 3;
  const suffix = options.backupSuffix ?? '.bak';
  const found: FileStat[] = [];
  for (let i = 1; i <= backupCount; i += 1) {
    const stat = await storage.stat(`${path}${suffix}${i}`);
    if (stat !== null) found.push(stat);
  }
  return found;
}

/**
 * Localiza temporales abandonados de un guardado interrumpido.
 *
 * Su existencia es la señal de que la aplicación murió mientras guardaba. El
 * editor la usa al abrir para ofrecer la recuperación, en vez de descartarlos
 * en silencio: ese temporal puede contener el único trabajo de la última hora.
 */
export async function findInterruptedWrites(
  storage: Storage,
  path: string,
): Promise<readonly FileStat[]> {
  const dir = storage.dirname(path);
  const base = storage.basename(path);
  try {
    const entries = await storage.readDir(dir);
    return entries
      .filter((e) => !e.isDirectory && storage.basename(e.path).startsWith(`${base}.tmp-`))
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Almacenamiento en memoria
 * ------------------------------------------------------------------ */

/**
 * Implementación en memoria.
 *
 * Además de servir a las pruebas, permite inyectar fallos: `failOn` provoca
 * un error en la operación indicada, que es la única forma práctica de
 * comprobar que el guardado atómico no pierde datos cuando el disco falla a
 * mitad de la secuencia.
 */
export class MemoryStorage implements Storage {
  readonly kind = 'memory' as const;

  private readonly files = new Map<string, { data: Uint8Array; modifiedAtMs: number }>();
  private readonly dirs = new Set<string>(['/']);
  private clock = 1_700_000_000_000;

  /** Operación que debe fallar la próxima vez: para probar la recuperación. */
  failOn: { op: 'writeFile' | 'rename' | 'remove'; path?: string } | null = null;

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private checkFailure(op: 'writeFile' | 'rename' | 'remove', path: string): void {
    const trigger = this.failOn;
    if (trigger === null || trigger.op !== op) return;
    if (trigger.path !== undefined && !path.includes(trigger.path)) return;
    this.failOn = null;
    throw new Error(`Fallo simulado en ${op} sobre ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(path);
    if (file !== undefined) {
      return { path, byteSize: file.data.length, modifiedAtMs: file.modifiedAtMs, isDirectory: false };
    }
    if (this.dirs.has(path)) {
      return { path, byteSize: 0, modifiedAtMs: 0, isDirectory: true };
    }
    return null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`No existe el archivo ${path}`);
    return file.data.slice();
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.checkFailure('writeFile', path);
    await this.mkdirp(this.dirname(path));
    this.files.set(path, { data: data.slice(), modifiedAtMs: this.tick() });
  }

  async rename(from: string, to: string): Promise<void> {
    this.checkFailure('rename', from);
    const file = this.files.get(from);
    if (file === undefined) throw new Error(`No existe el archivo ${from}`);
    this.files.delete(from);
    this.files.set(to, { ...file, modifiedAtMs: this.tick() });
  }

  async remove(path: string): Promise<void> {
    this.checkFailure('remove', path);
    this.files.delete(path);
    this.dirs.delete(path);
  }

  async mkdirp(path: string): Promise<void> {
    const parts = path.split('/').filter((p) => p.length > 0);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      this.dirs.add(current);
    }
    this.dirs.add('/');
  }

  async readDir(path: string): Promise<readonly FileStat[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: FileStat[] = [];
    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      if (filePath.slice(prefix.length).includes('/')) continue;
      out.push({
        path: filePath,
        byteSize: file.data.length,
        modifiedAtMs: file.modifiedAtMs,
        isDirectory: false,
      });
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      if (dir.slice(prefix.length).includes('/') || dir === path) continue;
      out.push({ path: dir, byteSize: 0, modifiedAtMs: 0, isDirectory: true });
    }
    return out;
  }

  join(...segments: string[]): string {
    return segments
      .filter((s) => s.length > 0)
      .join('/')
      .replace(/\/{2,}/g, '/');
  }

  dirname(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  /** Inspección para pruebas. */
  listAll(): readonly string[] {
    return [...this.files.keys()].sort();
  }
}
