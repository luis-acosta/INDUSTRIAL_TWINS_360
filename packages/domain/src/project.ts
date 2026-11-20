/**
 * Proyecto: el agregado raíz y el formato de intercambio.
 *
 * `Project` es el estado completo que el editor manipula y que el historial
 * de deshacer recorre. `Manifest` es lo que viaja dentro del paquete `.ivp`
 * y lo que el visor publicado lee.
 *
 * Son dos tipos y no uno porque sirven a propósitos opuestos: el proyecto
 * incluye todo lo necesario para editar —propuestas automáticas sin revisar,
 * escenas excluidas, aprobaciones de script, conexiones de telemetría—, y el
 * manifiesto publicado debe contener lo mínimo y nada sensible. Si fueran el
 * mismo tipo, publicar sería «serializar», y el día que alguien añada un
 * campo con un token, ese token acabaría en la carpeta que se sube al
 * servidor web.
 */
import { z } from 'zod';
import { sha256Schema, mediaSchema, publishQualitySchema } from './media';
import { assetClassSchema, assetLocationSchema, assetSchema, technicalDocumentSchema } from './asset';
import { noteCategorySchema, noteSchema } from './note';
import { planMarkerSchema, planSchema, sceneSchema, type Scene } from './scene';
import { skinSchema, walkSkin } from './skin';
import { infoWindowSchema, referencedWindowIds, type InfoWindow } from './info-window';
import type { Action } from './action';
import { quizSchema, tourSchema } from './tour';
import {
  conditionRuleSchema,
  influxConnectionSchema,
  telemetryMappingSchema,
} from './telemetry';
import { scriptingPolicySchema, DEFAULT_SCRIPTING_POLICY } from './scripting';
import { auditEventSchema, grantSchema, publicationStateSchema, userSchema } from './access';
import { tagUniquenessScopeSchema, uuidSchema } from './identity';

/**
 * Versión del esquema de proyecto.
 *
 * Se incrementa en cada cambio incompatible, y cada incremento necesita su
 * migración ascendente registrada en `@it360/persistence`. La numeración es
 * independiente de la versión del producto: ésta es la primera versión
 * publicada del formato, de modo que vale 1 aunque la aplicación sea 0.14.
 * Inventar un número alto implicaría migraciones que no existen, y la primera
 * vez que alguien abriera un proyecto antiguo de verdad se encontraría con
 * que el salto no está cubierto.
 *
 * Un proyecto con una versión MAYOR que la de la aplicación no se abre:
 * adivinar el significado de campos que todavía no existían es la forma más
 * rápida de corromper el trabajo de alguien. Se avisa y se ofrece actualizar
 * la aplicación.
 */
export const CURRENT_SCHEMA_VERSION = 3;

/** Versión mínima que las migraciones saben leer. */
export const MINIMUM_SCHEMA_VERSION = 1;

export const PROJECT_FORMAT = 'industrial-twins-360' as const;

/* ------------------------------------------------------------------ *
 * Ajustes del proyecto
 * ------------------------------------------------------------------ */

export const projectSettingsSchema = z.object({
  /** Alcance en que se exige TAG único (X01). */
  tagUniquenessScope: tagUniquenessScopeSchema.default('plant'),
  /** Idioma de la interfaz del recorrido publicado. */
  language: z.string().max(16).default('es'),
  /** Zona horaria para presentar timestamps. Los datos van en UTC. */
  displayTimeZone: z.string().max(64).default('America/Bogota'),
  /** Calidad de publicación por defecto (V01). */
  publishQuality: publishQualitySchema.default({
    format: 'webp',
    quality: 82,
    maxEdgePx: 8192,
    tiled: true,
    tileSizePx: 512,
    includeFallback: true,
  }),
  scripting: scriptingPolicySchema.default(DEFAULT_SCRIPTING_POLICY),
  /**
   * Habilita los algoritmos experimentales: conexión automática de panoramas
   * (C05-C09) y cosido (etapa 12). Desactivado por defecto porque el plan los
   * declara no triviales y exige revisión humana de sus resultados.
   */
  experimentalFeatures: z.boolean().default(false),
  /**
   * Inactividad antes de disparar las acciones de `idle`, en milisegundos
   * (J04).
   *
   * Es un ajuste del proyecto y no una constante porque el ritmo depende del
   * recorrido: una formación guiada quiere recuperar la atención en veinte
   * segundos, y un panel de sala de control que alguien mira de reojo durante
   * un turno, no. Treinta segundos por omisión es lo que distingue «está
   * leyendo» de «se levantó de la mesa».
   *
   * Campo opcional con valor por omisión: un proyecto guardado por una versión
   * anterior se abre sin migración.
   */
  idleTimeoutMs: z.number().int().min(5_000).max(600_000).default(30_000),
  /** Escena de entrada del recorrido. */
  entrySceneId: uuidSchema.nullable().default(null),
  /** Skin aplicado por defecto. */
  defaultSkinId: uuidSchema.nullable().default(null),
  /** Marca propia del visor publicado (S10). */
  branding: z
    .object({
      logoMediaId: uuidSchema.nullable().default(null),
      title: z.string().max(200).default(''),
      accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .default(null),
      faviconMediaId: uuidSchema.nullable().default(null),
    })
    .default({ logoMediaId: null, title: '', accentColor: null, faviconMediaId: null }),
  /** Minutos entre guardados automáticos. 0 = desactivado. */
  autosaveMinutes: z.number().int().min(0).max(120).default(5),
  /**
   * Copias de respaldo que se conservan al guardar.
   *
   * Tres es el mínimo útil: la anterior al guardado actual, y dos más para
   * cubrir el caso en que el usuario guarda dos veces antes de darse cuenta
   * de que se equivocó. Con una sola copia, un segundo guardado destruye la
   * única versión buena.
   */
  backupCount: z.number().int().min(0).max(20).default(3),
});

/* ------------------------------------------------------------------ *
 * Proyecto
 * ------------------------------------------------------------------ */

export const projectSchema = z.object({
  id: uuidSchema,
  schemaVersion: z.number().int().min(1),
  title: z.string().min(1).max(250),
  description: z.string().max(8000).default(''),
  /** Cliente o instalación a la que corresponde. */
  client: z.string().max(250).default(''),
  site: z.string().max(250).default(''),
  publicationState: publicationStateSchema.default('draft'),

  settings: projectSettingsSchema,

  media: z.array(mediaSchema).default([]),
  scenes: z.array(sceneSchema).default([]),
  plans: z.array(planSchema).default([]),
  planMarkers: z.array(planMarkerSchema).default([]),

  assetClasses: z.array(assetClassSchema).default([]),
  assets: z.array(assetSchema).default([]),
  assetLocations: z.array(assetLocationSchema).default([]),
  documents: z.array(technicalDocumentSchema).default([]),

  noteCategories: z.array(noteCategorySchema).default([]),
  notes: z.array(noteSchema).default([]),

  telemetryConnections: z.array(influxConnectionSchema).default([]),
  telemetryMappings: z.array(telemetryMappingSchema).default([]),
  conditionRules: z.array(conditionRuleSchema).default([]),

  infoWindows: z.array(infoWindowSchema).default([]),
  skins: z.array(skinSchema).default([]),
  tours: z.array(tourSchema).default([]),
  quizzes: z.array(quizSchema).default([]),

  users: z.array(userSchema).default([]),
  grants: z.array(grantSchema).default([]),
  auditLog: z.array(auditEventSchema).default([]),

  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** Versión de la aplicación que guardó por última vez. */
  savedByVersion: z.string().max(40).default(''),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

/* ------------------------------------------------------------------ *
 * Manifiesto publicado
 * ------------------------------------------------------------------ */

/**
 * Campos que NUNCA deben aparecer en un manifiesto publicado.
 *
 * La lista se usa en la construcción del manifiesto y en una prueba que
 * recorre el JSON resultante buscándolos. Es una comprobación mecánica de
 * algo que de otro modo depende de que nadie se despiste al añadir un campo.
 */
export const FORBIDDEN_MANIFEST_KEYS = [
  'tokenRef',
  'token',
  'password',
  'secret',
  'apiKey',
  'credential',
  'auditLog',
  'grants',
  'users',
  'approvals',
] as const;

export const manifestSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  schemaVersion: z.number().int().min(1),
  projectId: uuidSchema,
  title: z.string().min(1).max(250),
  description: z.string().max(8000).default(''),
  entrySceneId: uuidSchema.nullable(),
  /** Momento de la publicación. */
  publishedAt: z.string().datetime({ offset: true }),
  publishedByVersion: z.string().max(40).default(''),
  /** Contenido del recorrido, ya filtrado de lo no publicable. */
  scenes: z.array(sceneSchema),
  plans: z.array(planSchema),
  planMarkers: z.array(planMarkerSchema),
  media: z.array(mediaSchema),
  assets: z.array(assetSchema),
  assetClasses: z.array(assetClassSchema),
  assetLocations: z.array(assetLocationSchema),
  documents: z.array(technicalDocumentSchema),
  /**
   * Sólo las ventanas a las que apunta alguna acción publicable.
   *
   * Una ventana que el autor dejó a medias y no abre nadie no tiene por qué
   * viajar en el paquete: su contenido puede ser un borrador interno.
   */
  infoWindows: z.array(infoWindowSchema).default([]),
  skins: z.array(skinSchema),
  /**
   * Interfaz que el visor dibuja, de entre las publicadas.
   *
   * Sin esto el visor tendría que adivinar cuál usar cuando hay varias, y la
   * que el autor marcó por omisión es un dato del proyecto, no del visor.
   */
  defaultSkinId: uuidSchema.nullable().default(null),
  tours: z.array(tourSchema),
  quizzes: z.array(quizSchema),
  noteCategories: z.array(noteCategorySchema),
  /**
   * Mapeos de telemetría SIN datos de conexión. El visor publicado pide los
   * valores a un servicio por el identificador de mapeo; nunca conoce la URL,
   * la organización ni el token.
   */
  telemetryMappings: z.array(
    telemetryMappingSchema.omit({ connectionId: true }).extend({
      /** Endpoint relativo del servicio opcional de telemetría. */
      serviceEndpoint: z.string().max(500).default('/api/v1/telemetry'),
    }),
  ),
  conditionRules: z.array(conditionRuleSchema),
  branding: z.object({
    logoPath: z.string().nullable(),
    title: z.string().max(200),
    accentColor: z.string().nullable(),
    faviconPath: z.string().nullable(),
  }),
  /** `true` si el paquete se generó para funcionar sin red (S05). */
  offlineCapable: z.boolean().default(true),
  /** SHA-256 del archivo de checksums, para verificar el paquete completo. */
  checksumsSha256: sha256Schema.nullable().default(null),
  /**
   * Orígenes que el recorrido puede enmarcar (E08, D06).
   *
   * Los escribe el exportador a partir de los Webframes que el autor declaró,
   * y son los mismos que entran en `frame-src` de la política de seguridad.
   * El visor los lee para poder explicar por qué un marco no se muestra, en
   * lugar de dejar un hueco que el navegador bloqueó en silencio.
   */
  frameOrigins: z.array(z.string().max(300)).default([]),
  /**
   * Inactividad antes de disparar las acciones de `idle`, en ms (J04).
   *
   * Viaja en el manifiesto porque el visor publicado es quien las dispara, y
   * es un ajuste del recorrido: sin él, el visor tendría que suponer un valor
   * y el que el autor configuró en el editor no se aplicaría. Lleva valor por
   * omisión para que un paquete publicado por una versión anterior siga
   * abriéndose.
   */
  idleTimeoutMs: z.number().int().min(5_000).max(600_000).default(30_000),
});

export type Manifest = z.infer<typeof manifestSchema>;

/* ------------------------------------------------------------------ *
 * Construcción
 * ------------------------------------------------------------------ */

export interface NewProjectInput {
  readonly id: string;
  readonly title: string;
  readonly client?: string;
  readonly site?: string;
  readonly now: string;
  readonly appVersion: string;
  readonly noteCategories?: ReadonlyArray<z.infer<typeof noteCategorySchema>>;
}

/** Proyecto vacío, válido y abrible. */
export function createProject(input: NewProjectInput): Project {
  const settings = projectSettingsSchema.parse({});
  return projectSchema.parse({
    id: input.id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: input.title,
    description: '',
    client: input.client ?? '',
    site: input.site ?? '',
    publicationState: 'draft',
    settings,
    media: [],
    scenes: [],
    plans: [],
    planMarkers: [],
    assetClasses: [],
    assets: [],
    assetLocations: [],
    documents: [],
    noteCategories: input.noteCategories ?? [],
    notes: [],
    telemetryConnections: [],
    telemetryMappings: [],
    conditionRules: [],
    skins: [],
    tours: [],
    quizzes: [],
    users: [],
    grants: [],
    auditLog: [],
    createdAt: input.now,
    updatedAt: input.now,
    savedByVersion: input.appVersion,
  });
}

/* ------------------------------------------------------------------ *
 * Integridad referencial
 * ------------------------------------------------------------------ */

export interface IntegrityProblem {
  readonly severity: 'error' | 'warning';
  readonly entity: string;
  readonly entityId: string;
  readonly message: string;
  readonly recovery?: string;
}

/**
 * Comprueba la integridad referencial de un proyecto completo.
 *
 * Se ejecuta al abrir y antes de guardar. Es lo que separa «el archivo se
 * carga» de «el proyecto funciona»: un esquema válido puede contener un
 * marcador que navega a una escena borrada, y el usuario lo descubriría al
 * pulsarlo delante de un cliente.
 *
 * La distinción entre `error` y `warning` es operativa: un error impide
 * publicar, un aviso no. Una referencia rota es error; una propuesta
 * automática sin revisar es aviso.
 */
export function checkIntegrity(project: Project): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];

  const mediaIds = new Set(project.media.map((m) => m.id as string));
  const sceneIds = new Set(project.scenes.map((s) => s.id as string));
  const assetIds = new Set(project.assets.map((a) => a.id as string));
  const classIds = new Set(project.assetClasses.map((c) => c.id as string));
  const planIds = new Set(project.plans.map((p) => p.id as string));
  const mappingIds = new Set(project.telemetryMappings.map((m) => m.id as string));
  const connectionIds = new Set(project.telemetryConnections.map((c) => c.id as string));
  const quizIds = new Set(project.quizzes.map((q) => q.id as string));
  const categoryIds = new Set(project.noteCategories.map((c) => c.id));

  const requireMedia = (id: string | null, entity: string, entityId: string, what: string): void => {
    if (id !== null && !mediaIds.has(id)) {
      problems.push({
        severity: 'error',
        entity,
        entityId,
        message: `${what} referencia un archivo que no está en la biblioteca`,
        recovery: 'Vuelva a importar el archivo o elimine la referencia.',
      });
    }
  };

  if (project.settings.entrySceneId !== null && !sceneIds.has(project.settings.entrySceneId)) {
    problems.push({
      severity: 'error',
      entity: 'project',
      entityId: project.id,
      message: 'La escena de entrada del recorrido no existe',
      recovery: 'Elija otra escena de entrada en los ajustes del proyecto.',
    });
  }

  for (const scene of project.scenes) {
    requireMedia(scene.mediaId, 'scene', scene.id, `La escena «${scene.title}»`);

    for (const hotspot of scene.hotspots) {
      const label = `El marcador «${hotspot.name}» de «${scene.title}»`;

      if (hotspot.geometry.shape === 'icon') requireMedia(hotspot.geometry.mediaId, 'hotspot', hotspot.id, label);
      if (hotspot.geometry.shape === 'projectedImage' || hotspot.geometry.shape === 'model') {
        requireMedia(hotspot.geometry.mediaId, 'hotspot', hotspot.id, label);
      }

      if (hotspot.assetId !== null && !assetIds.has(hotspot.assetId)) {
        problems.push({
          severity: 'error',
          entity: 'hotspot',
          entityId: hotspot.id,
          message: `${label} está vinculado a un activo que no existe`,
          recovery: 'Vuelva a vincular el marcador o quite el vínculo.',
        });
      }

      if (hotspot.anchor.space === 'plan' && !planIds.has(hotspot.anchor.planId)) {
        problems.push({
          severity: 'error',
          entity: 'hotspot',
          entityId: hotspot.id,
          message: `${label} está anclado a un plano que no existe`,
        });
      }

      /* Un marcador pegado a una pieza en una escena que no es de modelo no
         tiene dónde pegarse: se dibujaría en ninguna parte. Que la pieza siga
         existiendo en el modelo no se puede saber aquí —hay que abrir el
         archivo— y lo comprueba el editor con las mallas cargadas. */
      if (hotspot.anchor.space === 'modelSurface' && scene.kind !== 'model') {
        problems.push({
          severity: 'error',
          entity: 'hotspot',
          entityId: hotspot.id,
          message: `${label} está pegado a una pieza, pero la escena no es de modelo`,
          recovery: 'Cambie el anclaje del marcador o el tipo de la escena.',
        });
      }

      if (hotspot.autoGenerated && !hotspot.reviewed) {
        problems.push({
          severity: 'warning',
          entity: 'hotspot',
          entityId: hotspot.id,
          message: `${label} es una propuesta automática sin revisar y no se publicará`,
          recovery: 'Revísela y confírmela para incluirla en la publicación.',
        });
      }

      for (const action of [...hotspot.actions, ...scene.actions]) {
        const cfg = action.config;
        if (cfg.type === 'goToScene' && !sceneIds.has(cfg.sceneId)) {
          problems.push({
            severity: 'error',
            entity: 'action',
            entityId: action.id,
            message: `${label} navega a una escena que no existe`,
            recovery: 'Elija otra escena destino o elimine la acción.',
          });
        }
        if ((cfg.type === 'openMedia' || cfg.type === 'playMedia' || cfg.type === 'downloadFile') && !mediaIds.has(cfg.mediaId)) {
          problems.push({
            severity: 'error',
            entity: 'action',
            entityId: action.id,
            message: `${label} abre un archivo que no está en la biblioteca`,
          });
        }
        if (cfg.type === 'showAsset' && !assetIds.has(cfg.assetId)) {
          problems.push({
            severity: 'error',
            entity: 'action',
            entityId: action.id,
            message: `${label} abre la ficha de un activo que no existe`,
          });
        }
        if (cfg.type === 'startQuiz' && !quizIds.has(cfg.quizId)) {
          problems.push({
            severity: 'error',
            entity: 'action',
            entityId: action.id,
            message: `${label} inicia una evaluación que no existe`,
          });
        }
        if (cfg.type === 'showPlan' && !planIds.has(cfg.planId)) {
          problems.push({
            severity: 'error',
            entity: 'action',
            entityId: action.id,
            message: `${label} abre un plano que no existe`,
          });
        }
      }
    }
  }

  for (const plan of project.plans) {
    requireMedia(plan.mediaId, 'plan', plan.id, `El plano «${plan.name}»`);
  }

  for (const marker of project.planMarkers) {
    if (!planIds.has(marker.planId)) {
      problems.push({
        severity: 'error',
        entity: 'planMarker',
        entityId: marker.id,
        message: 'Un punto de plano pertenece a un plano que no existe',
      });
    }
    if (!sceneIds.has(marker.sceneId)) {
      problems.push({
        severity: 'error',
        entity: 'planMarker',
        entityId: marker.id,
        message: `El punto «${marker.label || marker.id}» lleva a una escena que no existe`,
      });
    }
  }

  for (const asset of project.assets) {
    if (!classIds.has(asset.classId)) {
      problems.push({
        severity: 'error',
        entity: 'asset',
        entityId: asset.id,
        message: `El activo ${asset.tag} pertenece a una clase que no existe`,
        recovery: 'Asigne una clase existente al activo.',
      });
    }
  }

  for (const location of project.assetLocations) {
    if (!assetIds.has(location.assetId)) {
      problems.push({
        severity: 'error',
        entity: 'assetLocation',
        entityId: location.id,
        message: 'Una ubicación referencia un activo que no existe',
      });
    }
    if (!sceneIds.has(location.sceneId)) {
      problems.push({
        severity: 'error',
        entity: 'assetLocation',
        entityId: location.id,
        message: 'Una ubicación referencia una escena que no existe',
      });
    }
  }

  for (const document of project.documents) {
    requireMedia(document.mediaId, 'document', document.id, `El documento «${document.title}»`);
    if (document.assetId !== null && !assetIds.has(document.assetId)) {
      problems.push({
        severity: 'error',
        entity: 'document',
        entityId: document.id,
        message: `El documento «${document.title}» está vinculado a un activo que no existe`,
      });
    }
  }

  for (const note of project.notes) {
    if (note.sceneId !== null && !sceneIds.has(note.sceneId)) {
      problems.push({
        severity: 'warning',
        entity: 'note',
        entityId: note.id,
        message: `La nota «${note.title}» está anclada a una escena que ya no existe`,
        recovery: 'La nota se conserva; vuelva a anclarla si procede.',
      });
    }
    if (note.assetId !== null && !assetIds.has(note.assetId)) {
      problems.push({
        severity: 'warning',
        entity: 'note',
        entityId: note.id,
        message: `La nota «${note.title}» referencia un activo que ya no existe`,
      });
    }
    if (!categoryIds.has(note.categoryId) && project.noteCategories.length > 0) {
      problems.push({
        severity: 'warning',
        entity: 'note',
        entityId: note.id,
        message: `La nota «${note.title}» usa una categoría que ya no está definida`,
      });
    }
  }

  for (const mapping of project.telemetryMappings) {
    if (!connectionIds.has(mapping.connectionId)) {
      problems.push({
        severity: 'error',
        entity: 'telemetryMapping',
        entityId: mapping.id,
        message: `La variable «${mapping.variable}» no tiene conexión de telemetría válida`,
      });
    }
    if (!assetIds.has(mapping.assetId)) {
      problems.push({
        severity: 'error',
        entity: 'telemetryMapping',
        entityId: mapping.id,
        message: `La variable «${mapping.variable}» está asociada a un activo que no existe`,
      });
    }
  }

  for (const rule of project.conditionRules) {
    if (!mappingIds.has(rule.mappingId)) {
      problems.push({
        severity: 'error',
        entity: 'conditionRule',
        entityId: rule.id,
        message: `La regla «${rule.label}» apunta a una variable que no existe`,
      });
    }
  }

  for (const tour of project.tours) {
    for (const waypoint of tour.waypoints) {
      if (!sceneIds.has(waypoint.sceneId)) {
        problems.push({
          severity: 'error',
          entity: 'tour',
          entityId: tour.id,
          message: `El recorrido «${tour.name}» tiene un punto de paso en una escena que no existe`,
        });
      }
    }
    if (tour.requiresQuizId !== null && !quizIds.has(tour.requiresQuizId)) {
      problems.push({
        severity: 'error',
        entity: 'tour',
        entityId: tour.id,
        message: `El recorrido «${tour.name}» exige una evaluación que no existe`,
      });
    }
  }

  /* --- Acciones sobre el modelo (L10) --- */
  //
  // Una acción que nombra una animación o una pieza que el archivo no trae no
  // falla: no hace nada. Es el peor modo de fallo posible, porque el autor
  // configura, prueba en el editor —donde tampoco pasa nada— y publica un
  // recorrido con un marcador muerto. Esto lo convierte en un aviso antes de
  // publicar.
  //
  // Sólo se valida cuando la escena tiene registrado qué trae el archivo: en
  // un proyecto anterior a ese registro, o si el archivo se reemplazó por
  // fuera, la lista está vacía y validar daría avisos falsos sobre acciones
  // correctas.
  for (const scene of project.scenes) {
    const model = scene.model;
    const actions = [...scene.actions, ...scene.hotspots.flatMap((hotspot) => hotspot.actions)];

    for (const action of actions) {
      const config = action.config;

      if (config.type === 'modelPlayAnimation') {
        if (!sceneIds.has(config.modelSceneId)) {
          problems.push({
            severity: 'error',
            entity: 'scene',
            entityId: scene.id,
            message: `Una acción de animación en «${scene.title}» apunta a una escena que no existe`,
          });
          continue;
        }
        const target = project.scenes.find((candidate) => candidate.id === config.modelSceneId);
        if (target?.kind !== 'model') {
          problems.push({
            severity: 'error',
            entity: 'scene',
            entityId: scene.id,
            message: `Una acción de animación en «${scene.title}» apunta a una escena que no es de modelo`,
            recovery: 'Las animaciones sólo existen en escenas de modelo 3D.',
          });
          continue;
        }
        if (config.modelSceneId !== scene.id) {
          problems.push({
            severity: 'warning',
            entity: 'scene',
            entityId: scene.id,
            message:
              `Una acción de animación en «${scene.title}» apunta al modelo de otra escena ` +
              `(«${target.title}»), que no está cargado mientras se ve esta`,
            recovery: 'Lleve la acción a la escena del modelo, o navegue a ella antes de animar.',
          });
          continue;
        }
        const available = target.model?.availableAnimations ?? [];
        if (available.length > 0 && !available.includes(config.animationName)) {
          problems.push({
            severity: 'warning',
            entity: 'scene',
            entityId: scene.id,
            message: `El modelo de «${scene.title}» no trae la animación «${config.animationName}»`,
            recovery: `Animaciones del archivo: ${available.join(', ')}.`,
          });
        }
      }

      if (config.type === 'modelSetVisibility' && model !== null) {
        const known = model.componentNames;
        if (known.length === 0) continue;
        for (const nodeName of config.nodeNames) {
          if (!known.includes(nodeName)) {
            problems.push({
              severity: 'warning',
              entity: 'scene',
              entityId: scene.id,
              message: `El modelo de «${scene.title}» no trae la pieza «${nodeName}»`,
              recovery: 'Compruebe el nombre en la lista de componentes del modelo.',
            });
          }
        }
      }
    }
  }

  return problems;
}

export const hasBlockingProblems = (problems: readonly IntegrityProblem[]): boolean =>
  problems.some((p) => p.severity === 'error');

/* ------------------------------------------------------------------ *
 * Estadísticas
 * ------------------------------------------------------------------ */

export interface ProjectStats {
  readonly scenes: number;
  readonly panoramas: number;
  readonly models: number;
  readonly hotspots: number;
  readonly unreviewedHotspots: number;
  readonly assets: number;
  readonly documents: number;
  readonly notes: number;
  readonly openNotes: number;
  readonly telemetryVariables: number;
  readonly tours: number;
  readonly quizzes: number;
  readonly mediaBytes: number;
}

export function projectStats(project: Project): ProjectStats {
  const hotspots = project.scenes.flatMap((s) => s.hotspots);
  return {
    scenes: project.scenes.length,
    panoramas: project.scenes.filter((s) => s.kind === 'panorama').length,
    models: project.scenes.filter((s) => s.kind === 'model').length,
    hotspots: hotspots.length,
    unreviewedHotspots: hotspots.filter((h) => h.autoGenerated && !h.reviewed).length,
    assets: project.assets.length,
    documents: project.documents.length,
    notes: project.notes.length,
    openNotes: project.notes.filter((n) => n.status === 'open' || n.status === 'inProgress').length,
    telemetryVariables: project.telemetryMappings.length,
    tours: project.tours.length,
    quizzes: project.quizzes.length,
    mediaBytes: project.media.reduce((sum, m) => sum + m.byteSize, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Publicación: proyecto -> manifiesto
 * ------------------------------------------------------------------ */

export interface ManifestOptions {
  readonly publishedAt: string;
  readonly appVersion: string;
  readonly offlineCapable: boolean;
  /** Endpoint del servicio de telemetría en la publicación. */
  readonly telemetryEndpoint?: string;
  /** Ruta relativa del logotipo ya copiado al paquete. */
  readonly logoPath?: string | null;
  readonly faviconPath?: string | null;
}

/**
 * Construye el manifiesto publicable a partir del proyecto.
 *
 * Es una proyección con pérdida, y la pérdida es el objetivo:
 *
 *  - se excluyen las escenas marcadas como no publicables;
 *  - se excluyen los marcadores automáticos sin revisar (C05);
 *  - se excluyen por completo usuarios, permisos, auditoría, notas y
 *    conexiones de telemetría con sus referencias a credenciales;
 *  - los mapeos de telemetría pierden el `connectionId` y ganan el endpoint
 *    del servicio, de modo que el recorrido publicado sabe *qué* pedir pero
 *    no *a quién* ni *con qué token*.
 *
 * Las notas quedan fuera a propósito: son trabajo interno sobre la planta
 * (observaciones de seguridad, fugas, incumplimientos) y publicarlas con el
 * recorrido las expondría a cualquiera que reciba el enlace. La etapa 11
 * las sirve a través de la API con control de acceso.
 */
/**
 * Ventanas que viajan en el paquete.
 *
 * Son las que alguna acción publicable abre, más las que esas ventanas abren
 * a su vez al cerrarse: una ventana puede encadenar a otra (J06), y perder el
 * segundo eslabón dejaría al visitante con un botón que no hace nada.
 *
 * Se recorre todo lo que puede llevar acciones —marcadores y escenas, los
 * componentes de la interfaz, los pasos y los extremos del recorrido— porque
 * cualquiera de ellos puede ser el único sitio desde el que se abre una
 * ventana. Olvidar una fuente se notaría como una ventana que falta en el
 * paquete publicado y en ninguna otra parte.
 */
function publishableInfoWindows(
  project: Project,
  publishableScenes: readonly Scene[],
): InfoWindow[] {
  const actions: Action[] = [];

  for (const scene of publishableScenes) {
    actions.push(...scene.actions);
    for (const hotspot of scene.hotspots) actions.push(...hotspot.actions);
  }
  for (const skin of project.skins) {
    for (const { node } of walkSkin(skin.root)) actions.push(...node.actions);
  }
  for (const tour of project.tours) {
    actions.push(...tour.onStart, ...tour.onEnd);
    for (const waypoint of tour.waypoints) actions.push(...waypoint.actions);
  }

  const wanted = referencedWindowIds(actions);
  const byId = new Map(project.infoWindows.map((window) => [window.id as string, window]));

  /* Cierre transitivo: lo que abre una ventana al cerrarse también hace falta. */
  const included = new Map<string, InfoWindow>();
  const pending = [...wanted];

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || included.has(id)) continue;
    const window = byId.get(id);
    if (window === undefined) continue;

    included.set(id, window);
    for (const next of referencedWindowIds(window.onCloseActions)) {
      if (!included.has(next)) pending.push(next);
    }
  }

  // El orden del proyecto, no el del recorrido: así dos publicaciones del
  // mismo proyecto producen el mismo manifiesto byte a byte.
  return project.infoWindows.filter((window) => included.has(window.id));
}

export function toManifest(project: Project, options: ManifestOptions): Manifest {
  const publishableScenes = project.scenes
    .filter((scene) => !scene.excludedFromPublish)
    .map((scene) => ({
      ...scene,
      hotspots: scene.hotspots.filter((h) => !(h.autoGenerated && !h.reviewed)),
    }));

  const usedSceneIds = new Set(publishableScenes.map((s) => s.id as string));

  return manifestSchema.parse({
    format: PROJECT_FORMAT,
    schemaVersion: project.schemaVersion,
    projectId: project.id,
    title: project.settings.branding.title.trim().length > 0
      ? project.settings.branding.title
      : project.title,
    description: project.description,
    entrySceneId:
      project.settings.entrySceneId !== null && usedSceneIds.has(project.settings.entrySceneId)
        ? project.settings.entrySceneId
        : (publishableScenes[0]?.id ?? null),
    publishedAt: options.publishedAt,
    publishedByVersion: options.appVersion,
    scenes: publishableScenes,
    plans: project.plans,
    planMarkers: project.planMarkers.filter((m) => usedSceneIds.has(m.sceneId)),
    media: project.media.filter((m) => !m.quarantined),
    assets: project.assets,
    assetClasses: project.assetClasses,
    assetLocations: project.assetLocations.filter((l) => usedSceneIds.has(l.sceneId)),
    documents: project.documents,
    infoWindows: publishableInfoWindows(project, publishableScenes),
    skins: project.skins,
    defaultSkinId:
      project.settings.defaultSkinId !== null &&
      project.skins.some((skin) => skin.id === project.settings.defaultSkinId)
        ? project.settings.defaultSkinId
        : (project.skins[0]?.id ?? null),
    tours: project.tours,
    quizzes: project.quizzes,
    noteCategories: project.noteCategories,
    telemetryMappings: project.telemetryMappings
      .filter((m) => m.enabled)
      .map(({ connectionId: _connectionId, ...rest }) => ({
        ...rest,
        serviceEndpoint: options.telemetryEndpoint ?? '/api/v1/telemetry',
      })),
    conditionRules: project.conditionRules,
    branding: {
      logoPath: options.logoPath ?? null,
      title: project.settings.branding.title,
      accentColor: project.settings.branding.accentColor,
      faviconPath: options.faviconPath ?? null,
    },
    offlineCapable: options.offlineCapable,
    checksumsSha256: null,
    frameOrigins: [],
    // El visor publicado es quien dispara las acciones por inactividad (J04),
    // de modo que el ajuste tiene que viajar con el paquete: si no, el valor
    // que el autor configuró se quedaría en el editor.
    idleTimeoutMs: project.settings.idleTimeoutMs,
  });
}

/**
 * Busca claves prohibidas en una estructura serializada.
 *
 * La usa `publish.test.ts` sobre el manifiesto real. Existe porque la regla
 * «no publicar credenciales» no puede depender de que quien añada el próximo
 * campo se acuerde de ella.
 */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  const found: string[] = [];

  const visit = (node: unknown, currentPath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const childPath = `${currentPath}.${key}`;
        if ((FORBIDDEN_MANIFEST_KEYS as readonly string[]).includes(key)) {
          found.push(childPath);
        }
        visit(child, childPath);
      }
    }
  };

  visit(value, path);
  return found;
}
