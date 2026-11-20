/**
 * Permisos del usuario según el servicio local (P04).
 *
 * El editor es local y el proyecto es un archivo: quien tiene el archivo tiene
 * todo lo que hay dentro. Entonces, ¿para qué pedir permisos a un servicio?
 *
 * Porque hay dos problemas distintos y sólo uno es de seguridad. El de
 * seguridad —quién recibe el archivo, quién publica, quién aprueba— lo
 * resuelve el servicio y ya está implementado. El otro es de **presentación**:
 * un contratista y el equipo de mantenimiento trabajan sobre el mismo
 * proyecto, y las notas internas de mantenimiento no tienen por qué aparecerle
 * al contratista en la lista. Eso no se puede resolver en el servidor, porque
 * la lista se dibuja con datos locales; lo único que el servidor puede dar es
 * **qué le corresponde ver a este usuario**, y es lo que este módulo pide.
 *
 * Que sea presentación y no seguridad cambia una cosa importante: cuando el
 * servicio no está disponible, no se restringe nada. Un editor que se bloquea
 * porque no puede preguntar los permisos sería inservible en una planta sin
 * red, que es exactamente donde se usa.
 */
import { domainError, err, ok, type DomainError, type Result } from '@it360/domain';

/** Ámbito de una concesión, tal como lo publica el servicio. */
export interface GrantedScope {
  readonly role: string;
  readonly plantId: string | null;
  readonly unitId: string | null;
  readonly areaId: string | null;
  readonly noteCategoryIds: readonly string[];
}

export interface AccessProfile {
  /** Operaciones permitidas en algún ámbito. */
  readonly operations: readonly string[];
  readonly scopes: readonly GrantedScope[];
  /**
   * Categorías de nota visibles, o `null` si no hay restricción.
   *
   * El servicio distingue las dos cosas a propósito, y aquí se conserva la
   * distinción: una lista vacía es «ninguna categoría» —un estado legítimo— y
   * `null` es «todas».
   */
  readonly noteCategoryIds: readonly string[] | null;
}

/** Perfil sin restricciones, para cuando no hay servicio. */
export const UNRESTRICTED: AccessProfile = {
  operations: [],
  scopes: [],
  noteCategoryIds: null,
};

export interface AccessIdentity {
  readonly userId: string;
  readonly role: string;
  readonly plantId?: string;
}

/**
 * Pide al servicio el perfil del usuario.
 *
 * Devuelve un error en lugar de lanzarlo, y quien llama decide: la decisión
 * correcta es seguir sin restricción, y está documentada arriba.
 */
export async function fetchAccessProfile(
  baseUrl: string,
  identity: AccessIdentity,
  timeoutMs = 5000,
): Promise<Result<AccessProfile, DomainError>> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/v1/me/operations`, {
      signal: controller.signal,
      headers: {
        'x-usuario': identity.userId,
        'x-rol': identity.role,
        ...(identity.plantId === undefined ? {} : { 'x-planta': identity.plantId }),
      },
    });

    if (!response.ok) {
      return err(
        domainError('PERMISSION_DENIED', `El servicio respondió ${response.status} al pedir los permisos`, {
          recovery: 'Compruebe la identidad configurada y la dirección del servicio.',
        }),
      );
    }

    const body = (await response.json()) as {
      operations?: unknown;
      scopes?: unknown;
      noteCategoryIds?: unknown;
    };

    return ok({
      operations: Array.isArray(body.operations) ? body.operations.filter(isText) : [],
      scopes: Array.isArray(body.scopes) ? body.scopes.map(toScope) : [],
      // La distinción entre `null` y lista vacía es el punto delicado de todo
      // esto: tratar un `null` como lista vacía ocultaría todas las notas a un
      // usuario sin restricción, y lo contrario las mostraría todas a uno
      // restringido. Se comprueba el tipo en lugar de confiar en el valor.
      noteCategoryIds: Array.isArray(body.noteCategoryIds)
        ? body.noteCategoryIds.filter(isText)
        : null,
    });
  } catch (cause) {
    const aborted = (cause as { name?: string } | null)?.name === 'AbortError';
    return err(
      domainError(
        'NETWORK_UNAVAILABLE',
        aborted ? 'El servicio no respondió a tiempo' : 'No se pudo contactar con el servicio de permisos',
        { recovery: 'Se continúa sin restricciones de categoría.' },
      ),
    );
  } finally {
    globalThis.clearTimeout(timer);
  }
}

const isText = (value: unknown): value is string => typeof value === 'string';

function toScope(raw: unknown): GrantedScope {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    role: isText(value['role']) ? value['role'] : '',
    plantId: isText(value['plantId']) ? value['plantId'] : null,
    unitId: isText(value['unitId']) ? value['unitId'] : null,
    areaId: isText(value['areaId']) ? value['areaId'] : null,
    noteCategoryIds: Array.isArray(value['noteCategoryIds'])
      ? value['noteCategoryIds'].filter(isText)
      : [],
  };
}
