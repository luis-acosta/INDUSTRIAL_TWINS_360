/**
 * Publica las notas del proyecto en el servicio (P09).
 *
 * El servicio no lee archivos de proyecto —no sabe dónde están ni debe—, así
 * que la copia que sirve a los teléfonos de la planta es la que le entrega el
 * editor. Sin esto, la pantalla de notas del recorrido existiría y estaría
 * siempre vacía.
 *
 * Tres decisiones:
 *
 * **Sustituye, no fusiona.** Una nota borrada en el editor tiene que
 * desaparecer del servicio; fusionando volvería a aparecer en el teléfono de
 * alguien que seguiría trabajando sobre algo que ya no existe.
 *
 * **Lo que se manda es lo mínimo.** Ni adjuntos, ni comentarios internos, ni
 * resolución: lo que una pantalla de teléfono necesita para listar y abrir. Los
 * comentarios los lleva el servicio por su cuenta, porque es donde se escriben
 * desde el móvil.
 *
 * **Un fallo no bloquea el editor.** Que la planta no pueda consultar las notas
 * desde el móvil es un problema; que el editor se quede esperando a un servicio
 * caído es peor, porque entonces no se puede ni editar.
 */

import { domainError, err, ok, type DomainError, type Note, type Result } from '@it360/domain';

export interface NotesSyncIdentity {
  readonly userId: string;
  readonly role: string;
}

const TIMEOUT_MS = 6000;

/** Nota reducida a lo que el servicio necesita. */
const forService = (note: Note): Record<string, unknown> => ({
  id: note.id,
  title: note.title,
  body: note.body,
  categoryId: note.categoryId,
  status: note.status,
  priority: note.priority,
  sceneId: note.sceneId,
  assetId: note.assetId,
  assigneeId: note.assigneeId,
  assigneeName: note.assigneeName,
  dueDate: note.dueDate,
  updatedAt: note.updatedAt,
});

/**
 * Manda las notas al servicio.
 *
 * `baseUrl` es la raíz de la API (`…/api/v1`), la misma que usa el resto del
 * editor: deducirla de otro ajuste acabaría apuntando a otro servidor sin que
 * nada lo delate.
 */
export async function syncNotes(
  baseUrl: string,
  identity: NotesSyncIdentity,
  projectId: string,
  notes: readonly Note[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<number, DomainError>> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/notes`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-usuario': identity.userId,
        'x-rol': identity.role,
      },
      body: JSON.stringify({ projectId, notes: notes.map(forService) }),
      signal: controller.signal,
    });

    if (response.status === 403) {
      return err(
        domainError(
          'PERMISSION_DENIED',
          'Su concesión no permite publicar las notas en el servicio.',
          {
            recovery:
              'Hace falta permiso para actualizar el proyecto: con sólo poder leer, cualquiera podría vaciar la lista de los demás.',
          },
        ),
      );
    }

    if (!response.ok) {
      return err(
        domainError('INTERNAL', `El servicio respondió ${response.status}.`, {
          recovery: 'Las notas no se podrán consultar desde un móvil hasta que se repita.',
        }),
      );
    }

    const body = (await response.json()) as { loaded?: number };
    return ok(body.loaded ?? notes.length);
  } catch {
    return err(
      domainError('NETWORK_UNAVAILABLE', 'No se pudo contactar con el servicio de notas.', {
        recovery:
          'El editor sigue funcionando; las notas no se podrán consultar desde un móvil hasta que el servicio responda.',
      }),
    );
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Huella de lo que se mandaría.
 *
 * Sirve para no repetir el envío cuando nada que el servicio sirva ha
 * cambiado: el proyecto se guarda en cada tecla que el autor pulsa en cualquier
 * campo, y mandar las notas en cada una convertiría el servicio en el cuello de
 * botella del editor. La huella cubre sólo los campos que viajan, de modo que
 * mover un marcador no provoca un envío.
 */
export function notesFingerprint(notes: readonly Note[]): string {
  return notes
    .map((note) =>
      [
        note.id,
        note.title,
        note.status,
        note.priority,
        note.categoryId,
        note.assigneeId ?? '',
        note.dueDate ?? '',
        note.updatedAt,
      ].join('\u0001'),
    )
    .sort()
    .join('\u0002');
}

/* ------------------------------------------------------------------ *
 * Avisos por correo (P07)
 * ------------------------------------------------------------------ */

export interface NotifyRequest {
  readonly reason: 'note.assigned' | 'note.due_soon' | 'note.resolved';
  readonly noteId: string;
  readonly recipientId: string;
  readonly recipientAddress: string;
  readonly recipientName: string;
  readonly projectTitle: string;
  readonly plant?: string | null;
  readonly priority: string;
  readonly noteTitle: string;
  readonly link?: string | null;
}

export interface NotifyOutcome {
  /** Avisos que de verdad salieron. Cero significa que nadie ha sido avisado. */
  readonly delivered: number;
  readonly pending: number;
}

/**
 * Pide al servicio que avise por correo (P07).
 *
 * El título de la nota se manda y el servicio lo descarta: el correo no publica
 * el contenido de una nota de planta. Viaja porque quien llama lo tiene a mano
 * y porque dejar que el editor decida qué entra en el correo repartiría esa
 * regla en dos sitios; con un solo sitio, cambiarla es cambiar un archivo.
 *
 * Lo que devuelve es cuántos **salieron**. Un servicio sin correo configurado
 * responde cero, y quien asignó la tarea tiene que verlo: creer avisado a
 * alguien que no lo está es el daño que esta función existe para evitar.
 */
export async function requestNotification(
  baseUrl: string,
  identity: NotesSyncIdentity,
  request: NotifyRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<NotifyOutcome, DomainError>> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-usuario': identity.userId,
        'x-rol': identity.role,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (response.status === 403) {
      return err(
        domainError('PERMISSION_DENIED', 'Su concesión no permite mandar avisos.', {
          recovery: 'Avisar es parte de asignar trabajo y hace falta ese permiso.',
        }),
      );
    }

    if (response.status === 400) {
      return err(
        domainError('VALIDATION_FAILED', 'El servicio rechazó el aviso.', {
          recovery:
            'Compruebe que la persona tiene una dirección de correo válida en el equipo del proyecto.',
        }),
      );
    }

    if (!response.ok) {
      return err(
        domainError('INTERNAL', `El servicio respondió ${response.status}.`, {
          recovery: 'La nota queda asignada; el aviso no se mandó.',
        }),
      );
    }

    const body = (await response.json()) as Partial<NotifyOutcome>;
    return ok({ delivered: body.delivered ?? 0, pending: body.pending ?? 0 });
  } catch {
    return err(
      domainError('NETWORK_UNAVAILABLE', 'No se pudo contactar con el servicio de avisos.', {
        recovery: 'La nota queda asignada; el aviso no se mandó.',
      }),
    );
  } finally {
    globalThis.clearTimeout(timer);
  }
}
