/**
 * Identidades: UUID y TAG industrial.
 *
 * El contrato de datos separa deliberadamente dos identificadores por activo:
 *
 *  - **UUID**: identidad interna, inmutable, generada por el sistema. Es la
 *    que usan las referencias entre entidades.
 *  - **TAG**: identidad funcional de planta (`P-101A`, `TI-2301`). La asigna
 *    el cliente, puede corregirse y su unicidad depende del alcance acordado.
 *
 * Mantenerlos separados es lo que permite renombrar un TAG mal escrito sin
 * romper los hotspots, documentos y mapeos de telemetría que lo referencian.
 */
import { z } from 'zod';
import { domainError, err, ok, type Result } from './result';

/** UUID v4 en minúsculas. */
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Debe ser un UUID v4 en minúsculas',
  )
  .brand<'Uuid'>();

export type Uuid = z.infer<typeof uuidSchema>;

/** Genera un UUID v4. Usa `crypto.randomUUID` cuando está disponible. */
export function newUuid(): Uuid {
  const raw =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : fallbackUuidV4();
  return raw.toLowerCase() as Uuid;
}

function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export const isUuid = (value: unknown): value is Uuid => uuidSchema.safeParse(value).success;

/* ------------------------------------------------------------------ *
 * TAG industrial
 * ------------------------------------------------------------------ */

/**
 * Longitud máxima de un TAG. 64 caracteres cubren con holgura las
 * convenciones ISA-5.1 y los esquemas jerárquicos de planta
 * (`AREA-UNIT-FUNC-SEQ-SUFFIX`) sin convertir el campo en texto libre.
 */
export const TAG_MAX_LENGTH = 64;

/**
 * Caracteres admitidos en un TAG: letras ASCII en mayúscula, dígitos y los
 * separadores `-`, `_`, `/`, `.`.
 *
 * Se excluye deliberadamente todo lo demás, incluidos acentos y espacios,
 * porque el TAG se usa como parte de nombres de archivo exportados, de claves
 * de etiqueta en consultas a InfluxDB y de identificadores en paquetes SCORM.
 * Un TAG con espacios o con `Ñ` funciona en la base de datos y rompe en la
 * exportación, que es el peor momento para descubrirlo. El nombre descriptivo
 * del activo sí admite Unicode completo; es el TAG el que está restringido.
 */
const TAG_PATTERN = /^[A-Z0-9][A-Z0-9\-_/.]*[A-Z0-9]$|^[A-Z0-9]$/;

export const tagSchema = z
  .string()
  .min(1, 'El TAG no puede estar vacío')
  .max(TAG_MAX_LENGTH, `El TAG no puede exceder ${TAG_MAX_LENGTH} caracteres`)
  .regex(
    TAG_PATTERN,
    'El TAG admite letras mayúsculas, dígitos y los separadores - _ / . sin empezar ni terminar en separador',
  )
  .brand<'Tag'>();

export type Tag = z.infer<typeof tagSchema>;

/**
 * Normaliza un TAG tal y como viene de un CSV o de un formulario.
 *
 * La normalización es intencionadamente conservadora: recorta espacios,
 * pasa a mayúsculas y colapsa separadores repetidos. No intenta adivinar
 * correcciones (no convierte espacios en guiones ni elimina acentos), porque
 * un TAG inventado por el importador es peor que un TAG rechazado: el
 * primero entra en el catálogo y nadie lo revisa.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[-_/.]{2,}/g, (m) => m[0] ?? '')
    .replace(/^[-_/.]+|[-_/.]+$/g, '');
}

export function parseTag(raw: string): Result<Tag> {
  const normalized = normalizeTag(raw);
  const parsed = tagSchema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(
      domainError('VALIDATION_FAILED', issue?.message ?? 'TAG no válido', {
        detail: { raw, normalized },
        recovery:
          'Corrija el TAG en el archivo de origen o edítelo manualmente antes de confirmar la importación.',
      }),
    );
  }
  return ok(parsed.data);
}

/**
 * Alcance en el que se exige unicidad del TAG.
 *
 * El checklist (X01) pide «TAG industrial» sin fijar el alcance, y en planta
 * real conviven las tres convenciones: hay clientes con un TAG único en toda
 * la corporación y otros donde el mismo `TI-101` existe en dos unidades. Que
 * el alcance sea configurable evita que la aplicación imponga una política
 * que el cliente no sigue, lo que terminaría en TAG falseados con sufijos.
 */
export const tagUniquenessScopeSchema = z.enum(['project', 'plant', 'unit', 'area', 'none']);
export type TagUniquenessScope = z.infer<typeof tagUniquenessScopeSchema>;

export const TAG_SCOPE_LABELS: Readonly<Record<TagUniquenessScope, string>> = {
  project: 'Todo el proyecto',
  plant: 'Por planta',
  unit: 'Por unidad',
  area: 'Por área',
  none: 'Sin exigir unicidad',
};

/** Clave de comparación de un TAG dentro de su alcance de unicidad. */
export function tagScopeKey(
  tag: string,
  scope: TagUniquenessScope,
  hierarchy: { plantId?: string; unitId?: string; areaId?: string },
): string | null {
  switch (scope) {
    case 'none':
      return null;
    case 'project':
      return tag;
    case 'plant':
      return `${hierarchy.plantId ?? ''}::${tag}`;
    case 'unit':
      return `${hierarchy.plantId ?? ''}/${hierarchy.unitId ?? ''}::${tag}`;
    case 'area':
      return `${hierarchy.plantId ?? ''}/${hierarchy.unitId ?? ''}/${hierarchy.areaId ?? ''}::${tag}`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Alcance de unicidad no contemplado: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Nombres de archivo y rutas relativas
 * ------------------------------------------------------------------ */

/** Caracteres prohibidos en Windows más los de control. */
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Nombres reservados por Windows; no pueden usarse ni con extensión. */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Sanea un nombre de archivo para el paquete `.ivp`.
 *
 * El objetivo es que un proyecto creado en Windows se abra en el visor web
 * servido desde Linux y al revés. Por eso se eliminan los caracteres que
 * Windows prohíbe, se evitan los nombres de dispositivo reservados y se
 * recorta el punto final, que Windows descarta en silencio y provocaría que
 * el hash del manifiesto no coincidiera con el archivo en disco.
 */
export function sanitizeFileName(raw: string, fallback = 'archivo'): string {
  const base = raw
    .normalize('NFC')
    .replace(WINDOWS_FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');

  if (base.length === 0) return fallback;

  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) return `_${base}`;

  return base.length > 180 ? `${base.slice(0, 170)}${base.slice(base.lastIndexOf('.'))}` : base;
}

/**
 * Valida que una ruta sea relativa y no escape del paquete.
 *
 * Es la defensa contra «zip slip» exigida por el contrato de datos: un
 * proyecto `.ivp` recibido de un tercero puede traer una entrada
 * `../../AppData/Roaming/...` y la extracción no debe escribirla jamás.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.includes('\0')) return false;

  const segments = path.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (/^[-\s]+$/.test(segment)) return false;
  }
  return true;
}

export function assertSafeRelativePath(path: string): Result<string> {
  if (!isSafeRelativePath(path)) {
    return err(
      domainError('UNSAFE_PATH', `La ruta «${path}» no es una ruta relativa admisible`, {
        detail: { path },
        recovery:
          'El paquete contiene una ruta que intenta salir de su carpeta. No se extraerá. Solicite el archivo a su origen.',
      }),
    );
  }
  return ok(path);
}
