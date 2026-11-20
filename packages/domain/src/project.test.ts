import { describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  createProject,
  CURRENT_SCHEMA_VERSION,
  findForbiddenKeys,
  FORBIDDEN_MANIFEST_KEYS,
  hasBlockingProblems,
  manifestSchema,
  PROJECT_FORMAT,
  projectSchema,
  projectStats,
  toManifest,
  type Project,
} from './project';
import { actionSchema, type Action, type ActionConfig } from './action';
import { modelSettingsSchema, validateSceneConsistency, type Scene } from './scene';
import { createNode } from './skin-editing';
import { createModelSurfaceAnchor } from './model-hotspot';

/** Acción que abre una ventana, para armar los casos de publicación. */
const openWindowAction = (id: string, windowId: string): Action =>
  actionSchema.parse({ id, event: 'click', config: { type: 'openInfoWindow', windowId } });
import {
  ISO_NOW,
  makeFullProject,
  makeHotspot,
  makeProject,
  makeScene,
  testUuid,
} from './testing';

/**
 * TEST-PRJ-001 .. TEST-PRJ-028
 * Requisitos: Y01, Y02, Y03 (etapa 00), S01-S05 (etapa 10), contrato de
 * datos (formato de proyecto, «sin credenciales»).
 */
describe('creación de proyecto', () => {
  it('TEST-PRJ-001: un proyecto nuevo es válido y abrible', () => {
    const project = createProject({
      id: testUuid(1),
      title: 'Planta Norte',
      now: ISO_NOW,
      appVersion: '0.14.0',
    });
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.publicationState).toBe('draft');
  });

  it('TEST-PRJ-002: un proyecto nuevo no tiene problemas de integridad', () => {
    const project = createProject({
      id: testUuid(1),
      title: 'Vacío',
      now: ISO_NOW,
      appVersion: '0.14.0',
    });
    expect(checkIntegrity(project)).toEqual([]);
  });

  it('TEST-PRJ-003: los scripts llegan desactivados en un proyecto nuevo', () => {
    const project = createProject({
      id: testUuid(1),
      title: 'Vacío',
      now: ISO_NOW,
      appVersion: '0.14.0',
    });
    expect(project.settings.scripting.mode).toBe('disabled');
    expect(project.settings.experimentalFeatures).toBe(false);
  });
});

describe('integridad referencial', () => {
  it('TEST-PRJ-004: el proyecto completo de referencia es íntegro', () => {
    const problems = checkIntegrity(makeFullProject());
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('TEST-PRJ-005: detecta un marcador que navega a una escena borrada', () => {
    // Un esquema válido puede contener esto, y el usuario lo descubriría al
    // pulsar el marcador delante de un cliente.
    const base = makeFullProject();
    const project = { ...base, scenes: base.scenes.filter((s) => s.title !== 'Plataforma superior') };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.message.includes('navega a una escena que no existe'))).toBe(true);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it('TEST-PRJ-006: detecta una escena cuyo medio no está en la biblioteca', () => {
    const base = makeFullProject();
    const project = { ...base, media: [] };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.entity === 'scene' && p.severity === 'error')).toBe(true);
  });

  it('TEST-PRJ-007: detecta un activo con clase inexistente', () => {
    const base = makeFullProject();
    const project = { ...base, assetClasses: [] };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.message.includes('clase que no existe'))).toBe(true);
  });

  it('TEST-PRJ-008: detecta una variable de telemetría sin conexión válida', () => {
    const base = makeFullProject();
    const project = { ...base, telemetryConnections: [] };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.entity === 'telemetryMapping')).toBe(true);
  });

  it('TEST-PRJ-009: detecta una regla de condición huérfana', () => {
    const base = makeFullProject();
    const project = { ...base, telemetryMappings: [] };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.entity === 'conditionRule')).toBe(true);
  });

  it('TEST-PRJ-010: detecta un punto de plano que lleva a ninguna parte', () => {
    const base = makeFullProject();
    const project = { ...base, scenes: [] };
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.entity === 'planMarker')).toBe(true);
  });

  it('TEST-PRJ-011: una escena de entrada inexistente es error bloqueante', () => {
    const project = makeProject({
      settings: { ...makeProject().settings, entrySceneId: testUuid(999) as never },
    });
    const problems = checkIntegrity(project);
    expect(problems.some((p) => p.message.includes('escena de entrada'))).toBe(true);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it('TEST-PRJ-012: una nota anclada a una escena borrada es aviso, no error', () => {
    // La nota se conserva: puede ser la única evidencia de una observación de
    // campo, y borrarla por reorganizar escenas sería perder trabajo.
    const base = makeFullProject();
    const project = { ...base, scenes: [], planMarkers: [], assetLocations: [] };
    const problems = checkIntegrity(project);
    const noteProblems = problems.filter((p) => p.entity === 'note');
    expect(noteProblems.length).toBeGreaterThan(0);
    expect(noteProblems.every((p) => p.severity === 'warning')).toBe(true);
  });

  it('TEST-PRJ-013: una propuesta automática sin revisar es aviso con recuperación', () => {
    const base = makeFullProject();
    const scene = base.scenes[0];
    expect(scene).toBeDefined();
    if (scene === undefined) return;
    const auto = makeHotspot(500, scene.id, {
      autoGenerated: true,
      reviewed: false,
      autoConfidence: 0.62,
    });
    const project = {
      ...base,
      scenes: [{ ...scene, hotspots: [...scene.hotspots, auto] }, ...base.scenes.slice(1)],
    };
    const problems = checkIntegrity(project);
    const problem = problems.find((p) => p.entityId === auto.id);
    expect(problem?.severity).toBe('warning');
    expect(problem?.message).toContain('no se publicará');
    expect(problem?.recovery).toBeDefined();
  });

  it('TEST-PRJ-014: los avisos no bloquean la publicación', () => {
    const problems = [
      { severity: 'warning' as const, entity: 'note', entityId: 'x', message: 'aviso' },
    ];
    expect(hasBlockingProblems(problems)).toBe(false);
  });
});

describe('marcadores sobre modelo', () => {
  it('TEST-PRJ-017b: un marcador pegado a una pieza fuera de una escena de modelo es un error', () => {
    // Se dibujaría en ninguna parte, y el autor lo descubriría abriendo el
    // paquete publicado.
    const base = makeProject();
    const scene = makeScene(10, base.id, {
      kind: 'panorama',
      hotspots: [
        {
          ...makeHotspot(20, testUuid(10)),
          anchor: createModelSurfaceAnchor('valvula', { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
        },
      ],
    });

    const problems = checkIntegrity({ ...base, scenes: [scene] });
    const found = problems.filter((problem) => problem.message.includes('no es de modelo'));

    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('error');
  });

  it('TEST-PRJ-017c: en una escena de modelo no se denuncia', () => {
    const base = makeProject();
    const scene = makeScene(10, base.id, {
      kind: 'model',
      mediaId: null,
      hotspots: [
        {
          ...makeHotspot(20, testUuid(10)),
          anchor: createModelSurfaceAnchor('valvula', { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
        },
      ],
    });

    const problems = checkIntegrity({ ...base, scenes: [scene] });
    expect(problems.filter((problem) => problem.message.includes('no es de modelo'))).toEqual([]);
  });
});

describe('coherencia de escena', () => {
  it('TEST-PRJ-015: una escena de modelo sin configuración de modelo es incoherente', () => {
    const scene = makeScene(1, testUuid(1), { kind: 'model', mediaId: testUuid(10) as never });
    const problems = validateSceneConsistency(scene);
    expect(problems.some((p) => p.includes('configuración de modelo'))).toBe(true);
  });

  it('TEST-PRJ-016: una escena panorámica sin imagen es incoherente', () => {
    const scene = makeScene(1, testUuid(1), { kind: 'panorama', mediaId: null });
    expect(validateSceneConsistency(scene).some((p) => p.includes('imagen asociada'))).toBe(true);
  });

  it('TEST-PRJ-017: una vista inicial fuera de los límites de zoom se detecta', () => {
    const scene = makeScene(1, testUuid(1), {
      mediaId: testUuid(10) as never,
      camera: {
        initialView: { yaw: 0, pitch: 0, fov: 110 },
        zoom: { minFovDeg: 30, maxFovDeg: 100 },
        dragSpeed: 1,
        inertia: 0.82,
        autoRotate: false,
        autoRotateSpeed: 0.05,
        autoRotateIdleS: 8,
        invertPitch: false,
      },
    });
    expect(validateSceneConsistency(scene).some((p) => p.includes('límites de zoom'))).toBe(true);
  });

  it('TEST-PRJ-018: un marcador que apunta a otra escena se detecta', () => {
    const scene = makeScene(1, testUuid(1), { mediaId: testUuid(10) as never });
    const stray = makeHotspot(2, testUuid(999));
    const problems = validateSceneConsistency({ ...scene, hotspots: [stray] });
    expect(problems.some((p) => p.includes('apunta a otra escena'))).toBe(true);
  });
});

describe('publicación: proyecto -> manifiesto', () => {
  const options = {
    publishedAt: ISO_NOW,
    appVersion: '0.14.0',
    offlineCapable: true,
  };

  /** Proyecto con dos ventanas: una la abre un marcador, la otra no. */
  const projectWithWindows = (): Project => {
    const base = makeFullProject();
    const abierta = base.infoWindows[0];
    if (abierta === undefined) throw new Error('el proyecto de prueba debe traer una ventana');

    const huerfana = { ...abierta, id: testUuid(110) as typeof abierta.id, name: 'Borrador' };
    const encadenada = { ...abierta, id: testUuid(111) as typeof abierta.id, name: 'Siguiente' };

    const scene = base.scenes[0];
    if (scene === undefined) throw new Error('el proyecto de prueba debe traer una escena');
    const hotspot = scene.hotspots[0];
    if (hotspot === undefined) throw new Error('la escena de prueba debe traer un marcador');

    return {
      ...base,
      infoWindows: [
        { ...abierta, onCloseActions: [openWindowAction(testUuid(120), encadenada.id)] },
        huerfana,
        encadenada,
      ],
      scenes: [
        {
          ...scene,
          hotspots: [
            { ...hotspot, actions: [...hotspot.actions, openWindowAction(testUuid(121), abierta.id)] },
          ],
        },
        ...base.scenes.slice(1),
      ],
    };
  };

  it('TEST-PRJ-019b: sólo se publican las ventanas que alguien abre', () => {
    // Una ventana a medias que no abre nadie puede ser un borrador interno: no
    // tiene por qué viajar en un paquete que se sirve con un enlace.
    const manifest = toManifest(projectWithWindows(), options);
    const names = manifest.infoWindows.map((w) => w.name);

    expect(names).toContain('Ficha de la bomba');
    expect(names).not.toContain('Borrador');
  });

  it('TEST-PRJ-019c: una ventana que otra abre al cerrarse también se publica', () => {
    // Encadenar ventanas (J06) y perder el segundo eslabón dejaría al
    // visitante con un botón que no hace nada.
    const manifest = toManifest(projectWithWindows(), options);
    expect(manifest.infoWindows.map((w) => w.name)).toContain('Siguiente');
  });

  it('TEST-PRJ-019d: una ventana abierta desde la interfaz también se publica', () => {
    // La interfaz es una fuente de acciones tan válida como un marcador, y es
    // la que se olvida: el fallo sólo se vería en el paquete publicado.
    const base = makeFullProject();
    const window = base.infoWindows[0];
    const skin = base.skins[0];
    if (window === undefined || skin === undefined) throw new Error('faltan datos de prueba');

    const node = createNode({ kind: 'button', name: 'Ficha', taken: new Set<string>() });

    const manifest = toManifest(
      {
        ...base,
        skins: [
          {
            ...skin,
            root: [{ ...node, actions: [openWindowAction(testUuid(122), window.id)] }],
          },
        ],
      },
      options,
    );

    expect(manifest.infoWindows).toHaveLength(1);
  });

  it('TEST-PRJ-018b: un proyecto con fondos del sistema se puede publicar', () => {
    /* Esta prueba existe por un defecto concreto: la guarda de claves
       prohibidas del manifiesto rechaza cualquier clave llamada `token`, y los
       fondos del sistema de diseño usaban ese nombre. El resultado era que un
       proyecto con un contenedor de interfaz o una escena de modelo —los dos
       nacen con fondo del sistema— no se podía publicar en absoluto. No lo
       detectó ninguna prueba porque el proyecto de prueba no traía ni interfaz
       con fondo ni escena de modelo. */
    const base = makeFullProject();
    const skin = base.skins[0];
    const scene = base.scenes[0];
    if (skin === undefined || scene === undefined) throw new Error('faltan datos de prueba');

    const node = createNode({ kind: 'container', name: 'Barra', taken: new Set<string>() });

    const project: Project = {
      ...base,
      skins: [
        {
          ...skin,
          root: [
            {
              ...node,
              style: { ...node.style, background: { kind: 'token', surfaceToken: 'overlay' } },
            },
          ],
        },
      ],
      scenes: [
        {
          ...scene,
          model: modelSettingsSchema.parse({}),
        },
        ...base.scenes.slice(1),
      ],
    };

    const manifest = toManifest(project, options);
    expect(findForbiddenKeys(manifest)).toEqual([]);
  });

  it('TEST-PRJ-019: el manifiesto generado es válido', () => {
    const manifest = toManifest(makeFullProject(), options);
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.format).toBe(PROJECT_FORMAT);
  });

  it('TEST-PRJ-020: el manifiesto NO contiene credenciales ni sus referencias', () => {
    // Un recorrido publicado se sube a un servidor web. Si llevara la
    // referencia al token del histórico de la planta, el enlace al recorrido
    // sería el enlace a la telemetría.
    const manifest = toManifest(makeFullProject(), options);
    const found = findForbiddenKeys(manifest);
    expect(found).toEqual([]);
  });

  it('TEST-PRJ-021: el proyecto SÍ contiene lo que el manifiesto excluye', () => {
    // Confirma que la prueba anterior comprueba algo: si el proyecto no
    // tuviera esos campos, la ausencia en el manifiesto no probaría nada.
    const project = makeFullProject();
    const found = findForbiddenKeys(project);
    expect(found.length).toBeGreaterThan(0);
    for (const key of ['tokenRef', 'auditLog', 'grants', 'users']) {
      expect(found.some((path) => path.includes(key)), `falta ${key} en el proyecto`).toBe(true);
    }
  });

  it('TEST-PRJ-022: todas las claves prohibidas se detectan allí donde estén', () => {
    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      const nested = { a: { b: [{ [key]: 'valor' }] } };
      expect(findForbiddenKeys(nested), key).toEqual([`$.a.b[0].${key}`]);
    }
  });

  it('TEST-PRJ-023: las notas no se publican', () => {
    // Son observaciones internas sobre la planta (fugas, incumplimientos);
    // publicarlas las expondría a cualquiera que reciba el enlace.
    const manifest = toManifest(makeFullProject(), options);
    expect('notes' in manifest).toBe(false);
  });

  it('TEST-PRJ-024: los mapeos pierden la conexión y ganan el endpoint del servicio', () => {
    const manifest = toManifest(makeFullProject(), options);
    expect(manifest.telemetryMappings).toHaveLength(1);
    const mapping = manifest.telemetryMappings[0];
    expect(mapping).toBeDefined();
    expect('connectionId' in (mapping ?? {})).toBe(false);
    expect(mapping?.serviceEndpoint).toBe('/api/v1/telemetry');
  });

  it('TEST-PRJ-025: las escenas excluidas no se publican', () => {
    const base = makeFullProject();
    const scenes = base.scenes.map((s, i) => (i === 1 ? { ...s, excludedFromPublish: true } : s));
    const manifest = toManifest({ ...base, scenes }, options);
    expect(manifest.scenes).toHaveLength(1);
  });

  it('TEST-PRJ-026: las propuestas automáticas sin revisar no se publican (C05)', () => {
    // Si se publicaran, el visitante acabaría en una escena que el autor
    // nunca verificó.
    const base = makeFullProject();
    const scene = base.scenes[0];
    if (scene === undefined) throw new Error('fixture inválido');
    const auto = makeHotspot(500, scene.id, { autoGenerated: true, reviewed: false });
    const manifest = toManifest(
      { ...base, scenes: [{ ...scene, hotspots: [...scene.hotspots, auto] }, ...base.scenes.slice(1)] },
      options,
    );
    const published = manifest.scenes[0]?.hotspots ?? [];
    expect(published.some((h) => h.id === auto.id)).toBe(false);
    expect(published).toHaveLength(scene.hotspots.length);
  });

  it('TEST-PRJ-027: una propuesta automática revisada sí se publica', () => {
    const base = makeFullProject();
    const scene = base.scenes[0];
    if (scene === undefined) throw new Error('fixture inválido');
    const reviewed = makeHotspot(501, scene.id, { autoGenerated: true, reviewed: true });
    const manifest = toManifest(
      { ...base, scenes: [{ ...scene, hotspots: [...scene.hotspots, reviewed] }, ...base.scenes.slice(1)] },
      options,
    );
    expect((manifest.scenes[0]?.hotspots ?? []).some((h) => h.id === reviewed.id)).toBe(true);
  });

  it('TEST-PRJ-028: los medios en cuarentena no se publican', () => {
    const base = makeFullProject();
    const media = base.media.map((m, i) => (i === 3 ? { ...m, quarantined: true, quarantineReason: 'PDF ilegible' } : m));
    const manifest = toManifest({ ...base, media }, options);
    expect(manifest.media).toHaveLength(base.media.length - 1);
  });

  it('TEST-PRJ-029: si la escena de entrada no es publicable, se elige otra', () => {
    const base = makeFullProject();
    const scenes = base.scenes.map((s, i) => (i === 0 ? { ...s, excludedFromPublish: true } : s));
    const manifest = toManifest({ ...base, scenes }, options);
    expect(manifest.entrySceneId).toBe(base.scenes[1]?.id);
  });

  it('TEST-PRJ-030: la marca propia sustituye al título cuando está definida', () => {
    const base = makeFullProject();
    const branded = {
      ...base,
      settings: {
        ...base.settings,
        branding: { ...base.settings.branding, title: 'Recorrido ACME' },
      },
    };
    expect(toManifest(branded, options).title).toBe('Recorrido ACME');
    expect(toManifest(base, options).title).toBe(base.title);
  });
});

describe('estadísticas del proyecto', () => {
  it('TEST-PRJ-031: cuenta escenas, marcadores, activos y variables', () => {
    const stats = projectStats(makeFullProject());
    expect(stats.scenes).toBe(2);
    expect(stats.panoramas).toBe(2);
    expect(stats.hotspots).toBe(2);
    expect(stats.assets).toBe(2);
    expect(stats.documents).toBe(1);
    expect(stats.telemetryVariables).toBe(1);
    expect(stats.notes).toBe(1);
    expect(stats.openNotes).toBe(1);
    expect(stats.mediaBytes).toBeGreaterThan(0);
  });

  it('TEST-PRJ-032: cuenta aparte las propuestas automáticas sin revisar', () => {
    const base = makeFullProject();
    const scene = base.scenes[0];
    if (scene === undefined) throw new Error('fixture inválido');
    const auto = makeHotspot(500, scene.id, { autoGenerated: true, reviewed: false });
    const stats = projectStats({
      ...base,
      scenes: [{ ...scene, hotspots: [...scene.hotspots, auto] }, ...base.scenes.slice(1)],
    });
    expect(stats.unreviewedHotspots).toBe(1);
    expect(stats.hotspots).toBe(3);
  });
});

describe('checkIntegrity: acciones sobre el modelo (L10)', () => {
  /** Escena de modelo con las animaciones y piezas que trae el archivo. */
  function modelScene(overrides: Partial<NonNullable<Scene['model']>> = {}): Scene {
    const base = makeScene(40, testUuid(1), { title: 'Unidad U-200', kind: 'model' });
    return {
      ...base,
      kind: 'model',
      model: {
        // Los valores por omisión salen del propio esquema: copiarlos a mano
        // haría que la prueba dejara de reflejar el contrato en cuanto se
        // añadiera un campo.
        ...modelSettingsSchema.parse({}),
        availableAnimations: ['abrir-valvula', 'girar-bomba'],
        componentNames: ['valvula-v12', 'bomba-p101'],
        ...overrides,
      },
    };
  }

  function withAction(scene: Scene, config: ActionConfig): Scene {
    return {
      ...scene,
      actions: [
        actionSchema.parse({ id: testUuid(300), event: 'click', config }),
      ],
    };
  }

  it('avisa de una animación que el archivo no trae', () => {
    // TEST-PRJ-033: una acción que nombra una animación inexistente no falla:
    // no hace nada. Es el peor modo de fallo, porque el autor configura,
    // prueba —donde tampoco pasa nada— y publica un marcador muerto.
    const scene = modelScene();
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(scene, {
          type: 'modelPlayAnimation',
          modelSceneId: scene.id,
          animationName: 'abrir-valbula',
          loop: false,
        }),
      ],
    };

    const problems = checkIntegrity(project);
    const aviso = problems.find((p) => p.message.includes('abrir-valbula'));
    expect(aviso?.severity).toBe('warning');
    expect(aviso?.recovery).toContain('abrir-valvula');
  });

  it('no avisa de una animación que sí existe', () => {
    // TEST-PRJ-034: un aviso falso sobre una acción correcta entrena a
    // ignorar los avisos.
    const scene = modelScene();
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(scene, {
          type: 'modelPlayAnimation',
          modelSceneId: scene.id,
          animationName: 'girar-bomba',
          loop: true,
        }),
      ],
    };

    expect(checkIntegrity(project).filter((p) => p.message.includes('animación'))).toEqual([]);
  });

  it('no valida cuando la escena no tiene registrado qué trae el archivo', () => {
    // TEST-PRJ-035: en un proyecto anterior a ese registro, o si el archivo se
    // reemplazó por fuera, la lista está vacía: validar daría avisos falsos
    // sobre acciones correctas.
    const scene = modelScene({ availableAnimations: [] });
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(scene, {
          type: 'modelPlayAnimation',
          modelSceneId: scene.id,
          animationName: 'cualquiera',
          loop: false,
        }),
      ],
    };

    expect(checkIntegrity(project).filter((p) => p.message.includes('animación'))).toEqual([]);
  });

  it('avisa si la acción apunta al modelo de otra escena', () => {
    // TEST-PRJ-036: el modelo de otra escena no está cargado mientras se ve
    // ésta, de modo que la acción no puede aplicarse. En el visor publicado
    // eso se traducía en un marcador que no hacía nada.
    const first = modelScene();
    const second = { ...modelScene(), id: testUuid(41), title: 'Unidad U-300' };
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(first, {
          type: 'modelPlayAnimation',
          modelSceneId: second.id,
          animationName: 'girar-bomba',
          loop: false,
        }),
        second,
      ],
    };

    const aviso = checkIntegrity(project).find((p) => p.message.includes('otra escena'));
    expect(aviso?.severity).toBe('warning');
  });

  it('rechaza una acción de animación sobre una escena panorámica', () => {
    // TEST-PRJ-037: las animaciones sólo existen en escenas de modelo; esto es
    // un error de autoría y no una advertencia.
    const panorama = makeScene(42, testUuid(1), { title: 'Sala de bombas' });
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(panorama, {
          type: 'modelPlayAnimation',
          modelSceneId: panorama.id,
          animationName: 'girar-bomba',
          loop: false,
        }),
      ],
    };

    const problema = checkIntegrity(project).find((p) => p.message.includes('no es de modelo'));
    expect(problema?.severity).toBe('error');
  });

  it('avisa de una pieza que el modelo no trae', () => {
    // TEST-PRJ-038: igual que con las animaciones, y con el mismo modo de
    // fallo silencioso.
    const scene = modelScene();
    const project: Project = {
      ...makeProject(),
      scenes: [
        withAction(scene, {
          type: 'modelSetVisibility',
          modelSceneId: scene.id,
          nodeNames: ['bomba-p101', 'tuberia-t9'],
          visible: false,
        }),
      ],
    };

    const avisos = checkIntegrity(project).filter((p) => p.message.includes('pieza'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.message).toContain('tuberia-t9');
  });

  it('también valida las acciones declaradas en un marcador', () => {
    // TEST-PRJ-039: es donde el autor las pone casi siempre —pulsar la válvula
    // la abre— y validar sólo las de la escena dejaría fuera el caso normal.
    const scene = modelScene();
    const hotspot = makeHotspot(50, scene.id, {
      actions: [
        actionSchema.parse({
          id: testUuid(301),
          event: 'click',
          config: {
            type: 'modelPlayAnimation',
            modelSceneId: scene.id,
            animationName: 'no-existe',
            loop: false,
          },
        }),
      ],
    });
    const project: Project = {
      ...makeProject(),
      scenes: [{ ...scene, hotspots: [hotspot] }],
    };

    expect(checkIntegrity(project).some((p) => p.message.includes('no-existe'))).toBe(true);
  });
});
