/**
 * Política de ejecución de JavaScript del autor (etapa 03, J09).
 *
 * La arquitectura lo califica de «riesgo alto: deshabilitado por defecto,
 * solo administradores y contexto aislado, sin acceso al sistema operativo».
 * Este módulo convierte esa frase en reglas comprobables.
 *
 * El modelo de amenaza real no es un autor malicioso: es un proyecto `.ivp`
 * que llega por correo, de un integrador o de un cliente, y que alguien abre
 * para echarle un vistazo. Si abrir un proyecto ejecutara su código, el
 * formato de proyecto sería un vector de ejecución remota. De ahí las tres
 * reglas duras:
 *
 *  1. Un script importado nunca se ejecuta sin aprobación explícita, por
 *     script y registrada con su huella.
 *  2. La aprobación se liga al SHA-256 del código. Editar el script invalida
 *     la aprobación: lo aprobado fue ese texto, no «los scripts de este
 *     proyecto».
 *  3. La ejecución ocurre en un contexto sin acceso a red, sistema de
 *     archivos, shell, ni al resto de la aplicación. La superficie expuesta
 *     es una API explícita y pequeña.
 */
import { z } from 'zod';

export const scriptingModeSchema = z.enum([
  /** No se ejecuta ningún script. Valor por defecto del producto. */
  'disabled',
  /** Sólo los scripts aprobados por huella. */
  'approvedOnly',
  /** Todos los del proyecto. Exclusivo de desarrollo; nunca en publicación. */
  'allProjectScripts',
]);

export type ScriptingMode = z.infer<typeof scriptingModeSchema>;

export const SCRIPTING_MODE_LABELS: Readonly<Record<ScriptingMode, string>> = {
  disabled: 'Desactivado',
  approvedOnly: 'Sólo scripts aprobados',
  allProjectScripts: 'Todos los scripts del proyecto (sólo desarrollo)',
};

export const scriptApprovalSchema = z.object({
  /** SHA-256 del código aprobado. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Quién aprobó. En local, el usuario de Windows. */
  approvedBy: z.string().min(1).max(200),
  approvedAt: z.string().datetime({ offset: true }),
  /** Motivo declarado por quien aprueba; queda en la auditoría. */
  justification: z.string().max(1000).default(''),
  /** Primeros caracteres del código, para reconocerlo en el listado. */
  preview: z.string().max(200).default(''),
});

export type ScriptApproval = z.infer<typeof scriptApprovalSchema>;

export const scriptingPolicySchema = z.object({
  mode: scriptingModeSchema.default('disabled'),
  approvals: z.array(scriptApprovalSchema).default([]),
  /** Tiempo máximo de ejecución de un script, en ms. */
  timeoutMs: z.number().int().min(10).max(10_000).default(500),
  /**
   * Permitir scripts en el recorrido publicado.
   *
   * Por defecto no. Un recorrido publicado es de solo lectura y se sirve
   * como archivos estáticos; añadirle código del autor amplía su superficie
   * de ataque sin que nadie vuelva a revisarlo.
   */
  allowInPublished: z.boolean().default(false),
});

export type ScriptingPolicy = z.infer<typeof scriptingPolicySchema>;

export const DEFAULT_SCRIPTING_POLICY: ScriptingPolicy = {
  mode: 'disabled',
  approvals: [],
  timeoutMs: 500,
  allowInPublished: false,
};

/* ------------------------------------------------------------------ *
 * Decisión de ejecución
 * ------------------------------------------------------------------ */

export type ScriptDecision =
  | { readonly allowed: true; readonly reason: 'approved' | 'developmentMode' }
  | {
      readonly allowed: false;
      readonly reason:
        | 'scriptingDisabled'
        | 'notApproved'
        | 'approvalStale'
        | 'publishedContext'
        | 'notAdministrator';
      readonly message: string;
    };

export interface ScriptContext {
  /** El código se ejecuta en el recorrido publicado y no en el editor. */
  readonly published: boolean;
  /** El usuario actual tiene rol de administrador. */
  readonly isAdministrator: boolean;
}

/**
 * Decide si un script puede ejecutarse.
 *
 * Toda la política está en esta función, y el motor del visor no puede
 * ejecutar nada sin pasar por ella. Devuelve el motivo además de la
 * decisión, porque al autor hay que decirle por qué su script no corre: un
 * «no funciona» silencioso lleva a desactivar la seguridad a ciegas.
 */
export function decideScriptExecution(
  policy: ScriptingPolicy,
  scriptSha256: string,
  context: ScriptContext,
): ScriptDecision {
  if (policy.mode === 'disabled') {
    return {
      allowed: false,
      reason: 'scriptingDisabled',
      message:
        'La ejecución de código personalizado está desactivada. Un administrador puede habilitarla en Ajustes › Seguridad.',
    };
  }

  if (context.published && !policy.allowInPublished) {
    return {
      allowed: false,
      reason: 'publishedContext',
      message:
        'El recorrido publicado no ejecuta código personalizado. Habilítelo expresamente en las opciones de publicación si es imprescindible.',
    };
  }

  if (policy.mode === 'allProjectScripts') {
    if (!context.isAdministrator) {
      return {
        allowed: false,
        reason: 'notAdministrator',
        message: 'El modo de desarrollo de scripts requiere permisos de administrador.',
      };
    }
    return { allowed: true, reason: 'developmentMode' };
  }

  const approval = policy.approvals.find((a) => a.sha256 === scriptSha256);
  if (approval === undefined) {
    const anyApproval = policy.approvals.length > 0;
    return {
      allowed: false,
      reason: anyApproval ? 'approvalStale' : 'notApproved',
      message: anyApproval
        ? 'El código ha cambiado desde que se aprobó. Debe revisarse y aprobarse de nuevo.'
        : 'Este código no está aprobado. Revíselo y apruébelo desde Ajustes › Seguridad › Scripts.',
    };
  }

  return { allowed: true, reason: 'approved' };
}

/* ------------------------------------------------------------------ *
 * Superficie expuesta al script
 * ------------------------------------------------------------------ */

/**
 * Lo único que un script puede ver.
 *
 * Es una lista blanca, no una lista negra: el contexto de ejecución se
 * construye vacío y se le añaden estas claves. Así, cuando el motor de
 * acciones crezca con un tipo nuevo, el script no lo obtiene gratis.
 *
 * `globalThis`, `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`,
 * `import`, `require`, `window.parent` y las APIs de Tauri quedan fuera por
 * construcción.
 */
export const SCRIPT_API_SURFACE = [
  /** `tour.goToScene(sceneId)` y navegación equivalente a las acciones. */
  'tour',
  /** `vars.get(key)` y `vars.set(key, value)` sobre puntuaciones. */
  'vars',
  /** `ui.show(id)`, `ui.hide(id)`, `ui.toggle(id)`. */
  'ui',
  /** `log.info(mensaje)`: escribe en el registro de diagnóstico local. */
  'log',
  /** Lectura de la escena actual y su activo, sin modificarlos. */
  'scene',
] as const;

export type ScriptApiKey = (typeof SCRIPT_API_SURFACE)[number];

/**
 * Identificadores globales que nunca deben estar accesibles.
 *
 * Se usan en la construcción del contexto aislado —se declaran como
 * parámetros con valor `undefined`, que es lo que oscurece el global— y en la
 * prueba que verifica que ninguno es alcanzable.
 */
export const BLOCKED_GLOBALS = [
  'globalThis',
  'window',
  'self',
  'parent',
  'top',
  'document',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'require',
  'process',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'navigator',
  'location',
  'history',
  'open',
  'eval',
  'Function',
  '__tauri__',
  '__TAURI__',
  '__TAURI_INTERNALS__',
] as const;

/**
 * Patrones sintácticos rechazados antes de ejecutar.
 *
 * Es un filtro previo, no la defensa principal —la defensa es el contexto
 * aislado—, pero detecta en la revisión los intentos evidentes de salir del
 * recinto y permite avisar al administrador antes de que apruebe.
 */
export const SUSPICIOUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bimport\s*\(/, reason: 'importación dinámica de módulos' },
  { pattern: /\brequire\s*\(/, reason: 'carga de módulos de Node' },
  { pattern: /\bFunction\s*\(/, reason: 'construcción de funciones desde texto' },
  { pattern: /\beval\s*\(/, reason: 'evaluación de código desde texto' },
  { pattern: /\bfetch\s*\(/, reason: 'petición de red' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'petición de red' },
  { pattern: /\bWebSocket\b/, reason: 'conexión de red persistente' },
  { pattern: /\b__TAURI/i, reason: 'acceso al contenedor de la aplicación' },
  { pattern: /\bprocess\s*\./, reason: 'acceso al proceso del sistema' },
  { pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, reason: 'almacenamiento del navegador' },
  { pattern: /\bconstructor\s*\[\s*['"]constructor['"]/, reason: 'escape por la cadena de prototipos' },
  { pattern: /\[\s*['"]constructor['"]\s*\]/, reason: 'acceso indirecto al constructor' },
  { pattern: /\bdocument\s*\./, reason: 'acceso al DOM de la aplicación' },
];

export interface ScriptAudit {
  /** Patrones sospechosos encontrados, con su motivo. */
  readonly findings: ReadonlyArray<{ readonly reason: string; readonly match: string }>;
  readonly lineCount: number;
  readonly byteSize: number;
}

/** Revisa un script y devuelve lo que un administrador debería saber. */
export function auditScript(source: string): ScriptAudit {
  const findings: Array<{ reason: string; match: string }> = [];
  for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
    const match = pattern.exec(source);
    if (match !== null) findings.push({ reason, match: match[0] });
  }
  return {
    findings,
    lineCount: source.split('\n').length,
    byteSize: new TextEncoder().encode(source).length,
  };
}

/** Vista previa de una línea para el listado de aprobaciones. */
export function scriptPreview(source: string, maxLength = 120): string {
  const firstMeaningful =
    source
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('//')) ?? '';
  return firstMeaningful.length > maxLength
    ? `${firstMeaningful.slice(0, maxLength - 1)}…`
    : firstMeaningful;
}

/* ------------------------------------------------------------------ *
 * Huella de un guion (J09)
 * ------------------------------------------------------------------ */

/**
 * SHA-256 del código de un guion, en hexadecimal.
 *
 * Devuelve `null` cuando el entorno no ofrece SHA-256 de verdad, y esa
 * devolución es una decisión de seguridad, no una comodidad: **aquí no puede
 * haber reserva**. La huella es lo que distingue un guion aprobado de uno que
 * no lo está; una reserva que mire sólo los primeros bytes haría que dos
 * guiones con el mismo comienzo compartieran huella, y entonces bastaría
 * copiar el principio de un guion aprobado y añadirle lo que se quisiera
 * detrás. Sin SHA-256, lo correcto es no ejecutar.
 *
 * El contenido se compara byte a byte, sin normalizar ni recortar: un espacio
 * de más es otro código, y «aprobé algo muy parecido» no es aprobar.
 */
export async function scriptDigest(
  source: string,
  subtle: SubtleCrypto | undefined,
): Promise<string | null> {
  /* El `subtle` se pasa, no se lee de un global con valor por omisión: con un
     valor por omisión, pasar `undefined` adrede —que es como se prueba el caso
     sin SHA-256— vuelve a caer en el global y el caso no se puede ejercitar. Y
     en cada llamada queda a la vista de qué depende esto. */
  if (subtle === undefined) return null;

  const bytes = new TextEncoder().encode(source);
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
