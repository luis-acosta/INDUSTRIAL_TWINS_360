/**
 * Generación de paquetes publicados desde la aplicación de escritorio.
 *
 * Une tres piezas que viven separadas a propósito: el exportador (que decide
 * qué se publica y compone los archivos), el tiempo de ejecución del visor
 * (que se compila aparte y se distribuye como recurso de la aplicación) y el
 * almacenamiento (que escribe en disco). Aquí sólo está el pegamento.
 *
 * El visor se lee de los recursos de la aplicación y no se descarga: una red
 * de planta sin salida a Internet es el caso normal, y un publicador que
 * necesita conexión para generar un paquete local no sirve.
 */
import { BaseDirectory, readDir, readFile } from '@tauri-apps/plugin-fs';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { domainError, err, ok, type Project, type Result } from '@it360/domain';
import {
  exportOfflinePackage,
  exportScormPackage,
  exportWebSite,
  publicationReport,
  type PackageResult,
  type ViewerRuntime,
} from '@it360/exporter';
import { APP_VERSION } from '../version';
import { isTauri, TauriStorage } from './tauri-storage';
import { prepareMediaForPublish, publishSummary } from './image-publish';

/** Carpeta de recursos donde se empaqueta el visor compilado. */
const RUNTIME_DIR = 'viewer';

export type PublishTarget = 'web' | 'offline' | 'scorm';

export interface PublishRequest {
  readonly target: PublishTarget;
  readonly project: Project;
  /** Contenido de los medios del proyecto, por ruta relativa. */
  readonly mediaFiles: ReadonlyMap<string, Uint8Array>;
  readonly includeDocuments?: boolean;
  readonly includeUnreviewed?: boolean;
  readonly telemetryEndpoint?: string;
  /** Identificador del curso, obligatorio para SCORM. */
  readonly courseId?: string;
}

export interface PublishOutcome {
  readonly folder: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly warnings: readonly string[];
  /** Qué pasó con las imágenes: pesos antes y después. */
  readonly imageSummary?: string;
  readonly reportPath: string;
}

/**
 * Lee el visor compilado de los recursos de la aplicación.
 *
 * Si falta, se devuelve un error en lugar de generar un paquete sin visor: un
 * sitio con manifiesto e imágenes pero sin JavaScript abre una página en
 * blanco, y el cliente lo descubriría después de subirlo a su servidor.
 */
async function loadViewerRuntime(): Promise<Result<ViewerRuntime>> {
  try {
    const entries = await readDir(RUNTIME_DIR, { baseDir: BaseDirectory.Resource });
    const runtime = new Map<string, Uint8Array>();

    for (const entry of entries) {
      if (!entry.isFile) continue;
      const bytes = await readFile(`${RUNTIME_DIR}/${entry.name}`, {
        baseDir: BaseDirectory.Resource,
      });
      runtime.set(`${RUNTIME_DIR}/${entry.name}`, bytes);
    }

    if (![...runtime.keys()].some((path) => path.endsWith('.js'))) {
      return err(
        domainError('NOT_FOUND', 'La instalación no incluye el visor compilado', {
          detail: { carpeta: RUNTIME_DIR, archivos: [...runtime.keys()] },
          recovery:
            'Reinstale la aplicación. Sin el visor, el paquete publicado abriría una página en blanco.',
        }),
      );
    }

    return ok(runtime);
  } catch (cause) {
    return err(
      domainError('IO_FAILED', 'No se pudo leer el visor de los recursos de la aplicación', {
        detail: { cause: String(cause) },
        recovery: 'Reinstale la aplicación.',
      }),
    );
  }
}

/**
 * Genera el paquete y lo escribe en la carpeta que elija el usuario.
 *
 * Devuelve `null` si el usuario cancela el diálogo, que no es un error y no
 * debe mostrarse como tal.
 */
export async function publishProject(
  request: PublishRequest,
): Promise<Result<PublishOutcome | null>> {
  if (!isTauri()) {
    return err(
      domainError('STORAGE_FAILED', 'La generación del paquete necesita la aplicación de escritorio', {
        recovery:
          'La versión web ejecuta las comprobaciones previas pero no puede escribir archivos. Instale la aplicación de Windows para generar el paquete.',
      }),
    );
  }

  const runtime = await loadViewerRuntime();
  if (!runtime.ok) return err(runtime.error);

  const folder = await openDialog({ directory: true, multiple: false, title: 'Carpeta de destino' });
  if (folder === null || Array.isArray(folder)) return ok(null);

  /* Las imágenes se recodifican antes de armar el paquete, según los ajustes
     del proyecto (V01, V02). Hasta ahora los ajustes no hacían nada: el
     paquete llevaba los originales. */
  const prepared = await prepareMediaForPublish(request.project, request.mediaFiles);

  const common = {
    publishedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    runtime: runtime.value,
    mediaFiles: prepared.files,
    ...(request.includeDocuments === true ? { includeDocuments: true } : {}),
    ...(request.includeUnreviewed === true ? { includeUnreviewed: true } : {}),
    ...(request.telemetryEndpoint !== undefined
      ? { telemetryEndpoint: request.telemetryEndpoint }
      : {}),
  };

  let result: PackageResult;
  try {
    if (request.target === 'web') {
      result = await exportWebSite(prepared.project, common);
    } else if (request.target === 'offline') {
      result = await exportOfflinePackage(prepared.project, common);
    } else {
      if (request.courseId === undefined || request.courseId.trim().length === 0) {
        return err(
          domainError('VALIDATION_FAILED', 'Falta el identificador del curso para el paquete SCORM', {
            recovery: 'Indique el identificador con el que el LMS registrará el curso.',
          }),
        );
      }
      result = await exportScormPackage(prepared.project, {
        ...common,
        courseId: request.courseId,
        courseTitle: request.project.title,
      });
    }
  } catch (cause) {
    // El exportador lanza cuando el manifiesto llevaría credenciales: ese
    // fallo no se degrada a aviso, porque el daño consiste precisamente en
    // publicar algo que no debía salir del equipo.
    return err(
      domainError('VALIDATION_FAILED', 'La generación del paquete se detuvo', {
        detail: { cause: String(cause) },
        recovery: 'Revise la comprobación previa: el proyecto contiene algo que no se puede publicar.',
      }),
    );
  }

  /* --- Escritura --- */

  const storage = new TauriStorage();
  const encoder = new TextEncoder();
  const written: string[] = [];

  try {
    if (result.archive !== null) {
      // Destinos de archivo único: un solo archivo junto al informe.
      const name = request.target === 'scorm' ? 'curso-scorm.zip' : 'recorrido-offline.zip';
      const path = storage.join(folder, name);
      await storage.writeFile(path, result.archive);
      await storage.sync?.(path);
      written.push(path);
    } else {
      for (const file of result.files) {
        const path = storage.join(folder, ...file.path.split('/'));
        await storage.mkdirp(storage.dirname(path));
        await storage.writeFile(path, file.bytes);
        written.push(path);
      }
    }

    const reportPath = storage.join(folder, 'INFORME-PUBLICACION.txt');
    await storage.writeFile(
      reportPath,
      encoder.encode(publicationReport(result, request.project)),
    );
    await storage.sync?.(reportPath);

    return ok({
      folder,
      fileCount: written.length,
      totalBytes: result.totalBytes,
      // Lo que pasó con las imágenes va con las advertencias del exportador:
      // es información que el autor necesita antes de entregar el paquete, no
      // un detalle de registro.
      warnings: [...result.warnings, ...prepared.notes],
      imageSummary: publishSummary(prepared),
      reportPath,
    });
  } catch (cause) {
    return err(
      domainError('IO_FAILED', 'No se pudo escribir el paquete en la carpeta elegida', {
        detail: { cause: String(cause), escritos: written.length },
        recovery:
          'Compruebe que tiene permiso de escritura en la carpeta y espacio libre suficiente. Los archivos ya escritos se conservan.',
      }),
    );
  }
}
