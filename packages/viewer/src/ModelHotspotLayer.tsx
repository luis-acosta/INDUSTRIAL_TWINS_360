/**
 * Capa de marcadores sobre un modelo 3D (L06, L07).
 *
 * Los marcadores son botones del DOM encima del lienzo, no geometría dentro de
 * la escena. Así tienen texto legible a cualquier distancia, reciben el foco
 * del teclado y los lee un lector de pantalla; un cartel hecho de triángulos
 * no da ninguna de las tres cosas. El precio es reproyectarlos cada fotograma.
 *
 * **La reproyección no pasa por React.** Se escriben las posiciones
 * directamente en el estilo de cada botón. Un `setState` por fotograma con
 * cuarenta marcadores significa cuarenta reconciliaciones a sesenta hercios, y
 * el modelo se mueve a saltos justo mientras se orbita, que es cuando el
 * visitante está mirando. React dibuja los botones una vez, cuando cambia la
 * lista; el movimiento es trabajo del DOM.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { PerspectiveCamera, Object3D, Scene } from 'three';
import type { ModelSurfaceAnchor } from '@it360/domain';
import { Box3, Sphere } from 'three';

import { hotspotAtPointer, projectHotspot, type ProjectedHotspot } from './model-hotspots';
import { createDecals, resolveColor, type DecalSet } from './hotspot-decals';

export interface ModelHotspotItem {
  readonly id: string;
  readonly label: string;
  readonly anchor: ModelSurfaceAnchor;
  /** `true` para dibujarlo como seleccionado (editor). */
  readonly selected?: boolean;
  /**
   * Color de la calcomanía sobre la superficie (L07).
   *
   * Sale del estilo del punto de interés para que la calcomanía y el marcador
   * del DOM sean del mismo color: con colores distintos, el visitante ve dos
   * cosas en lugar de una, y la relación entre el rótulo y la pieza —que es lo
   * único que la calcomanía existe para dejar claro— se pierde.
   */
  readonly color?: string;
}

/** Color de la calcomanía cuando el punto de interés no declara uno. */
export const DEFAULT_DECAL_COLOR = '#4ec4d2';

export interface ModelHotspotLayerProps {
  readonly hotspots: readonly ModelHotspotItem[];
  /** Raíz del modelo cargado; `null` mientras no haya modelo. */
  readonly root: Object3D | null;
  readonly onActivate?: (hotspotId: string) => void;
  /**
   * Comprobar si otra geometría tapa cada marcador.
   *
   * Cuesta un rayo por marcador y por fotograma. Vale la pena en el recorrido
   * publicado, donde un marcador visto a través de un depósito confunde al
   * visitante; en el editor estorba, porque el autor quiere ver lo que ha
   * colocado aunque esté detrás de algo.
   */
  readonly testOcclusion?: boolean;
}

/** Radio de pulsación alrededor del centro del marcador. */
const HIT_RADIUS_PX = 26;

export interface ModelHotspotLayerHandle {
  /** Llamar al final de cada fotograma dibujado. */
  readonly onFrame: (frame: {
    readonly scene: Scene;
    readonly camera: PerspectiveCamera;
    readonly width: number;
    readonly height: number;
  }) => void;
  /** Marcador bajo el puntero, en píxeles del lienzo. */
  readonly pick: (pointer: { readonly x: number; readonly y: number }) => string | null;
}

/**
 * Capa de marcadores, con el gancho para el bucle de dibujado.
 *
 * Devuelve el elemento y el manejador que hay que conectar a `onFrame` del
 * modelo: la capa no puede pedir fotogramas por su cuenta sin duplicar el
 * bucle, y duplicarlo haría que el modelo se dibujara dos veces.
 */
export function useModelHotspotLayer(props: ModelHotspotLayerProps): {
  readonly element: JSX.Element;
  readonly handle: ModelHotspotLayerHandle;
} {
  const { hotspots, root, onActivate, testOcclusion = false } = props;

  const nodesRef = useRef(new Map<string, HTMLButtonElement>());
  const projectedRef = useRef(new Map<string, ProjectedHotspot | null>());

  /* Calcomanías sobre la superficie (L07). Van aquí y no en cada pantalla que
     usa esta capa: el marcador del DOM y su calcomanía son dos mitades de lo
     mismo y tienen que aparecer y desaparecer juntas. Montadas por separado,
     una pantalla acabaría teniendo marcador sin calcomanía o al revés. */
  const decalsRef = useRef<{ set: DecalSet; attachedTo: object | null } | null>(null);
  const modelSizeRef = useRef(1);

  useEffect(() => {
    /* Se recrean cuando cambian los puntos de interés o el modelo: una
       calcomanía de un punto que ya no existe seguiría dibujándose sobre la
       pieza, y no habría forma de quitarla desde la interfaz. */
    decalsRef.current?.set.dispose();
    decalsRef.current =
      root === null
        ? null
        : {
            set: createDecals(
              hotspots.map((hotspot) => ({
                id: hotspot.id,
                anchor: hotspot.anchor,
                color: resolveColor(hotspot.color ?? '', DEFAULT_DECAL_COLOR),
              })),
            ),
            attachedTo: null,
          };

    if (root !== null) {
      /* El tamaño del modelo se mide una vez por modelo y no por fotograma:
         recorrer la geometría en cada fotograma de una planta con cien mil
         triángulos se nota en el ritmo. */
      const sphere = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
      modelSizeRef.current = Math.max(sphere.radius * 2, 1e-6);
    }

    return () => {
      decalsRef.current?.set.dispose();
      decalsRef.current = null;
    };
  }, [hotspots, root]);

  /* Se limpian las referencias de los marcadores que ya no están: sin esto, la
     capa seguiría escribiendo en elementos desconectados del documento. */
  useEffect(() => {
    const ids = new Set(hotspots.map((hotspot) => hotspot.id));
    for (const id of [...nodesRef.current.keys()]) {
      if (!ids.has(id)) nodesRef.current.delete(id);
    }
    for (const id of [...projectedRef.current.keys()]) {
      if (!ids.has(id)) projectedRef.current.delete(id);
    }
  }, [hotspots]);

  const onFrame = useCallback<ModelHotspotLayerHandle['onFrame']>(
    ({ scene, camera, width, height }) => {
      if (root === null) return;

      /* Las calcomanías se añaden a la escena en el primer fotograma que la
         ve: la escena la crea el visor y esta capa no la recibe hasta aquí. Se
         recuerda a cuál se añadieron para no volver a añadirlas —un grupo
         añadido dos veces se dibuja dos veces— y para reaccionar si el visor
         rehace la escena. */
      const decals = decalsRef.current;
      if (decals !== null) {
        if (decals.attachedTo !== scene) {
          scene.add(decals.set.group);
          decals.attachedTo = scene;
        }
        decals.set.update(root, modelSizeRef.current);
      }

      for (const hotspot of hotspots) {
        const node = nodesRef.current.get(hotspot.id);
        const screen = projectHotspot(root, scene, camera, hotspot.anchor, {
          width,
          height,
          testOcclusion,
        });
        projectedRef.current.set(hotspot.id, screen);
        if (node === undefined) continue;

        if (screen === null || !screen.facing || screen.occluded) {
          // Se oculta con `visibility` y no desmontándolo: desmontar perdería
          // el foco del teclado cada vez que el marcador pasa por detrás.
          node.style.visibility = 'hidden';
          node.tabIndex = -1;
          continue;
        }

        node.style.visibility = 'visible';
        node.tabIndex = 0;
        node.style.transform = `translate(-50%, -50%) translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px) scale(${screen.scale.toFixed(3)})`;
        // Más cerca, más arriba: con dos marcadores superpuestos el de delante
        // tiene que quedar encima.
        node.style.zIndex = String(Math.max(0, 10_000 - Math.round(screen.distance * 10)));
      }
    },
    [hotspots, root, testOcclusion],
  );

  const pick = useCallback<ModelHotspotLayerHandle['pick']>(
    (pointer) =>
      hotspotAtPointer(
        hotspots.map((hotspot) => ({
          id: hotspot.id,
          screen: projectedRef.current.get(hotspot.id) ?? null,
        })),
        pointer,
        HIT_RADIUS_PX,
      ),
    [hotspots],
  );

  const element = (
    <div className="model-hotspots" aria-label="Marcadores del modelo">
      {hotspots.map((hotspot) => (
        <button
          key={hotspot.id}
          type="button"
          ref={(node) => {
            if (node === null) nodesRef.current.delete(hotspot.id);
            else nodesRef.current.set(hotspot.id, node);
          }}
          className={`model-hotspot${hotspot.selected === true ? ' model-hotspot--selected' : ''}`}
          // Arranca oculto: hasta el primer fotograma no se sabe dónde va, y
          // dibujarlo en la esquina y moverlo después se ve como un salto.
          style={{ visibility: 'hidden' }}
          onClick={() => onActivate?.(hotspot.id)}
        >
          <span className="model-hotspot__dot" aria-hidden="true" />
          <span className="model-hotspot__label">{hotspot.label}</span>
        </button>
      ))}
    </div>
  );

  return { element, handle: { onFrame, pick } };
}
