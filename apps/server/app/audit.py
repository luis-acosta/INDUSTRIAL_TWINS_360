"""Registro de auditoría.

Qué pasó, quién lo hizo y cuándo. En una planta industrial esto no es un
adorno: cuando una revisión de un documento cambia o una nota crítica se cierra,
alguien pregunta por qué, y la respuesta tiene que estar escrita.

El registro es de sólo añadir. No hay función para modificar ni borrar un
evento, y la tabla lleva disparadores en la base de datos que abortan
``UPDATE`` y ``DELETE``: un registro que se puede editar no sirve como registro.

Cada evento lleva la huella del anterior, formando una cadena. Eso no impide
manipular la base —quien tiene acceso de administrador a PostgreSQL puede
hacer lo que quiera— pero sí deja la manipulación detectable: romper la cadena
exige recalcular todos los eventos posteriores.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Final

#: Acciones registradas. La lista es cerrada a propósito: un registro donde
#: cada módulo inventa su propia etiqueta no se puede consultar.
ACTIONS: Final[tuple[str, ...]] = (
    "project.created",
    "project.updated",
    "project.published",
    "project.withdrawn",
    "project.deleted",
    "revision.created",
    "revision.submitted",
    "revision.approved",
    "revision.changes_requested",
    "revision.published",
    "revision.withdrawn",
    "asset.imported",
    "asset.updated",
    "document.uploaded",
    "document.approved",
    "note.created",
    "note.resolved",
    "note.deleted",
    # Participación desde un cliente móvil (P09). La lista es de sólo añadir
    # como el propio registro: un registro cuya lista de acciones se reescribe
    # deja eventos antiguos que ya no se pueden validar.
    "note.comment",
    "note.status",
    # Avisos por correo (P07). Se distingue «mandado» de «encolado» porque la
    # diferencia es justo lo que alguien necesita saber: un aviso encolado no
    # ha llegado a nadie.
    "notification.sent",
    "notification.queued",
    "user.invited",
    "user.removed",
    "role.granted",
    "role.revoked",
    "telemetry.configured",
    "script.approved",
    "backup.created",
    "backup.restored",
    "access.denied",
    "login.succeeded",
    "login.failed",
)

#: Claves que nunca se guardan en el detalle de un evento.
#:
#: El detalle lo escribe quien registra el evento, y la tentación de meter
#: «todo el objeto por si acaso» es constante. Esta lista se aplica de forma
#: recursiva al serializar: un token en el registro de auditoría es un token en
#: texto plano en una tabla que mucha gente puede leer.
REDACTED_KEYS: Final[frozenset[str]] = frozenset(
    {
        "token",
        "tokenref",
        "password",
        "passwd",
        "secret",
        "apikey",
        "api_key",
        "authorization",
        "cookie",
        "privatekey",
        "private_key",
        "sessionid",
        "session_id",
    }
)

REDACTED_MARKER: Final[str] = "[redactado]"


def redact(value: Any) -> Any:
    """Sustituye los valores de claves sensibles por un marcador.

    Se conserva la clave para que el registro siga siendo legible —se ve que
    había un token y que se omitió— pero no su valor.
    """
    if isinstance(value, dict):
        return {
            key: (REDACTED_MARKER if key.lower().replace("-", "") in REDACTED_KEYS else redact(item))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """JSON con claves ordenadas y sin espacios superfluos.

    Es lo que hace comparables las huellas: sin ordenar, dos serializaciones
    del mismo evento darían hashes distintos y la cadena se rompería sola.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


@dataclass(frozen=True, slots=True)
class AuditEvent:
    """Un evento del registro."""

    event_id: str
    action: str
    actor_id: str
    actor_name: str
    occurred_at: datetime
    #: Entidad afectada: ``note``, ``document``, ``project``…
    entity: str
    entity_id: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    #: Huella del evento anterior de la cadena.
    previous_hash: str | None = None
    #: Dirección desde la que se actuó, cuando se conoce.
    source: str | None = None

    def digest(self) -> str:
        """Huella de este evento, encadenada con la del anterior."""
        payload = canonical_json(
            {
                "action": self.action,
                "actorId": self.actor_id,
                "detail": redact(self.detail),
                "entity": self.entity,
                "entityId": self.entity_id,
                "eventId": self.event_id,
                "occurredAt": self.occurred_at.astimezone(timezone.utc).isoformat(),
                "previous": self.previous_hash,
            }
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def to_row(self) -> dict[str, Any]:
        """Fila lista para insertar, con el detalle ya saneado."""
        if self.action not in ACTIONS:
            raise ValueError(f"Acción de auditoría no contemplada: {self.action}")
        return {
            "event_id": self.event_id,
            "action": self.action,
            "actor_id": self.actor_id,
            "actor_name": self.actor_name,
            "occurred_at": self.occurred_at.astimezone(timezone.utc),
            "entity": self.entity,
            "entity_id": self.entity_id,
            "detail": redact(self.detail),
            "previous_hash": self.previous_hash,
            "event_hash": self.digest(),
            "source": self.source,
        }


class AuditLog:
    """Registro en memoria, con la misma semántica que la tabla.

    Existe para las pruebas y para el modo local sin PostgreSQL. La semántica
    que importa —sólo añadir, cadena de huellas— es la misma, de modo que una
    prueba que pasa aquí describe el comportamiento real.
    """

    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def append(self, event: AuditEvent) -> AuditEvent:
        """Añade un evento, encadenándolo con el último."""
        previous = self._events[-1].digest() if self._events else None
        chained = AuditEvent(
            event_id=event.event_id,
            action=event.action,
            actor_id=event.actor_id,
            actor_name=event.actor_name,
            occurred_at=event.occurred_at,
            entity=event.entity,
            entity_id=event.entity_id,
            detail=redact(event.detail),
            previous_hash=previous,
            source=event.source,
        )
        if chained.action not in ACTIONS:
            raise ValueError(f"Acción de auditoría no contemplada: {chained.action}")
        self._events.append(chained)
        return chained

    @property
    def events(self) -> tuple[AuditEvent, ...]:
        return tuple(self._events)

    def verify_chain(self) -> tuple[bool, str | None]:
        """Comprueba que la cadena de huellas es consistente.

        Devuelve el identificador del primer evento que no cuadra, para que la
        investigación empiece por algún sitio concreto.
        """
        previous: str | None = None
        for event in self._events:
            if event.previous_hash != previous:
                return False, event.event_id
            previous = event.digest()
        return True, None
