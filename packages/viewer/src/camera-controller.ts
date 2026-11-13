/**
 * Control de cámara del visor panorámico (etapa 01, C02 y C03).
 *
 * El controlador es independiente de Three.js y del DOM: recibe gestos ya
 * traducidos a desplazamientos y produce una orientación. Esa separación es
 * lo que permite probar la inercia, los límites y el zoom con pruebas
 * unitarias deterministas, en lugar de intentar simular arrastres sobre un
 * lienzo WebGL.
 *
 * El modelo de inercia es un amortiguador exponencial sobre la velocidad
 * angular. Se eligió frente a una curva de animación con duración fija
 * porque el gesto no tiene duración conocida: el usuario puede soltar en
 * cualquier momento y con cualquier velocidad, y lo que debe conservarse es
 * su impulso, no un tiempo preestablecido.
 */
import {
  applyZoom,
  clamp,
  constrainView,
  degToRad,
  FOV_MAX_DEG,
  FOV_MIN_DEG,
  normalizeCameraView,
  wrapYaw,
  type CameraControl,
  type CameraView,
  type PanoramaCoverage,
  type ZoomLimits,
} from '@it360/domain';

export interface CameraControllerOptions {
  readonly control: CameraControl;
  readonly coverage: PanoramaCoverage;
  /** Tamaño del lienzo, para convertir píxeles en ángulo. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Velocidad angular por debajo de la cual la inercia se considera agotada. */
const INERTIA_EPSILON = 1e-4;

/**
 * Fotogramas por segundo de referencia del amortiguador.
 *
 * La inercia configurada es un factor por fotograma a 60 fps. Para que la
 * sensación no dependa de la tasa real —y un equipo a 30 fps no frene el
 * doble de rápido— el factor se reescala con el tiempo transcurrido.
 */
const REFERENCE_FPS = 60;

export class CameraController {
  private view: CameraView;
  private velocityYaw = 0;
  private velocityPitch = 0;
  private control: CameraControl;
  private coverage: PanoramaCoverage;
  /**
   * Alto del lienzo en píxeles.
   *
   * La densidad angular se deriva sólo de la altura: el FOV vertical es el
   * que declara la cámara, y usar el ancho haría que el mismo arrastre girara
   * distinto en una ventana apaisada que en una estrecha. El ancho sí importa
   * para los límites de cobertura, que calcula el dominio.
   */
  private viewportHeight: number;
  private dragging = false;
  private lastInteractionMs = 0;

  constructor(options: CameraControllerOptions) {
    this.control = options.control;
    this.coverage = options.coverage;
    this.viewportHeight = Math.max(options.viewportHeight, 1);
    this.view = constrainView(normalizeCameraView(options.control.initialView), options.coverage);
  }

  getView(): CameraView {
    return this.view;
  }

  isMoving(): boolean {
    return (
      this.dragging ||
      Math.abs(this.velocityYaw) > INERTIA_EPSILON ||
      Math.abs(this.velocityPitch) > INERTIA_EPSILON
    );
  }

  setViewport(_width: number, height: number): void {
    this.viewportHeight = Math.max(height, 1);
    // Cambiar de tamaño puede alterar los límites efectivos: al estrechar la
    // ventana, una panorámica parcial deja de caber igual.
    this.view = constrainView(this.view, this.coverage);
  }

  setCoverage(coverage: PanoramaCoverage): void {
    this.coverage = coverage;
    this.view = constrainView(this.view, coverage);
  }

  setControl(control: CameraControl): void {
    this.control = control;
    this.view = constrainView(
      { ...this.view, fov: clamp(this.view.fov, control.zoom.minFovDeg, control.zoom.maxFovDeg) },
      this.coverage,
    );
  }

  /** Coloca la cámara sin animación. */
  setView(view: Partial<CameraView>): void {
    this.view = constrainView(normalizeCameraView({ ...this.view, ...view }), this.coverage);
    this.velocityYaw = 0;
    this.velocityPitch = 0;
  }

  /* ---------------------------------------------------------------- *
   * Gestos
   * ---------------------------------------------------------------- */

  beginDrag(nowMs: number): void {
    this.dragging = true;
    this.velocityYaw = 0;
    this.velocityPitch = 0;
    this.lastInteractionMs = nowMs;
  }

  /**
   * Arrastre en píxeles.
   *
   * La conversión de píxeles a ángulo depende del FOV: con el zoom acercado,
   * el mismo desplazamiento del ratón debe girar menos. Sin esta relación, el
   * arrastre resulta inmanejable al acercar y perezoso al alejar, que es el
   * defecto más común de un visor 360 hecho a medias.
   */
  drag(deltaXPx: number, deltaYPx: number, nowMs: number): void {
    const dt = Math.max(nowMs - this.lastInteractionMs, 1) / 1000;
    this.lastInteractionMs = nowMs;

    const fovRad = degToRad(this.view.fov);
    const radiansPerPixelY = fovRad / this.viewportHeight;
    const radiansPerPixelX = radiansPerPixelY; // misma densidad en ambos ejes

    const speed = this.control.dragSpeed;
    const deltaYaw = -deltaXPx * radiansPerPixelX * speed;
    const deltaPitch = (this.control.invertPitch ? -1 : 1) * deltaYPx * radiansPerPixelY * speed;

    const before = this.view;
    this.view = constrainView(
      { ...this.view, yaw: wrapYaw(this.view.yaw + deltaYaw), pitch: this.view.pitch + deltaPitch },
      this.coverage,
    );

    // La velocidad se mide sobre el movimiento REALMENTE aplicado, no sobre
    // el solicitado: si el arrastre topó con el límite de una panorámica
    // parcial, no debe quedar inercia empujando contra el tope.
    const appliedYaw = wrapYaw(this.view.yaw - before.yaw);
    const appliedPitch = this.view.pitch - before.pitch;
    this.velocityYaw = appliedYaw / dt;
    this.velocityPitch = appliedPitch / dt;
  }

  endDrag(): void {
    this.dragging = false;
    if (this.control.inertia <= 0) {
      this.velocityYaw = 0;
      this.velocityPitch = 0;
    }
  }

  /** Zoom por rueda o pellizco. `factor` < 1 acerca, > 1 aleja. */
  zoom(factor: number, nowMs: number): void {
    this.lastInteractionMs = nowMs;
    const limits: ZoomLimits = this.control.zoom;
    const fov = applyZoom(this.view.fov, factor, {
      minFovDeg: clamp(limits.minFovDeg, FOV_MIN_DEG, FOV_MAX_DEG),
      maxFovDeg: clamp(limits.maxFovDeg, FOV_MIN_DEG, FOV_MAX_DEG),
    });
    this.view = constrainView({ ...this.view, fov }, this.coverage);
  }

  /** Desplazamiento por teclado: un paso fijo, independiente del FOV. */
  nudge(direction: 'left' | 'right' | 'up' | 'down', stepDeg = 5): void {
    const step = degToRad(stepDeg);
    const delta = {
      left: { yaw: -step, pitch: 0 },
      right: { yaw: step, pitch: 0 },
      up: { yaw: 0, pitch: step },
      down: { yaw: 0, pitch: -step },
    }[direction];
    this.setView({ yaw: wrapYaw(this.view.yaw + delta.yaw), pitch: this.view.pitch + delta.pitch });
  }

  /* ---------------------------------------------------------------- *
   * Avance de simulación
   * ---------------------------------------------------------------- */

  /**
   * Avanza el estado el tiempo indicado.
   *
   * Devuelve `true` si la vista cambió, para que el renderizador pueda
   * saltarse el fotograma cuando no hay movimiento. En un portátil con GPU
   * integrada, no redibujar una escena estática es la diferencia entre un
   * ventilador en marcha permanente y uno en silencio.
   */
  update(deltaMs: number, nowMs: number): boolean {
    const before = this.view;
    const dt = Math.max(deltaMs, 0) / 1000;

    if (!this.dragging && (Math.abs(this.velocityYaw) > INERTIA_EPSILON || Math.abs(this.velocityPitch) > INERTIA_EPSILON)) {
      this.view = constrainView(
        {
          ...this.view,
          yaw: wrapYaw(this.view.yaw + this.velocityYaw * dt),
          pitch: this.view.pitch + this.velocityPitch * dt,
        },
        this.coverage,
      );

      // Amortiguación exponencial reescalada a la tasa real de fotogramas.
      const damping = Math.pow(this.control.inertia, deltaMs / (1000 / REFERENCE_FPS));
      this.velocityYaw *= damping;
      this.velocityPitch *= damping;

      if (Math.abs(this.velocityYaw) < INERTIA_EPSILON) this.velocityYaw = 0;
      if (Math.abs(this.velocityPitch) < INERTIA_EPSILON) this.velocityPitch = 0;

      // Si la vista topó con un límite, la inercia en ese eje se extingue.
      if (this.view.pitch === before.pitch && this.velocityPitch !== 0) this.velocityPitch = 0;
    } else if (
      this.control.autoRotate &&
      !this.dragging &&
      nowMs - this.lastInteractionMs > this.control.autoRotateIdleS * 1000
    ) {
      this.view = constrainView(
        { ...this.view, yaw: wrapYaw(this.view.yaw + this.control.autoRotateSpeed * dt) },
        this.coverage,
      );
    }

    return (
      this.view.yaw !== before.yaw ||
      this.view.pitch !== before.pitch ||
      this.view.fov !== before.fov
    );
  }

  /** Señala interacción del usuario: detiene el giro automático. */
  markInteraction(nowMs: number): void {
    this.lastInteractionMs = nowMs;
  }
}
