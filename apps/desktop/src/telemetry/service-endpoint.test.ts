/**
 * Pruebas de la dirección del servicio de telemetría.
 *
 * Lo que se protege aquí es un límite de confianza: el editor no debe poder
 * apuntar a un esquema que lea del disco, ni llevar credenciales en la URL, ni
 * elegir el cliente real cuando no hay dirección —porque entonces mostraría
 * errores de red donde antes mostraba datos simulados rotulados como tales.
 */
import { describe, expect, it } from 'vitest';

import {
  SERVICE_ENDPOINT_KEY,
  createTelemetryClient,
  isLoopbackEndpoint,
  loadServiceEndpoint,
  parseServiceEndpoint,
  saveServiceEndpoint,
  type EndpointStore,
} from './service-endpoint';

/** Almacén en memoria con la misma superficie que `localStorage`. */
function memoryStore(initial: Record<string, string> = {}): EndpointStore & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** Almacén que falla, como el de una ventana privada. */
const hostileStore: EndpointStore = {
  getItem: () => {
    throw new Error('acceso denegado');
  },
  setItem: () => {
    throw new Error('acceso denegado');
  },
  removeItem: () => {
    throw new Error('acceso denegado');
  },
};

describe('parseServiceEndpoint', () => {
  it('normaliza la raíz quitando la barra final', () => {
    // TEST-TEL-040: con barra final y rutas que empiezan por barra se pediría
    // «//api/v1/...», que no todos los servidores resuelven igual.
    const result = parseServiceEndpoint('  http://127.0.0.1:8787/  ');
    expect(result.ok && result.value).toBe('http://127.0.0.1:8787');
  });

  it('conserva un prefijo de ruta', () => {
    // TEST-TEL-041: tras un proxy inverso, el servicio puede vivir bajo un
    // prefijo; perderlo dejaría el editor pidiendo a la raíz del proxy.
    const result = parseServiceEndpoint('https://planta.local/telemetria/');
    expect(result.ok && result.value).toBe('https://planta.local/telemetria');
  });

  it('rechaza esquemas que no son http', () => {
    // TEST-TEL-042: `file:` leería del disco del equipo, y un esquema
    // personalizado acabaría en un manejador del sistema operativo.
    for (const raw of ['file:///etc/passwd', 'ftp://planta.local', 'javascript:alert(1)']) {
      expect(parseServiceEndpoint(raw).ok).toBe(false);
    }
  });

  it('rechaza credenciales en la dirección', () => {
    // TEST-TEL-043: viajarían en cada petición y acabarían en los registros
    // del servidor. Además el editor no maneja credenciales de telemetría.
    const result = parseServiceEndpoint('http://admin:secreto@127.0.0.1:8787');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('usuario');
  });

  it('rechaza parámetros y fragmento', () => {
    // TEST-TEL-044: con «?» detrás, la ruta compuesta ya no es la que el
    // servicio publica.
    expect(parseServiceEndpoint('http://127.0.0.1:8787/?token=abc').ok).toBe(false);
    expect(parseServiceEndpoint('http://127.0.0.1:8787/#x').ok).toBe(false);
  });

  it('rechaza una dirección vacía o inválida', () => {
    // TEST-TEL-045: el campo vacío significa «usar el simulador», y eso se
    // decide borrando la dirección, no guardando una cadena vacía.
    expect(parseServiceEndpoint('   ').ok).toBe(false);
    expect(parseServiceEndpoint('127.0.0.1:8787').ok).toBe(false);
  });
});

describe('isLoopbackEndpoint', () => {
  it('distingue el equipo propio de un servicio de red', () => {
    // TEST-TEL-046: contra un servicio remoto por http las lecturas viajan en
    // claro por la red industrial; la interfaz tiene que poder advertirlo.
    expect(isLoopbackEndpoint('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:8787')).toBe(true);
    expect(isLoopbackEndpoint('http://10.4.2.9:8787')).toBe(false);
  });
});

describe('almacenamiento', () => {
  it('guarda y recupera la dirección', () => {
    // TEST-TEL-047: la dirección es del equipo, no del proyecto: tiene que
    // sobrevivir a abrir otro recorrido.
    const store = memoryStore();
    saveServiceEndpoint('http://127.0.0.1:8787', store);
    expect(store.data.get(SERVICE_ENDPOINT_KEY)).toBe('http://127.0.0.1:8787');
    expect(loadServiceEndpoint(store)).toBe('http://127.0.0.1:8787');
  });

  it('borra la dirección al pasar null', () => {
    // TEST-TEL-048: volver al simulador es una operación explícita.
    const store = memoryStore({ [SERVICE_ENDPOINT_KEY]: 'http://127.0.0.1:8787' });
    saveServiceEndpoint(null, store);
    expect(loadServiceEndpoint(store)).toBeNull();
  });

  it('ignora una dirección guardada que ya no es válida', () => {
    // TEST-TEL-049: una versión anterior pudo guardar otro formato. Arrancar
    // con el simulador es recuperable; arrancar con una dirección inservible
    // deja el panel lleno de errores de red sin explicación.
    const store = memoryStore({ [SERVICE_ENDPOINT_KEY]: 'file:///tmp' });
    expect(loadServiceEndpoint(store)).toBeNull();
  });

  it('sobrevive a un almacén que falla', () => {
    // TEST-TEL-050: `localStorage` lanza en modo privado. No poder recordar la
    // dirección no justifica que el editor no arranque.
    expect(loadServiceEndpoint(hostileStore)).toBeNull();
    expect(() => saveServiceEndpoint('http://127.0.0.1:8787', hostileStore)).not.toThrow();
  });
});

describe('createTelemetryClient', () => {
  it('usa el simulador cuando no hay dirección', () => {
    // TEST-TEL-051: y el tipo lo dice, que es lo que la interfaz rotula. Un
    // panel con números inventados sin avisar es peor que un panel vacío.
    expect(createTelemetryClient(null).kind).toBe('simulated');
  });

  it('usa el servicio cuando hay dirección', () => {
    // TEST-TEL-052: hasta ahora el editor construía siempre el simulador, de
    // modo que el cliente real no era alcanzable desde la interfaz.
    expect(createTelemetryClient('http://127.0.0.1:8787').kind).toBe('backend');
  });
});
