/**
 * Escenas de modelo 3D en el editor (L01–L04, L08–L10, L12, V03).
 *
 * Trae a la aplicación lo que ya estaba probado aparte: el cargador valida el
 * archivo, el controlador de cámara respeta los límites y la resolución
 * adaptativa baja la nitidez antes que los fotogramas. Esta pantalla es donde
 * el autor lo usa.
 *
 * Dos decisiones que se notan al primer uso:
 *
 * - **El modelo se comprueba antes de cargarlo.** Un GLB truncado —el caso
 *   real, copiado de un recurso de red que se cortó— deja el lienzo en negro
 *   si se le pasa directamente al cargador. Aquí se mira la cabecera primero y
 *   se dice qué pasa y qué hacer.
 * - **El modelo se normaliza al abrirlo, sin tocar el archivo.** Los CAD
 *   llegan en milímetros, en pulgadas o con el origen a kilómetros; tal cual,
 *   el modelo aparece microscópico o fuera de cámara y parece que no cargó.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  actionSchema,
  createHotspot,
  createModelSurfaceAnchor,
  newUuid,
  type CameraMode,
  type ModelLighting,
  type ModelSurfaceAnchor,
  type Scene as DomainScene,
  type Uuid,
  scenesInSameSpace,
} from '@it360/domain';
import {
  describeModelProblem,
  loadModel,
  modelSizeWarning,
  ModelScene,
  normalizeModel,
  useModelHotspotLayer,
  worldToLocal,
  type ModelCameraState,
  type ModelPick,
} from '@it360/viewer';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  TextInput,
  useToast,
  PropertyList,
  PropertyRow,
} from '@it360/ui';
import type { Object3D } from 'three';
import type { ProjectStore } from '../state/project-store';

/**
 * Nombres de los modos de cámara.
 *
 * «Sobrevuelo» y «Primera persona» describen qué hace el modo, no cómo se
 * llama en la biblioteca: el autor no tiene por qué saber qué es un «fly
 * over» en inglés para elegirlo.
 */
const MODE_LABELS: Readonly<Record<CameraMode, string>> = {
  orbit: 'Orbital',
  flyOver: 'Sobrevuelo',
  firstPerson: 'Primera persona',
};

export interface ModelSceneModuleProps {
  readonly store: ProjectStore;
  readonly scene: DomainScene;
}

interface LoadedState {
  readonly root: Object3D;
  readonly meshNames: readonly string[];
  /** Animaciones que trae el archivo. */
  readonly animationNames: readonly string[];
  readonly sizeWarning: string | null;
  readonly fileName: string;
}

export function ModelSceneModule({ store, scene }: ModelSceneModuleProps): JSX.Element {
  const { push } = useToast();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelPick | null>(null);
  /**
   * Modo de colocación de marcadores (L06, L07).
   *
   * Es un modo y no un clic con tecla modificadora porque colocar varios
   * marcadores seguidos es la tarea normal: con modificador habría que
   * mantenerla pulsada durante toda la sesión de colocado.
   */
  const [placing, setPlacing] = useState(false);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [degraded, setDegraded] = useState<{ on: boolean; fps: number }>({ on: false, fps: 0 });

  const settings = scene.model;

  const update = useCallback(
    (label: string, patch: Partial<NonNullable<DomainScene['model']>>, key?: string): void => {
      if (settings === null) return;
      store.updateProject(
        label,
        {
          scenes: store.project.scenes.map((candidate) =>
            candidate.id === scene.id
              ? { ...candidate, model: { ...settings, ...patch } }
              : candidate,
          ),
        },
        key,
      );
    },
    [settings, store, scene.id],
  );

  /**
   * Lee el archivo elegido.
   *
   * `FileReader` y no `File.arrayBuffer()`, igual que en las demás
   * importaciones de la aplicación: es la única vía disponible en todas las
   * webviews que se soportan.
   */
  const readFile = (file: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? reader.result : new ArrayBuffer(0));
      };
      reader.onerror = () => reject(new Error('lectura fallida'));
      reader.readAsArrayBuffer(file);
    });

  /** Abre un archivo del disco y lo prepara para el lienzo. */
  const onPick = async (file: File): Promise<void> => {
    setProblem(null);
    setLoading(true);
    setPick(null);
    setHidden([]);

    try {
      const buffer = await readFile(file);
      const result = await loadModel(buffer);

      if (!result.ok) {
        setProblem(
          result.problem.kind === 'parse'
            ? result.problem.message
            : describeModelProblem(result.problem),
        );
        setLoaded(null);
        return;
      }

      // Se normaliza en el nodo raíz: el archivo del cliente no se toca.
      normalizeModel(result.model.root);

      setLoaded({
        root: result.model.root,
        meshNames: [],
        animationNames: result.model.animations.map((clip) => clip.name),
        sizeWarning: modelSizeWarning(buffer.byteLength),
        fileName: file.name,
      });

      // Se anotan en la escena las animaciones que el archivo trae de verdad
      // (L10). Con esta lista, el editor puede ofrecer las existentes y la
      // validación avisa de una acción que nombre una que no está; sin ella,
      // el autor escribe el nombre a mano y sólo descubre la errata probando
      // el recorrido publicado, donde la acción no hace nada.
      if (settings !== null) {
        store.updateScene(
          scene.id,
          'Registrar animaciones del modelo',
          {
            model: {
              ...settings,
              availableAnimations: result.model.animations.map((clip) => clip.name),
            },
          },
          `model.animations:${scene.id}`,
        );
      }

      push({
        tone: 'info',
        title: `«${file.name}» cargado`,
        description: `${result.model.meshCount} malla(s), ${result.model.animations.length} animación(es).`,
      });
    } catch {
      setProblem('No se pudo leer el archivo. Compruebe que sigue disponible y vuelva a elegirlo.');
      setLoaded(null);
    } finally {
      setLoading(false);
    }
  };

  const lighting: ModelLighting | null = settings?.lighting ?? null;

  /**
   * Escenas que comparten espacio de coordenadas con ésta (L11).
   *
   * Se calcula sobre el proyecto entero porque es lo que el autor necesita
   * comprobar: que el identificador que acaba de escribir coincide con el de
   * la otra escena, letra por letra.
   */
  const compatibleScenes = useMemo(
    () => scenesInSameSpace(scene, store.project.scenes),
    [scene, store.project.scenes],
  );

  const onMeshNames = useCallback(
    (names: readonly string[]): void => {
      setLoaded((current) => (current === null ? current : { ...current, meshNames: names }));

      // Las piezas se anotan igual que las animaciones, y por el mismo motivo:
      // una acción de visibilidad que nombra una pieza inexistente no hace
      // nada, y el autor sólo lo descubre probando el paquete publicado.
      const current = scene.model;
      if (current !== null && !sameNames(current.componentNames, names)) {
        store.updateScene(
          scene.id,
          'Registrar piezas del modelo',
          { model: { ...current, componentNames: [...names] } },
          `model.components:${scene.id}`,
        );
      }
    },
    [scene.id, scene.model, store],
  );

  /**
   * La cámara no se guarda en cada arrastre.
   *
   * Girar alrededor de un equipo produce cientos de cambios por segundo, y
   * escribirlos llenaría el historial de pasos que nadie quiere deshacer uno a
   * uno. El autor guarda la vista cuando le sirve, con el botón.
   */
  const [cameraState, setCameraState] = useState<ModelCameraState | null>(null);
  const onCameraChange = useCallback((state: ModelCameraState): void => {
    setCameraState(state);
  }, []);

  const saveCurrentView = (): void => {
    if (cameraState === null || settings === null) return;
    update('Guardar la vista del modelo', {
      savedViews: [
        ...settings.savedViews,
        {
          id: newUuid(),
          name: `Vista ${settings.savedViews.length + 1}`,
          position: {
            x: cameraState.target.x,
            y: cameraState.target.y,
            z: cameraState.target.z,
          },
          azimuth: cameraState.azimuth,
          polar: cameraState.polar,
          distance: cameraState.distance,
          fov: cameraState.fov,
        },
      ],
    } as never);
  };

  if (settings === null || lighting === null) {
    return (
      <EmptyState
        title="Esta escena no está configurada como modelo 3D"
        description="Cambie el tipo de la escena a «modelo» para poder cargar un GLB."
      />
    );
  }

  /* Marcadores pegados a una pieza de este modelo. Los de pantalla o de plano
     de la misma escena no se dibujan aquí: no tienen posición en el modelo. */
  const surfaceHotspots = useMemo(
    () =>
      scene.hotspots.filter(
        (hotspot): hotspot is typeof hotspot & { anchor: ModelSurfaceAnchor } =>
          hotspot.anchor.space === 'modelSurface',
      ),
    [scene.hotspots],
  );

  const layer = useModelHotspotLayer({
    hotspots: surfaceHotspots.map((hotspot) => ({
      id: hotspot.id,
      label: hotspot.name,
      anchor: hotspot.anchor,
      selected: hotspot.id === selectedHotspotId,
    })),
    root: loaded?.root ?? null,
    onActivate: (id) => setSelectedHotspotId(id),
    // En el editor no se comprueba la oclusión: el autor quiere ver lo que ha
    // colocado aunque esté detrás de un depósito.
    testOcclusion: false,
  });

  const selectedHotspot = useMemo(
    () => surfaceHotspots.find((hotspot) => hotspot.id === selectedHotspotId) ?? null,
    [surfaceHotspots, selectedHotspotId],
  );

  /** Escena a la que lleva el marcador, si tiene una acción de navegación. */
  const linkTargetOf = (hotspot: DomainScene['hotspots'][number]): string | null => {
    for (const action of hotspot.actions) {
      if (action.config.type === 'goToScene') return action.config.sceneId;
    }
    return null;
  };

  /**
   * Enlaza el marcador con una escena, o le quita el enlace (L05).
   *
   * Se usa la acción de navegación que ya existe en lugar de un campo nuevo:
   * un segundo mecanismo de navegación sería un segundo sitio donde arreglar
   * cada defecto de las transiciones.
   */
  const onLinkScene = (hotspot: DomainScene['hotspots'][number], sceneId: string): void => {
    const rest = hotspot.actions.filter((action) => action.config.type !== 'goToScene');

    if (sceneId === '') {
      store.updateHotspot(scene.id, hotspot.id, 'Quitar enlace del marcador', { actions: rest });
      return;
    }

    const action = actionSchema.parse({
      id: newUuid(),
      event: 'click',
      config: {
        type: 'goToScene',
        sceneId,
        entryMode: 'smart',
        transition: { kind: 'fade', durationMs: 600, useGeometry: true },
      },
      order: rest.length,
    });

    store.updateHotspot(scene.id, hotspot.id, 'Enlazar marcador con una escena', {
      actions: [...rest, action],
    });
  };

  /**
   * Coloca un marcador donde se ha pulsado.
   *
   * La posición se guarda en el espacio local de la pieza, no del modelo: así
   * el marcador sigue a una válvula animada en lugar de quedarse flotando.
   */
  const onPlaceAt = (hit: ModelPick): void => {
    const root = loaded?.root;
    if (root === undefined) return;

    const node = root.getObjectByName(hit.nodeName);
    if (node === undefined) {
      push({
        tone: 'warning',
        title: 'Esa pieza no tiene nombre en el modelo',
        description: 'Exporte el CAD conservando los nombres para poder anclarle marcadores.',
      });
      return;
    }

    const local = worldToLocal(node, hit.point);
    const created = createHotspot({
      sceneId: scene.id,
      name: `Marcador ${scene.hotspots.length + 1}`,
      anchor: createModelSurfaceAnchor(
        hit.nodeName,
        { x: local.x, y: local.y, z: local.z },
        { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      ),
      order: scene.hotspots.length,
      now: new Date().toISOString(),
    });

    store.addHotspot(scene.id, created);
    setSelectedHotspotId(created.id);
  };

  return (
    <div className="model-module">
      <div className="model-module__main">
        {problem !== null && (
          <Callout tone="alarm" title="No se pudo abrir el modelo">
            {problem}
          </Callout>
        )}

        {loaded?.sizeWarning != null && (
          <Callout tone="warning" title="Modelo grande">
            {loaded.sizeWarning}
          </Callout>
        )}

        {loaded === null ? (
          <EmptyState
            title="Sin modelo cargado"
            description="Elija un archivo .glb o .gltf exportado desde su herramienta de CAD. Se comprueba antes de abrirlo y se centra automáticamente, sin modificar el archivo."
            action={
              <label className="csv-dialog__file">
                <input
                  type="file"
                  accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                  aria-label="Archivo del modelo 3D"
                  disabled={loading}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file !== undefined) void onPick(file);
                  }}
                />
              </label>
            }
          />
        ) : (
          <>
            <div className="model-module__canvas">
              <ModelScene
                root={loaded.root}
                lighting={lighting}
                bounds={settings.bounds}
                mode={settings.defaultMode}
                hiddenNodes={hidden}
                onPick={(hit) => {
                  setPick(hit);
                  if (placing && hit !== null) onPlaceAt(hit);
                }}
                onCameraChange={onCameraChange}
                onMeshNames={onMeshNames}
                onDegraded={(on, fps) => setDegraded({ on, fps })}
                onFrame={layer.handle.onFrame}
                className="model-module__scene"
                ariaLabel={`Modelo de ${scene.title}`}
              />
              {layer.element}
            </div>

            <p className="model-module__hint">
              {placing ? (
                <strong>
                  Pulse sobre una pieza para anclarle un marcador. Pulse «Terminar» al acabar.
                </strong>
              ) : (
                <>
                  Arrastre para girar, con Mayús para desplazar, rueda para acercar.
                  {settings.defaultMode !== 'orbit' && ' Use W A S D o las flechas para moverse.'}{' '}
                  Pulse sobre una pieza para identificarla.
                </>
              )}
              {degraded.on && (
                <>
                  {' '}
                  <strong>
                    Resolución reducida para sostener {Math.round(degraded.fps)} fps.
                  </strong>
                </>
              )}
            </p>
          </>
        )}
      </div>

      <aside className="model-module__side">
        <SectionLabel>Modelo</SectionLabel>
        {loaded !== null && (
          <p className="model-module__file">
            {loaded.fileName}
            <Badge tone="neutral">{loaded.meshNames.length} piezas</Badge>
          </p>
        )}
        <label className="csv-dialog__file">
          <input
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            aria-label="Cambiar el archivo del modelo"
            disabled={loading}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void onPick(file);
            }}
          />
        </label>

        {/* ---------------- Cámara (L02–L04, L08) ---------------- */}

        <SectionLabel>Cámara</SectionLabel>

        <Field
          label="Modo"
          inline
          hint="Cambiar de modo no recoloca al observador: sólo cambia qué hace el arrastre."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              size="sm"
              aria-describedby={describedBy}
              value={settings.defaultMode}
              onChange={(event) =>
                update('Cambiar el modo de cámara', {
                  defaultMode: event.currentTarget.value as CameraMode,
                })
              }
            >
              {(['orbit', 'flyOver', 'firstPerson'] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="skin-editor__tree-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={cameraState === null}
            onClick={saveCurrentView}
          >
            Guardar esta vista
          </Button>
          {settings.savedViews.length > 0 && (
            <Badge tone="neutral">{settings.savedViews.length} guardada(s)</Badge>
          )}
        </div>

        <p className="model-module__hint">Modos que el visitante podrá usar:</p>
        <div className="skin-props__devices">
          {(['orbit', 'flyOver', 'firstPerson'] as const).map((mode) => (
            <Checkbox
              key={mode}
              label={MODE_LABELS[mode]}
              checked={settings.allowedModes.includes(mode)}
              onChange={(event) =>
                update('Modos de cámara permitidos', {
                  allowedModes: event.currentTarget.checked
                    ? [...settings.allowedModes, mode]
                    : settings.allowedModes.filter((candidate) => candidate !== mode),
                })
              }
            />
          ))}
        </div>

        <div className="skin-props__pair">
          <Field label="Distancia mínima" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                size="sm"
                value={settings.bounds.minDistance}
                onValueChange={(value) =>
                  update(
                    'Límite de distancia',
                    { bounds: { ...settings.bounds, minDistance: Math.max(0.01, value) } },
                    `model.mind:${scene.id}`,
                  )
                }
              />
            )}
          </Field>
          <Field label="Distancia máxima" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                size="sm"
                value={settings.bounds.maxDistance}
                onValueChange={(value) =>
                  update(
                    'Límite de distancia',
                    { bounds: { ...settings.bounds, maxDistance: Math.max(0.02, value) } },
                    `model.maxd:${scene.id}`,
                  )
                }
              />
            )}
          </Field>
        </div>

        <div className="skin-props__pair">
          <Field label="Altura de los ojos" inline hint="En primera persona.">
            {({ id, describedBy }) => (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={settings.bounds.eyeHeight}
                onValueChange={(value) =>
                  update(
                    'Altura del observador',
                    { bounds: { ...settings.bounds, eyeHeight: value } },
                    `model.eye:${scene.id}`,
                  )
                }
              />
            )}
          </Field>
          <Field label="Velocidad" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                size="sm"
                value={settings.bounds.moveSpeed}
                onValueChange={(value) =>
                  update(
                    'Velocidad de desplazamiento',
                    { bounds: { ...settings.bounds, moveSpeed: Math.max(0.1, value) } },
                    `model.speed:${scene.id}`,
                  )
                }
              />
            )}
          </Field>
        </div>

        {/* ---------------- Iluminación (L09) ---------------- */}

        <SectionLabel>Iluminación</SectionLabel>

        <Field label="Luz ambiente" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={lighting.ambientIntensity}
              onValueChange={(value) =>
                update(
                  'Luz ambiente',
                  { lighting: { ...lighting, ambientIntensity: Math.max(0, value) } },
                  `model.amb:${scene.id}`,
                )
              }
            />
          )}
        </Field>

        <Field label="Luz direccional" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={lighting.directionalIntensity}
              onValueChange={(value) =>
                update(
                  'Luz direccional',
                  { lighting: { ...lighting, directionalIntensity: Math.max(0, value) } },
                  `model.dir:${scene.id}`,
                )
              }
            />
          )}
        </Field>

        <Field
          label="Sombras"
          inline
          hint="Cuestan rendimiento; el visor bajará la resolución antes de perder fotogramas."
        >
          {({ id, describedBy }) => (
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={lighting.shadows}
              onChange={(event) =>
                update('Sombras del modelo', {
                  lighting: { ...lighting, shadows: event.currentTarget.checked },
                })
              }
            />
          )}
        </Field>

        <Field label="Exposición" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={lighting.exposure}
              onValueChange={(value) =>
                update(
                  'Exposición',
                  { lighting: { ...lighting, exposure: Math.max(0.1, value) } },
                  `model.exp:${scene.id}`,
                )
              }
            />
          )}
        </Field>

        {/* ---------------- Marcadores sobre el modelo (L06, L07) ---------------- */}

        <SectionLabel
          actions={
            <Button
              size="sm"
              variant={placing ? 'primary' : 'ghost'}
              disabled={loaded === null}
              onClick={() => setPlacing((current) => !current)}
            >
              {placing ? 'Terminar' : 'Anclar marcador'}
            </Button>
          }
        >
          Marcadores {surfaceHotspots.length > 0 && <Badge tone="neutral">{surfaceHotspots.length}</Badge>}
        </SectionLabel>

        {surfaceHotspots.length === 0 ? (
          <p className="model-module__hint">
            Ningún marcador anclado a una pieza. Un marcador sobre el modelo puede abrir la ficha
            del equipo o llevar a la panorámica tomada en ese punto.
          </p>
        ) : (
          <ul className="model-module__meshes">
            {surfaceHotspots.map((hotspot) => {
              const missing =
                loaded !== null && !loaded.meshNames.includes(hotspot.anchor.nodeName);

              return (
                <li key={hotspot.id}>
                  <button
                    type="button"
                    className={`model-module__hotspot${hotspot.id === selectedHotspotId ? ' model-module__hotspot--active' : ''}`}
                    onClick={() => setSelectedHotspotId(hotspot.id)}
                  >
                    <span>{hotspot.name}</span>
                    {missing ? (
                      <Badge tone="alarm" title="El modelo ya no tiene esta pieza">
                        pieza ausente
                      </Badge>
                    ) : (
                      <span className="model-module__hotspot-node">{hotspot.anchor.nodeName}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selectedHotspot !== null && (
          <>
            <Field label="Nombre del marcador">
              {({ id }) => (
                <TextInput
                  id={id}
                  size="sm"
                  value={selectedHotspot.name}
                  onChange={(event) =>
                    store.updateHotspot(
                      scene.id,
                      selectedHotspot.id,
                      'Renombrar marcador',
                      { name: event.currentTarget.value },
                      `hotspot.name:${selectedHotspot.id}`,
                    )
                  }
                />
              )}
            </Field>

            <Field label="Lleva a" hint="Una panorámica tomada en este punto (L05).">
              {({ id }) => (
                <Select
                  id={id}
                  value={linkTargetOf(selectedHotspot) ?? ''}
                  onChange={(event) => onLinkScene(selectedHotspot, event.currentTarget.value)}
                >
                  <option value="">Sin enlace</option>
                  {store.project.scenes
                    .filter((candidate) => candidate.id !== scene.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </Select>
              )}
            </Field>

            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                store.removeHotspots(scene.id, [selectedHotspot.id]);
                setSelectedHotspotId(null);
              }}
            >
              Quitar marcador
            </Button>
          </>
        )}

        {/* ---------------- Piezas (L12) ---------------- */}

        <SectionLabel>
          Piezas {loaded !== null && <Badge tone="neutral">{loaded.meshNames.length}</Badge>}
        </SectionLabel>

        {pick !== null && (
          <Callout tone="info" title="Pieza seleccionada">
            {pick.nodeName}
          </Callout>
        )}

        {loaded === null || loaded.meshNames.length === 0 ? (
          <p className="model-module__hint">
            {loaded === null
              ? 'Cargue un modelo para ver sus piezas.'
              : 'El modelo no trae nombres de pieza. Exporte desde el CAD conservando los nombres para poder ocultarlas o anclarles marcadores.'}
          </p>
        ) : (
          <ul className="model-module__meshes">
            {loaded.meshNames.slice(0, 200).map((name) => (
              <li key={name}>
                <Checkbox
                  label={name}
                  checked={!hidden.includes(name)}
                  onChange={(event) =>
                    setHidden((current) =>
                      event.currentTarget.checked
                        ? current.filter((candidate) => candidate !== name)
                        : [...current, name],
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {/* ---------------- Rendimiento (V03) ---------------- */}

        <SectionLabel>Rendimiento</SectionLabel>
        <Field
          label="Resolución adaptativa"
          inline
          hint="Baja la nitidez antes que los fotogramas cuando el equipo no sostiene el ritmo."
        >
          {({ id, describedBy }) => (
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={settings.adaptiveResolution}
              onChange={(event) =>
                update('Resolución adaptativa', {
                  adaptiveResolution: event.currentTarget.checked,
                })
              }
            />
          )}
        </Field>

        <Field label="Identificador de espacio" inline hint="Dos modelos con el mismo identificador conservan la vista al cambiar entre ellos.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              size="sm"
              mono
              aria-describedby={describedBy}
              value={settings.coordinateSpaceId ?? ''}
              onChange={(event) =>
                update(
                  'Espacio de coordenadas',
                  {
                    coordinateSpaceId:
                      event.target.value.trim().length === 0 ? null : event.target.value,
                  },
                  `model.space:${scene.id}`,
                )
              }
            />
          )}
        </Field>

        {/* Un identificador mal escrito no da ningún error: simplemente no
            agrupa. Decir con qué escenas agrupa es la única forma de que el
            autor compruebe que lo escribió igual en las dos. */}
        {settings.coordinateSpaceId !== null && (
          <PropertyList>
            <PropertyRow
              label="Conserva la vista con"
              value={
                compatibleScenes.length === 0 ? (
                  <span className="muted">
                    ninguna otra escena declara este espacio todavía
                  </span>
                ) : (
                  compatibleScenes.map((other) => other.title).join(', ')
                )
              }
            />
          </PropertyList>
        )}
      </aside>
    </div>
  );
}

/**
 * Compara dos listas de nombres sin importar el orden.
 *
 * Existe para no escribir en el proyecto cuando nada cambió: el visor informa
 * de las piezas en cada preparación del modelo, y escribir en cada una
 * llenaría el historial de pasos idénticos que nadie quiere deshacer.
 */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, index) => name === sortedB[index]);
}

/** Crea los ajustes de una escena de modelo con valores razonables. */
export function defaultModelSettings(): NonNullable<DomainScene['model']> {
  return {
    defaultMode: 'orbit',
    allowedModes: ['orbit', 'flyOver', 'firstPerson'],
    bounds: {
      minDistance: 0.5,
      maxDistance: 200,
      minPolarAngle: 0.05,
      maxPolarAngle: Math.PI - 0.05,
      eyeHeight: 1.7,
      moveSpeed: 4,
      collide: false,
    },
    lighting: {
      ambientIntensity: 0.8,
      directionalIntensity: 1.2,
      directionalYaw: 0.8,
      directionalPitch: 0.9,
      shadows: false,
      exposure: 1,
      background: { kind: 'token', surfaceToken: 'canvas' },
    },
    savedViews: [],
    adaptiveResolution: true,
    targetFps: 50,
    minPixelRatio: 0.6,
    autoplayAnimations: [],
    // Se rellenan al preparar el modelo: hasta entonces no se sabe qué trae el
    // archivo, y poner nombres inventados sería peor que dejarlo vacío.
    availableAnimations: [],
    componentNames: [],
    coordinateSpaceId: null,
  };
}

export type { Uuid };
export { newUuid };
