/**
 * La interfaz del recorrido dentro del visor (N03, N08, N09, N10).
 *
 * En pantalla, la piel del recorrido se dibuja con HTML y la coloca el motor
 * de maquetación del navegador. Dentro de una sesión inmersiva no hay HTML
 * sobre la imagen, y tampoco hay motor de maquetación: lo que llega al visor
 * es lo que se dibuja en una textura.
 *
 * Así que la piel necesita una maquetación propia para VR, y ésta es. No
 * reproduce el modelo de caja de CSS —sería reescribir un navegador— sino la
 * maquetación que la arquitectura anticipaba al advertir que «VR no soportará
 * automáticamente todas las herramientas del editor web: diseñar subconjunto
 * compatible»: una **pila vertical** de filas legibles a dos metros, con el
 * ancho del panel y el orden de declaración como únicas variables de posición.
 *
 * Esa simplificación es deliberada y tiene una consecuencia que el editor
 * debe advertir: un componente colocado en una esquina con desplazamientos en
 * píxeles aparecerá en VR en su orden de la pila, no en esa esquina.
 *
 * El módulo es puro: de nodos de piel a rectángulos en píxeles de textura, con
 * las zonas pulsables en coordenadas normalizadas que entiende `xr-panel.ts`.
 * Lo que pinta esos rectángulos es `xr-panel-paint.ts`.
 */
import type { ComponentKind, DeviceKind, SkinNode } from '@it360/domain';

import { isVrCompatible } from './webxr';
import { isNodeVisible, type SkinState } from './skin-layout';
import type { PanelTarget } from './xr-panel';

/**
 * Tamaño de la textura del panel.
 *
 * 1024 px de ancho para 1,2 m de panel son unos 853 px/m. Con el tamaño mínimo
 * de texto legible en VR (18 mm) eso da caracteres de 15 px en la textura:
 * suficiente para que el filtrado no los convierta en manchas, y lo bastante
 * pequeño para que la textura quepa sin presión en la memoria de un visor
 * autónomo. Subir a 2048 duplicaría la memoria para una mejora que el panel
 * del visor no resuelve.
 */
export const PANEL_TEXTURE_WIDTH = 1024;
export const PANEL_TEXTURE_HEIGHT = 666;

/** Medidas de la pila, en píxeles de textura. */
export const PANEL_METRICS = {
  padding: 28,
  gap: 16,
  rowHeight: 56,
  titleHeight: 64,
  buttonHeight: 72,
  imageHeight: 220,
  quizOptionHeight: 64,
  /** Alto mínimo de una zona pulsable para acertarla con el mando a 2 m. */
  minTouchHeight: 56,
} as const;

/** Fila ya colocada en la textura. */
export interface PanelRow {
  readonly node: SkinNode;
  readonly kind: ComponentKind;
  /** Rectángulo en píxeles de textura. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Profundidad en el árbol, para el sangrado de los contenedores. */
  readonly depth: number;
  /**
   * Zonas pulsables dentro de la fila, en píxeles de textura.
   *
   * Una tarjeta de pregunta tiene una por respuesta (N08); un botón, una.
   */
  readonly hits: readonly PanelHitRect[];
}

export interface PanelHitRect {
  /** Identificador de la acción: el id del nodo, o `nodo:opción`. */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
}

export interface PanelLayout {
  readonly rows: readonly PanelRow[];
  /** Alto total ocupado; si supera la textura, el panel desborda. */
  readonly contentHeight: number;
  readonly overflow: boolean;
}

/** Datos variables que cambian el alto de una fila. */
export interface PanelContext {
  readonly state: SkinState;
  readonly sceneId: string | null;
  /** Respuestas de la pregunta activa, para dimensionar la tarjeta (N08). */
  readonly quizOptions?: readonly string[];
  /** Puntuaciones a mostrar (N09). */
  readonly scoreEntries?: readonly { readonly label: string; readonly value: string }[];
}

/**
 * Maqueta los nodos visibles en VR como una pila vertical.
 *
 * Se filtra dos veces y por motivos distintos: `isNodeVisible` aplica la
 * visibilidad por dispositivo que el autor configuró (N06, N07), y
 * `isVrCompatible` descarta lo que no tiene equivalente manejable con un mando
 * a tres metros. Un nodo oculto por lo primero es una decisión del autor; uno
 * descartado por lo segundo es una limitación de la plataforma, y el editor la
 * avisa por separado con `vrCompatibilityWarnings`.
 */
export function layoutVrPanel(
  nodes: readonly SkinNode[],
  context: PanelContext,
  width = PANEL_TEXTURE_WIDTH,
  height = PANEL_TEXTURE_HEIGHT,
): PanelLayout {
  const rows: PanelRow[] = [];
  let cursor = PANEL_METRICS.padding;

  const place = (node: SkinNode, depth: number): void => {
    if (!isNodeVisible({ node, device: 'vr' as DeviceKind, sceneId: context.sceneId, state: context.state })) {
      return;
    }
    const kind = node.config.kind;
    if (!isVrCompatible(kind)) return;

    const indent = PANEL_METRICS.padding + depth * PANEL_METRICS.gap;
    const rowWidth = width - indent * 2;

    if (kind === 'container') {
      // El contenedor no ocupa alto propio: en una pila vertical sería una
      // franja vacía. Aporta el sangrado de sus hijos, que es lo que permite
      // leer la agrupación que el autor compuso.
      for (const child of node.children) place(child, depth + 1);
      return;
    }

    const rowHeight = heightOf(kind, context);
    const row: PanelRow = {
      node,
      kind,
      x: indent,
      y: cursor,
      width: rowWidth,
      height: rowHeight,
      depth,
      hits: hitsOf(node, kind, indent, cursor, rowWidth, rowHeight, context),
    };
    rows.push(row);
    cursor += rowHeight + PANEL_METRICS.gap;
  };

  for (const node of nodes) place(node, 0);

  const contentHeight = Math.max(cursor - PANEL_METRICS.gap + PANEL_METRICS.padding, PANEL_METRICS.padding * 2);
  return { rows, contentHeight, overflow: contentHeight > height };
}

/** Alto de una fila por tipo de componente. */
function heightOf(kind: ComponentKind, context: PanelContext): number {
  switch (kind) {
    case 'button':
      return PANEL_METRICS.buttonHeight;
    case 'image':
      return PANEL_METRICS.imageHeight;
    case 'quizCard': {
      const options = context.quizOptions?.length ?? 0;
      // Enunciado más una fila por respuesta. Sin respuestas la tarjeta sigue
      // ocupando el enunciado: es lo que se ve mientras carga la pregunta.
      return PANEL_METRICS.titleHeight + options * (PANEL_METRICS.quizOptionHeight + 8);
    }
    case 'scoreBoard': {
      const entries = context.scoreEntries?.length ?? 1;
      return PANEL_METRICS.titleHeight + entries * PANEL_METRICS.rowHeight;
    }
    case 'thumbnailList':
      return PANEL_METRICS.imageHeight * 0.6;
    case 'telemetryPanel':
    case 'assetPanel':
      return PANEL_METRICS.titleHeight + PANEL_METRICS.rowHeight * 2;
    case 'spacer':
      return PANEL_METRICS.gap;
    default:
      return PANEL_METRICS.rowHeight;
  }
}

/** Zonas pulsables de una fila. */
function hitsOf(
  node: SkinNode,
  kind: ComponentKind,
  x: number,
  y: number,
  width: number,
  height: number,
  context: PanelContext,
): readonly PanelHitRect[] {
  if (kind === 'button') {
    return [{ id: node.id, x, y, width, height, enabled: true }];
  }

  if (kind === 'quizCard') {
    const options = context.quizOptions ?? [];
    return options.map((_option, index) => ({
      id: `${node.id}:${index}`,
      x,
      y: y + PANEL_METRICS.titleHeight + index * (PANEL_METRICS.quizOptionHeight + 8),
      width,
      height: PANEL_METRICS.quizOptionHeight,
      enabled: true,
    }));
  }

  if (kind === 'thumbnailList') {
    // La lista se pulsa como una sola zona: elegir miniatura con el mando a
    // dos metros exige celdas grandes, y partirla en seis columnas daría
    // objetivos de un centímetro aparente.
    return [{ id: node.id, x, y, width, height, enabled: true }];
  }

  // Lo demás es informativo: una zona pulsable sin acción enseñaría al
  // visitante a apuntar a sitios que no responden.
  return node.actions.length > 0 ? [{ id: node.id, x, y, width, height, enabled: true }] : [];
}

/**
 * Pasa las zonas pulsables a coordenadas normalizadas del panel.
 *
 * `xr-panel.ts` trabaja en 0..1 porque es lo que devuelve el corte del rayo;
 * la textura trabaja en píxeles porque es lo que entiende el lienzo. La
 * conversión está aquí, en un sitio, y no repartida por los dos módulos.
 */
export function panelTargets(
  layout: PanelLayout,
  width = PANEL_TEXTURE_WIDTH,
  height = PANEL_TEXTURE_HEIGHT,
): readonly PanelTarget[] {
  const targets: PanelTarget[] = [];
  for (const row of layout.rows) {
    for (const hit of row.hits) {
      // Las zonas por debajo del borde de la textura no se pintan, así que
      // tampoco deben poder pulsarse: sería un botón invisible.
      if (hit.y >= height) continue;
      targets.push({
        id: hit.id,
        u0: hit.x / width,
        v0: hit.y / height,
        u1: (hit.x + hit.width) / width,
        v1: Math.min(hit.y + hit.height, height) / height,
        enabled: hit.enabled,
      });
    }
  }
  return targets;
}

/**
 * Comprueba que las zonas pulsables se puedan acertar con el mando.
 *
 * Un objetivo de 20 px de textura es medio centímetro a dos metros: con el
 * temblor natural de la mano no se acierta. Esto permite avisar en el editor
 * en lugar de descubrirlo con las gafas puestas.
 */
export function smallTargets(layout: PanelLayout): readonly string[] {
  return layout.rows
    .flatMap((row) => row.hits)
    .filter((hit) => hit.height < PANEL_METRICS.minTouchHeight)
    .map((hit) => hit.id);
}
