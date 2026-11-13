/**
 * Migraciones versionadas del esquema SQLite.
 *
 * El contrato de datos exige «migraciones idempotentes» y «política de
 * migración ascendente y rollback por copia previa». Eso se traduce en tres
 * reglas que el motor hace cumplir:
 *
 *  1. Cada migración declara su `version` y se aplica una sola vez, lo cual
 *     se registra en `schema_migrations`. Volver a ejecutar el motor sobre
 *     una base ya migrada no hace nada.
 *  2. Las migraciones se aplican en una transacción. Si una falla a mitad, la
 *     base queda en la versión anterior y no en un estado intermedio sin
 *     nombre, que es lo que hace irreparable una migración fallida.
 *  3. No hay migración descendente. El rollback es la copia previa del
 *     archivo, que `writeAtomic` ya conserva. Escribir migraciones inversas
 *     para un formato de documento da una falsa sensación de seguridad: la
 *     inversa de «añadir una columna con datos» no puede recuperar lo que la
 *     columna nueva ya no representa.
 */
import { CURRENT_SCHEMA_VERSION, domainError, err, ok, type Result } from '@it360/domain';
import type { SqlDatabase } from './sql';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Descripción de lo que cambia, para el registro y el changelog. */
  readonly description: string;
  readonly up: (db: SqlDatabase) => void;
}

/* ------------------------------------------------------------------ *
 * Versión 1 — esquema inicial
 * ------------------------------------------------------------------ */

/**
 * Esquema inicial.
 *
 * El diseño es híbrido a propósito: los campos por los que se busca, se
 * ordena o se filtra son columnas, y las estructuras anidadas que sólo se
 * leen completas (la geometría de un marcador, el árbol de un skin, la
 * configuración de cámara) van en columnas JSON.
 *
 * Normalizar del todo exigiría una docena de tablas más para representar,
 * por ejemplo, los vértices de un polígono, y ninguna consulta de la
 * aplicación las aprovecharía: el editor siempre carga el marcador entero.
 * Guardarlo todo en un único JSON, en el otro extremo, haría imposible
 * «buscar por TAG y abrir su ubicación» (X05) sin leer el proyecto completo.
 * El reparto sigue ese criterio y no otro.
 */
const INITIAL_SCHEMA = `
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- Un único proyecto por archivo. La restricción CHECK impide que un
-- error de programación inserte un segundo proyecto en el mismo documento,
-- que dejaría la aplicación eligiendo arbitrariamente cuál abrir.
CREATE TABLE project (
  id                 TEXT PRIMARY KEY,
  singleton          INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1),
  schema_version     INTEGER NOT NULL,
  title              TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  client             TEXT    NOT NULL DEFAULT '',
  site               TEXT    NOT NULL DEFAULT '',
  publication_state  TEXT    NOT NULL DEFAULT 'draft',
  settings_json      TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  saved_by_version   TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_project_singleton ON project(singleton);

CREATE TABLE media (
  id                TEXT PRIMARY KEY,
  sha256            TEXT    NOT NULL,
  mime              TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  relative_path     TEXT    NOT NULL,
  original_name     TEXT    NOT NULL,
  byte_size         INTEGER NOT NULL,
  width             INTEGER,
  height            INTEGER,
  duration_s        REAL,
  thumbnail_path    TEXT,
  panorama_json     TEXT,
  tiles_json        TEXT    NOT NULL DEFAULT '[]',
  quarantined       INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,
  created_at        TEXT    NOT NULL
);
-- El SHA-256 es la identidad real del contenido: direccionar por él es lo
-- que evita duplicar 40 MB al importar dos veces el mismo panorama.
CREATE UNIQUE INDEX idx_media_sha ON media(sha256);
CREATE UNIQUE INDEX idx_media_path ON media(relative_path);

CREATE TABLE scene (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind                  TEXT    NOT NULL,
  title                 TEXT    NOT NULL,
  description           TEXT    NOT NULL DEFAULT '',
  media_id              TEXT    REFERENCES media(id) ON DELETE SET NULL,
  camera_json           TEXT    NOT NULL,
  model_json            TEXT,
  actions_json          TEXT    NOT NULL DEFAULT '[]',
  scene_order           INTEGER NOT NULL DEFAULT 0,
  scene_group           TEXT    NOT NULL DEFAULT '',
  tags_json             TEXT    NOT NULL DEFAULT '[]',
  excluded_from_publish INTEGER NOT NULL DEFAULT 0,
  ambient_effect_json   TEXT    NOT NULL DEFAULT '{"effect":"none","intensity":0.5}',
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE INDEX idx_scene_order ON scene(scene_order);
CREATE INDEX idx_scene_group ON scene(scene_group);

CREATE TABLE hotspot (
  id              TEXT PRIMARY KEY,
  scene_id        TEXT    NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  anchor_json     TEXT    NOT NULL,
  geometry_json   TEXT    NOT NULL,
  style_json      TEXT    NOT NULL,
  actions_json    TEXT    NOT NULL DEFAULT '[]',
  asset_id        TEXT    REFERENCES asset(id) ON DELETE SET NULL,
  visibility_json TEXT    NOT NULL,
  preload         TEXT    NOT NULL DEFAULT 'lazy',
  locked          INTEGER NOT NULL DEFAULT 0,
  hidden_in_editor INTEGER NOT NULL DEFAULT 0,
  tags_json       TEXT    NOT NULL DEFAULT '[]',
  auto_generated  INTEGER NOT NULL DEFAULT 0,
  auto_confidence REAL,
  reviewed        INTEGER NOT NULL DEFAULT 1,
  hotspot_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_hotspot_scene ON hotspot(scene_id, hotspot_order);
CREATE INDEX idx_hotspot_asset ON hotspot(asset_id);
-- Las propuestas automáticas sin revisar se consultan como grupo para el
-- panel de revisión, así que tienen su propio índice parcial.
CREATE INDEX idx_hotspot_unreviewed ON hotspot(reviewed) WHERE auto_generated = 1 AND reviewed = 0;

CREATE TABLE asset_class (
  id              TEXT PRIMARY KEY,
  code            TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  level           TEXT    NOT NULL,
  attributes_json TEXT    NOT NULL DEFAULT '[]',
  icon            TEXT    NOT NULL DEFAULT 'equipment',
  parent_class_id TEXT    REFERENCES asset_class(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_asset_class_code ON asset_class(code);

CREATE TABLE asset (
  id              TEXT PRIMARY KEY,
  project_id      TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  tag             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  class_id        TEXT    NOT NULL REFERENCES asset_class(id),
  level           TEXT    NOT NULL,
  parent_id       TEXT    REFERENCES asset(id) ON DELETE SET NULL,
  attributes_json TEXT    NOT NULL DEFAULT '{}',
  revision        INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'draft',
  criticality     TEXT,
  manufacturer    TEXT    NOT NULL DEFAULT '',
  model           TEXT    NOT NULL DEFAULT '',
  serial_number   TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
-- La búsqueda por TAG (X05) es la operación más frecuente del catálogo.
-- No es UNIQUE: el alcance de unicidad es configurable y se valida en el
-- dominio, que sabe de la jerarquía; una restricción aquí impondría el
-- alcance «proyecto» a todos los clientes.
CREATE INDEX idx_asset_tag ON asset(tag);
CREATE INDEX idx_asset_parent ON asset(parent_id);
CREATE INDEX idx_asset_class ON asset(class_id);

CREATE TABLE asset_location (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT    NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  scene_id    TEXT    NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  hotspot_id  TEXT    REFERENCES hotspot(id) ON DELETE SET NULL,
  anchor_json TEXT    NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  note        TEXT    NOT NULL DEFAULT ''
);
-- X04: un mismo activo enlazado desde varias panorámicas.
CREATE INDEX idx_location_asset ON asset_location(asset_id);
CREATE INDEX idx_location_scene ON asset_location(scene_id);

CREATE TABLE technical_document (
  id                TEXT PRIMARY KEY,
  asset_id          TEXT REFERENCES asset(id) ON DELETE SET NULL,
  title             TEXT    NOT NULL,
  document_code     TEXT    NOT NULL DEFAULT '',
  revision          TEXT    NOT NULL DEFAULT '',
  status            TEXT    NOT NULL DEFAULT 'draft',
  media_id          TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  discipline        TEXT    NOT NULL DEFAULT 'other',
  issued_at         TEXT,
  superseded_by_id  TEXT REFERENCES technical_document(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL
);
CREATE INDEX idx_document_asset ON technical_document(asset_id, status);

CREATE TABLE plan (
  id                 TEXT PRIMARY KEY,
  name               TEXT    NOT NULL,
  media_id           TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  floor              TEXT    NOT NULL DEFAULT '',
  floor_order        INTEGER NOT NULL DEFAULT 0,
  orientation_json   TEXT    NOT NULL,
  show_radar         INTEGER NOT NULL DEFAULT 1,
  radar_aperture_deg REAL    NOT NULL DEFAULT 60
);
CREATE INDEX idx_plan_floor ON plan(floor_order);

CREATE TABLE plan_marker (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  scene_id    TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  pos_x       REAL NOT NULL,
  pos_y       REAL NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  heading_rad REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_plan_marker_plan ON plan_marker(plan_id);

CREATE TABLE note_category (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color_token TEXT NOT NULL DEFAULT 'neutral',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE note (
  id              TEXT PRIMARY KEY,
  project_id      TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL DEFAULT '',
  anchor_json     TEXT,
  scene_id        TEXT    REFERENCES scene(id) ON DELETE SET NULL,
  asset_id        TEXT    REFERENCES asset(id) ON DELETE SET NULL,
  category_id     TEXT    NOT NULL DEFAULT 'other',
  priority        TEXT    NOT NULL DEFAULT 'normal',
  status          TEXT    NOT NULL DEFAULT 'open',
  assignee_id     TEXT,
  assignee_name   TEXT,
  due_date        TEXT,
  attachments_json TEXT   NOT NULL DEFAULT '[]',
  author_id       TEXT    NOT NULL,
  author_name     TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  resolved_at     TEXT,
  resolved_by_id  TEXT,
  resolution      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_note_status ON note(status, priority);
CREATE INDEX idx_note_scene ON note(scene_id);
CREATE INDEX idx_note_asset ON note(asset_id);
CREATE INDEX idx_note_assignee ON note(assignee_id, status);
CREATE INDEX idx_note_due ON note(due_date) WHERE due_date IS NOT NULL;

CREATE TABLE note_comment (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  author_id       TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  body            TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  edited_at       TEXT
);
CREATE INDEX idx_comment_note ON note_comment(note_id, created_at);

CREATE TABLE telemetry_connection (
  id                   TEXT PRIMARY KEY,
  name                 TEXT    NOT NULL,
  url                  TEXT    NOT NULL,
  org                  TEXT    NOT NULL,
  bucket               TEXT    NOT NULL,
  -- Referencia al secreto en el almacén del sistema operativo. NUNCA el
  -- token: un .ivp compartido por correo no debe llevar la credencial.
  token_key_id         TEXT    NOT NULL,
  token_label          TEXT    NOT NULL DEFAULT '',
  timeout_ms           INTEGER NOT NULL DEFAULT 8000,
  verify_tls           INTEGER NOT NULL DEFAULT 1,
  tls_exemption_reason TEXT    NOT NULL DEFAULT '',
  enabled              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE telemetry_mapping (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT    NOT NULL REFERENCES telemetry_connection(id) ON DELETE CASCADE,
  asset_id          TEXT    NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  variable          TEXT    NOT NULL,
  instrument_tag    TEXT,
  measurement       TEXT    NOT NULL,
  field             TEXT    NOT NULL,
  tags_json         TEXT    NOT NULL DEFAULT '{}',
  unit              TEXT    NOT NULL DEFAULT '',
  decimals          INTEGER NOT NULL DEFAULT 2,
  freshness_seconds INTEGER NOT NULL DEFAULT 300,
  aggregation       TEXT    NOT NULL DEFAULT 'mean',
  display_min       REAL,
  display_max       REAL,
  enabled           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_mapping_asset ON telemetry_mapping(asset_id);

CREATE TABLE condition_rule (
  id          TEXT PRIMARY KEY,
  mapping_id  TEXT    NOT NULL REFERENCES telemetry_mapping(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  comparison  TEXT    NOT NULL,
  threshold   REAL    NOT NULL,
  threshold2  REAL,
  level       TEXT    NOT NULL,
  hysteresis  REAL    NOT NULL DEFAULT 0,
  rule_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_rule_mapping ON condition_rule(mapping_id, rule_order);

-- Caché de telemetría. Vive en el proyecto para que el modo sin conexión
-- muestre la última lectura conocida, SIEMPRE rotulada como caché.
CREATE TABLE telemetry_cache (
  mapping_id       TEXT PRIMARY KEY REFERENCES telemetry_mapping(id) ON DELETE CASCADE,
  value            REAL,
  raw_value        TEXT,
  source_timestamp TEXT,
  fetched_at       TEXT NOT NULL,
  quality          TEXT NOT NULL,
  error_message    TEXT
);

CREATE TABLE skin (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  layout_mode TEXT    NOT NULL DEFAULT 'fluid',
  design_width  INTEGER NOT NULL DEFAULT 1920,
  design_height INTEGER NOT NULL DEFAULT 1080,
  root_json   TEXT    NOT NULL DEFAULT '[]',
  template_id TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE tour (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name                    TEXT    NOT NULL,
  description             TEXT    NOT NULL DEFAULT '',
  waypoints_json          TEXT    NOT NULL DEFAULT '[]',
  loop_tour               INTEGER NOT NULL DEFAULT 0,
  allow_interrupt         INTEGER NOT NULL DEFAULT 1,
  resume_after_interrupt  INTEGER NOT NULL DEFAULT 1,
  auto_resume_idle_s      INTEGER NOT NULL DEFAULT 0,
  requires_quiz_id        TEXT,
  requires_quiz_min_score REAL,
  on_start_json           TEXT    NOT NULL DEFAULT '[]',
  on_end_json             TEXT    NOT NULL DEFAULT '[]',
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
);

CREATE TABLE quiz (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  questions_json     TEXT    NOT NULL DEFAULT '[]',
  entry_question_id  TEXT,
  goals_json         TEXT    NOT NULL DEFAULT '[]',
  passing_scores_json TEXT   NOT NULL DEFAULT '{}',
  immediate_feedback INTEGER NOT NULL DEFAULT 1,
  shuffle_questions  INTEGER NOT NULL DEFAULT 0,
  shuffle_choices    INTEGER NOT NULL DEFAULT 0,
  show_report        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE app_user (
  id           TEXT PRIMARY KEY,
  display_name TEXT    NOT NULL,
  email        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT    NOT NULL
);

CREATE TABLE access_grant (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_grant_user ON access_grant(user_id);

-- Auditoría de sólo-añadir (X17). Los disparadores impiden modificar o
-- borrar: un registro de auditoría que se puede editar no sirve como
-- registro de auditoría.
CREATE TABLE audit_event (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  actor_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_hash TEXT,
  after_hash  TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  reason      TEXT,
  timestamp   TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_event(timestamp);
CREATE INDEX idx_audit_entity ON audit_event(entity, entity_id);

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'El registro de auditoría no admite modificaciones');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'El registro de auditoría no admite borrados');
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'esquema-inicial',
    description:
      'Proyecto, medios, escenas, marcadores, catálogo de activos con jerarquía y clases, documentos técnicos, planos, notas con hilos, telemetría de solo lectura con caché y reglas de condición, interfaces, recorridos, evaluaciones, usuarios, permisos y auditoría de sólo-añadir.',
    up: (db) => {
      db.exec(INITIAL_SCHEMA);
    },
  },
];

/* ------------------------------------------------------------------ *
 * Motor de migración
 * ------------------------------------------------------------------ */

export interface MigrationReport {
  readonly from: number;
  readonly to: number;
  readonly applied: ReadonlyArray<{ version: number; name: string }>;
}

/** Versión actual de la base, o 0 si está vacía. */
export function currentVersion(db: SqlDatabase): number {
  const tableExists = db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (tableExists === null) return 0;
  const row = db.get('SELECT MAX(version) AS v FROM schema_migrations');
  const value = row?.['v'];
  return typeof value === 'number' ? value : 0;
}

/**
 * Lleva la base a la versión actual del esquema.
 *
 * Si la base viene de una versión MÁS NUEVA que la que conoce esta
 * aplicación, no se toca y se devuelve `SCHEMA_TOO_NEW`. Aplicar migraciones
 * «hacia atrás» o ignorar columnas desconocidas acabaría guardando el
 * proyecto sin los datos que la versión nueva añadió, y el usuario perdería
 * trabajo sin recibir ningún aviso.
 */
export function migrate(
  db: SqlDatabase,
  options: { now: string; migrations?: readonly Migration[] } = { now: new Date().toISOString() },
): Result<MigrationReport> {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  const target = migrations.length > 0 ? (migrations[migrations.length - 1]?.version ?? 0) : 0;
  const from = currentVersion(db);

  if (from > target) {
    return err(
      domainError(
        'SCHEMA_TOO_NEW',
        `El proyecto fue creado con una versión más reciente de la aplicación (formato ${from}; esta versión admite hasta ${target})`,
        {
          detail: { projectSchemaVersion: from, supported: target },
          recovery:
            'Actualice INDUSTRIAL TWINS 360 para abrir este proyecto. No se ha modificado el archivo.',
        },
      ),
    );
  }

  const applied: Array<{ version: number; name: string }> = [];

  try {
    for (const migration of migrations) {
      if (migration.version <= from) continue;
      db.transaction(() => {
        migration.up(db);
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          options.now,
        ]);
      });
      applied.push({ version: migration.version, name: migration.name });
    }
  } catch (cause) {
    return err(
      domainError('MIGRATION_FAILED', 'No se pudo actualizar el formato del proyecto', {
        detail: {
          from,
          failedAt: applied.length > 0 ? (applied[applied.length - 1]?.version ?? from) + 1 : from + 1,
          cause: String(cause),
        },
        recovery:
          'El archivo no se ha modificado. Abra la copia de respaldo anterior y comunique el problema con la versión del proyecto.',
      }),
    );
  }

  return ok({ from, to: currentVersion(db), applied });
}

/** Comprueba que el esquema del dominio y el de SQLite van a la par. */
export function assertSchemaVersionsAligned(): void {
  const target = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (target !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Desalineación de versiones: el dominio declara ${CURRENT_SCHEMA_VERSION} y las migraciones llegan a ${target}`,
    );
  }
}
