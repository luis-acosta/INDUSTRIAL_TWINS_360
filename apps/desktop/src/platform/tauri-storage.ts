/**
 * Almacenamiento sobre el contenedor Tauri.
 *
 * Implementa la misma interfaz `Storage` que usa la capa de persistencia en
 * las pruebas con memoria. Ese es el motivo de que exista: el guardado
 * atómico, la rotación de respaldos y la recuperación de temporales se
 * escribieron y se probaron una sola vez contra la interfaz, y aquí sólo se
 * conectan al sistema de archivos real. Si esta clase tuviera lógica propia de
 * rotación o de recuperación, esa lógica no estaría cubierta por ninguna
 * prueba, porque las pruebas no pueden ejecutar el contenedor.
 *
 * La escritura pasa por el complemento `fs` de Tauri, cuyo alcance está
 * limitado en `capabilities/default.json` a las carpetas de documentos y datos
 * de la aplicación: la interfaz no puede escribir en cualquier punto del
 * sistema ni siquiera por error de programación.
 */
import {
  exists as fsExists,
  mkdir,
  readDir as fsReadDir,
  readFile as fsReadFile,
  remove as fsRemove,
  rename as fsRename,
  stat as fsStat,
  writeFile as fsWriteFile,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { FileStat, Storage } from '@it360/persistence';

/** Separador del sistema. Windows acepta `/`, pero las rutas se muestran. */
const SEPARATOR = '\\';

export class TauriStorage implements Storage {
  readonly kind = 'tauri' as const;

  async exists(path: string): Promise<boolean> {
    return fsExists(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await fsStat(path);
      return {
        path,
        byteSize: info.size,
        isDirectory: info.isDirectory,
        modifiedAtMs: info.mtime?.getTime() ?? 0,
      };
    } catch {
      // `stat` falla tanto si no existe como si falta permiso. Devolver `null`
      // en ambos casos es correcto para el llamante: en los dos no hay nada
      // que leer, y la diferencia la dará el intento de lectura con su error.
      return null;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return fsReadFile(path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await fsWriteFile(path, data);
  }

  /**
   * Fuerza el volcado a disco.
   *
   * El complemento `fs` no expone `fsync`, así que lo hace un comando propio
   * de Rust. No es un detalle teórico: sin volcar, el renombrado posterior
   * puede completarse mientras el contenido sigue en la caché del sistema, y
   * un corte de corriente en ese instante deja un archivo con el nombre
   * definitivo y el contenido a medias. Es exactamente el fallo que el
   * guardado atómico pretende evitar.
   */
  async sync(path: string): Promise<void> {
    await invoke('fsync_path', { path });
  }

  async rename(from: string, to: string): Promise<void> {
    await fsRename(from, to);
  }

  async remove(path: string): Promise<void> {
    await fsRemove(path);
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readDir(path: string): Promise<readonly FileStat[]> {
    const entries = await fsReadDir(path);
    const stats: FileStat[] = [];
    for (const entry of entries) {
      const full = this.join(path, entry.name);
      const info = await this.stat(full);
      if (info !== null) stats.push(info);
      else {
        // La entrada existe en el directorio pero no se pudo consultar. Se
        // conserva en el listado con tamaño cero en lugar de omitirla: la
        // recuperación de temporales necesita saber que el archivo está ahí,
        // y omitirlo haría creer que no hay nada que recuperar.
        stats.push({ path: full, byteSize: 0, isDirectory: entry.isDirectory, modifiedAtMs: 0 });
      }
    }
    return stats;
  }

  join(...segments: string[]): string {
    return segments
      .filter((segment) => segment.length > 0)
      .map((segment, index) =>
        index === 0 ? segment.replace(/[\\/]+$/, '') : segment.replace(/^[\\/]+|[\\/]+$/g, ''),
      )
      .join(SEPARATOR);
  }

  dirname(path: string): string {
    const normalized = path.replace(/[\\/]+$/, '');
    const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return index <= 0 ? normalized.slice(0, index + 1) : normalized.slice(0, index);
  }

  basename(path: string): string {
    const normalized = path.replace(/[\\/]+$/, '');
    const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return index === -1 ? normalized : normalized.slice(index + 1);
  }
}

/* ------------------------------------------------------------------ *
 * Almacén de secretos
 * ------------------------------------------------------------------ */

/**
 * Credenciales guardadas en el almacén del sistema operativo.
 *
 * La interfaz nunca recibe el valor del secreto: estas funciones guardan y
 * borran por clave, y quien lo lee es el servicio de telemetría dentro del
 * proceso Rust. Es la razón de que no exista un `getSecret` aquí. Si lo
 * hubiera, el token acabaría en la memoria de la vista web, de donde puede
 * salir en un registro, en un volcado de errores o en un proyecto exportado.
 */
export const secretStore = {
  /** Guarda o reemplaza el secreto asociado a una clave. */
  async set(keyId: string, value: string): Promise<void> {
    await invoke('secret_set', { keyId, value });
  },

  /** Indica si hay un secreto guardado, sin devolverlo. */
  async has(keyId: string): Promise<boolean> {
    return invoke<boolean>('secret_exists', { keyId });
  },

  async remove(keyId: string): Promise<void> {
    await invoke('secret_delete', { keyId });
  },
};

/** Indica si la aplicación corre dentro del contenedor Tauri. */
export function isTauri(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    '__TAURI_INTERNALS__' in (globalThis as Record<string, unknown>)
  );
}
