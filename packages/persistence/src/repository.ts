/**
 * Lectura y escritura del proyecto en SQLite.
 *
 * El repositorio traduce entre el agregado `Project` que manipula el editor y
 * las tablas del esquema. Dos decisiones gobiernan la traducción:
 *
 *  - **La escritura es un reemplazo completo dentro de una transacción.** El
 *    editor trabaja sobre el proyecto en memoria con su historial de
 *    deshacer; intentar derivar un conjunto mínimo de INSERT/UPDATE/DELETE a
 *    partir de ese estado sería un segundo modelo de cambios que habría que
 *    mantener sincronizado con el primero. Un proyecto de recorrido tiene
 *    miles de filas, no millones: reescribirlas cuesta milisegundos y elimina
 *    una clase entera de fallos de sincronización.
 *  - **La lectura valida con Zod.** Un proyecto puede haber sido editado a
 *    mano, migrado desde una versión antigua o corrompido parcialmente. Cada
 *    fila se valida y lo que no pasa se reporta como problema de integridad
 *    en lugar de entrar al editor y fallar después.
 */
import {
  assetClassSchema,
  assetLocationSchema,
  assetSchema,
  commentSchema,
  conditionRuleSchema,
  CURRENT_SCHEMA_VERSION,
  domainError,
  err,
  hotspotSchema,
  influxConnectionSchema,
  mediaSchema,
  noteCategorySchema,
  noteSchema,
  ok,
  planMarkerSchema,
  planSchema,
  projectSchema,
  projectSettingsSchema,
  quizSchema,
  sceneSchema,
  infoWindowSchema,
  skinSchema,
  technicalDocumentSchema,
  telemetryMappingSchema,
  tourSchema,
  userSchema,
  grantSchema,
  auditEventSchema,
  type Project,
  type Result,
} from '@it360/domain';
import {
  asJson,
  asNumber,
  asText,
  toBool,
  toInt,
  toJson,
  type SqlDatabase,
  type SqlRow,
  type SqlValue,
} from './sql';

export interface LoadWarning {
  readonly table: string;
  readonly id: string;
  readonly message: string;
}

export interface LoadResult {
  readonly project: Project;
  /** Filas descartadas por no validar. El editor las muestra como avisos. */
  readonly warnings: readonly LoadWarning[];
}

const text = (row: SqlRow, column: string): string => asText(row[column] ?? null) ?? '';
const nullableText = (row: SqlRow, column: string): string | null => asText(row[column] ?? null);
const num = (row: SqlRow, column: string, fallback = 0): number =>
  asNumber(row[column] ?? null) ?? fallback;
const nullableNum = (row: SqlRow, column: string): number | null => asNumber(row[column] ?? null);
const bool = (row: SqlRow, column: string): boolean => toBool(row[column] ?? null);

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

export function loadProject(db: SqlDatabase): Result<LoadResult> {
  const warnings: LoadWarning[] = [];

  /**
   * Valida una fila y la descarta con aviso si no pasa.
   *
   * Descartar y seguir es correcto aquí: si una de cuatrocientas notas tiene
   * una prioridad que ya no existe, el usuario preferirá abrir el proyecto y
   * perder esa nota antes que no poder abrirlo.
   */
  const parse = <T>(
    table: string,
    id: string,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
    value: unknown,
  ): T | null => {
    const result = schema.safeParse(value);
    if (result.success && result.data !== undefined) return result.data;
    warnings.push({
      table,
      id,
      message: `Registro descartado por no cumplir el contrato de datos: ${describeZodError(result.error)}`,
    });
    return null;
  };

  const projectRow = db.get('SELECT * FROM project LIMIT 1');
  if (projectRow === null) {
    return err(
      domainError('NOT_FOUND', 'El archivo no contiene ningún proyecto', {
        recovery: 'Compruebe que el archivo es un proyecto de INDUSTRIAL TWINS 360.',
      }),
    );
  }

  const settingsParsed = projectSettingsSchema.safeParse(
    asJson(projectRow['settings_json'] ?? null, {}),
  );
  if (!settingsParsed.success) {
    warnings.push({
      table: 'project',
      id: text(projectRow, 'id'),
      message: 'Los ajustes del proyecto no eran válidos y se han restablecido a los valores por defecto',
    });
  }
  const settings = settingsParsed.success
    ? settingsParsed.data
    : projectSettingsSchema.parse({});

  /* --- Medios --- */
  const media = db
    .all('SELECT * FROM media ORDER BY created_at, id')
    .map((row) =>
      parse('media', text(row, 'id'), mediaSchema, {
        id: text(row, 'id'),
        sha256: text(row, 'sha256'),
        mime: text(row, 'mime'),
        kind: text(row, 'kind'),
        relativePath: text(row, 'relative_path'),
        originalName: text(row, 'original_name'),
        byteSize: num(row, 'byte_size'),
        width: nullableNum(row, 'width'),
        height: nullableNum(row, 'height'),
        durationS: nullableNum(row, 'duration_s'),
        thumbnailPath: nullableText(row, 'thumbnail_path'),
        panorama: asJson(row['panorama_json'] ?? null, null),
        tiles: asJson(row['tiles_json'] ?? null, []),
        renditions: asJson(row['renditions_json'] ?? null, []),
        quarantined: bool(row, 'quarantined'),
        quarantineReason: nullableText(row, 'quarantine_reason'),
        createdAt: text(row, 'created_at'),
      }),
    )
    .filter((m): m is NonNullable<typeof m> => m !== null);

  /* --- Escenas con sus marcadores --- */
  const hotspotRows = db.all('SELECT * FROM hotspot ORDER BY scene_id, hotspot_order, id');
  const hotspotsByScene = new Map<string, unknown[]>();
  for (const row of hotspotRows) {
    const sceneId = text(row, 'scene_id');
    const parsed = parse('hotspot', text(row, 'id'), hotspotSchema, {
      id: text(row, 'id'),
      sceneId,
      name: text(row, 'name'),
      anchor: asJson(row['anchor_json'] ?? null, null),
      geometry: asJson(row['geometry_json'] ?? null, null),
      style: asJson(row['style_json'] ?? null, null),
      actions: asJson(row['actions_json'] ?? null, []),
      assetId: nullableText(row, 'asset_id'),
      visibility: asJson(row['visibility_json'] ?? null, null),
      preload: text(row, 'preload'),
      locked: bool(row, 'locked'),
      hiddenInEditor: bool(row, 'hidden_in_editor'),
      tags: asJson(row['tags_json'] ?? null, []),
      autoGenerated: bool(row, 'auto_generated'),
      autoConfidence: nullableNum(row, 'auto_confidence'),
      reviewed: bool(row, 'reviewed'),
      order: num(row, 'hotspot_order'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
    });
    if (parsed === null) continue;
    const list = hotspotsByScene.get(sceneId) ?? [];
    list.push(parsed);
    hotspotsByScene.set(sceneId, list);
  }

  const scenes = db
    .all('SELECT * FROM scene ORDER BY scene_order, id')
    .map((row) =>
      parse('scene', text(row, 'id'), sceneSchema, {
        id: text(row, 'id'),
        projectId: text(row, 'project_id'),
        kind: text(row, 'kind'),
        title: text(row, 'title'),
        description: text(row, 'description'),
        mediaId: nullableText(row, 'media_id'),
        camera: asJson(row['camera_json'] ?? null, null),
        model: asJson(row['model_json'] ?? null, null),
        hotspots: hotspotsByScene.get(text(row, 'id')) ?? [],
        actions: asJson(row['actions_json'] ?? null, []),
        order: num(row, 'scene_order'),
        group: text(row, 'scene_group'),
        tags: asJson(row['tags_json'] ?? null, []),
        excludedFromPublish: bool(row, 'excluded_from_publish'),
        ambientEffect: asJson(row['ambient_effect_json'] ?? null, {
          effect: 'none',
          intensity: 0.5,
        }),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
      }),
    )
    .filter((s): s is NonNullable<typeof s> => s !== null);

  /* --- Catálogo --- */
  const assetClasses = db
    .all('SELECT * FROM asset_class ORDER BY code')
    .map((row) =>
      parse('asset_class', text(row, 'id'), assetClassSchema, {
        id: text(row, 'id'),
        code: text(row, 'code'),
        name: text(row, 'name'),
        description: text(row, 'description'),
        level: text(row, 'level'),
        attributes: asJson(row['attributes_json'] ?? null, []),
        icon: text(row, 'icon'),
        parentClassId: nullableText(row, 'parent_class_id'),
      }),
    )
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const assets = db
    .all('SELECT * FROM asset ORDER BY tag')
    .map((row) =>
      parse('asset', text(row, 'id'), assetSchema, {
        id: text(row, 'id'),
        projectId: text(row, 'project_id'),
        tag: text(row, 'tag'),
        name: text(row, 'name'),
        description: text(row, 'description'),
        classId: text(row, 'class_id'),
        level: text(row, 'level'),
        parentId: nullableText(row, 'parent_id'),
        attributes: asJson(row['attributes_json'] ?? null, {}),
        revision: num(row, 'revision', 1),
        status: text(row, 'status'),
        criticality: nullableText(row, 'criticality'),
        manufacturer: text(row, 'manufacturer'),
        model: text(row, 'model'),
        serialNumber: text(row, 'serial_number'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
      }),
    )
    .filter((a): a is NonNullable<typeof a> => a !== null);

  const assetLocations = db
    .all('SELECT * FROM asset_location')
    .map((row) =>
      parse('asset_location', text(row, 'id'), assetLocationSchema, {
        id: text(row, 'id'),
        assetId: text(row, 'asset_id'),
        sceneId: text(row, 'scene_id'),
        hotspotId: nullableText(row, 'hotspot_id'),
        anchor: asJson(row['anchor_json'] ?? null, null),
        primary: bool(row, 'is_primary'),
        note: text(row, 'note'),
      }),
    )
    .filter((l): l is NonNullable<typeof l> => l !== null);

  const documents = db
    .all('SELECT * FROM technical_document ORDER BY created_at')
    .map((row) =>
      parse('technical_document', text(row, 'id'), technicalDocumentSchema, {
        id: text(row, 'id'),
        assetId: nullableText(row, 'asset_id'),
        title: text(row, 'title'),
        documentCode: text(row, 'document_code'),
        revision: text(row, 'revision'),
        status: text(row, 'status'),
        mediaId: text(row, 'media_id'),
        discipline: text(row, 'discipline'),
        issuedAt: nullableText(row, 'issued_at'),
        supersededById: nullableText(row, 'superseded_by_id'),
        createdAt: text(row, 'created_at'),
      }),
    )
    .filter((d): d is NonNullable<typeof d> => d !== null);

  /* --- Planos --- */
  const plans = db
    .all('SELECT * FROM plan ORDER BY floor_order, name')
    .map((row) =>
      parse('plan', text(row, 'id'), planSchema, {
        id: text(row, 'id'),
        name: text(row, 'name'),
        mediaId: text(row, 'media_id'),
        floor: text(row, 'floor'),
        floorOrder: num(row, 'floor_order'),
        orientation: asJson(row['orientation_json'] ?? null, null),
        showRadar: bool(row, 'show_radar'),
        radarApertureDeg: num(row, 'radar_aperture_deg', 60),
      }),
    )
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const planMarkers = db
    .all('SELECT * FROM plan_marker')
    .map((row) =>
      parse('plan_marker', text(row, 'id'), planMarkerSchema, {
        id: text(row, 'id'),
        planId: text(row, 'plan_id'),
        sceneId: text(row, 'scene_id'),
        position: { x: num(row, 'pos_x'), y: num(row, 'pos_y') },
        label: text(row, 'label'),
        headingRad: num(row, 'heading_rad'),
      }),
    )
    .filter((m): m is NonNullable<typeof m> => m !== null);

  /* --- Notas --- */
  const commentRows = db.all('SELECT * FROM note_comment ORDER BY note_id, created_at');
  const commentsByNote = new Map<string, unknown[]>();
  for (const row of commentRows) {
    const noteId = text(row, 'note_id');
    const parsed = parse('note_comment', text(row, 'id'), commentSchema, {
      id: text(row, 'id'),
      noteId,
      authorId: text(row, 'author_id'),
      authorName: text(row, 'author_name'),
      body: text(row, 'body'),
      attachments: asJson(row['attachments_json'] ?? null, []),
      createdAt: text(row, 'created_at'),
      editedAt: nullableText(row, 'edited_at'),
    });
    if (parsed === null) continue;
    const list = commentsByNote.get(noteId) ?? [];
    list.push(parsed);
    commentsByNote.set(noteId, list);
  }

  const notes = db
    .all('SELECT * FROM note ORDER BY created_at')
    .map((row) =>
      parse('note', text(row, 'id'), noteSchema, {
        id: text(row, 'id'),
        projectId: text(row, 'project_id'),
        title: text(row, 'title'),
        body: text(row, 'body'),
        anchor: asJson(row['anchor_json'] ?? null, null),
        sceneId: nullableText(row, 'scene_id'),
        assetId: nullableText(row, 'asset_id'),
        categoryId: text(row, 'category_id'),
        priority: text(row, 'priority'),
        status: text(row, 'status'),
        assigneeId: nullableText(row, 'assignee_id'),
        assigneeName: nullableText(row, 'assignee_name'),
        dueDate: nullableText(row, 'due_date'),
        attachments: asJson(row['attachments_json'] ?? null, []),
        comments: commentsByNote.get(text(row, 'id')) ?? [],
        authorId: text(row, 'author_id'),
        authorName: text(row, 'author_name'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
        resolvedAt: nullableText(row, 'resolved_at'),
        resolvedById: nullableText(row, 'resolved_by_id'),
        resolution: text(row, 'resolution'),
      }),
    )
    .filter((n): n is NonNullable<typeof n> => n !== null);

  const noteCategories = db
    .all('SELECT * FROM note_category ORDER BY label')
    .map((row) =>
      parse('note_category', text(row, 'id'), noteCategorySchema, {
        id: text(row, 'id'),
        label: text(row, 'label'),
        colorToken: text(row, 'color_token'),
        description: text(row, 'description'),
      }),
    )
    .filter((c): c is NonNullable<typeof c> => c !== null);

  /* --- Telemetría --- */
  const telemetryConnections = db
    .all('SELECT * FROM telemetry_connection')
    .map((row) =>
      parse('telemetry_connection', text(row, 'id'), influxConnectionSchema, {
        id: text(row, 'id'),
        name: text(row, 'name'),
        url: text(row, 'url'),
        org: text(row, 'org'),
        bucket: text(row, 'bucket'),
        tokenRef: { keyId: text(row, 'token_key_id'), label: text(row, 'token_label') },
        timeoutMs: num(row, 'timeout_ms', 8000),
        verifyTls: bool(row, 'verify_tls'),
        tlsExemptionReason: text(row, 'tls_exemption_reason'),
        enabled: bool(row, 'enabled'),
      }),
    )
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const telemetryMappings = db
    .all('SELECT * FROM telemetry_mapping ORDER BY variable')
    .map((row) =>
      parse('telemetry_mapping', text(row, 'id'), telemetryMappingSchema, {
        id: text(row, 'id'),
        connectionId: text(row, 'connection_id'),
        assetId: text(row, 'asset_id'),
        variable: text(row, 'variable'),
        instrumentTag: nullableText(row, 'instrument_tag'),
        measurement: text(row, 'measurement'),
        field: text(row, 'field'),
        tags: asJson(row['tags_json'] ?? null, {}),
        unit: text(row, 'unit'),
        decimals: num(row, 'decimals', 2),
        freshnessSeconds: num(row, 'freshness_seconds', 300),
        aggregation: text(row, 'aggregation'),
        displayMin: nullableNum(row, 'display_min'),
        displayMax: nullableNum(row, 'display_max'),
        enabled: bool(row, 'enabled'),
      }),
    )
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const conditionRules = db
    .all('SELECT * FROM condition_rule ORDER BY mapping_id, rule_order')
    .map((row) =>
      parse('condition_rule', text(row, 'id'), conditionRuleSchema, {
        id: text(row, 'id'),
        mappingId: text(row, 'mapping_id'),
        label: text(row, 'label'),
        comparison: text(row, 'comparison'),
        threshold: num(row, 'threshold'),
        threshold2: nullableNum(row, 'threshold2'),
        level: text(row, 'level'),
        hysteresis: num(row, 'hysteresis'),
        order: num(row, 'rule_order'),
        enabled: bool(row, 'enabled'),
      }),
    )
    .filter((r): r is NonNullable<typeof r> => r !== null);

  /* --- Ventanas de información --- */
  const infoWindows = db
    .all('SELECT * FROM info_window ORDER BY name')
    .map((row) =>
      parse('info_window', text(row, 'id'), infoWindowSchema, {
        id: text(row, 'id'),
        name: text(row, 'name'),
        title: text(row, 'title'),
        tabs: asJson(row['tabs_json'] ?? null, []),
        widthPx: num(row, 'width_px', 720),
        heightPx: num(row, 'height_px', 520),
        modal: bool(row, 'modal'),
        onCloseActions: asJson(row['on_close_json'] ?? null, []),
      }),
    )
    .filter((w): w is NonNullable<typeof w> => w !== null);

  /* --- Interfaces, recorridos y evaluaciones --- */
  const skins = db
    .all('SELECT * FROM skin ORDER BY name')
    .map((row) =>
      parse('skin', text(row, 'id'), skinSchema, {
        id: text(row, 'id'),
        name: text(row, 'name'),
        description: text(row, 'description'),
        layoutMode: text(row, 'layout_mode'),
        designWidth: num(row, 'design_width', 1920),
        designHeight: num(row, 'design_height', 1080),
        root: asJson(row['root_json'] ?? null, []),
        templateId: nullableText(row, 'template_id'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
      }),
    )
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const tours = db
    .all('SELECT * FROM tour ORDER BY name')
    .map((row) =>
      parse('tour', text(row, 'id'), tourSchema, {
        id: text(row, 'id'),
        projectId: text(row, 'project_id'),
        name: text(row, 'name'),
        description: text(row, 'description'),
        waypoints: asJson(row['waypoints_json'] ?? null, []),
        loop: bool(row, 'loop_tour'),
        allowInterrupt: bool(row, 'allow_interrupt'),
        resumeAfterInterrupt: bool(row, 'resume_after_interrupt'),
        autoResumeIdleS: num(row, 'auto_resume_idle_s'),
        requiresQuizId: nullableText(row, 'requires_quiz_id'),
        requiresQuizMinScore: nullableNum(row, 'requires_quiz_min_score'),
        onStart: asJson(row['on_start_json'] ?? null, []),
        onEnd: asJson(row['on_end_json'] ?? null, []),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
      }),
    )
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const quizzes = db
    .all('SELECT * FROM quiz ORDER BY name')
    .map((row) =>
      parse('quiz', text(row, 'id'), quizSchema, {
        id: text(row, 'id'),
        projectId: text(row, 'project_id'),
        name: text(row, 'name'),
        description: text(row, 'description'),
        questions: asJson(row['questions_json'] ?? null, []),
        entryQuestionId: nullableText(row, 'entry_question_id'),
        goals: asJson(row['goals_json'] ?? null, []),
        passingScores: asJson(row['passing_scores_json'] ?? null, {}),
        immediateFeedback: bool(row, 'immediate_feedback'),
        shuffleQuestions: bool(row, 'shuffle_questions'),
        shuffleChoices: bool(row, 'shuffle_choices'),
        showReport: bool(row, 'show_report'),
        createdAt: text(row, 'created_at'),
        updatedAt: text(row, 'updated_at'),
      }),
    )
    .filter((q): q is NonNullable<typeof q> => q !== null);

  /* --- Usuarios, permisos y auditoría --- */
  const users = db
    .all('SELECT * FROM app_user ORDER BY display_name')
    .map((row) =>
      parse('app_user', text(row, 'id'), userSchema, {
        id: text(row, 'id'),
        displayName: text(row, 'display_name'),
        email: nullableText(row, 'email'),
        active: bool(row, 'active'),
        lastSeenAt: nullableText(row, 'last_seen_at'),
        createdAt: text(row, 'created_at'),
      }),
    )
    .filter((u): u is NonNullable<typeof u> => u !== null);

  const grants = db
    .all('SELECT * FROM access_grant')
    .map((row) =>
      parse('access_grant', text(row, 'id'), grantSchema, {
        id: text(row, 'id'),
        userId: text(row, 'user_id'),
        role: text(row, 'role'),
        scope: asJson(row['scope_json'] ?? null, null),
        grantedBy: text(row, 'granted_by'),
        grantedAt: text(row, 'granted_at'),
        expiresAt: nullableText(row, 'expires_at'),
      }),
    )
    .filter((g): g is NonNullable<typeof g> => g !== null);

  const auditLog = db
    .all('SELECT * FROM audit_event ORDER BY timestamp DESC LIMIT 5000')
    .map((row) =>
      parse('audit_event', text(row, 'id'), auditEventSchema, {
        id: text(row, 'id'),
        actor: text(row, 'actor'),
        actorName: text(row, 'actor_name'),
        action: text(row, 'action'),
        entity: text(row, 'entity'),
        entityId: nullableText(row, 'entity_id'),
        beforeHash: nullableText(row, 'before_hash'),
        afterHash: nullableText(row, 'after_hash'),
        summary: text(row, 'summary'),
        reason: nullableText(row, 'reason'),
        timestamp: text(row, 'timestamp'),
      }),
    )
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const candidate = {
    id: text(projectRow, 'id'),
    schemaVersion: num(projectRow, 'schema_version', CURRENT_SCHEMA_VERSION),
    title: text(projectRow, 'title'),
    description: text(projectRow, 'description'),
    client: text(projectRow, 'client'),
    site: text(projectRow, 'site'),
    publicationState: text(projectRow, 'publication_state'),
    settings,
    media,
    scenes,
    plans,
    planMarkers,
    assetClasses,
    assets,
    assetLocations,
    documents,
    noteCategories,
    notes,
    telemetryConnections,
    telemetryMappings,
    conditionRules,
    infoWindows,
    skins,
    tours,
    quizzes,
    users,
    grants,
    auditLog,
    createdAt: text(projectRow, 'created_at'),
    updatedAt: text(projectRow, 'updated_at'),
    savedByVersion: text(projectRow, 'saved_by_version'),
  };

  const parsed = projectSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      domainError('VALIDATION_FAILED', 'El proyecto no cumple el contrato de datos', {
        detail: { issues: describeZodError(parsed.error) },
        recovery:
          'El archivo puede estar dañado. Pruebe a abrir una copia de respaldo del proyecto.',
      }),
    );
  }

  return ok({ project: parsed.data, warnings });
}

/* ------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------ */

/**
 * Tablas en el orden en que deben vaciarse.
 *
 * El orden es el inverso de las dependencias: los hijos antes que los padres.
 * Con `foreign_keys = ON`, borrar al revés aborta la transacción, y con las
 * claves desactivadas dejaría filas huérfanas.
 *
 * `audit_event` NO está en la lista: sus disparadores prohíben el borrado, y
 * eso es lo que la convierte en auditoría. Los eventos se añaden, nunca se
 * reescriben.
 */
const CLEAR_ORDER = [
  'condition_rule',
  'telemetry_cache',
  'telemetry_mapping',
  'telemetry_connection',
  'note_comment',
  'note',
  'note_category',
  'plan_marker',
  'plan',
  'technical_document',
  'asset_location',
  'hotspot',
  'scene',
  'asset',
  'asset_class',
  'info_window',
  'skin',
  'tour',
  'quiz',
  'access_grant',
  'app_user',
  'media',
  'project',
] as const;

export interface SaveOptions {
  readonly appVersion: string;
  readonly now: string;
  /**
   * Permite escribir referencias que no resuelven.
   *
   * Sólo se activa en el guardado forzado, cuando el usuario decide
   * conservar el trabajo pese a los problemas de integridad. Con las claves
   * externas activas, una escena que apunta a un medio borrado aborta la
   * transacción entera y el usuario pierde todo lo demás. Desactivarlas para
   * esa escritura conserva el proyecto tal cual está —referencias rotas
   * incluidas— y deja que `checkIntegrity` se lo explique al abrir, que es
   * donde puede corregirlo. La alternativa, poner a nulo lo que no resuelve,
   * destruiría la pista de qué medio hay que volver a importar.
   */
  readonly allowDanglingReferences?: boolean;
}

export function saveProject(
  db: SqlDatabase,
  project: Project,
  options: SaveOptions,
): Result<{ rowsWritten: number }> {
  try {
    let rows = 0;

    if (options.allowDanglingReferences === true) db.exec('PRAGMA foreign_keys = OFF');

    db.transaction(() => {
      for (const table of CLEAR_ORDER) db.run(`DELETE FROM ${table}`);

      const insert = (sql: string, params: readonly SqlValue[]): void => {
        db.run(sql, params);
        rows += 1;
      };

      insert(
        `INSERT INTO project (id, singleton, schema_version, title, description, client, site,
           publication_state, settings_json, created_at, updated_at, saved_by_version)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project.id,
          CURRENT_SCHEMA_VERSION,
          project.title,
          project.description,
          project.client,
          project.site,
          project.publicationState,
          toJson(project.settings),
          project.createdAt,
          options.now,
          options.appVersion,
        ],
      );

      for (const m of project.media) {
        insert(
          `INSERT INTO media (id, sha256, mime, kind, relative_path, original_name, byte_size,
             width, height, duration_s, thumbnail_path, panorama_json, tiles_json,
             renditions_json, quarantined, quarantine_reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            m.id, m.sha256, m.mime, m.kind, m.relativePath, m.originalName, m.byteSize,
            m.width, m.height, m.durationS, m.thumbnailPath,
            m.panorama === null ? null : toJson(m.panorama), toJson(m.tiles),
            toJson(m.renditions),
            toInt(m.quarantined), m.quarantineReason, m.createdAt,
          ],
        );
      }

      for (const c of project.assetClasses) {
        insert(
          `INSERT INTO asset_class (id, code, name, description, level, attributes_json, icon, parent_class_id)
           VALUES (?,?,?,?,?,?,?,?)`,
          [c.id, c.code, c.name, c.description, c.level, toJson(c.attributes), c.icon, c.parentClassId],
        );
      }

      // Los activos se insertan por profundidad para que el padre exista antes
      // que el hijo: la clave externa `parent_id` se comprueba en el acto.
      for (const a of sortByHierarchy(project.assets)) {
        insert(
          `INSERT INTO asset (id, project_id, tag, name, description, class_id, level, parent_id,
             attributes_json, revision, status, criticality, manufacturer, model, serial_number,
             created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            a.id, a.projectId, a.tag, a.name, a.description, a.classId, a.level, a.parentId,
            toJson(a.attributes), a.revision, a.status, a.criticality,
            a.manufacturer, a.model, a.serialNumber, a.createdAt, a.updatedAt,
          ],
        );
      }

      for (const s of project.scenes) {
        insert(
          `INSERT INTO scene (id, project_id, kind, title, description, media_id, camera_json,
             model_json, actions_json, scene_order, scene_group, tags_json,
             excluded_from_publish, ambient_effect_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            s.id, s.projectId, s.kind, s.title, s.description, s.mediaId, toJson(s.camera),
            s.model === null ? null : toJson(s.model), toJson(s.actions), s.order, s.group,
            toJson(s.tags), toInt(s.excludedFromPublish), toJson(s.ambientEffect),
            s.createdAt, s.updatedAt,
          ],
        );
      }

      for (const s of project.scenes) {
        for (const h of s.hotspots) {
          insert(
            `INSERT INTO hotspot (id, scene_id, name, anchor_json, geometry_json, style_json,
               actions_json, asset_id, visibility_json, preload, locked, hidden_in_editor,
               tags_json, auto_generated, auto_confidence, reviewed, hotspot_order,
               created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              h.id, h.sceneId, h.name, toJson(h.anchor), toJson(h.geometry), toJson(h.style),
              toJson(h.actions), h.assetId, toJson(h.visibility), h.preload,
              toInt(h.locked), toInt(h.hiddenInEditor), toJson(h.tags),
              toInt(h.autoGenerated), h.autoConfidence, toInt(h.reviewed), h.order,
              h.createdAt, h.updatedAt,
            ],
          );
        }
      }

      for (const l of project.assetLocations) {
        insert(
          `INSERT INTO asset_location (id, asset_id, scene_id, hotspot_id, anchor_json, is_primary, note)
           VALUES (?,?,?,?,?,?,?)`,
          [l.id, l.assetId, l.sceneId, l.hotspotId, toJson(l.anchor), toInt(l.primary), l.note],
        );
      }

      // Los documentos se insertan en dos pasadas: primero sin el vínculo
      // `superseded_by_id` y luego actualizándolo. Una cadena de revisiones
      // puede referenciar un documento que viene después en la lista.
      for (const d of project.documents) {
        insert(
          `INSERT INTO technical_document (id, asset_id, title, document_code, revision, status,
             media_id, discipline, issued_at, superseded_by_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
          [d.id, d.assetId, d.title, d.documentCode, d.revision, d.status, d.mediaId,
            d.discipline, d.issuedAt, d.createdAt],
        );
      }
      for (const d of project.documents) {
        if (d.supersededById === null) continue;
        db.run('UPDATE technical_document SET superseded_by_id = ? WHERE id = ?', [
          d.supersededById,
          d.id,
        ]);
      }

      for (const p of project.plans) {
        insert(
          `INSERT INTO plan (id, name, media_id, floor, floor_order, orientation_json, show_radar, radar_aperture_deg)
           VALUES (?,?,?,?,?,?,?,?)`,
          [p.id, p.name, p.mediaId, p.floor, p.floorOrder, toJson(p.orientation), toInt(p.showRadar), p.radarApertureDeg],
        );
      }

      for (const m of project.planMarkers) {
        insert(
          `INSERT INTO plan_marker (id, plan_id, scene_id, pos_x, pos_y, label, heading_rad)
           VALUES (?,?,?,?,?,?,?)`,
          [m.id, m.planId, m.sceneId, m.position.x, m.position.y, m.label, m.headingRad],
        );
      }

      for (const c of project.noteCategories) {
        insert(
          'INSERT INTO note_category (id, label, color_token, description) VALUES (?,?,?,?)',
          [c.id, c.label, c.colorToken, c.description],
        );
      }

      for (const n of project.notes) {
        insert(
          `INSERT INTO note (id, project_id, title, body, anchor_json, scene_id, asset_id,
             category_id, priority, status, assignee_id, assignee_name, due_date,
             attachments_json, author_id, author_name, created_at, updated_at,
             resolved_at, resolved_by_id, resolution)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            n.id, n.projectId, n.title, n.body, n.anchor === null ? null : toJson(n.anchor),
            n.sceneId, n.assetId, n.categoryId, n.priority, n.status,
            n.assigneeId, n.assigneeName, n.dueDate, toJson(n.attachments),
            n.authorId, n.authorName, n.createdAt, n.updatedAt,
            n.resolvedAt, n.resolvedById, n.resolution,
          ],
        );
        for (const comment of n.comments) {
          insert(
            `INSERT INTO note_comment (id, note_id, author_id, author_name, body, attachments_json, created_at, edited_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [comment.id, comment.noteId, comment.authorId, comment.authorName, comment.body,
              toJson(comment.attachments), comment.createdAt, comment.editedAt],
          );
        }
      }

      for (const c of project.telemetryConnections) {
        insert(
          `INSERT INTO telemetry_connection (id, name, url, org, bucket, token_key_id, token_label,
             timeout_ms, verify_tls, tls_exemption_reason, enabled)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, c.name, c.url, c.org, c.bucket, c.tokenRef.keyId, c.tokenRef.label,
            c.timeoutMs, toInt(c.verifyTls), c.tlsExemptionReason, toInt(c.enabled)],
        );
      }

      for (const m of project.telemetryMappings) {
        insert(
          `INSERT INTO telemetry_mapping (id, connection_id, asset_id, variable, instrument_tag,
             measurement, field, tags_json, unit, decimals, freshness_seconds, aggregation,
             display_min, display_max, enabled)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [m.id, m.connectionId, m.assetId, m.variable, m.instrumentTag, m.measurement, m.field,
            toJson(m.tags), m.unit, m.decimals, m.freshnessSeconds, m.aggregation,
            m.displayMin, m.displayMax, toInt(m.enabled)],
        );
      }

      for (const r of project.conditionRules) {
        insert(
          `INSERT INTO condition_rule (id, mapping_id, label, comparison, threshold, threshold2,
             level, hysteresis, rule_order, enabled)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [r.id, r.mappingId, r.label, r.comparison, r.threshold, r.threshold2, r.level,
            r.hysteresis, r.order, toInt(r.enabled)],
        );
      }

      for (const w of project.infoWindows) {
        insert(
          `INSERT INTO info_window (id, name, title, tabs_json, width_px, height_px, modal,
             on_close_json)
           VALUES (?,?,?,?,?,?,?,?)`,
          [w.id, w.name, w.title, toJson(w.tabs), w.widthPx, w.heightPx, toInt(w.modal),
            toJson(w.onCloseActions)],
        );
      }

      for (const s of project.skins) {
        insert(
          `INSERT INTO skin (id, name, description, layout_mode, design_width, design_height,
             root_json, template_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [s.id, s.name, s.description, s.layoutMode, s.designWidth, s.designHeight,
            toJson(s.root), s.templateId, s.createdAt, s.updatedAt],
        );
      }

      for (const t of project.tours) {
        insert(
          `INSERT INTO tour (id, project_id, name, description, waypoints_json, loop_tour,
             allow_interrupt, resume_after_interrupt, auto_resume_idle_s, requires_quiz_id,
             requires_quiz_min_score, on_start_json, on_end_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [t.id, t.projectId, t.name, t.description, toJson(t.waypoints), toInt(t.loop),
            toInt(t.allowInterrupt), toInt(t.resumeAfterInterrupt), t.autoResumeIdleS,
            t.requiresQuizId, t.requiresQuizMinScore, toJson(t.onStart), toJson(t.onEnd),
            t.createdAt, t.updatedAt],
        );
      }

      for (const q of project.quizzes) {
        insert(
          `INSERT INTO quiz (id, project_id, name, description, questions_json, entry_question_id,
             goals_json, passing_scores_json, immediate_feedback, shuffle_questions,
             shuffle_choices, show_report, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [q.id, q.projectId, q.name, q.description, toJson(q.questions), q.entryQuestionId,
            toJson(q.goals), toJson(q.passingScores), toInt(q.immediateFeedback),
            toInt(q.shuffleQuestions), toInt(q.shuffleChoices), toInt(q.showReport),
            q.createdAt, q.updatedAt],
        );
      }

      for (const u of project.users) {
        insert(
          'INSERT INTO app_user (id, display_name, email, active, last_seen_at, created_at) VALUES (?,?,?,?,?,?)',
          [u.id, u.displayName, u.email, toInt(u.active), u.lastSeenAt, u.createdAt],
        );
      }

      for (const g of project.grants) {
        insert(
          'INSERT INTO access_grant (id, user_id, role, scope_json, granted_by, granted_at, expires_at) VALUES (?,?,?,?,?,?,?)',
          [g.id, g.userId, g.role, toJson(g.scope), g.grantedBy, g.grantedAt, g.expiresAt],
        );
      }

      // La auditoría sólo admite altas: se insertan los eventos que aún no
      // están, y los existentes se dejan como están.
      for (const e of project.auditLog) {
        const existing = db.get('SELECT id FROM audit_event WHERE id = ?', [e.id]);
        if (existing !== null) continue;
        insert(
          `INSERT INTO audit_event (id, actor, actor_name, action, entity, entity_id,
             before_hash, after_hash, summary, reason, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [e.id, e.actor, e.actorName, e.action, e.entity, e.entityId,
            e.beforeHash, e.afterHash, e.summary, e.reason, e.timestamp],
        );
      }
    });

    return ok({ rowsWritten: rows });
  } catch (cause) {
    return err(
      domainError('STORAGE_FAILED', 'No se pudo guardar el proyecto en la base de datos', {
        detail: { cause: String(cause) },
        recovery:
          'No se ha modificado el archivo en disco. Revise los avisos de integridad y vuelva a intentarlo.',
      }),
    );
  } finally {
    // Las claves externas vuelven a estar activas pase lo que pase: una base
    // que se quedara sin ellas aceptaría en silencio cualquier incoherencia
    // en las escrituras siguientes.
    if (options.allowDanglingReferences === true) db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Ordena los activos de modo que cada padre preceda a sus hijos.
 *
 * Sin esto, insertar un activo cuyo padre viene después en la lista viola la
 * clave externa `parent_id`. El recorrido tolera ciclos: lo que no se puede
 * ordenar se añade al final, y la validación del dominio ya reporta el ciclo
 * como problema de integridad.
 */
function sortByHierarchy<T extends { id: string; parentId: string | null }>(
  assets: readonly T[],
): T[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const emitted = new Set<string>();
  const result: T[] = [];

  const visit = (asset: T, guard: Set<string>): void => {
    if (emitted.has(asset.id) || guard.has(asset.id)) return;
    guard.add(asset.id);
    if (asset.parentId !== null) {
      const parent = byId.get(asset.parentId);
      if (parent !== undefined) visit(parent, guard);
    }
    if (!emitted.has(asset.id)) {
      emitted.add(asset.id);
      result.push(asset);
    }
  };

  for (const asset of assets) visit(asset, new Set());
  for (const asset of assets) {
    if (!emitted.has(asset.id)) result.push(asset);
  }
  return result;
}

/** Resume un error de Zod en una línea legible. */
function describeZodError(error: unknown): string {
  if (error === null || typeof error !== 'object') return 'error desconocido';
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return 'error desconocido';
  return issues
    .slice(0, 3)
    .map((i) => `${(i.path ?? []).join('.') || 'raíz'}: ${i.message ?? 'inválido'}`)
    .join('; ');
}
