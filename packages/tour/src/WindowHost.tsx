/**
 * Ventanas dentro del recorrido publicado (E01–E03, E05, E08).
 *
 * Antes, cualquier cosa que abriera un marcador —una foto, un PDF, un enlace—
 * se abría en una pestaña nueva. El visitante salía del recorrido y un álbum
 * de fotografías era imposible, porque en una pestaña nueva no hay
 * «siguiente».
 *
 * Esta capa es sólo la que pinta: qué ventana abre cada acción y cómo se
 * recorre un álbum está en `windows.ts`, probado aparte. Lo que vive aquí es
 * lo que no se puede decidir sin el DOM:
 *
 * - **El foco se atrapa dentro de la ventana** mientras está abierta, y vuelve
 *   a donde estaba al cerrarla. Sin eso, quien navega con teclado sale de la
 *   ventana sin verlo y queda tabulando por una panorámica que no puede usar.
 * - **Escape cierra**, siempre. Es lo primero que prueba cualquiera.
 * - **El arrastre no atraviesa la ventana** hasta la panorámica: mover el dedo
 *   sobre una foto giraría la escena de fondo, que es desconcertante.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { InfoWindowBody } from './InfoWindowBody';
import {
  albumPosition,
  canStepAlbum,
  documentUrlWithPage,
  isFrameAllowed,
  stepAlbum,
  type TourWindow,
} from './windows';

export interface WindowHostProps {
  readonly window: TourWindow | null;
  readonly onClose: () => void;
  /** Cambia la foto del álbum. */
  readonly onAlbumIndex: (index: number) => void;
  /** Orígenes que la política del paquete admite enmarcar. */
  readonly frameOrigins: readonly string[];
  /** Lleva a una escena desde un bloque de enlace. */
  readonly onSceneLink?: (sceneId: string) => void;
  /** Valor en vivo de una variable de proceso, si el visor lo tiene. */
  readonly telemetryValue?: (mappingId: string) => string | null;
  /**
   * Entrega el elemento del vídeo que se está reproduciendo (N10).
   *
   * Lo pide la sesión inmersiva: un vídeo en DOM no se compone sobre la imagen
   * del visor, así que hay que llevar **este mismo** elemento a una textura. Se
   * reutiliza en lugar de crear otro porque con dos el sonido se oiría dos
   * veces y los controles de la pantalla no dirían la verdad sobre lo que se
   * ve dentro de las gafas.
   */
  readonly onVideoElement?: (video: HTMLVideoElement | null) => void;
}

export function WindowHost({
  window: win,
  onClose,
  onAlbumIndex,
  frameOrigins,
  onSceneLink,
  telemetryValue,
  onVideoElement,
}: WindowHostProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  /* La pestaña abierta vive aquí y no en el modelo de la ventana: es estado de
     la vista, y guardarlo en el modelo haría que abrir la misma ventana dos
     veces recordase la pestaña de la vez anterior. */
  const [tabId, setTabId] = useState<string | null>(null);

  const infoTabs = win?.kind === 'info' ? win.tabs : null;
  const activeTabId =
    infoTabs === null ? '' : (infoTabs.find((tab) => tab.id === tabId)?.id ?? infoTabs[0]?.id ?? '');

  /* --- Foco --- */

  useEffect(() => {
    if (win === null) return;

    restoreFocusRef.current = globalThis.document.activeElement;
    // Se enfoca el panel y no el primer botón: leer el título antes de los
    // controles es lo que da contexto a quien usa un lector de pantalla.
    panelRef.current?.focus();

    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [win]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (win?.kind === 'media' && win.items.length > 1) {
        if (event.key === 'ArrowRight' && canStepAlbum(win.index, win.items.length, 1)) {
          onAlbumIndex(stepAlbum(win.index, win.items.length, 1));
          event.preventDefault();
          return;
        }
        if (event.key === 'ArrowLeft' && canStepAlbum(win.index, win.items.length, -1)) {
          onAlbumIndex(stepAlbum(win.index, win.items.length, -1));
          event.preventDefault();
          return;
        }
      }

      if (event.key !== 'Tab') return;

      // Atrapar el tabulador dentro de la ventana. Sin esto, quien navega con
      // teclado sale sin darse cuenta y queda tabulando por una panorámica que
      // no puede usar.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable === undefined || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = globalThis.document.activeElement;

      if (event.shiftKey && (active === first || active === panelRef.current)) {
        last?.focus();
        event.preventDefault();
      } else if (!event.shiftKey && active === last) {
        first?.focus();
        event.preventDefault();
      }
    },
    [win, onClose, onAlbumIndex],
  );

  if (win === null) return null;

  return (
    <div
      className="tour-window__backdrop"
      // El arrastre no debe llegar a la panorámica de fondo.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="tour-window"
        role="dialog"
        aria-modal="true"
        aria-label={win.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="tour-window__head">
          <h2 className="tour-window__title">{win.title}</h2>
          <button
            type="button"
            className="tour-window__close"
            aria-label="Cerrar la ventana"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div
          className="tour-window__body"
          style={
            win.kind === 'info'
              ? { width: `min(${win.widthPx}px, 92vw)`, minHeight: `min(${win.heightPx}px, 70vh)` }
              : undefined
          }
        >
          <WindowBody
            window={win}
            frameOrigins={frameOrigins}
            activeTabId={activeTabId}
            onTab={setTabId}
            onSceneLink={onSceneLink ?? (() => undefined)}
            {...(telemetryValue !== undefined ? { telemetryValue } : {})}
            {...(onVideoElement !== undefined ? { onVideoElement } : {})}
          />
        </div>

        {win.kind === 'media' && win.items.length > 1 && (
          <footer className="tour-window__foot">
            <button
              type="button"
              disabled={!canStepAlbum(win.index, win.items.length, -1)}
              onClick={() => onAlbumIndex(stepAlbum(win.index, win.items.length, -1))}
            >
              Anterior
            </button>
            <span className="tour-window__position" aria-live="polite">
              {albumPosition(win.index, win.items.length)}
            </span>
            <button
              type="button"
              disabled={!canStepAlbum(win.index, win.items.length, 1)}
              onClick={() => onAlbumIndex(stepAlbum(win.index, win.items.length, 1))}
            >
              Siguiente
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

interface WindowBodyProps {
  readonly window: TourWindow;
  readonly frameOrigins: readonly string[];
  readonly activeTabId: string;
  readonly onTab: (tabId: string) => void;
  readonly onSceneLink: (sceneId: string) => void;
  readonly telemetryValue?: (mappingId: string) => string | null;
  readonly onVideoElement?: (video: HTMLVideoElement | null) => void;
}

function WindowBody({
  window: win,
  frameOrigins,
  activeTabId,
  onTab,
  onSceneLink,
  telemetryValue,
  onVideoElement,
}: WindowBodyProps): JSX.Element {
  if (win.kind === 'info') {
    return (
      <InfoWindowBody
        tabs={win.tabs}
        activeTabId={activeTabId}
        onTab={onTab}
        frameOrigins={frameOrigins}
        onSceneLink={onSceneLink}
        {...(telemetryValue !== undefined ? { telemetryValue } : {})}
      />
    );
  }

  if (win.kind === 'media') {
    const item = win.items[win.index];
    if (item === undefined) return <p className="tour-window__text">No hay nada que mostrar.</p>;

    if (item.kind === 'video') {
      return (
        <video
          className="tour-window__media"
          src={item.url}
          controls
          autoPlay={win.autoplay}
          playsInline
          /* React llama a la referencia con `null` al desmontar, y de eso
             depende que la sesión inmersiva suelte la textura: sin el aviso,
             seguiría decodificando fotogramas de un elemento que ya no está en
             el documento. No se devuelve una función de limpieza porque en
             React 18 se ignora, y devolverla sólo produce un aviso. */
          ref={(element) => onVideoElement?.(element)}
        />
      );
    }
    if (item.kind === 'audio') {
      return <audio className="tour-window__audio" src={item.url} controls autoPlay={win.autoplay} />;
    }
    return (
      <img
        className="tour-window__media"
        src={item.url}
        // La descripción del medio es lo único que hay; si está vacía, se deja
        // vacía en lugar de poner el nombre del archivo, que no describe nada.
        alt={item.caption}
      />
    );
  }

  if (win.kind === 'document') {
    if (!win.embeddable) {
      return (
        <div className="tour-window__fallback">
          <p className="tour-window__text">
            Este documento no se puede mostrar dentro del recorrido. Ábralo o descárguelo para
            verlo.
          </p>
          <a href={win.url} download rel="noopener" className="tour-window__link">
            Descargar el documento
          </a>
        </div>
      );
    }

    return (
      <iframe
        className="tour-window__frame"
        src={documentUrlWithPage(win.url, win.page)}
        title={win.title}
      />
    );
  }

  // Webframe: sólo si la política del paquete lo admite.
  if (!isFrameAllowed(win.url, frameOrigins)) {
    return (
      <div className="tour-window__fallback">
        <p className="tour-window__text">
          Este contenido web no se puede mostrar dentro del recorrido porque su dirección no estaba
          declarada al publicarlo.
        </p>
        <a
          href={win.url}
          target="_blank"
          rel="noopener noreferrer"
          className="tour-window__link"
        >
          Abrirlo en una pestaña nueva
        </a>
      </div>
    );
  }

  return (
    <iframe
      className="tour-window__frame"
      src={win.url}
      title={win.title}
      style={{ width: win.widthPx, height: win.heightPx }}
      // Sin más permisos que los imprescindibles: conceder permisos amplios a
      // una página de un tercero no es algo que el autor pueda evaluar.
      sandbox="allow-scripts allow-same-origin allow-popups"
      {...(win.allowFullscreen ? { allow: 'fullscreen' } : {})}
    />
  );
}
