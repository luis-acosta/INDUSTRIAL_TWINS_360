/**
 * Ejecución aislada de guiones del autor (J09).
 *
 * Las especificaciones son explícitas con esto: «JavaScript personalizado es
 * riesgo alto: deshabilitado por defecto, solo administradores y contexto
 * aislado, sin acceso al sistema operativo». La política —desactivado por
 * omisión, aprobación por huella, nunca en el recorrido publicado— ya estaba en
 * el dominio desde la etapa 02 y no la usaba nadie. Esto es la ejecución, y
 * está construida alrededor de cuatro reglas que son el único motivo por el que
 * se puede permitir esta función:
 *
 * **1. El aislamiento lo da el navegador, no una promesa nuestra.** El guion
 * corre en un `iframe` con `sandbox="allow-scripts"` y sin
 * `allow-same-origin`: un documento así tiene origen opaco, de modo que no
 * puede leer el DOM de la aplicación, ni sus cookies, ni su almacenamiento, ni
 * hacer peticiones a nombre de nadie. Intentar aislar con `with`, `Proxy` o una
 * lista de globales borrados es lo que hace todo el mundo y se rompe siempre:
 * siempre queda un camino de vuelta al objeto global.
 *
 * **2. La superficie es una lista blanca de operaciones.** El guion no recibe
 * funciones, recibe un canal por el que pedir operaciones **por nombre**. Si el
 * nombre no está en la lista, no se ejecuta. Pasarle funciones del anfitrión
 * sería devolverle una referencia al mundo del que se le acaba de sacar.
 *
 * **3. Cada ejecución lleva su propia credencial de un solo uso.** Los mensajes
 * que no la traigan se descartan sin mirar. Sin esto, cualquier otro marco de
 * la página —un vídeo incrustado, una ventana de información que enmarca una
 * página del cliente— podría responder en nombre del guion.
 *
 * **4. El plazo se cumple destruyendo el marco.** Un bucle infinito no se puede
 * interrumpir desde fuera con una variable: hay que quitarle el intérprete. Al
 * vencer el plazo, el marco se elimina y con él el guion.
 *
 * Lo que esto **no** da, y queda dicho: no hay acceso al sistema de archivos,
 * ni a la red, ni a procesos, ni a las API de Tauri. Un guion del autor puede
 * mirar y cambiar el recorrido a través de las operaciones de la lista, y nada
 * más.
 */

import { domainError, err, ok, type DomainError, type Result } from '@it360/domain';

/**
 * Operaciones que un guion puede pedir. Lista blanca, no filtro.
 *
 * Una por cada capacidad de `SCRIPT_API_SURFACE`, que es la superficie que el
 * contrato declara desde la etapa 02: `tour`, `vars`, `ui`, `log` y `scene`.
 * Una prueba comprueba que no haya operación sin capacidad declarada ni
 * capacidad sin operación —si se separaran, el documento diría una cosa y el
 * aislamiento permitiría otra, y la que manda es la segunda—.
 */
export const SCRIPT_OPERATIONS = [
  // scene
  'getSceneId',
  // vars
  'getVariable',
  'setVariable',
  // tour
  'goToScene',
  // ui
  'setNodeVisible',
  // log
  'log',
] as const;

export type ScriptOperation = (typeof SCRIPT_OPERATIONS)[number];

export const isScriptOperation = (value: unknown): value is ScriptOperation =>
  typeof value === 'string' && (SCRIPT_OPERATIONS as readonly string[]).includes(value);

/** Lo que el anfitrión sabe hacer por un guion. */
export interface ScriptHostApi {
  getSceneId(): string | null;
  getVariable(name: string): string | number | boolean | null;
  setVariable(name: string, value: string | number | boolean): void;
  goToScene(sceneId: string): void;
  /** Muestra u oculta un nodo de la piel por identificador. */
  setNodeVisible(nodeId: string, visible: boolean): void;
  log(message: string): void;
}

/** Mensaje que llega del marco aislado. */
export interface SandboxMessage {
  readonly token?: unknown;
  readonly kind?: unknown;
  readonly callId?: unknown;
  readonly operation?: unknown;
  readonly args?: unknown;
  readonly error?: unknown;
}

export type SandboxReply =
  | { readonly kind: 'result'; readonly callId: number; readonly value: unknown }
  | { readonly kind: 'failed'; readonly callId: number; readonly message: string };

/**
 * Trata un mensaje del marco aislado.
 *
 * Está aparte del DOM para poder probar exactamente lo que importa: que un
 * mensaje sin credencial se descarte, que una operación que no está en la lista
 * no se ejecute, y que un argumento del tipo equivocado no llegue al anfitrión.
 * Dentro de un `iframe` real, estas tres reglas no se podrían ejercitar una por
 * una.
 *
 * Devuelve lo que hay que contestar, o `null` cuando el mensaje se descarta: no
 * contestar es parte de la defensa, porque una respuesta —aunque sea un error—
 * le confirma a quien sondea que hay alguien escuchando.
 */
export function handleSandboxMessage(
  message: SandboxMessage,
  token: string,
  api: ScriptHostApi,
): SandboxReply | null {
  if (message.token !== token) return null;
  if (typeof message.callId !== 'number' || !Number.isFinite(message.callId)) return null;

  const callId = message.callId;

  if (message.kind === 'done' || message.kind === 'error') return null;
  if (message.kind !== 'call') {
    return { kind: 'failed', callId, message: 'Mensaje de tipo desconocido.' };
  }

  if (!isScriptOperation(message.operation)) {
    return {
      kind: 'failed',
      callId,
      message: `La operación «${String(message.operation)}» no está permitida para los guiones.`,
    };
  }

  const args = Array.isArray(message.args) ? message.args : [];

  try {
    switch (message.operation) {
      case 'getSceneId':
        return { kind: 'result', callId, value: api.getSceneId() };

      case 'getVariable': {
        const name = args[0];
        if (typeof name !== 'string') {
          return { kind: 'failed', callId, message: 'getVariable espera un nombre de texto.' };
        }
        return { kind: 'result', callId, value: api.getVariable(name) };
      }

      case 'setVariable': {
        const name = args[0];
        const value = args[1];
        if (typeof name !== 'string') {
          return { kind: 'failed', callId, message: 'setVariable espera un nombre de texto.' };
        }
        /* Sólo escalares. Un objeto cruzando esta frontera traería referencias
           del mundo del guion a la memoria del anfitrión, y además las
           variables del recorrido son escalares por contrato. */
        if (
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          typeof value !== 'boolean'
        ) {
          return {
            kind: 'failed',
            callId,
            message: 'setVariable sólo admite texto, número o booleano.',
          };
        }
        api.setVariable(name, value);
        return { kind: 'result', callId, value: null };
      }

      case 'goToScene': {
        const sceneId = args[0];
        if (typeof sceneId !== 'string') {
          return { kind: 'failed', callId, message: 'goToScene espera un identificador.' };
        }
        api.goToScene(sceneId);
        return { kind: 'result', callId, value: null };
      }

      case 'setNodeVisible': {
        const nodeId = args[0];
        const visible = args[1];
        if (typeof nodeId !== 'string' || typeof visible !== 'boolean') {
          return {
            kind: 'failed',
            callId,
            message: 'setNodeVisible espera un identificador y un booleano.',
          };
        }
        api.setNodeVisible(nodeId, visible);
        return { kind: 'result', callId, value: null };
      }

      case 'log': {
        const text = args[0];
        api.log(typeof text === 'string' ? text : String(text));
        return { kind: 'result', callId, value: null };
      }
    }
  } catch (cause) {
    /* Un fallo del anfitrión se cuenta al guion como fallo de la operación y no
       se propaga: una excepción que suba desde aquí rompería el manejador de
       mensajes de la aplicación por culpa del guion de un autor. */
    return {
      kind: 'failed',
      callId,
      message: `La operación falló: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Documento del marco aislado.
 *
 * Se construye aquí para que lo que corre dentro se pueda leer de un tirón. Tres
 * detalles deliberados:
 *
 *  - El guion del autor se mete en una función `async` y no se evalúa en el
 *    ámbito global del marco: así una declaración suya no puede sustituir a algo
 *    del arranque.
 *  - El código del autor va **incrustado como texto de datos** y se lee con
 *    `textContent`, no interpolado en el guion de arranque. Interpolarlo
 *    dejaría que un cierre de comentario o un salto de línea rompieran la
 *    estructura del arranque, que es la vía por la que un guion se saldría de
 *    su función.
 *  - El marco no declara `allow-same-origin`. Con él, el aislamiento no existe:
 *    el documento compartiría origen con la aplicación y podría leerlo todo.
 */
export function sandboxDocument(source: string, token: string): string {
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!doctype html>
<meta charset="utf-8" />
<script id="fuente" type="text/plain">${escaped}</script>
<script>
(() => {
  const TOKEN = ${JSON.stringify(token)};
  let nextCall = 1;
  const pending = new Map();

  addEventListener('message', (event) => {
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const entry = pending.get(data.callId);
    if (entry === undefined) return;
    pending.delete(data.callId);
    if (data.kind === 'result') entry.resolve(data.value);
    else entry.reject(new Error(String(data.message)));
  });

  const call = (operation, ...args) => {
    const callId = nextCall++;
    return new Promise((resolve, reject) => {
      pending.set(callId, { resolve, reject });
      parent.postMessage({ token: TOKEN, kind: 'call', callId, operation, args }, '*');
    });
  };

  // La API que ve el guion: funciones que piden operaciones por nombre, nunca
  // referencias del anfitrión. Congelada para que el guion no la reescriba y
  // deje trampas a los que corran después en este mismo marco.
  const it360 = Object.freeze({
    scene: Object.freeze({ id: () => call('getSceneId') }),
    vars: Object.freeze({
      get: (name) => call('getVariable', name),
      set: (name, value) => call('setVariable', name, value),
    }),
    tour: Object.freeze({ goToScene: (sceneId) => call('goToScene', sceneId) }),
    ui: Object.freeze({
      show: (nodeId) => call('setNodeVisible', nodeId, true),
      hide: (nodeId) => call('setNodeVisible', nodeId, false),
    }),
    log: Object.freeze({ info: (message) => call('log', message) }),
  });

  const source = document.getElementById('fuente').textContent;

  (async () => {
    try {
      // El guion del autor, dentro de una función: una declaración suya no
      // puede sustituir nada del arranque.
      const fn = new Function('it360', '"use strict";\\nreturn (async () => {' + source + '})();');
      await fn(it360);
      parent.postMessage({ token: TOKEN, kind: 'done', callId: 0 }, '*');
    } catch (error) {
      parent.postMessage({
        token: TOKEN,
        kind: 'error',
        callId: 0,
        error: String(error && error.message ? error.message : error),
      }, '*');
    }
  })();
})();
</script>`;
}

/** Credencial de un solo uso para una ejecución. */
export function sandboxToken(random: () => number = Math.random): string {
  return `it360-${Math.floor(random() * 2 ** 48).toString(36)}-${Date.now().toString(36)}`;
}

export interface SandboxRunOptions {
  readonly timeoutMs: number;
  readonly api: ScriptHostApi;
  /** Contenedor donde se monta el marco; por omisión, el cuerpo del documento. */
  readonly mount?: HTMLElement;
}

/**
 * Ejecuta un guion en un marco aislado y espera su final.
 *
 * El plazo se cumple **destruyendo el marco**: un bucle infinito no se
 * interrumpe desde fuera con una variable, hay que quitarle el intérprete.
 */
export async function runSandboxed(
  source: string,
  options: SandboxRunOptions,
): Promise<Result<void, DomainError>> {
  const doc = globalThis.document;
  if (doc === undefined) {
    return err(
      domainError('SCRIPT_DISABLED', 'No hay documento donde aislar el guion.', {
        recovery: 'Los guiones sólo se ejecutan en la aplicación, no en procesos sin interfaz.',
      }),
    );
  }

  const token = sandboxToken();
  const frame = doc.createElement('iframe');
  // Sin `allow-same-origin`: con él, el documento compartiría origen con la
  // aplicación y el aislamiento no existiría.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  frame.srcdoc = sandboxDocument(source, token);

  const mount = options.mount ?? doc.body;

  return new Promise<Result<void, DomainError>>((resolve) => {
    let settled = false;

    const finish = (result: Result<void, DomainError>): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      globalThis.removeEventListener('message', onMessage);
      frame.remove();
      resolve(result);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as SandboxMessage;
      if (data === null || typeof data !== 'object' || data.token !== token) return;

      if (data.kind === 'done') {
        finish(ok(undefined));
        return;
      }
      if (data.kind === 'error') {
        finish(
          err(
            domainError('SCRIPT_FAILED', `El guion falló: ${String(data.error)}`, {
              recovery: 'Revise el código del guion en el editor de acciones.',
            }),
          ),
        );
        return;
      }

      const reply = handleSandboxMessage(data, token, options.api);
      if (reply === null) return;
      frame.contentWindow?.postMessage(reply, '*');
    };

    const timer = globalThis.setTimeout(() => {
      finish(
        err(
          domainError('SCRIPT_TIMEOUT', `El guion superó el plazo de ${options.timeoutMs} ms.`, {
            recovery:
              'Se detuvo para no bloquear la aplicación. Revise si tiene un bucle sin salida.',
          }),
        ),
      );
    }, options.timeoutMs);

    globalThis.addEventListener('message', onMessage);
    mount.append(frame);
  });
}
