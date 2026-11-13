/**
 * Lienzo de edición de la interfaz, con arrastrar y soltar (F01).
 *
 * El lienzo dibuja los componentes con **el mismo cálculo que el visor
 * publicado** —`resolveBox` y `styleToCss` de `@it360/viewer`— y no con una
 * aproximación propia. Si el editor colocara las cosas con su propia
 * aritmética, el autor ajustaría una cabecera hasta que quedara bien aquí y
 * saldría desplazada en el recorrido publicado, que es el único sitio donde
 * importa. Esa divergencia no se descubre hasta después de publicar.
 *
 * El arrastre se hace con eventos de puntero y no con la API de arrastrar y
 * soltar del navegador: `dragover`/`drop` no da la posición con precisión
 * suficiente para colocar al píxel, y en el navegador embebido de Windows
 * cancela el arrastre al salir del elemento.
 *
 * Qué significa soltar:
 * - Sobre el lienzo, mueve el componente a esa posición dentro de su mismo
 *   contenedor.
 * - Sobre un contenedor, lo mete dentro.
 * Se marca el destino mientras se arrastra, porque soltar sin saber dónde va a
 * caer convierte cada movimiento en un intento.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTAINER_KINDS,
  findSkinNode,
  walkSkin,
  type Skin,
  type SkinNode,
} from '@it360/domain';
import { resolveBox, styleToCss, type Viewport } from '@it360/viewer';

export interface SkinCanvasProps {
  readonly skin: Skin;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** Mueve el nodo a un contenedor (o a la raíz) y a una posición. */
  readonly onReparent: (nodeId: string, parentId: string | null) => void;
  /** Cambia la posición de un nodo dentro de su contenedor. */
  readonly onMoveTo: (nodeId: string, offsetX: number, offsetY: number) => void;
  /** Cambia el tamaño de un nodo. */
  readonly onResize: (nodeId: string, width: number, height: number) => void;
}

/** Tamaño del lienzo de edición, en píxeles de diseño. */
const CANVAS: Viewport = { width: 1280, height: 720 };

/**
 * Tamaño con el que se dibuja un componente que no declara el suyo.
 *
 * En el visor publicado ese componente se dimensiona por su contenido, que
 * aquí todavía no existe. Se dibuja con un tamaño de referencia y el panel de
 * propiedades lo declara como automático, para que el autor no crea que es un
 * tamaño fijo que él puso.
 */
const AUTO_SIZE = { width: 160, height: 40 } as const;

interface DragState {
  readonly nodeId: string;
  readonly mode: 'move' | 'resize';
  readonly startX: number;
  readonly startY: number;
  readonly originX: number;
  readonly originY: number;
  readonly originW: number;
  readonly originH: number;
}

export function SkinCanvas({
  skin,
  selectedId,
  onSelect,
  onReparent,
  onMoveTo,
  onResize,
}: SkinCanvasProps): JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverParent, setHoverParent] = useState<string | null>(null);
  /** Desplazamiento en curso, para mover sin escribir en el proyecto. */
  const [preview, setPreview] = useState<{ dx: number; dy: number } | null>(null);

  const containers = useMemo(() => {
    const ids = new Set<string>();
    for (const { node } of walkSkin(skin.root)) {
      if (CONTAINER_KINDS.includes(node.config.kind)) ids.add(node.id);
    }
    return ids;
  }, [skin.root]);

  /** Escala del lienzo a la caja que lo contiene. */
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const measure = (): void => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0) return;
      setScale(Math.min(1, rect.width / CANVAS.width));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent, node: SkinNode, mode: 'move' | 'resize'): void => {
      if (node.locked) return;
      event.stopPropagation();
      event.preventDefault();

      onSelect(node.id);

      const box = resolveBox(node.box, CANVAS);
      setDrag({
        nodeId: node.id,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.box.offsetX,
        originY: node.box.offsetY,
        // Una caja sin tamaño explícito se dimensiona por su contenido. Para
        // arrastrar hace falta un número, así que se parte del que se está
        // dibujando: soltar el tirador fija ese tamaño, que es justo lo que
        // significa arrastrarlo.
        originW: box.width ?? AUTO_SIZE.width,
        originH: box.height ?? AUTO_SIZE.height,
      });
      setPreview({ dx: 0, dy: 0 });
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [onSelect],
  );

  useEffect(() => {
    if (drag === null) return;

    const onMove = (event: PointerEvent): void => {
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      setPreview({ dx, dy });

      if (drag.mode !== 'move') return;

      // Contenedor bajo el puntero, para marcarlo como destino. Se ignora el
      // propio nodo arrastrado y su descendencia: meter algo dentro de sí
      // mismo destruiría el árbol, y ofrecerlo como destino sería invitar a
      // intentarlo.
      const surface = surfaceRef.current;
      if (surface === null) return;

      const under = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => {
          const id = (element as HTMLElement).dataset?.['nodeId'];
          if (id === undefined || id === drag.nodeId) return false;
          if (!containers.has(id)) return false;
          const dragged = findSkinNode(skin.root, drag.nodeId);
          return dragged === null || findSkinNode(dragged.children, id) === null;
        });

      setHoverParent(((under as HTMLElement | undefined)?.dataset?.['nodeId']) ?? null);
    };

    const onUp = (): void => {
      const node = findSkinNode(skin.root, drag.nodeId);
      const moved = preview;

      if (node !== null && moved !== null) {
        if (drag.mode === 'resize') {
          onResize(
            drag.nodeId,
            Math.max(16, Math.round(drag.originW + moved.dx)),
            Math.max(16, Math.round(drag.originH + moved.dy)),
          );
        } else if (hoverParent !== null) {
          onReparent(drag.nodeId, hoverParent);
        } else if (Math.abs(moved.dx) > 1 || Math.abs(moved.dy) > 1) {
          onMoveTo(
            drag.nodeId,
            Math.round(drag.originX + moved.dx),
            Math.round(drag.originY + moved.dy),
          );
        }
      }

      setDrag(null);
      setPreview(null);
      setHoverParent(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, preview, hoverParent, scale, skin.root, containers, onMoveTo, onReparent, onResize]);

  const render = (nodes: readonly SkinNode[], container: Viewport): JSX.Element[] =>
    nodes.map((node) => {
      const box = resolveBox(node.box, container);
      const dragging = drag?.nodeId === node.id ? preview : null;

      const baseWidth = box.width ?? AUTO_SIZE.width;
      const baseHeight = box.height ?? AUTO_SIZE.height;

      const left = box.left + (drag?.mode === 'move' ? (dragging?.dx ?? 0) : 0);
      const top = box.top + (drag?.mode === 'move' ? (dragging?.dy ?? 0) : 0);
      const width = Math.max(16, baseWidth + (drag?.mode === 'resize' ? (dragging?.dx ?? 0) : 0));
      const height = Math.max(16, baseHeight + (drag?.mode === 'resize' ? (dragging?.dy ?? 0) : 0));

      const isContainer = CONTAINER_KINDS.includes(node.config.kind);
      const classes = [
        'skin-canvas__node',
        node.id === selectedId ? 'skin-canvas__node--selected' : '',
        node.id === hoverParent ? 'skin-canvas__node--drop' : '',
        node.locked ? 'skin-canvas__node--locked' : '',
        node.initiallyVisible ? '' : 'skin-canvas__node--hidden',
      ]
        .filter((name) => name.length > 0)
        .join(' ');

      return (
        <div
          key={node.id}
          data-node-id={node.id}
          className={classes}
          style={{
            ...styleToCss(node.style),
            position: 'absolute',
            left,
            top,
            width,
            height,
          }}
          onPointerDown={(event) => onPointerDown(event, node, 'move')}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(node.id);
          }}
        >
          <span className="skin-canvas__label">{node.name}</span>

          {isContainer && node.children.length > 0 && (
            <div className="skin-canvas__children">
              {render(node.children, { width, height })}
            </div>
          )}

          {node.id === selectedId && !node.locked && (
            <span
              className="skin-canvas__handle"
              role="slider"
              tabIndex={0}
              aria-label={`Cambiar tamaño de ${node.name}`}
              aria-valuenow={Math.round(width)}
              aria-valuemin={16}
              aria-valuemax={CANVAS.width}
              onPointerDown={(event) => onPointerDown(event, node, 'resize')}
              onKeyDown={(event) => {
                // El teclado tiene que poder hacer lo mismo que el ratón: un
                // editor que sólo responde al arrastre deja fuera a quien no
                // puede usarlo.
                const step = event.shiftKey ? 10 : 1;
                if (event.key === 'ArrowRight') onResize(node.id, width + step, height);
                else if (event.key === 'ArrowLeft') onResize(node.id, Math.max(16, width - step), height);
                else if (event.key === 'ArrowDown') onResize(node.id, width, height + step);
                else if (event.key === 'ArrowUp') onResize(node.id, width, Math.max(16, height - step));
                else return;
                event.preventDefault();
              }}
            />
          )}
        </div>
      );
    });

  return (
    <div className="skin-canvas" ref={surfaceRef}>
      <div
        className="skin-canvas__surface"
        style={{
          width: CANVAS.width,
          height: CANVAS.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
        onClick={() => onSelect(null)}
        role="application"
        aria-label="Lienzo de la interfaz"
      >
        {render(skin.root, CANVAS)}

        {skin.root.length === 0 && (
          <p className="skin-canvas__empty">
            La interfaz está vacía. Añada componentes desde la paleta, o parta de una plantilla.
          </p>
        )}
      </div>

      {drag !== null && hoverParent !== null && (
        <p className="skin-canvas__hint" role="status">
          Se soltará dentro de «{findSkinNode(skin.root, hoverParent)?.name}»
        </p>
      )}
    </div>
  );
}
