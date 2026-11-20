/**
 * Resultado explícito en lugar de excepciones.
 *
 * Los casos de uso del dominio devuelven `Result` porque un fallo esperable
 * —un CSV con TAG duplicado, un panorama con relación de aspecto incorrecta,
 * un token de InfluxDB rechazado— no es una condición excepcional: es una
 * salida que la interfaz tiene que mostrar. Reservar las excepciones para los
 * defectos de programación hace que un `catch` en la capa de UI signifique
 * siempre «esto es un error nuestro» y no «esto le pasa al usuario».
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Transforma el valor de un resultado correcto. */
export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Encadena operaciones que pueden fallar, cortando en el primer error. */
export function flatMapResult<T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/**
 * Recoge una lista de resultados: devuelve todos los valores o todos los
 * errores. Se usa al importar lotes (CSV de activos, cosido por lotes), donde
 * informar de un único fallo obligaría al usuario a repetir la importación
 * una vez por fila defectuosa.
 */
export function collectResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
}

/** Desenvuelve o lanza. Sólo para pruebas y para fallos no recuperables. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap sobre un resultado erróneo: ${JSON.stringify(r.error)}`);
}

/* ------------------------------------------------------------------ *
 * Errores de dominio
 * ------------------------------------------------------------------ */

/**
 * Códigos de error estables. Son parte del contrato: la interfaz los usa para
 * elegir el mensaje y la acción de recuperación, y la API de la etapa 11 los
 * expone tal cual, de modo que renombrar uno es un cambio incompatible.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE_TAG',
  'UNSUPPORTED_FORMAT',
  'INVALID_ASPECT_RATIO',
  'FILE_TOO_LARGE',
  'CHECKSUM_MISMATCH',
  'UNSAFE_PATH',
  'MIGRATION_FAILED',
  'SCHEMA_TOO_NEW',
  'PERMISSION_DENIED',
  'TELEMETRY_UNAVAILABLE',
  'TELEMETRY_UNAUTHORIZED',
  'TELEMETRY_WRITE_FORBIDDEN',
  'NETWORK_UNAVAILABLE',
  'EMBED_BLOCKED',
  'SCRIPT_DISABLED',
  'EXPERIMENTAL_DISABLED',
  'XR_UNAVAILABLE',
  'CIRCULAR_REFERENCE',
  'STORAGE_FAILED',
  'IO_FAILED',
  'CANCELLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DomainError {
  readonly code: ErrorCode;
  /** Mensaje para el usuario, en español y sin jerga de implementación. */
  readonly message: string;
  /** Ruta al dato que falló, en notación de puntos: `scenes.0.initialView.yaw`. */
  readonly path?: string;
  /** Contexto de diagnóstico. Nunca contiene credenciales ni rutas absolutas. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Qué puede hacer el usuario a continuación. */
  readonly recovery?: string;
}

export function domainError(
  code: ErrorCode,
  message: string,
  extra: Omit<DomainError, 'code' | 'message'> = {},
): DomainError {
  return { code, message, ...extra };
}

/** Atajo para el caso más frecuente. */
export const validationError = (message: string, path?: string): DomainError =>
  domainError('VALIDATION_FAILED', message, path !== undefined ? { path } : {});
