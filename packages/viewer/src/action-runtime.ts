/**
 * Motor de ejecución de acciones (etapa 03, grupo J; etapa 02, D13).
 *
 * El dominio define las acciones como datos; aquí se ejecutan. El motor no
 * conoce React, Three.js ni el DOM: habla con un `ActionHost` que la
 * aplicación implementa. Esa frontera permite probar el encadenamiento, los
 * retardos, las condiciones de puntuación y el «ejecutar una sola vez» sin
 * montar un visor.
 *
 * Una decisión de fondo: el motor **no lanza excepciones** cuando una acción
 * falla. Un recorrido publicado puede tener una acción que apunta a algo que
 * ya no existe, y detener toda la cadena por ello dejaría al visitante
 * atrapado. Cada acción devuelve su resultado y el motor sigue, registrando
 * lo que no pudo hacerse.
 */
import {
  requiresNetwork,
  sortActions,
  type Action,
  type ActionConfig,
  type ActionEvent,
  type ActionType,
  type CameraView,
  type DeviceKind,
} from '@it360/domain';

export interface ActionOutcome {
  readonly actionId: string;
  readonly type: ActionType;
  readonly status: 'executed' | 'skipped' | 'failed';
  readonly reason?: string;
}

/**
 * Operaciones que el anfitrión debe saber hacer.
 *
 * Todas devuelven `void` o una promesa: el motor no espera valores de vuelta.
 * Una acción que necesitara leer algo del anfitrión sería una acción con
 * lógica, y las acciones son datos.
 */
export interface ActionHost {
  goToScene(sceneId: string, config: Extract<ActionConfig, { type: 'goToScene' }>): Promise<void> | void;
  lookAt(view: CameraView, durationMs: number): void;
  openInfoWindow(windowId: string, modal: boolean): void;
  openMedia(mediaId: string, albumMediaIds: readonly string[], autoplay: boolean): void;
  openDocument(documentId: string, page: number): void;
  downloadFile(mediaId: string, suggestedName?: string): void;
  openUrl(url: string, external: boolean): void;
  openWebframe(url: string, width: number, height: number, allowFullscreen: boolean): void;
  setElementVisibility(elementIds: readonly string[], visible: boolean | 'toggle'): void;
  setVariable(namespace: 'score' | 'quiz', key: string, operation: 'set' | 'add' | 'subtract', value: number): void;
  getVariable(namespace: 'score' | 'quiz', key: string): number;
  startTour(tourId: string, fromWaypointIndex: number): void;
  stopTour(): void;
  startQuiz(quizId: string): void;
  showAsset(assetId: string, tab: string): void;
  createNote(category?: string): void;
  showPlan(planId: string): void;
  setVisualEffect(effect: string, intensity: number): void;
  playMedia(mediaId: string, loop: boolean, volume: number): void;
  pauseMedia(mediaId?: string): void;
  enterVr(): Promise<void> | void;
  exitVr(): void;
  modelPlayAnimation(modelSceneId: string, animationName: string, loop: boolean): void;
  modelSetVisibility(modelSceneId: string, nodeNames: readonly string[], visible: boolean): void;
  /** Ejecuta un script del autor. El anfitrión aplica la política de J09. */
  runScript(source: string, purpose: string): Promise<void> | void;
  /** Registro de diagnóstico local, sin datos sensibles. */
  log(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>): void;
}

export interface ActionContext {
  readonly device: DeviceKind;
  readonly online: boolean;
  /** El recorrido se ve publicado y de solo lectura. */
  readonly published: boolean;
  readonly inVr: boolean;
}

export interface RunOptions {
  readonly context: ActionContext;
  /** Momento actual en ms, inyectable para pruebas. */
  readonly nowMs: number;
  /** Temporizador inyectable: las pruebas no esperan en tiempo real. */
  readonly schedule?: (fn: () => void, delayMs: number) => void;
}

/**
 * Ejecutor de acciones.
 *
 * Mantiene el registro de las acciones marcadas «una sola vez» por sesión.
 * Ese estado vive aquí y no en cada marcador porque el recorrido publicado es
 * de solo lectura: marcar el hotspot como ejecutado sería modificar el
 * manifiesto.
 */
export class ActionRunner {
  private readonly executedOnce = new Set<string>();
  private readonly pendingTimers = new Set<number>();

  constructor(private readonly host: ActionHost) {}

  /** Olvida el registro de «una sola vez». Se llama al reiniciar la sesión. */
  resetSession(): void {
    this.executedOnce.clear();
  }

  /** Cancela los retardos pendientes. Se llama al salir de una escena. */
  cancelPending(): void {
    for (const timer of this.pendingTimers) globalThis.clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Ejecuta todas las acciones de un evento.
   *
   * Las acciones se ordenan de forma estable y se ejecutan en secuencia; las
   * que declaran retardo se programan. Una acción que falla no detiene a las
   * siguientes.
   */
  async run(
    actions: readonly Action[],
    event: ActionEvent,
    options: RunOptions,
  ): Promise<readonly ActionOutcome[]> {
    const applicable = sortActions(actions.filter((a) => a.enabled && a.event === event));
    const outcomes: ActionOutcome[] = [];

    for (const action of applicable) {
      const gate = this.evaluateGate(action, options);
      if (gate !== null) {
        outcomes.push({ actionId: action.id, type: action.config.type, status: 'skipped', reason: gate });
        continue;
      }

      if (action.delayMs > 0) {
        this.scheduleDelayed(action, options);
        outcomes.push({
          actionId: action.id,
          type: action.config.type,
          status: 'executed',
          reason: `programada en ${action.delayMs} ms`,
        });
        continue;
      }

      outcomes.push(await this.execute(action, options));
    }

    return outcomes;
  }

  /** Comprueba las condiciones previas. Devuelve el motivo de omisión o `null`. */
  private evaluateGate(action: Action, options: RunOptions): string | null {
    if (action.once && this.executedOnce.has(action.id)) {
      return 'ya se ejecutó en esta sesión';
    }

    if (action.requiresScore !== null) {
      const current = this.host.getVariable('score', action.requiresScore.key);
      const { comparison, value } = action.requiresScore;
      const meets =
        comparison === 'gte' ? current >= value : comparison === 'lte' ? current <= value : current === value;
      if (!meets) {
        return `requiere puntuación ${action.requiresScore.key} ${comparison} ${value} (actual ${current})`;
      }
    }

    if (requiresNetwork(action.config.type) && !options.context.online) {
      // Degradación explícita: la arquitectura exige que lo que depende de
      // Internet lo indique en vez de fallar en silencio.
      return 'requiere conexión a Internet y el equipo está sin conexión';
    }

    if (action.config.type === 'exitVr' && !options.context.inVr) {
      return 'no hay una sesión de realidad virtual activa';
    }

    if (action.config.type === 'createNote' && options.context.published) {
      return 'el recorrido publicado es de solo lectura';
    }

    return null;
  }

  private scheduleDelayed(action: Action, options: RunOptions): void {
    const run = (): void => {
      void this.execute(action, options);
    };

    if (options.schedule !== undefined) {
      options.schedule(run, action.delayMs);
      return;
    }

    const timer = globalThis.setTimeout(() => {
      this.pendingTimers.delete(timer as unknown as number);
      run();
    }, action.delayMs) as unknown as number;
    this.pendingTimers.add(timer);
  }

  private async execute(action: Action, options: RunOptions): Promise<ActionOutcome> {
    const config = action.config;
    const base = { actionId: action.id, type: config.type } as const;

    try {
      switch (config.type) {
        case 'goToScene':
          await this.host.goToScene(config.sceneId, config);
          break;
        case 'lookAt':
          this.host.lookAt(config.view, config.durationMs);
          break;
        case 'openInfoWindow':
          this.host.openInfoWindow(config.windowId, config.modal);
          break;
        case 'openMedia':
          this.host.openMedia(config.mediaId, config.albumMediaIds, config.autoplay);
          break;
        case 'openDocument':
          this.host.openDocument(config.documentId, config.page);
          break;
        case 'downloadFile':
          this.host.downloadFile(config.mediaId, config.suggestedName);
          break;
        case 'openUrl':
          this.host.openUrl(config.url, config.external);
          break;
        case 'openWebframe':
          this.host.openWebframe(config.url, config.width, config.height, config.allowFullscreen);
          break;
        case 'showElement':
          this.host.setElementVisibility(config.elementIds, true);
          break;
        case 'hideElement':
          this.host.setElementVisibility(config.elementIds, false);
          break;
        case 'toggleElement':
          this.host.setElementVisibility(config.elementIds, 'toggle');
          break;
        case 'setVariable':
          this.host.setVariable(config.namespace, config.key, config.operation, config.value);
          break;
        case 'startTour':
          this.host.startTour(config.tourId, config.fromWaypointIndex);
          break;
        case 'stopTour':
          this.host.stopTour();
          break;
        case 'startQuiz':
          this.host.startQuiz(config.quizId);
          break;
        case 'showAsset':
          this.host.showAsset(config.assetId, config.tab);
          break;
        case 'createNote':
          this.host.createNote(config.category);
          break;
        case 'showPlan':
          this.host.showPlan(config.planId);
          break;
        case 'setVisualEffect':
          this.host.setVisualEffect(config.effect, config.intensity);
          break;
        case 'playMedia':
          this.host.playMedia(config.mediaId, config.loop, config.volume);
          break;
        case 'pauseMedia':
          this.host.pauseMedia(config.mediaId);
          break;
        case 'wait':
          await new Promise<void>((resolve) => {
            if (options.schedule !== undefined) options.schedule(resolve, config.durationMs);
            else globalThis.setTimeout(resolve, config.durationMs);
          });
          break;
        case 'enterVr':
          await this.host.enterVr();
          break;
        case 'exitVr':
          this.host.exitVr();
          break;
        case 'modelPlayAnimation':
          this.host.modelPlayAnimation(config.modelSceneId, config.animationName, config.loop);
          break;
        case 'modelSetVisibility':
          this.host.modelSetVisibility(config.modelSceneId, config.nodeNames, config.visible);
          break;
        case 'runScript':
          await this.host.runScript(config.source, config.purpose);
          break;
        default: {
          const exhaustive: never = config;
          throw new Error(`Acción no contemplada: ${JSON.stringify(exhaustive)}`);
        }
      }

      if (action.once) this.executedOnce.add(action.id);
      return { ...base, status: 'executed' };
    } catch (cause) {
      // Una acción rota no puede dejar al visitante atrapado: se registra y
      // la cadena continúa.
      this.host.log('warn', 'La acción no se pudo completar', {
        actionId: action.id,
        type: config.type,
        cause: String(cause),
      });
      return { ...base, status: 'failed', reason: String(cause) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Disparo por mirada sostenida (D13, N07)
 * ------------------------------------------------------------------ */

export interface FocusDwellState {
  readonly targetId: string | null;
  readonly startedAtMs: number;
  /** Progreso 0-1 del tiempo de permanencia. */
  readonly progress: number;
  readonly triggered: boolean;
}

export const IDLE_DWELL: FocusDwellState = {
  targetId: null,
  startedAtMs: 0,
  progress: 0,
  triggered: false,
};

/**
 * Avanza el estado del disparo por mirada.
 *
 * Es el único modo de interacción que funciona igual en escritorio, en móvil
 * y en VR sin mandos. El retardo es imprescindible: sin él, cruzar la escena
 * activaría todo lo que quedara en el camino.
 */
export function updateFocusDwell(
  state: FocusDwellState,
  hoveredId: string | null,
  dwellMs: number,
  nowMs: number,
): FocusDwellState {
  if (hoveredId === null) return IDLE_DWELL;

  if (state.targetId !== hoveredId) {
    return { targetId: hoveredId, startedAtMs: nowMs, progress: 0, triggered: false };
  }

  if (state.triggered) return state;

  const elapsed = nowMs - state.startedAtMs;
  const progress = dwellMs <= 0 ? 1 : Math.min(elapsed / dwellMs, 1);

  return {
    targetId: hoveredId,
    startedAtMs: state.startedAtMs,
    progress,
    triggered: progress >= 1,
  };
}
