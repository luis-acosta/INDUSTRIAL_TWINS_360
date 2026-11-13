/**
 * Contenido de una ventana compuesta por el autor (E01, F08, F09).
 *
 * Lo que se resuelve contra el paquete está en `windows.ts`: aquí llegan
 * bloques ya resueltos y lo único que se hace es pintarlos. Esa separación es
 * la que permite probar en serio la parte difícil —qué se muestra y qué falta—
 * sin montar nada.
 *
 * El texto se pinta como **elementos**, nunca como marcado. El autor escribe
 * un subconjunto diminuto de formato que el dominio analiza, y lo que llega
 * aquí es un árbol de tramos. No hay ninguna vía por la que el texto de un
 * proyecto acabe interpretado como HTML, y por eso tampoco hay nada que
 * sanear: lo que no era formato reconocido ya viene marcado como texto llano.
 */
import { Badge, Callout } from '@it360/ui';
import type { RichNode, RichSpan } from '@it360/domain';
import {
  documentUrlWithPage,
  isFrameAllowed,
  type ResolvedBlock,
  type ResolvedTab,
} from './windows';

export interface InfoWindowBodyProps {
  readonly tabs: readonly ResolvedTab[];
  readonly activeTabId: string;
  readonly onTab: (tabId: string) => void;
  readonly frameOrigins: readonly string[];
  readonly onSceneLink: (sceneId: string) => void;
  /** Valor en vivo de una variable de proceso, si el visor lo tiene. */
  readonly telemetryValue?: (mappingId: string) => string | null;
}

export function InfoWindowBody({
  tabs,
  activeTabId,
  onTab,
  frameOrigins,
  onSceneLink,
  telemetryValue,
}: InfoWindowBodyProps): JSX.Element {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <div className="info-window">
      {/* Con una sola pestaña no se dibuja la barra: una pestaña única es
          ruido que roba alto a lo que el visitante vino a leer. */}
      {tabs.length > 1 && (
        <div className="info-window__tabs" role="tablist" aria-label="Secciones">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`info-tab-${tab.id}`}
              aria-selected={tab.id === active?.id}
              aria-controls={`info-panel-${tab.id}`}
              className={`info-window__tab${tab.id === active?.id ? ' info-window__tab--active' : ''}`}
              onClick={() => onTab(tab.id)}
            >
              {tab.title}
            </button>
          ))}
        </div>
      )}

      <div
        className="info-window__panel"
        {...(tabs.length > 1
          ? {
              role: 'tabpanel',
              id: `info-panel-${active?.id ?? ''}`,
              'aria-labelledby': `info-tab-${active?.id ?? ''}`,
            }
          : {})}
      >
        {active === undefined || active.blocks.length === 0 ? (
          <p className="tour-window__text">Esta sección no tiene contenido.</p>
        ) : (
          active.blocks.map((block, index) => (
            <BlockView
              key={index}
              block={block}
              frameOrigins={frameOrigins}
              onSceneLink={onSceneLink}
              {...(telemetryValue !== undefined ? { telemetryValue } : {})}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface BlockViewProps {
  readonly block: ResolvedBlock;
  readonly frameOrigins: readonly string[];
  readonly onSceneLink: (sceneId: string) => void;
  readonly telemetryValue?: (mappingId: string) => string | null;
}

function BlockView({
  block,
  frameOrigins,
  onSceneLink,
  telemetryValue,
}: BlockViewProps): JSX.Element {
  switch (block.kind) {
    case 'richText':
      return <RichText nodes={block.nodes} />;

    case 'media':
      return (
        <figure className="info-window__figure">
          {block.media.kind === 'video' ? (
            <video
              className="tour-window__media"
              src={block.media.url}
              controls
              autoPlay={block.autoplay}
              playsInline
            />
          ) : block.media.kind === 'audio' ? (
            <audio className="tour-window__audio" src={block.media.url} controls />
          ) : (
            <img className="tour-window__media" src={block.media.url} alt={block.caption} />
          )}
          {block.caption !== '' && (
            <figcaption className="info-window__caption">{block.caption}</figcaption>
          )}
        </figure>
      );

    case 'document':
      return block.embeddable ? (
        <iframe
          className="info-window__document"
          src={documentUrlWithPage(block.url, block.page)}
          title={block.title}
        />
      ) : (
        <p className="tour-window__text">
          <a href={block.url} download rel="noopener noreferrer">
            Descargar {block.title}
          </a>
        </p>
      );

    case 'asset':
      return (
        <div className="info-window__asset">
          <p className="info-window__asset-head">
            <Badge tone="accent" mono>
              {block.tag}
            </Badge>
            <strong>{block.name}</strong>
            {block.className !== '' && (
              <span className="info-window__asset-class">{block.className}</span>
            )}
          </p>
          {block.attributes.length > 0 && (
            <dl className="info-window__attributes">
              {block.attributes.map((attribute) => (
                <div key={attribute.label}>
                  <dt>{attribute.label}</dt>
                  <dd>{attribute.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      );

    case 'telemetry': {
      const value = telemetryValue?.(block.mappingId) ?? null;
      return (
        <p className="info-window__telemetry">
          <span className="info-window__telemetry-label">{block.label}</span>
          {/* Sin dato se dice que no hay dato. Un hueco o un cero harían creer
              al operador que la variable vale eso. */}
          <span className="info-window__telemetry-value">{value ?? 'sin dato'}</span>
        </p>
      );
    }

    case 'webframe':
      return isFrameAllowed(block.url, frameOrigins) ? (
        <iframe
          className="info-window__frame"
          style={{ height: `${block.heightPx}px` }}
          src={block.url}
          title="Contenido web"
          /* Sin `allow-same-origin`: el marco no debe poder leer ni escribir
             nada del recorrido que lo contiene. Lo que se concede es lo justo
             para que un mapa o un reproductor funcionen. */
          sandbox="allow-scripts allow-popups allow-forms"
          referrerPolicy="no-referrer"
          {...(block.allowFullscreen ? { allow: 'fullscreen' } : {})}
        />
      ) : (
        <Callout tone="warning" title="Este contenido no se puede mostrar aquí">
          La dirección no estaba declarada al publicar el recorrido.{' '}
          <a href={block.url} target="_blank" rel="noopener noreferrer">
            Abrirla aparte
          </a>
          .
        </Callout>
      );

    case 'sceneLink':
      return (
        <p className="tour-window__text">
          <button
            type="button"
            className="info-window__scene-link"
            onClick={() => onSceneLink(block.sceneId)}
          >
            Ir a {block.label}
          </button>
        </p>
      );

    case 'missing':
      return (
        <Callout tone="warning" title="Falta contenido">
          Esta ventana apunta a {block.what}.
        </Callout>
      );

    default:
      return <></>;
  }
}

/** Pinta los tramos de texto como elementos. */
function RichText({ nodes }: { readonly nodes: readonly RichNode[] }): JSX.Element {
  return (
    <>
      {nodes.map((node, index) =>
        node.kind === 'paragraph' ? (
          <p key={index} className="tour-window__text">
            {node.spans.map((span, spanIndex) => (
              <Span key={spanIndex} span={span} />
            ))}
          </p>
        ) : (
          <ul key={index} className="info-window__list">
            {node.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                {item.map((span, spanIndex) => (
                  <Span key={spanIndex} span={span} />
                ))}
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function Span({ span }: { readonly span: RichSpan }): JSX.Element {
  switch (span.kind) {
    case 'bold':
      return <strong>{span.text}</strong>;
    case 'italic':
      return <em>{span.text}</em>;
    case 'code':
      return <code>{span.text}</code>;
    case 'link':
      // `noopener` siempre: sin él la página abierta puede manipular esta.
      return (
        <a href={span.href} target="_blank" rel="noopener noreferrer">
          {span.text}
        </a>
      );
    default:
      return <>{span.text}</>;
  }
}
