/**
 * Lógica de un fotograma inmersivo (N03, N05, N10, N11).
 *
 * Reúne las piezas de la etapa 13 —entrada de los mandos, anclas de los
 * paneles, corte del rayo— en la secuencia que hay que ejecutar en cada
 * fotograma, y lo hace sin tocar Three ni el DOM. Lo que se gana con eso es
 * poder comprobar lo que de verdad decide si el visor es usable: que apuntar
 * resalta el botón correcto, que el gatillo activa ese botón y no otro, que un
 * modal abierto impide activar lo que hay detrás, y que el giro del mando no
 * se dispara dos veces.
 *
 * Esta clase no ejecuta las acciones del recorrido: devuelve los
 * identificadores activados. Quien las ejecuta es el `ActionRunner` que ya usa
 * la versión plana, de modo que en el visor y en la pantalla un botón hace
 * exactamente lo mismo.
 */
import {
  EMPTY_INPUT_MEMORY,
  readXrInput,
  type XrInputMemory,
  type XrInputSnapshot,
  type XrRay,
} from './xr-input';
import {
  anchorFor,
  dragAnchor,
  interactivePanels,
  intersectPanel,
  panelFrame,
  targetAt,
  updateAnchor,
  type HeadPose,
  type PanelAnchor,
  type PanelFrame,
  type PanelHit,
  type PanelTarget,
} from './xr-panel';
import { SNAP_TURN_RAD, type VrPanelPlacement } from './webxr';

/** Panel abierto en la sesión. */
export interface XrPanelSpec {
  readonly id: string;
  readonly placement: VrPanelPlacement;
  /** Zonas pulsables en coordenadas normalizadas. */
  readonly targets: readonly PanelTarget[];
}

export interface XrFrameInput {
  readonly head: HeadPose;
  readonly inputs: readonly XrInputSnapshot[];
  /** Rayo de cada mando, en el mismo orden que `inputs`. */
  readonly rays: readonly XrRay[];
  readonly panels: readonly XrPanelSpec[];
}

export interface XrFrameOutput {
  readonly yawOffset: number;
  /** Zona a la que apunta el mando activo, para resaltarla. */
  readonly hovered: string | null;
  /** Zonas activadas con el gatillo en este fotograma. */
  readonly activated: readonly string[];
  /** Marco de cada panel, para colocar su malla. */
  readonly frames: ReadonlyMap<string, PanelFrame>;
  /** `true` si el visitante ha pedido salir de la sesión. */
  readonly exitRequested: boolean;
  /** Distancia al punto apuntado, para dibujar el puntero. */
  readonly pointerLengthM: number;
}

/**
 * Longitud del puntero cuando no apunta a nada.
 *
 * Un puntero infinito atravesaría la panorámica, que está a 500 m, y se vería
 * como una línea que cruza toda la escena. Tres metros es «un poco más allá de
 * donde están los paneles».
 */
export const POINTER_FALLBACK_M = 3;

export class XrRuntime {
  private yaw = 0;
  private memory: XrInputMemory = EMPTY_INPUT_MEMORY;
  private hand: 'left' | 'right' | null = null;
  private anchors = new Map<string, PanelAnchor>();
  private dragging: string | null = null;
  private lastHead: HeadPose | null = null;

  get yawOffset(): number {
    return this.yaw;
  }

  /** Ancla actual de un panel, para pruebas y para persistir la colocación. */
  anchorOf(panelId: string): PanelAnchor | undefined {
    return this.anchors.get(panelId);
  }

  /**
   * Procesa un fotograma.
   *
   * El orden de los pasos es el que evita los defectos conocidos: primero la
   * entrada (que puede pedir salir, y entonces no hay que hacer nada más),
   * luego las anclas (porque el corte del rayo necesita los paneles ya
   * colocados) y por último la activación.
   */
  frame(input: XrFrameInput): XrFrameOutput {
    const reading = readXrInput(input.inputs, this.memory, this.hand);
    this.memory = reading.memory;
    this.hand = reading.activeHand;

    let exitRequested = false;
    for (const action of reading.actions) {
      if (action === 'rotateLeft') this.yaw -= SNAP_TURN_RAD;
      else if (action === 'rotateRight') this.yaw += SNAP_TURN_RAD;
      else if (action === 'exit') exitRequested = true;
    }

    // Las anclas de los paneles que ya no están abiertos se olvidan: si se
    // conservaran, reabrir un panel arrastrable lo haría aparecer donde lo
    // dejó una sesión anterior, en una posición que el visitante no recuerda.
    const open = new Set(input.panels.map((panel) => panel.id));
    for (const id of [...this.anchors.keys()]) {
      if (!open.has(id)) this.anchors.delete(id);
    }

    const frames = new Map<string, PanelFrame>();
    for (const panel of input.panels) {
      const existing = this.anchors.get(panel.id);
      const anchor = existing === undefined ? anchorFor(panel.placement, input.head) : updateAnchor(existing, input.head);
      this.anchors.set(panel.id, anchor);
      frames.set(panel.id, panelFrame(panel.placement, anchor));
    }

    // El arrastre se aplica tras colocar: mueve el ancla para el fotograma
    // siguiente, de modo que el panel acompaña al mando con un fotograma de
    // retardo en lugar de dar un salto.
    this.applyDrag(input, reading.actions.includes('select'));

    const candidates = interactivePanels(input.panels);
    const pointed = this.pointedTarget(input, candidates, frames);

    const activated: string[] = [];
    if (pointed !== null) {
      const selections = reading.actions.filter((action) => action === 'select').length;
      for (let i = 0; i < selections; i += 1) activated.push(pointed.target.id);
    }

    this.lastHead = input.head;
    return {
      yawOffset: this.yaw,
      hovered: pointed?.target.id ?? null,
      activated,
      frames,
      exitRequested,
      pointerLengthM: pointed?.hit.distanceM ?? POINTER_FALLBACK_M,
    };
  }

  /**
   * Zona apuntada por el mando activo.
   *
   * Se elige el corte más cercano, no el primero: con dos paneles solapados,
   * el de delante es el que el visitante cree estar pulsando.
   */
  private pointedTarget(
    input: XrFrameInput,
    candidates: readonly XrPanelSpec[],
    frames: ReadonlyMap<string, PanelFrame>,
  ): { readonly target: PanelTarget; readonly hit: PanelHit } | null {
    const rayIndex = this.activeRayIndex(input);
    const ray = input.rays[rayIndex];
    if (ray === undefined) return null;

    let best: { target: PanelTarget; hit: PanelHit } | null = null;
    for (const panel of candidates) {
      const frame = frames.get(panel.id);
      if (frame === undefined) continue;
      const hit = intersectPanel(ray.origin, ray.direction, frame);
      if (hit === null) continue;
      if (best !== null && hit.distanceM >= best.hit.distanceM) continue;
      const target = targetAt(hit, panel.targets);
      if (target === null) continue;
      best = { target, hit };
    }
    return best;
  }

  /**
   * Índice del mando que manda.
   *
   * Si el visitante ha usado el gatillo con una mano, es la suya; si todavía
   * no ha pulsado nada, el primero que informe. Elegir siempre el primero
   * dejaría el puntero en la mano que no se usa.
   */
  private activeRayIndex(input: XrFrameInput): number {
    if (this.hand !== null) {
      const index = input.inputs.findIndex((source) => source.handedness === this.hand);
      if (index >= 0) return index;
    }
    return 0;
  }

  /**
   * Arrastre de paneles arrastrables (N05).
   *
   * El arrastre se mide por el giro de la **cabeza** entre fotogramas y no por
   * el del mando: es lo que permite colocar un panel mirando a donde se quiere
   * dejar, que es el gesto natural con un mando que no tiene posición absoluta
   * fiable en todos los visores.
   */
  private applyDrag(input: XrFrameInput, selecting: boolean): void {
    const squeezing = input.inputs.some((source) => source.buttons[1] === true);
    if (!squeezing) {
      this.dragging = null;
      return;
    }

    if (this.dragging === null) {
      const draggable = input.panels.find((panel) => panel.placement.mode === 'draggable');
      // Se empieza a arrastrar con el agarre, no con el gatillo: si fuera el
      // gatillo, arrastrar y pulsar un botón serían el mismo gesto.
      this.dragging = selecting ? null : (draggable?.id ?? null);
    }

    const id = this.dragging;
    const previous = this.lastHead;
    if (id === null || previous === null) return;

    const anchor = this.anchors.get(id);
    if (anchor === undefined) return;
    this.anchors.set(id, dragAnchor(anchor, input.head.yaw - previous.yaw, 0));
  }
}
