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
import { useCallback, useState } from 'react';
import {
  newUuid,
  type CameraMode,
  type ModelLighting,
  type Scene as DomainScene,
  type Uuid,
} from '@it360/domain';
import {
  describeModelProblem,
  loadModel,
  modelSizeWarning,
  ModelScene,
  normalizeModel,
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
  readonly sizeWarning: string | null;
  readonly fileName: string;
}

export function ModelSceneModule({ store, scene }: ModelSceneModuleProps): JSX.Element {
  const { push } = useToast();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelPick | null>(null);
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
        sizeWarning: modelSizeWarning(buffer.byteLength),
        fileName: file.name,
      });

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

  const onMeshNames = useCallback((names: readonly string[]): void => {
    setLoaded((current) => (current === null ? current : { ...current, meshNames: names }));
  }, []);

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
                onPick={setPick}
                onCameraChange={onCameraChange}
                onMeshNames={onMeshNames}
                onDegraded={(on, fps) => setDegraded({ on, fps })}
                className="model-module__scene"
                ariaLabel={`Modelo de ${scene.title}`}
              />
            </div>

            <p className="model-module__hint">
              Arrastre para girar, con Mayús para desplazar, rueda para acercar.
              {settings.defaultMode !== 'orbit' && ' Use W A S D o las flechas para moverse.'}{' '}
              Pulse sobre una pieza para identificarla.
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
      </aside>
    </div>
  );
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
      background: { kind: 'token', token: 'canvas' },
    },
    savedViews: [],
    adaptiveResolution: true,
    targetFps: 50,
    minPixelRatio: 0.6,
    autoplayAnimations: [],
    coordinateSpaceId: null,
  };
}

export type { Uuid };
export { newUuid };
