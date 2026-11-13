/**
 * Formato de proyecto `.ivp`.
 *
 * El contrato de datos lo define así: ZIP versionado con `manifest.json`,
 * `data/project.sqlite`, `media/`, `documents/` y `checksums.sha256`, rutas
 * relativas, nombres saneados, hashes verificados y sin credenciales.
 *
 * Que el proyecto sea un ZIP y no una carpeta tiene una razón concreta: un
 * recorrido industrial es un documento que se envía por correo, se guarda en
 * un servidor de archivos y se adjunta a un informe. Una carpeta con 400
 * archivos se pierde a trozos; un archivo único llega completo o no llega.
 *
 * Que dentro lleve SQLite y no JSON tiene otra: el proyecto se consulta
 * (buscar por TAG, filtrar notas, listar documentos de un activo) y un JSON
 * de 40 MB habría que cargarlo entero en memoria para responder a cualquier
 * pregunta.
 */
import {
  assertSafeRelativePath,
  CURRENT_SCHEMA_VERSION,
  domainError,
  err,
  isErr,
  manifestSchema,
  ok,
  PROJECT_FORMAT,
  sanitizeFileName,
  type Manifest,
  type Result,
} from '@it360/domain';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { formatChecksums, parseChecksums, sha256, verifyChecksums } from './hash';

export const IVP_EXTENSION = '.ivp';

/** Rutas con significado dentro del paquete. */
export const IVP_PATHS = {
  manifest: 'manifest.json',
  database: 'data/project.sqlite',
  checksums: 'checksums.sha256',
  mediaDir: 'media/',
  documentsDir: 'documents/',
} as const;

/**
 * Límites del paquete.
 *
 * Existen porque un ZIP es un formato que un atacante controla por completo:
 * puede declarar un archivo de 10 GB que se descomprime desde 1 MB (bomba de
 * descompresión). Sin un tope, abrir un proyecto recibido de un tercero puede
 * agotar la memoria del equipo.
 */
export const IVP_LIMITS = {
  /** Tamaño máximo del paquete comprimido. */
  maxPackageBytes: 8 * 1024 * 1024 * 1024,
  /** Tamaño máximo descomprimido de un solo archivo. */
  maxEntryBytes: 4 * 1024 * 1024 * 1024,
  /** Número máximo de entradas. */
  maxEntries: 50_000,
  /** Relación máxima entre tamaño descomprimido y comprimido. */
  maxCompressionRatio: 200,
} as const;

export interface IvpContents {
  readonly manifest: Manifest;
  /** Bytes de la base de datos del proyecto. */
  readonly database: Uint8Array;
  /** Archivos del paquete por ruta relativa, incluidos medios y documentos. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface IvpWriteOptions {
  /** Nivel de compresión 0-9. */
  readonly level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/* ------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------ */

/**
 * Empaqueta un proyecto en bytes `.ivp`.
 *
 * El nivel de compresión por defecto es 6 y no 9. Los medios de un recorrido
 * son JPEG, WebP y GLB, que ya están comprimidos: subir a 9 multiplica el
 * tiempo de guardado por tres y reduce el tamaño en menos del uno por ciento.
 * Lo que sí comprime bien —la base de datos y el manifiesto— es pequeño.
 */
export async function writeIvp(
  contents: {
    readonly manifest: Manifest;
    readonly database: Uint8Array;
    readonly files: ReadonlyMap<string, Uint8Array>;
  },
  options: IvpWriteOptions = {},
): Promise<Result<Uint8Array>> {
  const level = options.level ?? 6;

  const manifestParsed = manifestSchema.safeParse(contents.manifest);
  if (!manifestParsed.success) {
    return err(
      domainError('VALIDATION_FAILED', 'El manifiesto del proyecto no es válido', {
        detail: { issues: manifestParsed.error.issues.slice(0, 3) },
      }),
    );
  }

  const entries = new Map<string, Uint8Array>();

  for (const [path, data] of contents.files) {
    const safe = assertSafeRelativePath(path);
    if (isErr(safe)) return safe;
    entries.set(path, data);
  }

  const manifestBytes = new TextEncoder().encode(
    `${JSON.stringify(manifestParsed.data, null, 2)}\n`,
  );
  entries.set(IVP_PATHS.manifest, manifestBytes);
  entries.set(IVP_PATHS.database, contents.database);

  // Los checksums cubren todo lo demás; el propio archivo de checksums no
  // puede cubrirse a sí mismo, y su integridad la respalda el manifiesto.
  const checksums = new Map<string, string>();
  for (const [path, data] of entries) checksums.set(path, await sha256(data));
  entries.set(IVP_PATHS.checksums, new TextEncoder().encode(formatChecksums(checksums)));

  try {
    const zippable: Zippable = {};
    for (const [path, data] of entries) {
      // Los medios ya vienen comprimidos: recomprimirlos cuesta tiempo y no
      // gana espacio.
      const alreadyCompressed = /\.(jpe?g|png|webp|avif|mp4|webm|mp3|ogg|glb|zip|pdf)$/i.test(path);
      zippable[path] = [data, { level: alreadyCompressed ? 0 : level }];
    }
    return ok(zipSync(zippable));
  } catch (cause) {
    return err(
      domainError('IO_FAILED', 'No se pudo comprimir el paquete del proyecto', {
        detail: { cause: String(cause) },
      }),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

export interface IvpReadOptions {
  /** Verificar los hashes de todos los archivos al abrir. */
  readonly verifyIntegrity?: boolean;
  /** Abrir aun con hashes que no coinciden, para rescatar contenido. */
  readonly allowChecksumMismatch?: boolean;
}

export interface IvpReadResult extends IvpContents {
  readonly warnings: readonly string[];
}

/**
 * Lee un paquete `.ivp`.
 *
 * El orden de las comprobaciones es deliberado:
 *  1. tamaño del paquete, antes de descomprimir nada;
 *  2. número de entradas y seguridad de cada ruta, antes de materializarlas;
 *  3. tamaño de cada entrada y relación de compresión;
 *  4. integridad de los hashes;
 *  5. presencia del manifiesto y compatibilidad de versión.
 *
 * Cada paso protege al siguiente. Validar la versión antes de validar las
 * rutas implicaría haber extraído ya una ruta maliciosa, y verificar los
 * hashes DESPUÉS de interpretar el manifiesto significaría que un paquete
 * manipulado se rechazaría por «manifiesto inválido» en vez de por
 * «integridad comprometida», que es la información que el usuario necesita:
 * la primera suena a archivo viejo, la segunda a archivo alterado.
 */
export async function readIvp(
  bytes: Uint8Array,
  options: IvpReadOptions = {},
): Promise<Result<IvpReadResult>> {
  const warnings: string[] = [];

  if (bytes.length > IVP_LIMITS.maxPackageBytes) {
    return err(
      domainError('FILE_TOO_LARGE', 'El paquete del proyecto excede el tamaño admitido', {
        detail: { byteSize: bytes.length, limit: IVP_LIMITS.maxPackageBytes },
      }),
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (cause) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El archivo no es un paquete de proyecto válido', {
        detail: { cause: String(cause) },
        recovery:
          'Compruebe que el archivo tiene extensión .ivp y que la descarga o la copia se completó.',
      }),
    );
  }

  const paths = Object.keys(raw);
  if (paths.length > IVP_LIMITS.maxEntries) {
    return err(
      domainError('FILE_TOO_LARGE', 'El paquete contiene demasiados archivos', {
        detail: { entries: paths.length, limit: IVP_LIMITS.maxEntries },
      }),
    );
  }

  const files = new Map<string, Uint8Array>();
  let totalUncompressed = 0;

  for (const path of paths) {
    // Las entradas de directorio del ZIP no llevan contenido y no se extraen.
    if (path.endsWith('/')) continue;

    const safe = assertSafeRelativePath(path);
    if (isErr(safe)) return safe;

    const data = raw[path];
    if (data === undefined) continue;

    if (data.length > IVP_LIMITS.maxEntryBytes) {
      return err(
        domainError('FILE_TOO_LARGE', `El archivo «${path}» del paquete es demasiado grande`, {
          detail: { path, byteSize: data.length, limit: IVP_LIMITS.maxEntryBytes },
        }),
      );
    }

    totalUncompressed += data.length;
    files.set(path, data);
  }

  // Bomba de descompresión: un paquete pequeño que se expande sin medida.
  if (bytes.length > 0 && totalUncompressed / bytes.length > IVP_LIMITS.maxCompressionRatio) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El paquete presenta una relación de compresión anómala', {
        detail: {
          compressedBytes: bytes.length,
          uncompressedBytes: totalUncompressed,
          ratio: Math.round(totalUncompressed / bytes.length),
        },
        recovery:
          'El archivo podría estar manipulado. No se ha extraído nada. Solicítelo de nuevo a su origen.',
      }),
    );
  }

  if (options.verifyIntegrity !== false) {
    const checksumBytes = files.get(IVP_PATHS.checksums);
    if (checksumBytes === undefined) {
      warnings.push(
        'El paquete no incluye archivo de verificación; no se ha podido comprobar su integridad.',
      );
    } else {
      const registered = parseChecksums(new TextDecoder().decode(checksumBytes));
      const verification = await verifyChecksums(registered, files);

      if (verification.unexpected.length > 0) {
        warnings.push(
          `El paquete contiene ${verification.unexpected.length} archivo(s) que no figuran en su verificación.`,
        );
      }

      if (!verification.ok) {
        if (options.allowChecksumMismatch !== true) {
          return err(
            domainError('CHECKSUM_MISMATCH', 'La verificación de integridad del paquete ha fallado', {
              detail: {
                mismatched: verification.mismatched.slice(0, 10),
                missing: verification.missing.slice(0, 10),
              },
              recovery:
                'El paquete está dañado o se ha alterado. Solicite una copia nueva a su origen, o ábralo en modo de rescate para recuperar lo que sea legible.',
            }),
          );
        }
        warnings.push(
          `Integridad no verificada: ${verification.mismatched.length} archivo(s) alterado(s) y ${verification.missing.length} ausente(s). El proyecto se abre en modo de rescate.`,
        );
      }
    }
  }

  const manifestBytes = files.get(IVP_PATHS.manifest);
  if (manifestBytes === undefined) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El paquete no contiene el manifiesto del proyecto', {
        recovery: 'El archivo no es un proyecto de INDUSTRIAL TWINS 360.',
      }),
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (cause) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El manifiesto del proyecto no se puede leer', {
        detail: { cause: String(cause) },
      }),
    );
  }

  const format = (manifestJson as { format?: unknown }).format;
  if (format !== PROJECT_FORMAT) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El paquete no es un proyecto de esta aplicación', {
        detail: { format: String(format) },
      }),
    );
  }

  const schemaVersion = (manifestJson as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion === 'number' && schemaVersion > CURRENT_SCHEMA_VERSION) {
    return err(
      domainError(
        'SCHEMA_TOO_NEW',
        `El proyecto fue creado con una versión más reciente (formato ${schemaVersion}; esta versión admite hasta ${CURRENT_SCHEMA_VERSION})`,
        {
          detail: { schemaVersion, supported: CURRENT_SCHEMA_VERSION },
          recovery: 'Actualice INDUSTRIAL TWINS 360 para abrir este proyecto.',
        },
      ),
    );
  }

  const manifestParsed = manifestSchema.safeParse(manifestJson);
  if (!manifestParsed.success) {
    return err(
      domainError('VALIDATION_FAILED', 'El manifiesto del proyecto no cumple el contrato de datos', {
        detail: { issues: manifestParsed.error.issues.slice(0, 3) },
        recovery: 'Pruebe a abrir una copia de respaldo del proyecto.',
      }),
    );
  }

  const database = files.get(IVP_PATHS.database);
  if (database === undefined) {
    return err(
      domainError('UNSUPPORTED_FORMAT', 'El paquete no contiene la base de datos del proyecto', {
        detail: { expected: IVP_PATHS.database },
      }),
    );
  }

  return ok({
    manifest: manifestParsed.data,
    database,
    files,
    warnings,
  });
}

/* ------------------------------------------------------------------ *
 * Rutas de medios
 * ------------------------------------------------------------------ */

/**
 * Ruta de un medio dentro del paquete.
 *
 * Se incluyen los primeros doce caracteres del SHA-256 en el nombre por dos
 * motivos: dos archivos con el mismo nombre original no se pisan, y el nombre
 * del archivo revela su identidad de contenido, lo que permite verificar un
 * medio concreto sin abrir el ZIP entero.
 */
export function mediaPath(sha256Hex: string, originalName: string, extension: string): string {
  const stem = sanitizeFileName(originalName.replace(/\.[^.]*$/, ''), 'medio')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80);
  return `${IVP_PATHS.mediaDir}${stem}-${sha256Hex.slice(0, 12)}${extension}`;
}

export function documentPath(sha256Hex: string, originalName: string, extension: string): string {
  const stem = sanitizeFileName(originalName.replace(/\.[^.]*$/, ''), 'documento')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80);
  return `${IVP_PATHS.documentsDir}${stem}-${sha256Hex.slice(0, 12)}${extension}`;
}

/** `true` si la ruta corresponde a un archivo de contenido y no de estructura. */
export function isContentPath(path: string): boolean {
  return (
    path !== IVP_PATHS.manifest &&
    path !== IVP_PATHS.database &&
    path !== IVP_PATHS.checksums
  );
}
