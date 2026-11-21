/**
 * Pruebas del aislamiento de guiones del autor (J09).
 *
 * Las especificaciones califican esta función de riesgo alto, así que las
 * pruebas no van del camino feliz: van de las tres formas en que un aislamiento
 * se rompe de verdad.
 *
 *  1. **Alguien contesta en nombre del guion.** Una página incrustada en una
 *     ventana de información, un vídeo de otro origen: cualquier marco de la
 *     página puede enviar mensajes. Sin credencial de un solo uso, el
 *     anfitrión ejecutaría operaciones que el guion nunca pidió.
 *  2. **El guion pide algo que no está en la lista.** La defensa es una lista
 *     blanca de nombres, no un filtro de lo peligroso: lo que no está, no se
 *     ejecuta, y así una operación nueva del anfitrión no queda expuesta por
 *     olvido.
 *  3. **El guion manda un argumento del tipo equivocado.** Un objeto cruzando
 *     la frontera trae referencias del mundo del guion a la memoria del
 *     anfitrión.
 *
 * El documento del marco se comprueba por lo que **no** contiene: el código del
 * autor no se interpola en el guion de arranque, porque interpolarlo es
 * exactamente cómo un guion se sale de su función.
 */
import { describe, expect, it, vi } from 'vitest';

import { SCRIPT_API_SURFACE } from '@it360/domain';

import {
  SCRIPT_OPERATIONS,
  handleSandboxMessage,
  isScriptOperation,
  sandboxDocument,
  sandboxToken,
  type ScriptHostApi,
} from './script-sandbox';

const TOKEN = 'it360-prueba';

function hostApi(overrides: Partial<ScriptHostApi> = {}): ScriptHostApi {
  return {
    getSceneId: vi.fn(() => 'escena-1'),
    getVariable: vi.fn(() => 'valor'),
    setVariable: vi.fn(),
    goToScene: vi.fn(),
    setNodeVisible: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe('credencial de un solo uso', () => {
  it('descarta un mensaje sin credencial, y sin contestar', () => {
    // TEST-SBX-001: no contestar es parte de la defensa. Una respuesta
    // —aunque sea un error— confirma a quien sondea que hay alguien
    // escuchando, y le dice cuándo ha acertado con el formato.
    const api = hostApi();

    const reply = handleSandboxMessage(
      { kind: 'call', callId: 1, operation: 'goToScene', args: ['escena-9'] },
      TOKEN,
      api,
    );

    expect(reply).toBeNull();
    expect(api.goToScene).not.toHaveBeenCalled();
  });

  it('descarta un mensaje con otra credencial', () => {
    // TEST-SBX-002: el caso real es otro marco de la misma página —una página
    // del cliente enmarcada en una ventana de información— enviando mensajes.
    const api = hostApi();

    const reply = handleSandboxMessage(
      { token: 'otra', kind: 'call', callId: 1, operation: 'setVariable', args: ['x', 1] },
      TOKEN,
      api,
    );

    expect(reply).toBeNull();
    expect(api.setVariable).not.toHaveBeenCalled();
  });

  it('cada ejecución recibe una credencial distinta', () => {
    // TEST-SBX-003: una credencial fija se descubre una vez y vale para
    // siempre; el objeto es que un mensaje preparado para una ejecución no
    // sirva para la siguiente.
    const a = sandboxToken(() => 0.1);
    const b = sandboxToken(() => 0.9);

    expect(a).not.toBe(b);
  });
});

describe('lista blanca de operaciones', () => {
  it('rechaza una operación que no está en la lista', () => {
    // TEST-SBX-004: la defensa es una lista blanca y no un filtro de lo
    // peligroso. Con un filtro, cada operación nueva del anfitrión queda
    // expuesta hasta que alguien se acuerde de añadirla al filtro.
    const api = hostApi();

    const reply = handleSandboxMessage(
      { token: TOKEN, kind: 'call', callId: 7, operation: 'deleteProject', args: [] },
      TOKEN,
      api,
    );

    expect(reply).toEqual({
      kind: 'failed',
      callId: 7,
      message: expect.stringContaining('no está permitida'),
    });
  });

  it('la lista no incluye nada que toque el sistema', () => {
    // TEST-SBX-005: las especificaciones lo exigen —«sin acceso al sistema
    // operativo»—, y esta prueba es lo que hará saltar un añadido descuidado.
    expect([...SCRIPT_OPERATIONS]).toEqual([
      'getSceneId',
      'getVariable',
      'setVariable',
      'goToScene',
      'setNodeVisible',
      'log',
    ]);
    expect(isScriptOperation('readFile')).toBe(false);
    expect(isScriptOperation('invoke')).toBe(false);
  });

  it('un tipo de mensaje desconocido no se ejecuta', () => {
    // TEST-SBX-006
    const reply = handleSandboxMessage(
      { token: TOKEN, kind: 'eval', callId: 1, operation: 'log', args: ['x'] },
      TOKEN,
      hostApi(),
    );

    expect(reply).toMatchObject({ kind: 'failed' });
  });
});

describe('argumentos', () => {
  it('sólo deja pasar escalares a setVariable', () => {
    // TEST-SBX-007: un objeto cruzando la frontera trae referencias del mundo
    // del guion a la memoria del anfitrión. Y las variables del recorrido son
    // escalares por contrato, así que no se pierde nada.
    const api = hostApi();

    const reply = handleSandboxMessage(
      {
        token: TOKEN,
        kind: 'call',
        callId: 1,
        operation: 'setVariable',
        args: ['x', { toString: () => 'truco' }],
      },
      TOKEN,
      api,
    );

    expect(reply).toMatchObject({ kind: 'failed' });
    expect(api.setVariable).not.toHaveBeenCalled();
  });

  it('acepta los tres escalares del contrato', () => {
    // TEST-SBX-008
    const api = hostApi();

    for (const value of ['texto', 42, true]) {
      handleSandboxMessage(
        { token: TOKEN, kind: 'call', callId: 1, operation: 'setVariable', args: ['x', value] },
        TOKEN,
        api,
      );
    }

    expect(api.setVariable).toHaveBeenCalledTimes(3);
  });

  it('un nombre que no es texto se rechaza', () => {
    // TEST-SBX-009: con un nombre numérico, la variable se guardaría bajo una
    // clave que ninguna plantilla del recorrido puede nombrar: un cambio que
    // no hace nada y que nadie entiende.
    const api = hostApi();

    const reply = handleSandboxMessage(
      { token: TOKEN, kind: 'call', callId: 1, operation: 'getVariable', args: [7] },
      TOKEN,
      api,
    );

    expect(reply).toMatchObject({ kind: 'failed' });
    expect(api.getVariable).not.toHaveBeenCalled();
  });

  it('un fallo del anfitrión se cuenta al guion y no se propaga', () => {
    // TEST-SBX-010: una excepción que subiera desde aquí rompería el manejador
    // de mensajes de la aplicación por culpa del guion de un autor.
    const api = hostApi({
      goToScene: () => {
        throw new Error('esa escena no existe');
      },
    });

    const reply = handleSandboxMessage(
      { token: TOKEN, kind: 'call', callId: 3, operation: 'goToScene', args: ['x'] },
      TOKEN,
      api,
    );

    expect(reply).toEqual({
      kind: 'failed',
      callId: 3,
      message: expect.stringContaining('esa escena no existe'),
    });
  });

  it('un identificador de llamada que no es número se descarta', () => {
    // TEST-SBX-011: sin él no se puede contestar a nadie, y contestar a un
    // identificador inventado resolvería una promesa que no es la que espera.
    expect(
      handleSandboxMessage(
        { token: TOKEN, kind: 'call', callId: 'uno', operation: 'log', args: ['x'] },
        TOKEN,
        hostApi(),
      ),
    ).toBeNull();
  });
});

describe('documento del marco', () => {
  it('no interpola el código del autor en el guion de arranque', () => {
    // TEST-SBX-012: es la comprobación más importante del archivo.
    // Interpolarlo deja que el código del autor termine la cadena o el
    // comentario que lo envuelve y siga escribiendo en el ámbito del arranque,
    // que es justo el lugar del que se le acaba de sacar.
    const malicioso = `'; parent.postMessage({kind:'call',operation:'deleteProject'},'*'); //`;
    const doc = sandboxDocument(malicioso, TOKEN);

    // El código va dentro de un bloque de datos, leído con textContent.
    expect(doc).toContain('id="fuente" type="text/plain"');
    expect(doc).toContain("document.getElementById('fuente').textContent");
    // Y no aparece dentro del guion de arranque.
    const arranque = doc.slice(doc.indexOf('<script>'));
    expect(arranque).not.toContain('deleteProject');
  });

  it('escapa los signos que cerrarían la etiqueta antes de tiempo', () => {
    // TEST-SBX-013: un guion que contenga «</script>» cerraría su propio
    // bloque de datos y lo que siguiera se interpretaría como HTML del marco.
    const doc = sandboxDocument('const x = 1; // </script><img src=x onerror=1>', TOKEN);
    /* Se mira el contenido del bloque y no el bloque: su etiqueta de cierre
       es un «</script>» legítimo, y buscarlo con ella dentro confundiría la
       etiqueta real con una inyectada. */
    const inicio = doc.indexOf('>', doc.indexOf('id="fuente"')) + 1;
    const contenido = doc.slice(inicio, doc.indexOf('</script>', inicio));

    expect(contenido).not.toContain('</script>');
    expect(contenido).not.toContain('<img');
    expect(contenido).toContain('&lt;');
  });

  it('el marco se aísla sin compartir origen', () => {
    // TEST-SBX-014: con `allow-same-origin` el aislamiento no existe —el
    // documento compartiría origen con la aplicación y podría leer su DOM, sus
    // cookies y su almacenamiento—. Esta prueba existe para que nadie lo añada
    // «para que funcione algo».
    const doc = sandboxDocument('', TOKEN);

    expect(doc).not.toContain('allow-same-origin');
  });

  it('la API del guion va congelada', () => {
    // TEST-SBX-015: si el guion pudiera reescribirla, dejaría trampas a los
    // que corran después en ese mismo marco.
    expect(sandboxDocument('', TOKEN)).toContain('Object.freeze(');
  });

  it('el guion del autor corre dentro de una función, no en el ámbito global', () => {
    // TEST-SBX-016: en el ámbito global, una declaración del autor podría
    // sustituir a algo del arranque —`parent`, `call`, la propia API— y
    // romper la frontera desde dentro.
    expect(sandboxDocument('', TOKEN)).toContain('new Function(');
    expect(sandboxDocument('', TOKEN)).toContain('"use strict"');
  });
});

describe('la superficie del aislamiento y la del contrato coinciden', () => {
  it('cada capacidad declarada tiene operación y al revés', () => {
    // TEST-SBX-017: `SCRIPT_API_SURFACE` está en el contrato desde la etapa 02
    // y es lo que el manual documenta. Si las dos listas se separaran, el
    // documento diría una cosa y el aislamiento permitiría otra, y la que
    // manda es la segunda: así es como una capacidad acaba expuesta sin que
    // nadie la haya revisado.
    const porCapacidad: Readonly<Record<string, readonly string[]>> = {
      scene: ['getSceneId'],
      vars: ['getVariable', 'setVariable'],
      tour: ['goToScene'],
      ui: ['setNodeVisible'],
      log: ['log'],
    };

    expect(Object.keys(porCapacidad).sort()).toEqual([...SCRIPT_API_SURFACE].sort());
    expect(Object.values(porCapacidad).flat().sort()).toEqual([...SCRIPT_OPERATIONS].sort());
  });

  it('el objeto que ve el guion está agrupado por capacidad', () => {
    // TEST-SBX-018: el manual promete «vars.get», «tour.goToScene» y
    // «log.info». Un objeto plano haría que todos los ejemplos del manual
    // fallaran, y el autor concluiría que los guiones no funcionan.
    const doc = sandboxDocument('', TOKEN);

    for (const capacidad of SCRIPT_API_SURFACE) {
      expect(doc).toContain(`${capacidad}: Object.freeze(`);
    }
    expect(doc).toContain('get: (name) =>');
    expect(doc).toContain('goToScene: (sceneId) =>');
    expect(doc).toContain('info: (message) =>');
  });
});
