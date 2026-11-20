/**
 * La interfaz que diseñó el autor, dibujada en el recorrido publicado
 * (F05–F13, J05, J10).
 *
 * Hasta ahora el visor traía una barra de herramientas escrita a mano y el
 * *skin* no se dibujaba en ninguna parte: el autor componía una interfaz en el
 * editor y el visitante no la veía nunca. Esto es lo que faltaba.
 *
 * La aritmética —anclajes, escala del modo fijo, visibilidad, pestaña activa,
 * estilos— vive en `@it360/viewer/skin-layout` y está probada aparte. Aquí
 * queda sólo lo que necesita el DOM.
 *
 * Tres decisiones que conviene no reconstruir:
 *
 * **Los paneles pesados llegan como ranuras.** La ficha de activo, el panel de
 * instrumentos, las notas y la evaluación ya existen en el visor con su propio
 * estado y sus propias peticiones. Volverlos a escribir aquí habría duplicado
 * cuatro componentes difíciles; en su lugar, el anfitrión los pasa. Una ranura
 * que el anfitrión no pasa se dice en su sitio, no se deja en blanco.
 *
 * **Un componente que esta versión no dibuja se declara.** Es la misma regla
 * que el resto del proyecto: antes un recuadro vacío que una función simulada,
 * y antes un aviso con el nombre del componente que un recuadro vacío.
 *
 * **El texto del autor no es HTML.** La plantilla pasa por el mismo análisis
 * de formato sencillo que las ventanas de información, y se pinta como
 * elementos. El campo `markdown` del componente de texto decide si se analiza
 * el formato o se respeta el texto tal cual, no si se interpreta marcado.
 */
import { useMemo } from 'react';
import {
  parseRichText,
  resolveVariables,
  type Action,
  type ComponentConfig,
  type DeviceKind,
  type Manifest,
  type RichNode,
  type RichSpan,
  type Skin,
  type SkinNode,
} from '@it360/domain';
import {
  activeTabOf,
  carouselIndexOf,
  designArea,
  fixedScale,
  isNodeVisible,
  progressFraction,
  resolveBox,
  styleToCss,
  type SkinState,
  type Viewport,
} from '@it360/viewer';

/** Lo que el anfitrión sabe hacer y la interfaz necesita. */
export interface SkinHost {
  readonly manifest: Manifest;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly device: DeviceKind;
  readonly sceneId: string | null;
  readonly state: SkinState;
  /** Valores de las variables de las plantillas (F09, J10). */
  readonly variables: Readonly<Record<string, string | number | null | undefined>>;
  readonly onActions: (actions: readonly Action[], nodeId: string) => void;
  readonly onTab: (nodeId: string, tabId: string) => void;
  readonly onCarousel: (nodeId: string, index: number) => void;
  readonly onSelectScene: (sceneId: string) => void;
  /** Progreso por origen, en [0, 1]; `null` si no hay nada en curso. */
  /**
   * Avance de una barra.
   *
   * `scoreTarget` sólo lo usa la fuente «puntuación»: una puntuación no tiene
   * máximo por sí misma, de modo que sin el objetivo que declara el autor no
   * hay fracción que dibujar.
   */
  readonly progress: (
    source: 'tour' | 'media' | 'score' | 'quiz',
    scoreKey: string,
    scoreTarget?: number | null,
  ) => number | null;
  /** Texto del temporizador y de la puntuación, que los lleva el anfitrión. */
  readonly timerText: (mode: 'elapsed' | 'countdown', durationS: number) => string;
  readonly scoreLines: (keys: readonly string[]) => readonly { label: string; value: string }[];
  /** Paneles que el visor ya tiene montados. */
  readonly slots?: {
    readonly planView?: (planId: string | null, showRadar: boolean) => JSX.Element;
    readonly assetPanel?: (assetId: string | null, tabs: readonly string[]) => JSX.Element;
    readonly telemetryPanel?: (mappingIds: readonly string[], layout: string) => JSX.Element;
    readonly notesPanel?: (scope: string, allowCreate: boolean) => JSX.Element;
    readonly quizCard?: (quizId: string | null) => JSX.Element;
    readonly webframe?: (url: string, allowFullscreen: boolean) => JSX.Element;
  };
}

export interface SkinRendererProps {
  readonly skin: Skin;
  readonly viewport: Viewport;
  readonly host: SkinHost;
}

export function SkinRenderer({ skin, viewport, host }: SkinRendererProps): JSX.Element {
  const scale = fixedScale(skin, viewport);
  const area = designArea(skin, viewport);

  /* En modo fijo se dibuja el lienzo de diseño a su tamaño y se escala en
     bloque, de modo que la composición del autor se conserva. En adaptable, el
     lienzo es la ventana. */
  const canvas: Viewport =
    skin.layoutMode === 'fixed'
      ? { width: skin.designWidth, height: skin.designHeight }
      : viewport;

  return (
    <div
      className="skin"
      style={
        skin.layoutMode === 'fixed'
          ? {
              width: `${skin.designWidth}px`,
              height: `${skin.designHeight}px`,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              left: `${(viewport.width - area.width) / 2}px`,
              top: `${(viewport.height - area.height) / 2}px`,
            }
          : undefined
      }
      data-layout={skin.layoutMode}
    >
      {skin.root.map((node) => (
        <NodeView key={node.id} node={node} container={canvas} host={host} parentActiveTab={null} />
      ))}
    </div>
  );
}

interface NodeViewProps {
  readonly node: SkinNode;
  readonly container: Viewport;
  readonly host: SkinHost;
  readonly parentActiveTab: string | null;
}

function NodeView({ node, container, host, parentActiveTab }: NodeViewProps): JSX.Element | null {
  const visible = isNodeVisible({
    node,
    device: host.device,
    sceneId: host.sceneId,
    state: host.state,
    parentActiveTab,
  });

  const box = useMemo(() => resolveBox(node.box, container), [node.box, container]);
  const styleCss = useMemo(
    () => styleToCss(node.style, { mediaUrls: host.mediaUrls }),
    [node.style, host.mediaUrls],
  );

  if (!visible) return null;

  const inner: Viewport = {
    width: Math.max((box.width ?? container.width) - box.padding * 2, 0),
    height: Math.max((box.height ?? container.height) - box.padding * 2, 0),
  };

  return (
    <div
      className={`skin-node skin-node--${node.config.kind}`}
      data-node={node.id}
      style={{
        left: `${box.left}px`,
        top: `${box.top}px`,
        ...(box.width !== null ? { width: `${box.width}px` } : {}),
        ...(box.height !== null ? { height: `${box.height}px` } : {}),
        minWidth: `${box.minWidth}px`,
        minHeight: `${box.minHeight}px`,
        padding: `${box.padding}px`,
        gap: `${box.gap}px`,
        ...styleCss,
      }}
    >
      <ComponentView node={node} inner={inner} host={host} />
    </div>
  );
}

interface ComponentViewProps {
  readonly node: SkinNode;
  readonly inner: Viewport;
  readonly host: SkinHost;
}

function ComponentView({ node, inner, host }: ComponentViewProps): JSX.Element {
  const config: ComponentConfig = node.config;
  const slots = host.slots ?? {};

  switch (config.kind) {
    case 'container': {
      const flow =
        config.direction === 'free'
          ? { position: 'relative' as const }
          : {
              display: 'flex' as const,
              flexDirection: config.direction === 'row' ? ('row' as const) : ('column' as const),
              justifyContent: JUSTIFY[config.justify],
              alignItems: ALIGN[config.align],
            };

      return (
        <div
          className="skin-container"
          style={{ ...flow, ...(config.scrollable ? { overflow: 'auto' } : {}) }}
        >
          {node.children.map((child) => (
            <NodeView
              key={child.id}
              node={child}
              container={inner}
              host={host}
              parentActiveTab={null}
            />
          ))}
        </div>
      );
    }

    case 'button': {
      const label = resolveVariables(config.label, host.variables);
      const image =
        config.imageMediaId === null ? undefined : host.mediaUrls.get(config.imageMediaId);

      return (
        <button
          type="button"
          className={`skin-button skin-button--${config.variant}`}
          title={config.tooltip === '' ? undefined : resolveVariables(config.tooltip, host.variables)}
          aria-label={label === '' ? node.name : undefined}
          onClick={() => host.onActions(node.actions, node.id)}
        >
          {image !== undefined ? <img src={image} alt={label} /> : label}
        </button>
      );
    }

    case 'image': {
      const url = config.mediaId === null ? undefined : host.mediaUrls.get(config.mediaId);
      if (url === undefined) {
        return <Missing what={`la imagen de «${node.name}»`} />;
      }
      return (
        <img
          className="skin-image"
          src={url}
          alt={config.alt}
          style={{ objectFit: config.fit, width: '100%', height: '100%' }}
        />
      );
    }

    case 'text': {
      const resolved = resolveVariables(config.template, host.variables);
      /* `markdown` decide si se analiza el formato sencillo o se respeta el
         texto tal cual. En ninguno de los dos casos se interpreta marcado. */
      return config.markdown ? (
        <RichText nodes={parseRichText(resolved)} />
      ) : (
        <p className="skin-text">{resolved}</p>
      );
    }

    case 'dropdown':
      return (
        <details className="skin-dropdown">
          <summary>{resolveVariables(config.label, host.variables)}</summary>
          <ul>
            {config.items.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => host.onActions(item.actions, node.id)}>
                  {resolveVariables(item.label, host.variables)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      );

    case 'tabs': {
      const active = activeTabOf(node, host.state, config.tabs);
      return (
        <div className="skin-tabs">
          <div role="tablist" aria-label={node.name} className="skin-tabs__list">
            {config.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === active}
                className={`skin-tabs__tab${tab.id === active ? ' skin-tabs__tab--active' : ''}`}
                onClick={() => host.onTab(node.id, tab.id)}
              >
                {resolveVariables(tab.label, host.variables)}
              </button>
            ))}
          </div>
          <div className="skin-tabs__panel">
            {node.children.map((child) => (
              <NodeView
                key={child.id}
                node={child}
                container={inner}
                host={host}
                parentActiveTab={active}
              />
            ))}
          </div>
        </div>
      );
    }

    case 'progressBar': {
      const fraction = host.progress(config.source, config.scoreKey, config.scoreTarget);
      if (fraction === null) {
        /* Sin nada en curso no se dibuja una barra al 0 %: una barra vacía
           dice «empezado y sin avance», que es distinto de «no empezado». */
        return <span className="skin-progress skin-progress--idle" aria-hidden="true" />;
      }
      const percent = Math.round(progressFraction(fraction, 1) * 100);
      return (
        <div
          className="skin-progress"
          role="progressbar"
          aria-label={node.name}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="skin-progress__fill" style={{ width: `${percent}%` }} />
          {config.showLabel && <span className="skin-progress__label">{percent} %</span>}
        </div>
      );
    }

    case 'thumbnailList': {
      const scenes =
        config.sceneIds.length > 0
          ? config.sceneIds
              .map((id) => host.manifest.scenes.find((scene) => scene.id === id))
              .filter((scene): scene is NonNullable<typeof scene> => scene !== undefined)
          : [...host.manifest.scenes].sort((a, b) => a.order - b.order);

      return (
        <ul className={`skin-thumbs skin-thumbs--${config.orientation}`}>
          {scenes.map((scene) => {
            const url = scene.mediaId === null ? undefined : host.mediaUrls.get(scene.mediaId);
            const current = scene.id === host.sceneId;
            return (
              <li key={scene.id}>
                <button
                  type="button"
                  className={`skin-thumb${current ? ' skin-thumb--current' : ''}`}
                  aria-current={current ? 'true' : undefined}
                  style={{ width: `${config.thumbnailSize}px` }}
                  onClick={() => host.onSelectScene(scene.id)}
                >
                  {url === undefined ? (
                    <span className="skin-thumb__blank" aria-hidden="true" />
                  ) : (
                    <img src={url} alt="" />
                  )}
                  {config.showTitles && <span className="skin-thumb__title">{scene.title}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      );
    }

    case 'carousel': {
      const index = carouselIndexOf(node, host.state, node.children.length);
      const child = node.children[index];

      return (
        <div className="skin-carousel">
          <div className="skin-carousel__stage">
            {child === undefined ? (
              <Missing what="contenido en el carrusel" />
            ) : (
              <NodeView node={child} container={inner} host={host} parentActiveTab={null} />
            )}
          </div>
          {config.showArrows && node.children.length > 1 && (
            <div className="skin-carousel__arrows">
              <button
                type="button"
                aria-label="Anterior"
                disabled={!config.loop && index === 0}
                onClick={() => host.onCarousel(node.id, index - 1)}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Siguiente"
                disabled={!config.loop && index === node.children.length - 1}
                onClick={() => host.onCarousel(node.id, index + 1)}
              >
                ›
              </button>
            </div>
          )}
          {config.showDots && node.children.length > 1 && (
            <div className="skin-carousel__dots" aria-hidden="true">
              {node.children.map((candidate, dot) => (
                <span
                  key={candidate.id}
                  className={`skin-carousel__dot${dot === index ? ' skin-carousel__dot--active' : ''}`}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    case 'scoreBoard': {
      const lines = host.scoreLines(config.scoreKeys);
      if (lines.length === 0) {
        return <p className="skin-text skin-text--muted">Sin puntuación todavía.</p>;
      }
      return (
        <dl className="skin-scores">
          {lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
      );
    }

    case 'timer':
      return (
        <p className="skin-timer" aria-live="off">
          {host.timerText(config.mode, config.durationS)}
        </p>
      );

    case 'planView':
      return slots.planView?.(config.planId, config.showRadar) ?? <NoSlot what="el plano" />;

    case 'assetPanel':
      return (
        slots.assetPanel?.(config.assetId, config.visibleTabs) ?? (
          <NoSlot what="la ficha de activo" />
        )
      );

    case 'telemetryPanel':
      return (
        slots.telemetryPanel?.(config.mappingIds, config.layout) ?? (
          <NoSlot what="el panel de instrumentos" />
        )
      );

    case 'notesPanel':
      return (
        slots.notesPanel?.(config.scope, config.allowCreate) ?? <NoSlot what="el panel de notas" />
      );

    case 'quizCard':
      return slots.quizCard?.(config.quizId) ?? <NoSlot what="la evaluación" />;

    case 'webframe':
      return (
        slots.webframe?.(config.url, config.allowFullscreen) ?? (
          <NoSlot what="el contenido web" />
        )
      );

    case 'spacer':
      return <span className="skin-spacer" style={config.flexible ? { flex: 1 } : undefined} />;

    default:
      return <Missing what={`un componente que esta versión del visor no dibuja`} />;
  }
}

const JUSTIFY: Readonly<Record<string, string>> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  spaceBetween: 'space-between',
};

const ALIGN: Readonly<Record<string, string>> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/** Aviso en el sitio del componente, para que el autor lo vea al probar. */
function Missing({ what }: { readonly what: string }): JSX.Element {
  return <p className="skin-missing">Falta {what}.</p>;
}

function NoSlot({ what }: { readonly what: string }): JSX.Element {
  return <p className="skin-missing">Este recorrido no muestra {what} aquí.</p>;
}

function RichText({ nodes }: { readonly nodes: readonly RichNode[] }): JSX.Element {
  return (
    <>
      {nodes.map((node, index) =>
        node.kind === 'paragraph' ? (
          <p key={index} className="skin-text">
            {node.spans.map((span, spanIndex) => (
              <Span key={spanIndex} span={span} />
            ))}
          </p>
        ) : (
          <ul key={index} className="skin-list">
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
      return (
        <a href={span.href} target="_blank" rel="noopener noreferrer">
          {span.text}
        </a>
      );
    default:
      return <>{span.text}</>;
  }
}
