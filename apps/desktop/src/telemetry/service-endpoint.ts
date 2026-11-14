/**
 * Dirección del servicio local de telemetría.
 *
 * El editor no habla con InfluxDB: habla con el servicio local, que es quien
 * tiene el token. Esa dirección es una propiedad del **equipo**, no del
 * proyecto, y por eso no se guarda en el `.ivp`: un recorrido copiado a otro
 * puesto llevaría apuntada una dirección que allí no existe, y un `.ivp`
 * enviado por correo dejaría ver la topología de la red de planta.
 *
 * Mientras no haya dirección configurada, el editor usa el simulador y lo
 * dice. Un panel que muestra números inventados sin avisar es peor que un
 * panel vacío.
 */
import { domainError, err, ok, type Result } from '@it360/domain';

import {
  BackendTelemetryClient,
  CachingTelemetryClient,
  SimulatedTelemetryClient,
  type TelemetryClient,
} from './telemetry-client';

/** Clave en el almacén local. Versionada para poder cambiar el formato. */
export const SERVICE_ENDPOINT_KEY = 'it360.telemetry.service.v1';

/** Subconjunto de `localStorage` que esto necesita. */
export interface EndpointStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Valida y normaliza la dirección escrita por un administrador.
 *
 * Las reglas no son caprichos de formato:
 *
 * - **Sólo http y https.** `file:` leería del disco del equipo y un esquema
 *   personalizado acabaría en un manejador del sistema operativo.
 * - **Sin usuario ni contraseña en la URL.** La credencial viajaría en cada
 *   peticion y acabaría en los registros del servidor; además contradice la
 *   regla de que el editor no maneja credenciales de telemetría.
 * - **Sin consulta ni fragmento.** La dirección es una raíz a la que se le
 *   añaden rutas; con `?` detrás, la ruta resultante ya no es la que el
 *   servicio publica.
 */
export function parseServiceEndpoint(raw: string): Result<string> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return err(
      domainError('VALIDATION_FAILED', 'La dirección del servicio está vacía', {
        recovery: 'Escriba la dirección del servicio local, por ejemplo http://127.0.0.1:8787',
      }),
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return err(
      domainError('VALIDATION_FAILED', 'La dirección no es una URL válida', {
        recovery: 'Incluya el esquema: http://127.0.0.1:8787',
      }),
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err(
      domainError('VALIDATION_FAILED', `El esquema «${url.protocol}» no se admite`, {
        recovery: 'El servicio local se publica por http o https.',
      }),
    );
  }

  if (url.username !== '' || url.password !== '') {
    return err(
      domainError('VALIDATION_FAILED', 'La dirección no debe llevar usuario ni contraseña', {
        recovery:
          'El editor no maneja credenciales de telemetría: el token lo guarda el servicio local.',
      }),
    );
  }

  if (url.search !== '' || url.hash !== '') {
    return err(
      domainError('VALIDATION_FAILED', 'La dirección no debe llevar parámetros ni fragmento', {
        recovery: 'Indique sólo la raíz del servicio, sin «?» ni «#».',
      }),
    );
  }

  // Raíz sin barra final: las rutas que se le añaden la llevan al principio, y
  // con las dos se pediría «//api/v1/...», que algunos servidores no resuelven.
  const path = url.pathname.replace(/\/+$/, '');
  return ok(`${url.origin}${path}`);
}

/**
 * Indica si la dirección sale del propio equipo.
 *
 * No se prohíbe —un servicio compartido en la red de planta es un despliegue
 * legítimo—, pero la interfaz lo advierte: contra un servicio remoto por
 * `http`, las lecturas viajan en claro por la red industrial.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

/** Dirección guardada, o `null` si no hay ninguna utilizable. */
export function loadServiceEndpoint(store: EndpointStore | undefined = globalThis.localStorage): string | null {
  if (store === undefined) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SERVICE_ENDPOINT_KEY);
  } catch {
    // `localStorage` lanza en modo privado de algunos navegadores. Quedarse
    // sin dirección es recuperable; caerse al arrancar el editor no.
    return null;
  }
  if (raw === null) return null;
  const parsed = parseServiceEndpoint(raw);
  return parsed.ok ? parsed.value : null;
}

/** Guarda la dirección, o la borra cuando se pasa `null`. */
export function saveServiceEndpoint(
  endpoint: string | null,
  store: EndpointStore | undefined = globalThis.localStorage,
): void {
  if (store === undefined) return;
  try {
    if (endpoint === null) store.removeItem(SERVICE_ENDPOINT_KEY);
    else store.setItem(SERVICE_ENDPOINT_KEY, endpoint);
  } catch {
    // Igual que al leer: no poder recordar la dirección no justifica abortar.
  }
}

/**
 * Cliente que corresponde a la configuración actual.
 *
 * Con dirección, el cliente del servicio envuelto en la caché que marca las
 * lecturas conservadas; sin ella, el simulador. La envoltura de caché existe
 * por la regla del contrato de datos: «datos offline se etiquetan como caché,
 * no como telemetría actual».
 */
export function createTelemetryClient(endpoint: string | null, timeoutMs = 8000): TelemetryClient {
  if (endpoint === null) return new CachingTelemetryClient(new SimulatedTelemetryClient());
  return new CachingTelemetryClient(new BackendTelemetryClient(endpoint, timeoutMs));
}
