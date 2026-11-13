import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canPerform,
  effectiveOperations,
  GLOBAL_SCOPE,
  isGrantActive,
  OPERATIONS,
  proposeResolution,
  ROLE_PERMISSIONS,
  scopeCovers,
  type AccessScope,
  type Grant,
  type Operation,
  type Role,
  type User,
} from './access';

import { testUuid as uuid } from './testing';
const NOW = new Date('2026-11-12T19:00:00.000Z');

// El ámbito de una concesión referencia activos de la jerarquía, así que sus
// identificadores son UUID igual que en producción.
const PLANT_1 = uuid(101);
const PLANT_2 = uuid(102);
const UNIT_1 = uuid(201);
const UNIT_2 = uuid(202);
const AREA_1 = uuid(301);
const AREA_2 = uuid(302);

const user = (overrides: Partial<User> = {}): User => ({
  id: 'u-ana',
  displayName: 'Ana Restrepo',
  email: null,
  active: true,
  lastSeenAt: null,
  createdAt: NOW.toISOString(),
  ...overrides,
});

const grant = (role: Role, scope: Partial<AccessScope> = {}, overrides: Partial<Grant> = {}): Grant =>
  ({
    id: uuid(1),
    userId: 'u-ana',
    role,
    scope: { ...GLOBAL_SCOPE, ...scope },
    grantedBy: 'u-admin',
    grantedAt: NOW.toISOString(),
    expiresAt: null,
    ...overrides,
  }) as Grant;

/**
 * TEST-ACC-001 .. TEST-ACC-022
 * Requisitos: P04, X15-X17 (etapa 11). Regla transversal del contrato:
 * los permisos se verifican en el backend, nunca sólo en la interfaz.
 */
describe('permisos por rol', () => {
  it('TEST-ACC-001: el lector no puede escribir nada', () => {
    const writes = ROLE_PERMISSIONS.viewer.filter((op) =>
      /\.(create|update|delete|publish|approve|import|manage|restore)$/.test(op),
    );
    expect(writes).toEqual([]);
  });

  it('TEST-ACC-002: el colaborador crea notas pero no edita escenas', () => {
    // Es el perfil del inspector que recorre la planta y levanta
    // observaciones, no el del autor del recorrido.
    expect(ROLE_PERMISSIONS.contributor).toContain('note.create');
    expect(ROLE_PERMISSIONS.contributor).not.toContain('scene.update');
    expect(ROLE_PERMISSIONS.contributor).not.toContain('project.publish');
  });

  it('TEST-ACC-003: el editor no puede publicar su propio trabajo', () => {
    // Separar edición de publicación es lo que da sentido al estado
    // «en revisión» y a la auditoría.
    expect(ROLE_PERMISSIONS.editor).toContain('scene.update');
    expect(ROLE_PERMISSIONS.editor).not.toContain('project.publish');
  });

  it('TEST-ACC-004: el revisor publica y aprueba, pero no gestiona usuarios', () => {
    expect(ROLE_PERMISSIONS.reviewer).toContain('project.publish');
    expect(ROLE_PERMISSIONS.reviewer).toContain('document.approve');
    expect(ROLE_PERMISSIONS.reviewer).not.toContain('user.manage');
    expect(ROLE_PERMISSIONS.reviewer).not.toContain('scene.update');
  });

  it('TEST-ACC-005: restaurar un respaldo es exclusivo del administrador', () => {
    // Restaurar sobreescribe el trabajo de otros.
    for (const role of ['viewer', 'contributor', 'editor', 'reviewer'] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain('backup.restore');
    }
    expect(ROLE_PERMISSIONS.administrator).toContain('backup.restore');
  });

  it('TEST-ACC-006: ningún rol tiene permiso de escritura sobre telemetría', () => {
    // La operación no existe en el sistema: la telemetría es solo lectura.
    const telemetryWrites = OPERATIONS.filter(
      (op) => op.startsWith('telemetry.') && op !== 'telemetry.read' && op !== 'telemetry.configure',
    );
    expect(telemetryWrites).toEqual([]);
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      expect(ROLE_PERMISSIONS[role].filter((op) => op === ('telemetry.write' as Operation))).toEqual([]);
    }
  });

  it('TEST-ACC-007: el administrador tiene todas las operaciones', () => {
    expect(new Set(ROLE_PERMISSIONS.administrator)).toEqual(new Set(OPERATIONS));
  });
});

describe('ámbito de la concesión (X15)', () => {
  it('TEST-ACC-008: un nivel nulo cubre cualquier valor', () => {
    expect(scopeCovers(GLOBAL_SCOPE, { plantId: PLANT_1, unitId: UNIT_1, areaId: AREA_1 })).toBe(true);
    expect(scopeCovers(GLOBAL_SCOPE, {})).toBe(true);
  });

  it('TEST-ACC-009: un ámbito de planta no cubre otra planta', () => {
    const scope: AccessScope = { ...GLOBAL_SCOPE, plantId: PLANT_1 };
    expect(scopeCovers(scope, { plantId: PLANT_1 })).toBe(true);
    expect(scopeCovers(scope, { plantId: PLANT_2 })).toBe(false);
  });

  it('TEST-ACC-010: ante un recurso sin ubicación declarada, se deniega', () => {
    // Es la elección conservadora, y la correcta cuando lo que hay detrás es
    // información industrial de otra planta.
    const scope: AccessScope = { ...GLOBAL_SCOPE, plantId: PLANT_1 };
    expect(scopeCovers(scope, {})).toBe(false);
    expect(scopeCovers(scope, { plantId: null })).toBe(false);
  });

  it('TEST-ACC-011: el ámbito de área exige coincidencia en los tres niveles', () => {
    const scope: AccessScope = { ...GLOBAL_SCOPE, plantId: PLANT_1, unitId: UNIT_1, areaId: AREA_1 };
    expect(scopeCovers(scope, { plantId: PLANT_1, unitId: UNIT_1, areaId: AREA_1 })).toBe(true);
    expect(scopeCovers(scope, { plantId: PLANT_1, unitId: UNIT_1, areaId: AREA_2 })).toBe(false);
    expect(scopeCovers(scope, { plantId: PLANT_1, unitId: UNIT_2, areaId: AREA_1 })).toBe(false);
  });

  it('TEST-ACC-012: las categorías de nota restringen el acceso (P04)', () => {
    const scope: AccessScope = { ...GLOBAL_SCOPE, noteCategoryIds: ['maintenance'] };
    expect(scopeCovers(scope, { noteCategoryId: 'maintenance' })).toBe(true);
    expect(scopeCovers(scope, { noteCategoryId: 'safety' })).toBe(false);
    // Un recurso que no es una nota no se ve afectado.
    expect(scopeCovers(scope, { plantId: PLANT_1 })).toBe(true);
  });
});

describe('decisión de acceso', () => {
  it('TEST-ACC-013: permite la operación que el rol incluye', () => {
    const decision = canPerform({
      user: user(),
      grants: [grant('editor')],
      operation: 'scene.update',
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.grantId).toBe(uuid(1));
  });

  it('TEST-ACC-014: deniega la operación que el rol no incluye y explica por qué', () => {
    const decision = canPerform({
      user: user(),
      grants: [grant('editor')],
      operation: 'project.publish',
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('project.publish');
  });

  it('TEST-ACC-015: deniega el acceso cruzado entre plantas con motivo específico', () => {
    const decision = canPerform({
      user: user(),
      grants: [grant('editor', { plantId: PLANT_1 })],
      operation: 'scene.update',
      resource: { plantId: PLANT_2 },
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no sobre esta planta');
  });

  it('TEST-ACC-016: una cuenta desactivada no puede nada', () => {
    const decision = canPerform({
      user: user({ active: false }),
      grants: [grant('administrator')],
      operation: 'project.read',
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('desactivada');
  });

  it('TEST-ACC-017: una concesión caducada no autoriza', () => {
    const expired = grant('administrator', {}, {
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect(isGrantActive(expired, NOW)).toBe(false);
    const decision = canPerform({
      user: user(),
      grants: [expired],
      operation: 'project.read',
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('caducado');
  });

  it('TEST-ACC-018: una concesión vigente con caducidad futura sí autoriza', () => {
    const active = grant('viewer', {}, {
      expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    });
    expect(canPerform({ user: user(), grants: [active], operation: 'project.read', now: NOW }).allowed).toBe(true);
  });

  it('TEST-ACC-019: varias concesiones se acumulan', () => {
    const grants = [
      grant('viewer', { plantId: PLANT_1 }, { id: uuid(1) }),
      grant('editor', { plantId: PLANT_2 }, { id: uuid(2) }),
    ];
    expect(
      canPerform({ user: user(), grants, operation: 'scene.update', resource: { plantId: PLANT_2 }, now: NOW }).allowed,
    ).toBe(true);
    expect(
      canPerform({ user: user(), grants, operation: 'scene.update', resource: { plantId: PLANT_1 }, now: NOW }).allowed,
    ).toBe(false);
  });

  it('TEST-ACC-020: un usuario sin concesiones no puede nada', () => {
    const decision = canPerform({ user: user(), grants: [], operation: 'project.read', now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no tiene permisos');
  });

  it('TEST-ACC-021: las concesiones de otro usuario no se aplican', () => {
    const other = grant('administrator', {}, { userId: 'u-otro' });
    expect(canPerform({ user: user(), grants: [other], operation: 'project.read', now: NOW }).allowed).toBe(false);
  });

  it('TEST-ACC-022: effectiveOperations reúne lo de todas las concesiones vigentes', () => {
    const grants = [
      grant('viewer', {}, { id: uuid(1) }),
      grant('contributor', {}, { id: uuid(2) }),
      grant('editor', {}, { id: uuid(3), expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
    ];
    const ops = effectiveOperations(grants, 'u-ana', NOW);
    expect(ops.has('note.create')).toBe(true);
    expect(ops.has('scene.update')).toBe(false);
  });
});

describe('estados de publicación (X16)', () => {
  it('TEST-ACC-023: desde borrador sólo se puede enviar a revisión', () => {
    const editorOps = new Set<Operation>(ROLE_PERMISSIONS.editor);
    expect(allowedTransitions('draft', editorOps)).toEqual(['inReview']);
  });

  it('TEST-ACC-024: publicar exige el permiso que el editor no tiene', () => {
    const editorOps = new Set<Operation>(ROLE_PERMISSIONS.editor);
    const reviewerOps = new Set<Operation>(ROLE_PERMISSIONS.reviewer);
    expect(allowedTransitions('inReview', editorOps)).toEqual(['draft']);
    expect(allowedTransitions('inReview', reviewerOps)).toContain('published');
  });

  it('TEST-ACC-025: un publicado sólo se puede retirar', () => {
    const adminOps = new Set<Operation>(ROLE_PERMISSIONS.administrator);
    expect(allowedTransitions('published', adminOps)).toEqual(['withdrawn']);
  });
});

describe('edición concurrente (X17)', () => {
  it('TEST-ACC-026: campos disjuntos se pueden fusionar', () => {
    const resolution = proposeResolution({
      entity: 'asset',
      entityId: uuid(5),
      expectedRevision: 3,
      actualRevision: 4,
      remoteActor: 'u-otro',
      remoteTimestamp: NOW.toISOString(),
      localFields: ['description'],
      remoteFields: ['manufacturer'],
    });
    expect(resolution).toBe('merge');
  });

  it('TEST-ACC-027: el solape exige decisión manual', () => {
    // Elegir automáticamente por marca de tiempo descartaría trabajo de
    // alguien sin avisarle, y ese alguien puede haber corregido un TAG a
    // partir de una inspección en campo.
    const resolution = proposeResolution({
      entity: 'asset',
      entityId: uuid(5),
      expectedRevision: 3,
      actualRevision: 4,
      remoteActor: 'u-otro',
      remoteTimestamp: NOW.toISOString(),
      localFields: ['tag', 'description'],
      remoteFields: ['tag'],
    });
    expect(resolution).toBe('manual');
  });
});
