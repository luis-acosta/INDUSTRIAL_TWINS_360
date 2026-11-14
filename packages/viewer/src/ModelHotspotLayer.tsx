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
import { hotspotAtPointer, projectHotspot, type ProjectedHotspot } from './model-hotspots';

export interface ModelHotspotItem {
  readonly id: string;
  readonly label: string;
  readonly anchor: ModelSurfaceAnchor;
  /** `true` para dibujarlo como seleccionado (editor). */
  readonly selected?: boolean;
}

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
