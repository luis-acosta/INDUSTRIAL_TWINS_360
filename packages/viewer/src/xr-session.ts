/**
 * Sesión inmersiva real (N01, N02).
 *
 * `webxr.ts` declara qué subconjunto de la plataforma es portable a VR y
 * detecta si el equipo puede entrar. Lo que faltaba es lo otro: pedir la
 * sesión, entregársela al renderizador y recogerla cuando el visitante se
 * quita las gafas. Sin esto, el botón «Entrar en VR» no tenía a dónde llevar.
 *
 * El módulo no importa Three ni toca el DOM. Habla con dos interfaces
 * estrechas —el sistema WebXR del navegador y un puente al gestor XR del
 * renderizador— y eso es lo que permite probar el ciclo de vida completo sin
 * unas gafas puestas: lo que hay que verificar aquí es la secuencia de
 * llamadas y el tratamiento de los fallos, no el dibujado.
 */
import { domainError, err, ok, type DomainError, type Result } from '@it360/domain';

/**
 * Lo que este módulo necesita del gestor XR del renderizador.
 *
 * Es el subconjunto de `WebGLRenderer.xr` que se usa, y nada más. Declararlo
 * así tiene dos consecuencias buenas: la sesión se puede probar con un doble
 * y un cambio en la API de Three rompe la compilación en un punto único.
 */
export interface XrRendererBridge {
  enabled: boolean;
  setReferenceSpaceType(type: XRReferenceSpaceType): void;
  setSession(session: XRSession | null): Promise<void>;
  /**
   * Bucle de fotogramas de la sesión.
   *
   * En XR los fotogramas los pide el visor y no el navegador: usar
   * `requestAnimationFrame` dentro de una sesión inmersiva da un bucle que no
   * está sincronizado con la pantalla del visor, y el resultado es el
   * tartamudeo que produce malestar. Por eso el bucle se cede aquí.
   */
  setAnimationLoop(callback: ((time: number, frame?: XRFrame) => void) | null): void;
}

/** Estado observable de la sesión. */
export interface XrSessionStatus {
  readonly phase: 'idle' | 'requesting' | 'active' | 'ending';
  /** Espacio de referencia concedido; interesa porque cambia la altura. */
  readonly referenceSpace: XRReferenceSpaceType | null;
  /** Motivo del último fallo, para mostrarlo donde el visitante lo lea. */
  readonly error: DomainError | null;
}

export const IDLE_XR_STATUS: XrSessionStatus = {
  phase: 'idle',
  referenceSpace: null,
  error: null,
};

/**
 * Espacios de referencia en orden de preferencia.
 *
 * `local-floor` pone el suelo virtual donde está el suelo real, de modo que
 * una panorámica tomada a la altura de los ojos se ve a la altura de los ojos.
 * `local` es la reserva: sitúa el origen donde esté la cabeza al empezar, lo
 * que descuadra la altura pero permite entrar en visores que no publican el
 * suelo. Pedir sólo `local-floor` dejaría fuera esos visores; pedir sólo
 * `local` empeoraría la experiencia en todos los demás.
 */
export const REFERENCE_SPACE_PREFERENCE: readonly XRReferenceSpaceType[] = ['local-floor', 'local'];

/**
 * Características opcionales que se solicitan.
 *
 * Van como opcionales a propósito: si una de ellas fuese obligatoria, un visor
 * que no la implemente rechazaría la sesión entera. Se pide el seguimiento de
 * manos porque algunos visores autónomos no traen mandos en la caja, y el
 * recorrido debe poder mirarse igual.
 */
export const OPTIONAL_FEATURES: readonly string[] = ['local-floor', 'bounded-floor', 'hand-tracking'];

export interface XrSessionDeps {
  /** `navigator.xr`, o `undefined` donde no exista. */
  readonly xr: XRSystem | undefined;
  readonly renderer: XrRendererBridge;
  /** Se invoca en cada cambio de fase. */
  readonly onStatusChange?: (status: XrSessionStatus) => void;
  /**
   * Bucle de fotogramas inmersivos.
   *
   * Recibe el espacio de referencia concedido porque sin él no se puede leer
   * ninguna pose: `getViewerPose` y `getPose` lo exigen. Pasarlo aquí evita
   * que quien dibuja tenga que volver a pedirlo —una operación asíncrona que
   * no cabe en un fotograma— o guardarlo por su cuenta.
   */
  readonly onXrFrame?: (
    time: number,
    frame: XRFrame | undefined,
    session: XRSession,
    referenceSpace: XRReferenceSpace,
  ) => void;
}

/**
 * Controlador del ciclo de vida de la sesión inmersiva.
 *
 * Una instancia por lienzo. El controlador es la única pieza que conoce el
 * orden correcto de las operaciones, que no es evidente y cuyo
 * incumplimiento produce fallos difíciles de leer: el gestor XR se habilita
 * **antes** de entregar la sesión, el espacio de referencia se fija antes de
 * que el renderizador pida la primera pose, y el bucle de fotogramas se
 * instala sólo cuando la sesión ya está activa.
 */
export class XrSessionController {
  private status: XrSessionStatus = IDLE_XR_STATUS;
  private session: XRSession | null = null;
  private space: XRReferenceSpace | null = null;
  private endListener: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: XrSessionDeps) {}

  get current(): XrSessionStatus {
    return this.status;
  }

  get activeSession(): XRSession | null {
    return this.session;
  }

  /** Espacio de referencia concedido, mientras la sesión esté activa. */
  get activeReferenceSpace(): XRReferenceSpace | null {
    return this.space;
  }

  /**
   * Entra en la sesión inmersiva.
   *
   * Devuelve un error en vez de lanzarlo porque ninguno de los fallos posibles
   * es un defecto del programa: el visitante puede denegar el permiso, el
   * visor puede estar ocupado por otra aplicación, o el equipo puede no tener
   * ninguno. Los tres acaban en un mensaje y en el recorrido plano, que sigue
   * funcionando.
   */
  async enter(): Promise<Result<XRSession>> {
    if (this.disposed) {
      return err(domainError('INTERNAL', 'El visor ya se ha liberado'));
    }
    if (this.session !== null) {
      return ok(this.session);
    }
    if (this.deps.xr === undefined) {
      return this.fail(
        domainError('XR_UNAVAILABLE', 'Este navegador no ofrece WebXR', {
          recovery: 'Abra el recorrido desde el navegador del visor o use la versión plana.',
        }),
      );
    }

    this.setStatus({ phase: 'requesting', referenceSpace: null, error: null });

    let session: XRSession;
    try {
      session = await this.deps.xr.requestSession('immersive-vr', {
        optionalFeatures: [...OPTIONAL_FEATURES],
      });
    } catch (cause) {
      // El rechazo llega como `DOMException` con nombres distintos según el
      // motivo, y la diferencia importa: un permiso denegado se arregla
      // volviendo a pulsar, y un visor ausente no.
      // El nombre se lee del objeto y no tras comprobar `instanceof Error`:
      // `DOMException` no hereda de `Error` en todos los entornos, y
      // perder el nombre convertiría los dos motivos distinguibles en uno
      // genérico justo donde la diferencia importa.
      const name = typeof (cause as { name?: unknown })?.name === 'string' ? (cause as { name: string }).name : '';
      const message =
        name === 'NotAllowedError'
          ? 'El visor denegó el permiso para entrar en modo inmersivo'
          : name === 'InvalidStateError'
            ? 'Otra aplicación está usando el visor'
            : 'No se pudo iniciar la sesión inmersiva';
      return this.fail(
        domainError('XR_UNAVAILABLE', message, {
          recovery: 'Compruebe que el visor está conectado y vuelva a intentarlo.',
        }),
      );
    }

    // A partir de aquí la sesión existe y es responsabilidad nuestra: cualquier
    // fallo en la instalación tiene que terminarla, porque una sesión
    // concedida y no atendida deja el visor en negro hasta que el sistema
    // operativo la mata.
    try {
      const referenceSpace = await this.installSession(session);
      this.session = session;
      this.setStatus({ phase: 'active', referenceSpace, error: null });
      return ok(session);
    } catch (cause) {
      await session.end().catch(() => undefined);
      return this.fail(
        domainError('XR_UNAVAILABLE', 'La sesión inmersiva no pudo configurarse', {
          detail: {
          cause:
            typeof (cause as { message?: unknown })?.message === 'string'
              ? (cause as { message: string }).message
              : String(cause),
        },
        }),
      );
    }
  }

  /** Termina la sesión. Idempotente: salir dos veces no es un error. */
  async exit(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.setStatus({ ...this.status, phase: 'ending' });
    await session.end().catch(() => undefined);
    // `end()` dispara el evento `end`, que es quien hace la limpieza. Si el
    // visor no lo emitiera, la limpieza explícita de abajo evita quedarse con
    // un estado que dice «saliendo» para siempre.
    this.handleEnd();
  }

  /**
   * Libera el controlador.
   *
   * Sin esto, cerrar la pestaña con la sesión abierta deja al visor
   * presentando una escena que ya no se dibuja.
   */
  dispose(): void {
    this.disposed = true;
    void this.exit();
  }

  private async installSession(session: XRSession): Promise<XRReferenceSpaceType> {
    const bridge = this.deps.renderer;
    bridge.enabled = true;

    const granted = await this.chooseReferenceSpace(session);
    bridge.setReferenceSpaceType(granted.type);
    await bridge.setSession(session);
    this.space = granted.space;

    this.endListener = () => this.handleEnd();
    session.addEventListener('end', this.endListener);

    bridge.setAnimationLoop((time, frame) => {
      this.deps.onXrFrame?.(time, frame, session, granted.space);
    });

    return granted.type;
  }

  /**
   * Primer espacio de referencia que el visor conceda.
   *
   * Se pregunta en vez de suponerlo porque `local-floor` puede figurar como
   * característica opcional concedida y aun así fallar al pedir el espacio en
   * visores donde el usuario no ha trazado la zona de juego.
   */
  private async chooseReferenceSpace(
    session: XRSession,
  ): Promise<{ readonly type: XRReferenceSpaceType; readonly space: XRReferenceSpace }> {
    for (const type of REFERENCE_SPACE_PREFERENCE) {
      try {
        const space = await session.requestReferenceSpace(type);
        return { type, space };
      } catch {
        continue;
      }
    }
    throw new Error('El visor no concedió ningún espacio de referencia utilizable');
  }

  private handleEnd(): void {
    const session = this.session;
    if (session !== null && this.endListener !== null) {
      session.removeEventListener('end', this.endListener);
    }
    this.endListener = null;
    this.session = null;
    this.space = null;

    const bridge = this.deps.renderer;
    bridge.setAnimationLoop(null);
    bridge.enabled = false;
    // El bucle plano lo reinstala quien monta el lienzo al ver el estado
    // «idle»: aquí no se sabe con qué vista hay que seguir dibujando.
    void bridge.setSession(null).catch(() => undefined);

    this.setStatus({ phase: 'idle', referenceSpace: null, error: this.status.error });
  }

  private fail(error: DomainError): Result<never> {
    this.setStatus({ phase: 'idle', referenceSpace: null, error });
    return err(error);
  }

  private setStatus(status: XrSessionStatus): void {
    this.status = status;
    this.deps.onStatusChange?.(status);
  }
}
