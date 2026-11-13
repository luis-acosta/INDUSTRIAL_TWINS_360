/**
 * Usuarios, permisos y auditoría (etapa 11, grupo X15-X20 y P04).
 *
 * El control de acceso es ABAC sobre RBAC: el rol dice *qué* puede hacer una
 * persona y el ámbito dice *dónde*. Un «editor en la Unidad 200» no es un rol
 * distinto de «editor en la Unidad 300»; es el mismo rol con otro ámbito. Sin
 * esa separación, cada combinación de planta y área sería un rol nuevo y la
 * administración de permisos se vuelve impracticable en cuanto hay tres
 * plantas.
 *
 * La regla que atraviesa la etapa: **el permiso se verifica en el backend,
 * nunca sólo en la interfaz**. Lo que se oculta en pantalla es cortesía; lo
 * que impide el acceso es la comprobación del servidor. Este módulo contiene
 * la decisión pura, y la usan los dos lados para no divergir.
 */
import { z } from 'zod';
import { uuidSchema } from './identity';

/* ------------------------------------------------------------------ *
 * Operaciones y roles
 * ------------------------------------------------------------------ */

/**
 * Operaciones del sistema. El conjunto es cerrado y cada una se comprueba de
 * forma independiente, de modo que un rol no «implica» permisos por su
 * nombre sino por la lista explícita que tiene asignada.
 */
export const OPERATIONS = [
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'project.publish',
  'scene.read',
  'scene.update',
  'asset.read',
  'asset.update',
  'asset.import',
  'asset.export',
  'document.read',
  'document.upload',
  'document.approve',
  'note.read',
  'note.create',
  'note.update',
  'note.assign',
  'note.resolve',
  'note.delete',
  'telemetry.read',
  'telemetry.configure',
  'tour.read',
  'tour.update',
  'quiz.read',
  'quiz.update',
  'quiz.results.read',
  'skin.update',
  'user.read',
  'user.manage',
  'role.manage',
  'audit.read',
  'backup.create',
  'backup.restore',
  'script.approve',
  'settings.update',
] as const;

export const operationSchema = z.enum(OPERATIONS);
export type Operation = z.infer<typeof operationSchema>;

export const roleSchema = z.enum(['viewer', 'contributor', 'editor', 'reviewer', 'administrator']);
export type Role = z.infer<typeof roleSchema>;

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  viewer: 'Lector',
  contributor: 'Colaborador',
  editor: 'Editor',
  reviewer: 'Revisor',
  administrator: 'Administrador',
};

/**
 * Permisos por rol.
 *
 * Decisiones que merecen justificarse:
 *
 *  - Ningún rol, administrador incluido, tiene una operación de escritura de
 *    telemetría, porque esa operación no existe en el sistema.
 *  - `contributor` puede crear y comentar notas pero no editar escenas: es el
 *    perfil del inspector que recorre la planta y levanta observaciones.
 *  - `reviewer` aprueba documentos y publica, pero no gestiona usuarios:
 *    separar la aprobación técnica de la administración del sistema es lo
 *    que hace que la auditoría signifique algo.
 *  - `backup.restore` es exclusivo de administrador porque restaurar
 *    sobreescribe el trabajo de otros.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Operation[]>> = {
  viewer: ['project.read', 'scene.read', 'asset.read', 'document.read', 'note.read', 'telemetry.read', 'tour.read', 'quiz.read'],
  contributor: [
    'project.read', 'scene.read', 'asset.read', 'document.read', 'document.upload',
    'note.read', 'note.create', 'note.update', 'telemetry.read', 'tour.read', 'quiz.read',
  ],
  editor: [
    'project.read', 'project.update', 'scene.read', 'scene.update',
    'asset.read', 'asset.update', 'asset.import', 'asset.export',
    'document.read', 'document.upload',
    'note.read', 'note.create', 'note.update', 'note.assign', 'note.resolve',
    'telemetry.read', 'telemetry.configure',
    'tour.read', 'tour.update', 'quiz.read', 'quiz.update', 'quiz.results.read',
    'skin.update',
  ],
  reviewer: [
    'project.read', 'project.publish', 'scene.read', 'asset.read',
    'document.read', 'document.approve',
    'note.read', 'note.create', 'note.update', 'note.assign', 'note.resolve',
    'telemetry.read', 'tour.read', 'quiz.read', 'quiz.results.read', 'audit.read',
  ],
  administrator: [...OPERATIONS],
};

/* ------------------------------------------------------------------ *
 * Ámbito (X15)
 * ------------------------------------------------------------------ */

/**
 * Ámbito de una concesión: planta, unidad y área.
 *
 * `null` significa «cualquiera» en ese nivel. Así `{plant: 'P1', unit: null,
 * area: null}` concede sobre toda la planta 1, y `{plant: null, ...}` sobre
 * todo. Es más expresivo que una lista de identificadores y no obliga a
 * reasignar permisos cuando el cliente crea un área nueva.
 */
export const accessScopeSchema = z.object({
  plantId: uuidSchema.nullable().default(null),
  unitId: uuidSchema.nullable().default(null),
  areaId: uuidSchema.nullable().default(null),
  /** Categorías de nota accesibles; vacío = todas (P04). */
  noteCategoryIds: z.array(z.string().max(64)).default([]),
});

export type AccessScope = z.infer<typeof accessScopeSchema>;

export const GLOBAL_SCOPE: AccessScope = {
  plantId: null,
  unitId: null,
  areaId: null,
  noteCategoryIds: [],
};

export const grantSchema = z.object({
  id: uuidSchema,
  userId: z.string().min(1).max(120),
  role: roleSchema,
  scope: accessScopeSchema.default(GLOBAL_SCOPE),
  grantedBy: z.string().min(1).max(120),
  grantedAt: z.string().datetime({ offset: true }),
  /** Caducidad; `null` = sin caducidad. Útil para contratistas. */
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export type Grant = z.infer<typeof grantSchema>;

export const userSchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  /** Correo para notificaciones (P07). */
  email: z.string().email().nullable().default(null),
  active: z.boolean().default(true),
  /** Último acceso, para revisiones de cuentas inactivas. */
  lastSeenAt: z.string().datetime({ offset: true }).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
});

export type User = z.infer<typeof userSchema>;

/* ------------------------------------------------------------------ *
 * Decisión de acceso
 * ------------------------------------------------------------------ */

/** Ubicación del recurso sobre el que se decide. */
export interface ResourceContext {
  readonly plantId?: string | null;
  readonly unitId?: string | null;
  readonly areaId?: string | null;
  readonly noteCategoryId?: string | null;
}

export interface AccessDecision {
  readonly allowed: boolean;
  /** Concesión que permitió la operación. */
  readonly grantId: string | null;
  readonly reason: string;
}

/** `true` si la concesión no ha caducado en `now`. */
export function isGrantActive(grant: Grant, now: Date): boolean {
  if (grant.expiresAt === null) return true;
  const expiry = Date.parse(grant.expiresAt);
  return Number.isNaN(expiry) ? true : expiry > now.getTime();
}

/**
 * `true` si el ámbito de la concesión cubre la ubicación del recurso.
 *
 * Un nivel `null` en la concesión cubre cualquier valor. Un recurso sin
 * ubicación declarada en un nivel que la concesión restringe NO queda
 * cubierto: ante la duda, se deniega. Es la elección conservadora, y la
 * correcta cuando lo que está detrás es información industrial de otra
 * planta.
 */
export function scopeCovers(scope: AccessScope, resource: ResourceContext): boolean {
  const levels: ReadonlyArray<[string | null, string | null | undefined]> = [
    [scope.plantId, resource.plantId],
    [scope.unitId, resource.unitId],
    [scope.areaId, resource.areaId],
  ];

  for (const [granted, actual] of levels) {
    if (granted === null) continue;
    if (actual === undefined || actual === null) return false;
    if (granted !== actual) return false;
  }

  if (scope.noteCategoryIds.length > 0 && resource.noteCategoryId != null) {
    if (!scope.noteCategoryIds.includes(resource.noteCategoryId)) return false;
  }

  return true;
}

/**
 * Decide si un usuario puede realizar una operación sobre un recurso.
 *
 * El resultado es deliberadamente explicativo: la etapa 11 exige auditoría, y
 * registrar «denegado» sin el motivo convierte el registro en algo que nadie
 * puede investigar.
 */
export function canPerform(input: {
  readonly user: User;
  readonly grants: readonly Grant[];
  readonly operation: Operation;
  readonly resource?: ResourceContext;
  readonly now: Date;
}): AccessDecision {
  if (!input.user.active) {
    return { allowed: false, grantId: null, reason: 'La cuenta está desactivada' };
  }

  const resource = input.resource ?? {};
  const relevant = input.grants.filter((g) => g.userId === input.user.id);

  if (relevant.length === 0) {
    return { allowed: false, grantId: null, reason: 'El usuario no tiene permisos asignados' };
  }

  let sawExpired = false;
  let sawOutOfScope = false;

  for (const grant of relevant) {
    if (!isGrantActive(grant, input.now)) {
      sawExpired = true;
      continue;
    }
    if (!ROLE_PERMISSIONS[grant.role].includes(input.operation)) continue;
    if (!scopeCovers(grant.scope, resource)) {
      sawOutOfScope = true;
      continue;
    }
    return {
      allowed: true,
      grantId: grant.id,
      reason: `Permitido por el rol ${ROLE_LABELS[grant.role]}`,
    };
  }

  if (sawOutOfScope) {
    return {
      allowed: false,
      grantId: null,
      reason: 'El usuario tiene el rol necesario pero no sobre esta planta, unidad o área',
    };
  }
  if (sawExpired) {
    return { allowed: false, grantId: null, reason: 'Los permisos del usuario han caducado' };
  }

  return {
    allowed: false,
    grantId: null,
    reason: `Ningún rol del usuario incluye la operación ${input.operation}`,
  };
}

/** Operaciones efectivas de un usuario, para decidir qué mostrar. */
export function effectiveOperations(
  grants: readonly Grant[],
  userId: string,
  now: Date,
): Set<Operation> {
  const result = new Set<Operation>();
  for (const grant of grants) {
    if (grant.userId !== userId || !isGrantActive(grant, now)) continue;
    for (const operation of ROLE_PERMISSIONS[grant.role]) result.add(operation);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Estados de publicación (X16)
 * ------------------------------------------------------------------ */

export const publicationStateSchema = z.enum(['draft', 'inReview', 'published', 'withdrawn']);
export type PublicationState = z.infer<typeof publicationStateSchema>;

export const PUBLICATION_LABELS: Readonly<Record<PublicationState, string>> = {
  draft: 'Borrador',
  inReview: 'En revisión',
  published: 'Publicado',
  withdrawn: 'Retirado',
};

/**
 * Transiciones de publicación y operación que las autoriza.
 *
 * Publicar exige `project.publish`, que `editor` no tiene: quien edita no
 * publica su propio trabajo. Es la separación de funciones que da sentido al
 * estado «en revisión».
 */
export const PUBLICATION_TRANSITIONS: ReadonlyArray<{
  readonly from: PublicationState;
  readonly to: PublicationState;
  readonly operation: Operation;
  readonly label: string;
}> = [
  { from: 'draft', to: 'inReview', operation: 'project.update', label: 'Enviar a revisión' },
  { from: 'inReview', to: 'draft', operation: 'project.update', label: 'Devolver a borrador' },
  { from: 'inReview', to: 'published', operation: 'project.publish', label: 'Publicar' },
  { from: 'published', to: 'withdrawn', operation: 'project.publish', label: 'Retirar publicación' },
  { from: 'withdrawn', to: 'draft', operation: 'project.update', label: 'Reabrir como borrador' },
];

export function allowedTransitions(
  from: PublicationState,
  operations: ReadonlySet<Operation>,
): PublicationState[] {
  return PUBLICATION_TRANSITIONS.filter(
    (t) => t.from === from && operations.has(t.operation),
  ).map((t) => t.to);
}

/* ------------------------------------------------------------------ *
 * Auditoría (X17)
 * ------------------------------------------------------------------ */

export const auditActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'read',
  'publish',
  'withdraw',
  'approve',
  'login',
  'loginFailed',
  'permissionDenied',
  'import',
  'export',
  'backup',
  'restore',
  'scriptApproved',
  'settingsChanged',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEventSchema = z.object({
  id: uuidSchema,
  /** Identificador del actor. `system` para procesos automáticos. */
  actor: z.string().min(1).max(120),
  actorName: z.string().max(200).default(''),
  action: auditActionSchema,
  /** Tipo de entidad afectada: `scene`, `asset`, `note`. */
  entity: z.string().min(1).max(64),
  entityId: z.string().max(120).nullable().default(null),
  /**
   * Hash del estado antes y después.
   *
   * Se guardan hashes y no el contenido: la auditoría debe permitir
   * demostrar que algo cambió sin convertirse en una segunda copia de los
   * datos industriales, con su propio problema de control de acceso.
   */
  beforeHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  afterHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** Resumen legible: «Prioridad: normal → urgente». */
  summary: z.string().max(1000).default(''),
  /** Motivo de la denegación, cuando `action` es `permissionDenied`. */
  reason: z.string().max(500).nullable().default(null),
  timestamp: z.string().datetime({ offset: true }),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

/* ------------------------------------------------------------------ *
 * Edición concurrente (X17)
 * ------------------------------------------------------------------ */

export const conflictResolutionSchema = z.enum(['keepLocal', 'keepRemote', 'merge', 'manual']);
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;

export interface EditConflict {
  readonly entity: string;
  readonly entityId: string;
  /** Revisión que el cliente creía vigente. */
  readonly expectedRevision: number;
  /** Revisión real en el servidor. */
  readonly actualRevision: number;
  readonly remoteActor: string;
  readonly remoteTimestamp: string;
  /** Campos modificados por cada lado. */
  readonly localFields: readonly string[];
  readonly remoteFields: readonly string[];
}

/**
 * Propone una resolución para un conflicto.
 *
 * Si los dos lados tocaron campos distintos, la fusión es segura y se
 * propone. Si coinciden en algún campo, se exige decisión manual: elegir
 * automáticamente por marca de tiempo descartaría trabajo de alguien sin
 * avisarle, y en un catálogo de activos ese alguien puede haber corregido un
 * TAG a partir de una inspección en campo.
 */
export function proposeResolution(conflict: EditConflict): ConflictResolution {
  const overlap = conflict.localFields.filter((f) => conflict.remoteFields.includes(f));
  return overlap.length === 0 ? 'merge' : 'manual';
}
