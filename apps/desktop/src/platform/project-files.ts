/**
 * Abrir y guardar proyectos desde la interfaz.
 *
 * Es la capa que traduce «el usuario pulsó Guardar» a la secuencia de la capa
 * de persistencia, y lo hace en un módulo aparte por una razón concreta: la
 * aplicación tiene que seguir funcionando en el navegador, donde no hay
 * sistema de archivos. Toda la detección del contenedor está aquí, de modo que
 * los componentes no se llenan de condicionales y el mensaje que ve el usuario
 * cuando no se puede guardar es uno y el mismo.
 */
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  err,
  ok,
  domainError,
  type Media,
  type Project,
  type Result,
} from '@it360/domain';
import { Workspace, type RecoveryCandidate } from '@it360/persistence';
import { APP_VERSION } from '../version';
import { isTauri, TauriStorage } from './tauri-storage';

const PROJECT_FILTER = { name: 'Proyecto INDUSTRIAL TWINS 360', extensions: ['ivp'] };

/**
 * Crea el espacio de trabajo contra el disco real.
 *
 * `null` cuando no hay contenedor. Devolver `null` en lugar de lanzar permite
 * que quien llama decida el mensaje: en la barra de comandos conviene explicar
 * que el guardado vive en la aplicación de escritorio, y en una prueba
 * automática conviene simplemente no intentarlo.
 */
export function createWorkspace(): Workspace | null {
  if (!isTauri()) return null;
  return new Workspace({
    storage: new TauriStorage(),
    appVersion: APP_VERSION,
    now: () => new Date(),
    // El WASM de SQLite se sirve desde los recursos de la aplicación, no desde
    // la red: un contenedor sin acceso a Internet —el caso normal en una red
    // de planta— tiene que poder abrir proyectos.
    locateSqlWasm: (file) => `/wasm/${file}`,
  });
}

const NO_CONTAINER = (): Result<never> =>
  err(
    // `STORAGE_FAILED` y no un código nuevo: el catálogo de códigos es
    // estable y una lista que crece con cada caso particular deja de ser útil
    // para decidir qué hacer. Aquí el almacenamiento, literalmente, no existe.
    domainError('STORAGE_FAILED', 'Esta operación necesita la aplicación de escritorio', {
      recovery:
        'La versión web trabaja en memoria y no puede leer ni escribir archivos. Instale la aplicación de Windows para guardar y abrir proyectos.',
    }),
  );

export interface OpenedProject {
  readonly project: Project;
  readonly path: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly warnings: readonly string[];
}

/** Pide un archivo al usuario y lo abre. `null` si cancela. */
export async function pickAndOpenProject(): Promise<Result<OpenedProject | null>> {
  const workspace = createWorkspace();
  if (workspace === null) return NO_CONTAINER();

  const selected = await openDialog({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
  if (selected === null || Array.isArray(selected)) return ok(null);

  const result = await workspace.openProject(selected);
  if (!result.ok) return err(result.error);

  return ok({
    project: result.value.project,
    path: selected,
    files: result.value.files,
    // Las advertencias de carga se propagan en lugar de descartarse: una fila
    // que no validó significa que algo del proyecto no se cargó, y el usuario
    // debe saberlo antes de guardar encima del archivo.
    warnings: [
      ...result.value.warnings,
      ...result.value.loadWarnings.map((w) => `${w.table} ${w.id}: ${w.message}`),
    ],
  });
}

export interface SaveOutcome {
  readonly path: string;
  readonly byteSize: number;
  readonly backupsKept: number;
}

/**
 * Guarda en la ruta conocida, o pregunta si todavía no hay ninguna.
 *
 * `force` salta el bloqueo por problemas de integridad. Se expone porque el
 * caso de uso existe —el usuario necesita conservar su trabajo aunque el
 * proyecto tenga referencias rotas— pero no es el camino por defecto: quien
 * llama tiene que pedirlo explícitamente después de avisar.
 */
export async function saveProject(
  project: Project,
  files: ReadonlyMap<string, Uint8Array>,
  currentPath: string | null,
  options: { readonly force?: boolean } = {},
): Promise<Result<SaveOutcome | null>> {
  const workspace = createWorkspace();
  if (workspace === null) return NO_CONTAINER();

  let path = currentPath;
  if (path === null) {
    const chosen = await saveDialog({
      filters: [PROJECT_FILTER],
      defaultPath: `${project.title.replace(/[\\/:*?"<>|]/g, '-')}.ivp`,
    });
    if (chosen === null) return ok(null);
    path = chosen;
  }

  const result = await workspace.saveProject(path, project, files, {
    ...(options.force === true ? { force: true } : {}),
    backupCount: project.settings.backupCount,
  });
  if (!result.ok) return err(result.error);

  return ok({
    path,
    byteSize: result.value.byteSize,
    backupsKept: result.value.backupsKept,
  });
}

/** Guarda una copia independiente, con identificador nuevo. */
export async function saveProjectAs(
  project: Project,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Result<(SaveOutcome & { project: Project }) | null>> {
  const workspace = createWorkspace();
  if (workspace === null) return NO_CONTAINER();

  const chosen = await saveDialog({
    filters: [PROJECT_FILTER],
    defaultPath: `${project.title.replace(/[\\/:*?"<>|]/g, '-')} copia.ivp`,
  });
  if (chosen === null) return ok(null);

  const result = await workspace.saveProjectAs(chosen, project, files);
  if (!result.ok) return err(result.error);

  return ok({
    path: chosen,
    byteSize: result.value.byteSize,
    backupsKept: result.value.backupsKept,
    project: result.value.project,
  });
}

/**
 * Busca trabajo recuperable junto a un proyecto.
 *
 * Se consulta al abrir, no al cerrar: si la aplicación terminó de golpe, no
 * hubo ocasión de preguntar nada, y el temporal completo que dejó el guardado
 * interrumpido sigue en la carpeta. Ofrecerlo al reabrir es la única
 * oportunidad real de no perder ese trabajo.
 */
export async function findRecovery(path: string): Promise<readonly RecoveryCandidate[]> {
  const workspace = createWorkspace();
  if (workspace === null) return [];
  return workspace.findRecoveryCandidates(path);
}

/* ------------------------------------------------------------------ *
 * Contenido binario del paquete
 * ------------------------------------------------------------------ */

/** Bytes de una URL de datos en base64. */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Construye el paquete del proyecto en memoria, sin escribirlo.
 *
 * Lo usa el respaldo, que necesita los mismos bytes que se guardarían pero
 * entregados al usuario en lugar de escritos en el disco. Pasa por el mismo
 * camino que guardar: un respaldo construido por otra vía sería una vía que no
 * se ejercita, y fallaría el día que hiciera falta.
 */
export async function buildPackageBytes(
  project: Project,
  mediaUrls: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<Result<Uint8Array>> {
  const workspace = createWorkspace();
  if (workspace === null) return NO_CONTAINER();

  const { files } = collectPackage(project, mediaUrls, existing);
  return workspace.buildPackage(project, files);
}

export interface CollectedFiles {
  readonly files: ReadonlyMap<string, Uint8Array>;
  /**
   * Medios declarados por el proyecto cuyos bytes no se pudieron reunir.
   *
   * Es la parte que importa: un paquete al que le falta una panorámica se abre
   * igual y el fallo lo descubre quien lo recibe, no quien lo exportó.
   */
  readonly missing: readonly Media[];
}

/**
 * Reúne el contenido binario que debe ir al paquete.
 *
 * Las claves son las rutas relativas que declara cada medio, que es lo que el
 * formato `.ivp` espera. Los medios cuya URL no es una URL de datos —los que
 * vienen de un paquete ya abierto— se toman de `existing`: sus bytes ya están
 * en memoria y no hay que reconstruirlos.
 *
 * Lo que no se puede reunir se devuelve en `missing` en lugar de omitirse en
 * silencio. Antes se saltaba sin más, de modo que un proyecto se podía
 * exportar sin una de sus panorámicas y nadie se enteraba hasta que el
 * destinatario abría una escena vacía.
 */
export function collectPackage(
  project: Project,
  mediaUrls: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, Uint8Array> = new Map(),
): CollectedFiles {
  const files = new Map<string, Uint8Array>(existing);
  const missing: Media[] = [];

  for (const media of project.media) {
    if (files.has(media.relativePath)) continue;

    const url = mediaUrls.get(media.id);
    const bytes = url === undefined ? null : dataUrlToBytes(url);

    if (bytes === null) missing.push(media);
    else files.set(media.relativePath, bytes);
  }

  return { files, missing };
}

/** Sólo los archivos, para quien ya ha comprobado los ausentes. */
export const collectPackageFiles = (
  project: Project,
  mediaUrls: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, Uint8Array> = new Map(),
): ReadonlyMap<string, Uint8Array> => collectPackage(project, mediaUrls, existing).files;
