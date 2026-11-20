/**
 * Cliente de notas del recorrido publicado (P09).
 *
 * Esto es lo que permite consultar las notas del proyecto y participar en ellas
 * desde un teléfono, de pie en la planta: el recorrido ya está abierto en el
 * navegador del dispositivo y el servicio sirve las notas con control de acceso.
 *
 * Tres decisiones que conviene no perder de vista:
 *
 * **La identidad va en cabeceras y no autentica.** Es la misma superficie que
 * el resto del servicio y la misma advertencia: la integración con el
 * directorio del cliente es la parte pendiente de la etapa 11. Aquí se escribe
 * para que nadie monte esto creyendo que valida algo.
 *
 * **El recorte por categoría no lo hace este cliente.** Lo hace el servidor. Un
 * cliente que filtrara por su cuenta estaría pidiendo las notas que no debe ver
 * y descartándolas después, de modo que bastaría mirar la respuesta de red para
 * leerlas.
 *
 * **Los estados que se pueden poner los dice el servicio.** Si este cliente
 * llevara la lista escrita, ofrecería un estado que el servicio rechaza en
 * cuanto cambie una de las dos.
 */

import { domainError, err, ok, type DomainError, type Result } from '@it360/domain';

/** Nota tal como la sirve el servicio; es menos de lo que guarda el proyecto. */
export interface ServedNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly categoryId: string;
  readonly status: string;
  readonly priority: string;
  readonly sceneId: string | null;
  readonly assetId: string | null;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly dueDate: string | null;
  readonly updatedAt: string;
  readonly comments: readonly {
    readonly id: string;
    readonly authorId: string;
    readonly authorName: string;
    readonly body: string;
    readonly createdAt: string;
  }[];
}

export interface NotesPage {
  readonly notes: readonly ServedNote[];
  /** Estados de trabajo que este cliente puede poner, según el servicio. */
  readonly fieldStatuses: readonly string[];
}

export interface NotesIdentity {
  readonly userId: string;
  readonly role: string;
  readonly displayName?: string;
}

export interface NotesQuery {
  readonly projectId: string;
  readonly status?: string;
  readonly sceneId?: string;
  /** Sólo las asignadas a quien pregunta. */
  readonly mine?: boolean;
}

const TIMEOUT_MS = 8000;

export class NotesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly identity: NotesIdentity,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-usuario': this.identity.userId,
      'x-rol': this.identity.role,
    };
  }

  private url(path: string, params?: Record<string, string>): string {
    const base = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    if (params === undefined) return base;
    const query = new URLSearchParams(params).toString();
    return query.length === 0 ? base : `${base}?${query}`;
  }

  /**
   * Hace la petición y traduce el fallo a algo que se le pueda decir a quien
   * está en la planta.
   *
   * Los códigos importan: un 403 es «su acceso no alcanza» y un 404 es «esa
   * nota no está» —que incluye «no la puede ver», y es correcto que no se
   * distingan—. Un fallo de red es otra cosa y merece otra respuesta, porque en
   * una planta la red se cae y el usuario necesita saber que puede reintentar.
   */
  private async request<T>(
    url: string,
    init: RequestInit,
  ): Promise<Result<T, DomainError>> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: this.headers(),
        signal: controller.signal,
      });

      if (response.status === 403) {
        return err(
          domainError('PERMISSION_DENIED', 'Su acceso no alcanza para esto.', {
            recovery: 'Pida al responsable del proyecto que amplíe su concesión.',
          }),
        );
      }
      if (response.status === 404) {
        return err(
          domainError('NOT_FOUND', 'Esa nota no está disponible.', {
            recovery: 'Vuelva a cargar la lista: puede haberse resuelto o archivado.',
          }),
        );
      }
      if (!response.ok) {
        const detail = await response.text();
        return err(
          domainError('INTERNAL', `El servicio respondió ${response.status}.`, {
            recovery: detail.slice(0, 200),
          }),
        );
      }

      return ok((await response.json()) as T);
    } catch (cause) {
      /* Se distingue el plazo agotado del fallo de red: en una planta con red
         compartida, «tardó demasiado» se resuelve reintentando y «no hay red»
         no, y decir lo segundo cuando pasa lo primero manda a alguien a buscar
         cobertura que ya tiene. */
      const aborted =
        typeof cause === 'object' && cause !== null && 'name' in cause
          ? (cause as { name?: string }).name === 'AbortError'
          : false;

      return err(
        domainError(
          'NETWORK_UNAVAILABLE',
          aborted
            ? 'El servicio tardó demasiado en responder.'
            : 'No se pudo contactar con el servicio de notas.',
          { recovery: 'Compruebe la cobertura y vuelva a intentarlo.' },
        ),
      );
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  async list(query: NotesQuery): Promise<Result<NotesPage, DomainError>> {
    const params: Record<string, string> = { projectId: query.projectId };
    if (query.status !== undefined) params['status'] = query.status;
    if (query.sceneId !== undefined) params['sceneId'] = query.sceneId;
    if (query.mine === true) params['mine'] = 'true';

    return this.request<NotesPage>(this.url('/notes', params), { method: 'GET' });
  }

  async comment(noteId: string, body: string): Promise<Result<ServedNote, DomainError>> {
    const result = await this.request<{ note: ServedNote }>(
      this.url(`/notes/${encodeURIComponent(noteId)}/comments`),
      {
        method: 'POST',
        body: JSON.stringify({
          body,
          authorName: this.identity.displayName ?? this.identity.userId,
        }),
      },
    );
    return result.ok ? ok(result.value.note) : result;
  }

  async setStatus(noteId: string, status: string): Promise<Result<ServedNote, DomainError>> {
    const result = await this.request<{ note: ServedNote }>(
      this.url(`/notes/${encodeURIComponent(noteId)}/status`),
      { method: 'POST', body: JSON.stringify({ status }) },
    );
    return result.ok ? ok(result.value.note) : result;
  }
}

/**
 * Nota más urgente de una lista ya servida.
 *
 * El servicio devuelve lo vencido primero; esto es para la cabecera del panel,
 * que en un teléfono tiene sitio para una sola línea. Devuelve `null` con la
 * lista vacía en lugar de una nota inventada: «no tiene nada pendiente» es una
 * respuesta, y una nota en blanco no.
 */
export const mostUrgent = (notes: readonly ServedNote[]): ServedNote | null => notes[0] ?? null;

/* ------------------------------------------------------------------ *
 * Base del servicio e identidad recordada (P09)
 * ------------------------------------------------------------------ */

const IDENTITY_KEY = 'it360.notes.identity';

/**
 * Base de la API a partir del endpoint de telemetría del manifiesto.
 *
 * El paquete declara el servicio una sola vez, en los mapeos de telemetría, y
 * las notas viven en el mismo servicio: deducir la base de ahí evita un segundo
 * ajuste que alguien configuraría distinto y que apuntaría a otro servidor sin
 * que nada lo delate.
 */
export function notesBaseUrl(
  telemetryEndpoint: string | undefined,
  packageBaseUrl: string,
): string | null {
  if (telemetryEndpoint === undefined || telemetryEndpoint.trim().length === 0) return null;

  const absolute =
    telemetryEndpoint.startsWith('http://') || telemetryEndpoint.startsWith('https://')
      ? telemetryEndpoint
      : `${packageBaseUrl.replace(/\/$/, '')}${telemetryEndpoint.startsWith('/') ? '' : '/'}${telemetryEndpoint}`;

  // El endpoint apunta a la familia de telemetría; las notas son hermanas.
  return absolute.replace(/\/telemetry\/?$/, '');
}

/**
 * Identidad recordada en este dispositivo.
 *
 * Se recuerda porque pedirla en cada consulta, en un teléfono y con guantes, es
 * la forma de que nadie use la función. Y se guarda **sólo** el identificador y
 * el rol: no hay nada que proteger aquí porque el servicio no autentica —lo
 * dice su propia documentación—, y guardar algo que pareciera una credencial
 * haría creer lo contrario.
 */
export function loadNotesIdentity(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): NotesIdentity | null {
  try {
    const raw = storage?.getItem(IDENTITY_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<NotesIdentity>;
    if (typeof parsed.userId !== 'string' || parsed.userId.length === 0) return null;
    return {
      userId: parsed.userId,
      role: typeof parsed.role === 'string' && parsed.role.length > 0 ? parsed.role : 'viewer',
      ...(typeof parsed.displayName === 'string' ? { displayName: parsed.displayName } : {}),
    };
  } catch {
    // Un almacenamiento bloqueado —navegación privada, política de empresa— no
    // es un fallo que contar: simplemente no hay identidad recordada.
    return null;
  }
}

export function saveNotesIdentity(
  identity: NotesIdentity,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    /* Sin almacenamiento, la identidad vale para esta sesión y nada más. Es
       peor perder la función que perder la comodidad de no repetirla. */
  }
}
