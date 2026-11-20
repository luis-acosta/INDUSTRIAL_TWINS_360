/**
 * Cliente del flujo de revisión (X16, X17).
 *
 * Habla con el servicio local por las mismas rutas que cualquier integración
 * del cliente (X19), y por el mismo motivo que el cliente de telemetría: el
 * editor no tiene credenciales de nada: la identidad y los permisos los
 * resuelve el servicio.
 *
 * Lo que este cliente **no** envía es el proyecto. Envía el resumen por
 * sección que calcula `projectSections`, que es lo justo para que el servicio
 * detecte solapes. La edición se queda en el equipo del autor: es el diseño
 * local-first del producto, y además significa que una instalación con el
 * servicio apagado sigue permitiendo trabajar.
 */
import {
  domainError,
  err,
  ok,
  projectDigest,
  projectSections,
  sectionsToMap,
  type DomainError,
  type Project,
  type Result,
} from '@it360/domain';
import { sha256Canonical } from '@it360/persistence';

/** Estados que publica el servicio. */
export type RevisionState =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'published'
  | 'withdrawn';

/** Acciones que admite una revisión. */
export type RevisionAction = 'submit' | 'approve' | 'request_changes' | 'publish' | 'withdraw';

export interface RevisionConflict {
  readonly section: string;
  readonly base: string | null;
  readonly incoming: string;
  readonly published: string | null;
}

export interface RevisionInfo {
  readonly revisionId: string;
  readonly projectId: string;
  readonly authorId: string;
  readonly state: RevisionState;
  readonly summary: string;
  readonly baseRevisionId: string | null;
  readonly approvedBy: string | null;
  readonly comments: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conflicts: readonly RevisionConflict[];
}

/** Identidad con la que se actúa. En esta versión viaja por cabeceras. */
export interface ReviewIdentity {
  readonly userId: string;
  readonly role: string;
  readonly plantId?: string;
}

export interface ReviewClient {
  create(project: Project, summary: string): Promise<Result<RevisionInfo>>;
  list(projectId: string, state?: RevisionState): Promise<Result<readonly RevisionInfo[]>>;
  act(revisionId: string, action: RevisionAction, comment?: string): Promise<Result<RevisionInfo>>;
}

/** Etiquetas de estado, para la interfaz. */
export const REVISION_STATE_LABELS: Readonly<Record<RevisionState, string>> = {
  draft: 'Borrador',
  in_review: 'En revisión',
  changes_requested: 'Cambios solicitados',
  approved: 'Aprobada',
  published: 'Publicada',
  withdrawn: 'Retirada',
};

/** Acciones que tienen sentido ofrecer en cada estado. */
export const ACTIONS_BY_STATE: Readonly<Record<RevisionState, readonly RevisionAction[]>> = {
  draft: ['submit', 'withdraw'],
  in_review: ['approve', 'request_changes', 'withdraw'],
  changes_requested: ['submit', 'withdraw'],
  approved: ['publish', 'request_changes'],
  published: [],
  withdrawn: [],
};

export const REVISION_ACTION_LABELS: Readonly<Record<RevisionAction, string>> = {
  submit: 'Enviar a revisión',
  approve: 'Aprobar',
  request_changes: 'Pedir cambios',
  publish: 'Publicar',
  withdraw: 'Retirar',
};

export class HttpReviewClient implements ReviewClient {
  constructor(
    private readonly baseUrl: string,
    private readonly identity: ReviewIdentity,
    private readonly timeoutMs = 8000,
  ) {}

  async create(project: Project, summary: string): Promise<Result<RevisionInfo>> {
    const sections = await projectSections(project, sha256Canonical);
    const digest = await projectDigest(sections, sha256Canonical);

    return this.request<RevisionInfo>('/api/v1/revisions', {
      method: 'POST',
      body: {
        projectId: project.id,
        summary,
        sections: sectionsToMap(sections),
        contentDigest: digest,
      },
    });
  }

  async list(projectId: string, state?: RevisionState): Promise<Result<readonly RevisionInfo[]>> {
    const params = new URLSearchParams({ projectId });
    if (state !== undefined) params.set('state', state);

    const result = await this.request<{ revisions: RevisionInfo[] }>(
      `/api/v1/revisions?${params.toString()}`,
      { method: 'GET' },
    );
    return result.ok ? ok(result.value.revisions) : result;
  }

  async act(revisionId: string, action: RevisionAction, comment = ''): Promise<Result<RevisionInfo>> {
    return this.request<RevisionInfo>(
      `/api/v1/revisions/${encodeURIComponent(revisionId)}/actions`,
      { method: 'POST', body: { action, comment } },
    );
  }

  private async request<T>(
    path: string,
    options: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
  ): Promise<Result<T>> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // La identidad va en cabeceras porque es lo que el servicio acepta
          // en esta versión. No es autenticación, y el servicio lo dice en su
          // propia documentación: la integración con el directorio del cliente
          // es la parte pendiente de la etapa 11.
          'x-usuario': this.identity.userId,
          'x-rol': this.identity.role,
          ...(this.identity.plantId !== undefined ? { 'x-planta': this.identity.plantId } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });

      if (!response.ok) {
        return err(await this.errorOf(response));
      }
      return ok((await response.json()) as T);
    } catch (cause) {
      const aborted = (cause as { name?: string } | null)?.name === 'AbortError';
      return err(
        domainError('NETWORK_UNAVAILABLE', aborted ? 'El servicio no respondió a tiempo' : 'No se pudo contactar con el servicio', {
          recovery: 'Compruebe la dirección del servicio en el módulo de telemetría.',
        }),
      );
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /**
   * Traduce la respuesta de error del servicio.
   *
   * El servicio distingue por código —`separation_of_duties`,
   * `invalid_transition`, `conflict`— y la distinción es lo que permite dar la
   * salida correcta: a quien le falta permiso hay que decirle a quién pedirlo,
   * y a quien tiene un conflicto, qué secciones mirar. Un único «error 400»
   * obligaría a leer el mensaje para decidir.
   */
  private async errorOf(response: Response): Promise<DomainError> {
    let code = '';
    let message = `El servicio respondió ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: { code?: string; message?: string }; message?: string };
      code = body.detail?.code ?? '';
      message = body.detail?.message ?? body.message ?? message;
    } catch {
      // Una respuesta sin cuerpo JSON: queda el código HTTP, que ya informa.
    }

    if (code === 'separation_of_duties') {
      return domainError('PERMISSION_DENIED', message, {
        recovery: 'La revisión la tiene que aprobar o publicar otra persona con permiso.',
      });
    }
    if (code === 'permission_denied' || response.status === 403) {
      return domainError('PERMISSION_DENIED', message, {
        recovery: 'Pida el permiso al administrador de la instalación.',
      });
    }
    if (code === 'conflict') {
      return domainError('CONFLICT', message, {
        recovery: 'Revise las secciones en conflicto y vuelva a abrir una revisión sobre lo publicado.',
      });
    }
    if (code === 'invalid_transition') {
      return domainError('CONFLICT', message, {
        recovery: 'Vuelva a cargar la lista: el estado de la revisión ha cambiado.',
      });
    }
    if (response.status === 404) {
      return domainError('NOT_FOUND', message);
    }
    return domainError('VALIDATION_FAILED', message);
  }
}
