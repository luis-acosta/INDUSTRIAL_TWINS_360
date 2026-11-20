"""Borradores, revisión y publicación controlada (X16) y ediciones simultáneas (X17).

Un recorrido de una planta no se publica porque alguien pulse un botón. Lo
edita un técnico, lo revisa quien responde del área y se publica cuando está
aprobado; y si dos personas editaron a la vez, hay que saberlo antes y no
después. Eso es lo que implementa este módulo.

Tres decisiones gobiernan el diseño, y las tres responden a cómo se usa esto
en una planta de verdad:

1. **Separación de funciones.** Quien escribe no aprueba lo que escribió,
   aunque tenga permiso para aprobar. Un permiso dice qué puede hacer una
   persona; la separación de funciones dice qué no puede hacer *sobre su propio
   trabajo*. Sin esta regla, «publicación controlada» es sólo un botón con otro
   nombre.

2. **Las transiciones son explícitas y cerradas.** La máquina de estados se
   declara en una tabla y cualquier paso que no figure en ella se rechaza con
   el motivo. Es lo contrario de comprobar condiciones sueltas en cada ruta,
   donde el camino que nadie probó acaba siendo el que alguien usa.

3. **El conflicto se detecta por secciones y no por archivo.** Decir «el
   proyecto cambió» obliga a rehacer el trabajo entero. Decir «ambos tocasteis
   la escena 4 y el activo P-101» permite resolverlo. La comparación es sobre
   resúmenes por sección: el servidor no necesita el contenido para saber qué
   se solapa, y así no guarda el proyecto de nadie.

El almacén es en memoria, igual que el registro de auditoría de este servicio:
la edición vive en el equipo del autor —ése es el diseño local-first del
producto— y este servicio coordina la revisión. Un despliegue que necesite que
las revisiones sobrevivan a un reinicio sustituye ``ReviewStore`` por una
implementación con base de datos; la interfaz está pensada para eso y no
expone ninguna estructura mutable.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Final
from uuid import uuid4

from .audit import AuditEvent, AuditLog

#: Estados de una revisión.
#:
#: ``withdrawn`` existe porque un borrador abandonado tiene que poder salir de
#: la cola de revisión sin borrarse: lo que se hizo queda registrado.
STATES: Final[tuple[str, ...]] = (
    "draft",
    "in_review",
    "changes_requested",
    "approved",
    "published",
    "withdrawn",
)

#: Transiciones permitidas: estado actual -> (acción, estado siguiente).
#:
#: La tabla es el contrato. Una acción que no figure para el estado actual se
#: rechaza con su motivo, de modo que no hay camino sin declarar.
TRANSITIONS: Final[dict[str, dict[str, str]]] = {
    "draft": {"submit": "in_review", "withdraw": "withdrawn"},
    "in_review": {
        "approve": "approved",
        "request_changes": "changes_requested",
        "withdraw": "withdrawn",
    },
    "changes_requested": {"submit": "in_review", "withdraw": "withdrawn"},
    "approved": {"publish": "published", "request_changes": "changes_requested"},
    "published": {},
    "withdrawn": {},
}

#: Operación de acceso que exige cada acción.
#:
#: ``submit`` pide ``project.update`` porque enviar a revisión es parte de
#: editar. ``approve`` y ``publish`` piden ``project.publish``, que sólo
#: tienen el revisor y el administrador.
REQUIRED_OPERATION: Final[dict[str, str]] = {
    "create": "project.update",
    "submit": "project.update",
    "approve": "project.publish",
    "request_changes": "project.publish",
    "publish": "project.publish",
    "withdraw": "project.update",
}

#: Acción de auditoría que registra cada transición.
#:
#: El vocabulario del registro es cerrado a propósito —``audit.py`` rechaza una
#: acción no contemplada— de modo que la correspondencia se declara aquí en vez
#: de componerse con una cadena de formato, que es como se cuela una acción que
#: el registro no admite y que sólo falla en producción.
AUDIT_ACTION: Final[dict[str, str]] = {
    "create": "revision.created",
    "submit": "revision.submitted",
    "approve": "revision.approved",
    "request_changes": "revision.changes_requested",
    "publish": "revision.published",
    "withdraw": "revision.withdrawn",
}

#: Acciones que no puede ejercer el autor de la revisión sobre su propio trabajo.
#:
#: Es la separación de funciones. ``request_changes`` no está en la lista: que
#: el autor devuelva a borrador su propia revisión es razonable y no se salta
#: ningún control.
SELF_FORBIDDEN: Final[frozenset[str]] = frozenset({"approve", "publish"})


class ReviewError(Exception):
    """Transición rechazada, con el motivo que se puede mostrar al usuario."""

    def __init__(self, reason: str, *, code: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


@dataclass(frozen=True, slots=True)
class Revision:
    """Una propuesta de cambio sobre un proyecto.

    No contiene el proyecto: contiene los resúmenes por sección que permiten
    detectar solapes (``sections``) y el resumen del conjunto
    (``content_digest``). El contenido se queda en el equipo del autor.
    """

    revision_id: str
    project_id: str
    author_id: str
    state: str
    summary: str
    #: Revisión publicada sobre la que se editó, o ``None`` para la primera.
    base_revision_id: str | None
    #: Resumen por sección: ``"scene:<id>" -> hash``.
    sections: dict[str, str]
    content_digest: str
    created_at: datetime
    updated_at: datetime
    #: Quién aprobó, para que la separación de funciones quede registrada.
    approved_by: str | None = None
    #: Comentarios de la revisión, en orden.
    comments: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class Conflict:
    """Sección que dos revisiones cambiaron de forma distinta."""

    section: str
    #: Resumen en la revisión base.
    base: str | None
    #: Resumen en la revisión que se intenta enviar.
    incoming: str
    #: Resumen en la revisión ya publicada.
    published: str | None


def detect_conflicts(
    base_sections: dict[str, str],
    incoming_sections: dict[str, str],
    published_sections: dict[str, str],
) -> list[Conflict]:
    """Secciones que ambas partes cambiaron respecto a la base.

    La regla es la de cualquier control de versiones que no pierde trabajo: hay
    conflicto donde las dos partes se separaron de la base **y** no coincidieron
    entre sí. Si sólo cambió una, no hay nada que resolver; si las dos llegaron
    al mismo resultado, tampoco.

    Lo que esto permite es decirle al autor «ambos tocasteis la escena 4» en
    lugar de «el proyecto cambió», que es la diferencia entre corregir dos
    escenas y rehacer el trabajo de una semana.
    """
    conflicts: list[Conflict] = []

    for section, incoming in sorted(incoming_sections.items()):
        base = base_sections.get(section)
        published = published_sections.get(section)

        if incoming == base:
            continue  # el autor no tocó esta sección
        if published == base:
            continue  # nadie más la tocó
        if incoming == published:
            continue  # los dos llegaron al mismo sitio

        conflicts.append(Conflict(section=section, base=base, incoming=incoming, published=published))

    # Una sección que el autor borró y otro cambió también es un conflicto: su
    # ausencia es un cambio, y resolverlo exige decidir si se recupera.
    for section, published in sorted(published_sections.items()):
        if section in incoming_sections:
            continue
        base = base_sections.get(section)
        if base is None or published == base:
            continue
        conflicts.append(Conflict(section=section, base=base, incoming="", published=published))

    return conflicts


class ReviewStore:
    """Cola de revisiones de un servicio privado.

    Guarda las revisiones y la última publicada por proyecto. Todas las
    transiciones pasan por ``act``, que es el único sitio donde se comprueban
    los permisos, la separación de funciones y la tabla de estados: un camino
    nuevo no puede saltarse los tres por descuido.
    """

    def __init__(self, audit: AuditLog | None = None) -> None:
        self._revisions: dict[str, Revision] = {}
        self._published: dict[str, str] = {}
        self._audit = audit

    # ------------------------------------------------------------------ #
    # Consulta
    # ------------------------------------------------------------------ #

    def get(self, revision_id: str) -> Revision:
        revision = self._revisions.get(revision_id)
        if revision is None:
            raise ReviewError("No existe esa revisión", code="not_found")
        return revision

    def list_for_project(self, project_id: str, *, state: str | None = None) -> list[Revision]:
        """Revisiones de un proyecto, de la más reciente a la más antigua."""
        found = [r for r in self._revisions.values() if r.project_id == project_id]
        if state is not None:
            found = [r for r in found if r.state == state]
        return sorted(found, key=lambda r: r.created_at, reverse=True)

    def published_revision(self, project_id: str) -> Revision | None:
        revision_id = self._published.get(project_id)
        return None if revision_id is None else self._revisions[revision_id]

    # ------------------------------------------------------------------ #
    # Creación y transiciones
    # ------------------------------------------------------------------ #

    def create(
        self,
        *,
        project_id: str,
        author_id: str,
        summary: str,
        sections: dict[str, str],
        content_digest: str,
        allowed_operations: frozenset[str],
        now: datetime | None = None,
    ) -> Revision:
        """Abre un borrador sobre la última revisión publicada."""
        self._require(action="create", allowed=allowed_operations)
        if not summary.strip():
            # Una revisión sin resumen deja al revisor adivinando qué aprueba.
            raise ReviewError("La revisión necesita un resumen de los cambios", code="summary_required")

        moment = now or datetime.now(timezone.utc)
        published = self.published_revision(project_id)
        revision = Revision(
            revision_id=str(uuid4()),
            project_id=project_id,
            author_id=author_id,
            state="draft",
            summary=summary.strip(),
            base_revision_id=None if published is None else published.revision_id,
            sections=dict(sections),
            content_digest=content_digest,
            created_at=moment,
            updated_at=moment,
        )
        self._revisions[revision.revision_id] = revision
        self._record(revision, action="create", actor_id=author_id, detail={"summary": revision.summary})
        return revision

    def act(
        self,
        *,
        revision_id: str,
        action: str,
        actor_id: str,
        allowed_operations: frozenset[str],
        comment: str = "",
        now: datetime | None = None,
    ) -> Revision:
        """Aplica una acción a una revisión.

        El orden de las comprobaciones importa y es el de menor a mayor
        información revelada: primero que la acción exista, luego que el estado
        la admita, luego el permiso, y por último la separación de funciones.
        Así un usuario sin permiso no averigua en qué estado está una revisión
        que no puede ver.
        """
        revision = self.get(revision_id)

        if action not in REQUIRED_OPERATION:
            raise ReviewError(f"Acción desconocida: {action}", code="unknown_action")

        target = TRANSITIONS.get(revision.state, {}).get(action)
        if target is None:
            raise ReviewError(
                f"Una revisión en estado «{revision.state}» no admite la acción «{action}»",
                code="invalid_transition",
            )

        self._require(action=action, allowed=allowed_operations)

        if action in SELF_FORBIDDEN and actor_id == revision.author_id:
            raise ReviewError(
                "Quien redactó la revisión no puede aprobarla ni publicarla",
                code="separation_of_duties",
            )

        if action == "publish":
            conflicts = self.conflicts_for(revision)
            if conflicts:
                # Publicar sobre una base que ya se movió sobrescribiría el
                # trabajo de otra persona sin que nadie lo decidiera.
                raise ReviewError(
                    "Otra revisión se publicó después de esta y hay secciones en conflicto",
                    code="conflict",
                )

        moment = now or datetime.now(timezone.utc)
        updated = replace(
            revision,
            state=target,
            updated_at=moment,
            approved_by=actor_id if action == "approve" else revision.approved_by,
            comments=revision.comments + (comment.strip(),) if comment.strip() else revision.comments,
        )
        self._revisions[revision_id] = updated

        if target == "published":
            self._published[revision.project_id] = revision_id

        self._record(
            updated,
            action=action,
            actor_id=actor_id,
            detail={"from": revision.state, "to": target, **({"comment": comment.strip()} if comment.strip() else {})},
        )
        return updated

    def conflicts_for(self, revision: Revision) -> list[Conflict]:
        """Conflictos de una revisión contra lo publicado ahora mismo (X17)."""
        published = self.published_revision(revision.project_id)
        if published is None or published.revision_id == revision.base_revision_id:
            return []

        base = self._revisions.get(revision.base_revision_id or "")
        base_sections = {} if base is None else base.sections
        return detect_conflicts(base_sections, revision.sections, published.sections)

    # ------------------------------------------------------------------ #
    # Interno
    # ------------------------------------------------------------------ #

    @staticmethod
    def _require(*, action: str, allowed: frozenset[str]) -> None:
        operation = REQUIRED_OPERATION[action]
        if operation not in allowed:
            raise ReviewError(
                f"Esta acción exige el permiso «{operation}»",
                code="permission_denied",
            )

    def _record(self, revision: Revision, *, action: str, actor_id: str, detail: dict[str, object]) -> None:
        if self._audit is None:
            return
        self._audit.append(
            AuditEvent(
                event_id=str(uuid4()),
                action=AUDIT_ACTION[action],
                actor_id=actor_id,
                actor_name=actor_id,
                occurred_at=revision.updated_at,
                entity="revision",
                entity_id=revision.revision_id,
                detail={"projectId": revision.project_id, **detail},
            )
        )
