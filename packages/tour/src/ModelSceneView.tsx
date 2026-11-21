/**
 * Escena de modelo 3D en el recorrido publicado (L01–L07).
 *
 * Faltaba por completo: el visor sólo dibujaba panorámicas, así que un
 * proyecto con una escena de modelo se publicaba y esa escena aparecía en
 * negro. El autor sólo lo descubría abriendo el paquete.
 *
 * El modelo se descarga del propio paquete y se prepara igual que en el
 * editor —la misma carga, la misma normalización— porque un modelo que se ve
 * de una manera al editarlo y de otra al publicarlo no sirve para decidir
 * nada.
 *
 * La oclusión de los marcadores **sí** se comprueba aquí, al contrario que en
 * el editor: el visitante no sabe qué hay detrás de cada depósito, y un
 * marcador visto a través de la chapa le dice que puede llegar a algo que no
 * puede ver.
 */
import { useEffect, useState } from 'react';
import {
  loadModel,
  describeModelProblem,
  ModelScene,
  normalizeModel,
  useModelHotspotLayer,
  type ModelCameraState,
  type ModelSceneControls,
} from '@it360/viewer';
import { EmptyState, ErrorState, LoadingState } from '@it360/ui';
import type { AnimationClip, Object3D } from 'three';
import type { Hotspot, ModelSurfaceAnchor, Scene } from '@it360/domain';

export interface ModelSceneViewProps {
  readonly scene: Scene;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly onHotspot: (hotspot: Hotspot) => void;
  /** Vista guardada a la que entrar, si el recorrido la indicó. */
  readonly initialView?: ModelCameraState;
  /**
   * Mando del modelo, para que las acciones del recorrido lo alcancen (L10).
   *
   * Sin esto, una acción «reproduce la animación de apertura» configurada en
   * un marcador no tenía a quién dirigirse en el recorrido publicado: el
   * ejecutor la recibía y su anfitrión la descartaba.
   */
  readonly onControls?: (controls: ModelSceneControls | null) => void;
  /**
   * Avisa de la vista actual del modelo (L11).
   *
   * Lo usa el recorrido para conservar la vista al pasar a otro modelo del
   * mismo espacio de coordenadas: sin ello, el visitante que cambia de un
   * modelo a su despiece tiene que volver a buscar la pieza que estaba
   * mirando.
   */
  readonly onCameraChange?: (state: ModelCameraState) => void;
}

interface Prepared {
  readonly root: Object3D;
  readonly animations: readonly AnimationClip[];
}

export function ModelSceneView({
  scene,
  mediaUrls,
  onHotspot,
  initialView,
  onControls,
  onCameraChange,
}: ModelSceneViewProps): JSX.Element {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const url = scene.mediaId === null ? undefined : mediaUrls.get(scene.mediaId);

  useEffect(() => {
    if (url === undefined) {
      setProblem('El paquete no trae el archivo del modelo de esta escena.');
      return undefined;
    }

    let cancelled = false;
    setPrepared(null);
    setProblem(null);

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`el servidor respondió ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const result = await loadModel(buffer);
        if (cancelled) return;

        if (!result.ok) {
          setProblem(
            result.problem.kind === 'parse'
              ? result.problem.message
              : describeModelProblem(result.problem),
          );
          return;
        }

        // Se normaliza en el nodo raíz, igual que en el editor: el archivo del
        // paquete no se toca.
        normalizeModel(result.model.root);
        setPrepared({ root: result.model.root, animations: result.model.animations });
      } catch (cause: unknown) {
        if (!cancelled) {
          setProblem(
            `No se pudo cargar el modelo: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  /* Marcadores pegados a una pieza. Los de pantalla y los de plano de la misma
     escena los dibuja la interfaz, no esta capa. */
  const surfaceHotspots = scene.hotspots.filter(
    (hotspot): hotspot is Hotspot & { anchor: ModelSurfaceAnchor } =>
      hotspot.anchor.space === 'modelSurface',
  );

  const layer = useModelHotspotLayer({
    hotspots: surfaceHotspots.map((hotspot) => ({
      id: hotspot.id,
      label: hotspot.style.labelTemplate !== '' ? hotspot.style.labelTemplate : hotspot.name,
      anchor: hotspot.anchor,
      /* Mismo color que el marcador: con dos colores, el visitante ve dos
         cosas en lugar de una (L07). El token se resuelve en la capa, que es
         donde se sabe si hay documento del que leer las variables. */
      color: hotspot.style.colorOverride ?? `var(--it-color-status-${hotspot.style.colorToken})`,
    })),
    root: prepared?.root ?? null,
    onActivate: (id) => {
      const hotspot = surfaceHotspots.find((candidate) => candidate.id === id);
      if (hotspot !== undefined) onHotspot(hotspot);
    },
    testOcclusion: true,
  });

  if (problem !== null) {
    return (
      <ErrorState
        title="Esta escena no se puede mostrar"
        detail={problem}
        recovery="Vuelva a publicar el recorrido incluyendo el archivo del modelo."
      />
    );
  }

  if (prepared === null) {
    return <LoadingState label="Preparando el modelo…" />;
  }

  if (scene.model === null) {
    // Una escena de modelo sin ajustes no debería existir —el esquema los pone
    // por omisión— pero si llega así, se dice en lugar de dibujar en negro.
    return <EmptyState title="Esta escena de modelo no trae ajustes de cámara" />;
  }

  return (
    <div className="tour__model">
      <ModelScene
        root={prepared.root}
        animations={prepared.animations}
        autoplay={scene.model.autoplayAnimations}
        lighting={scene.model.lighting}
        bounds={scene.model.bounds}
        mode={scene.model.defaultMode}
        {...(initialView !== undefined ? { initialView } : {})}
        onFrame={layer.handle.onFrame}
        {...(onControls !== undefined ? { onControls } : {})}
        {...(onCameraChange !== undefined ? { onCameraChange } : {})}
        className="tour__model-canvas"
        ariaLabel={`Modelo de ${scene.title}`}
      />
      {layer.element}
    </div>
  );
}
