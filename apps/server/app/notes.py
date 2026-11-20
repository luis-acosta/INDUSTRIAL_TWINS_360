"""Notas servidas con control de acceso (P09).

Por qué existe este módulo: las notas viven en el archivo del proyecto, que lo
tiene quien edita. Para que alguien las consulte y participe **desde un
teléfono, en la planta**, hacen falta dos cosas que el archivo no da: llegar sin
el archivo, y que lo que se vea dependa de quién mira.

La segunda es la que importa. El modelo de acceso del servicio tenía desde la
etapa 11 el ámbito por categoría de nota —la pieza que permite que un
contratista trabaje sobre el mismo proyecto y no vea las notas internas de
mantenimiento—, y el editor ya lo aplicaba en su pantalla (P04). Aquí se aplica
**en el servidor**, que es la única forma de que signifique algo: un recorte que
sólo hace la interfaz lo salta cualquiera que llame a la API.

Lo que un teléfono puede hacer y lo que no:

- **Consultar** las notas que su concesión le permite ver.
- **Participar**: añadir un comentario y mover el estado de trabajo.
- **No** asignar responsables, no cambiar fechas comprometidas y no resolver sin
  escribir cómo se resolvió. Eso no es una limitación técnica: quien está en la
  planta describe y avanza, y decidir quién atiende qué es del responsable del
  proyecto, igual que en el panel de notas de campo del recorrido.

El almacén es en memoria, como el registro de auditoría, y con la misma
advertencia: tiene la semántica que tendrá la tabla y se pierde al reiniciar. La
persistencia en PostgreSQL es la parte pendiente, y está declarada en
LIMITACIONES para que nadie lo despliegue creyendo otra cosa.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Final, Iterable, Literal

#: Estados de trabajo que un teléfono puede poner.
#:
#: `resolved` y `archived` quedan fuera a propósito: resolver exige escribir cómo
#: se resolvió y archivar es una decisión del responsable del proyecto. Un
#: desplegable que los ofreciera convertiría «ya está» en un toque de pantalla,
#: y la nota se cerraría sin que nadie pueda saber después qué se hizo.
FIELD_STATUSES: Final[tuple[str, ...]] = ("open", "inProgress", "blocked")

#: Operación que exige cada acción.
REQUIRED_OPERATION: Final[dict[str, str]] = {
    "list": "note.read",
    "comment": "note.update",
    "status": "note.update",
}

MAX_COMMENT_LENGTH: Final[int] = 5_000


class NoteError(Exception):
    """Fallo con un motivo que se le puede contar a quien llama."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Comment:
    comment_id: str
    author_id: str
    author_name: str
    body: str
    created_at: str


@dataclass(frozen=True)
class ServedNote:
    note_id: str
    project_id: str
    title: str
    body: str
    category_id: str
    status: str
    priority: str
    scene_id: str | None
    asset_id: str | None
    assignee_id: str | None
    assignee_name: str | None
    due_date: str | None
    updated_at: str
    comments: tuple[Comment, ...] = field(default_factory=tuple)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def visible_notes(
    notes: Iterable[ServedNote],
    *,
    allowed_categories: tuple[str, ...] | None,
) -> list[ServedNote]:
    """Recorta por categoría.

    `None` es «sin restricción» y una tupla vacía es «ninguna categoría».
    Confundirlas convierte el control en un filtro que no filtra, o en uno que
    lo oculta todo; la misma distinción que el editor hace en su pantalla, y la
    razón de que aquí sea un tipo que admite `None` en lugar de una lista.
    """
    if allowed_categories is None:
        return list(notes)
    return [note for note in notes if note.category_id in allowed_categories]


@dataclass
class NoteStore:
    """Notas del proyecto, servidas y modificables con permiso."""

    notes: dict[str, ServedNote] = field(default_factory=dict)
    _sequence: int = 0

    def replace_project(self, project_id: str, notes: Iterable[ServedNote]) -> None:
        """Sustituye las notas de un proyecto.

        Las carga el editor al abrir el proyecto: el servicio no lee archivos de
        proyecto —no sabe dónde están ni debe—, así que su copia es la que le
        entregue quien sí lo tiene. Sustituir y no fusionar es deliberado: una
        nota borrada en el editor tiene que desaparecer aquí, y fusionando
        volvería a aparecer en el teléfono de alguien.
        """
        for note_id in [
            key for key, note in self.notes.items() if note.project_id == project_id
        ]:
            del self.notes[note_id]
        for note in notes:
            # El proyecto lo fija el argumento y no la nota: si se confiara en
            # el campo de la nota, una llamada con el proyecto equivocado
            # guardaría notas que luego no aparecen en ninguna lista —ni en la
            # del proyecto que se pidió ni en la del que traían dentro—, y el
            # síntoma sería una lista vacía sin error.
            self.notes[note.note_id] = replace(note, project_id=project_id)

    def list_for_project(
        self,
        project_id: str,
        *,
        allowed_operations: frozenset[str],
        allowed_categories: tuple[str, ...] | None,
        status: str | None = None,
        scene_id: str | None = None,
        assignee_id: str | None = None,
    ) -> list[ServedNote]:
        self._require("list", allowed_operations)

        found = [note for note in self.notes.values() if note.project_id == project_id]
        found = visible_notes(found, allowed_categories=allowed_categories)

        if status is not None:
            found = [note for note in found if note.status == status]
        if scene_id is not None:
            found = [note for note in found if note.scene_id == scene_id]
        if assignee_id is not None:
            found = [note for note in found if note.assignee_id == assignee_id]

        # Las vencidas primero y después por fecha de cambio: es el orden con el
        # que alguien mira esta lista de pie en una planta.
        return sorted(found, key=lambda note: (note.due_date or "9999", note.updated_at))

    def add_comment(
        self,
        note_id: str,
        *,
        author_id: str,
        author_name: str,
        body: str,
        allowed_operations: frozenset[str],
        allowed_categories: tuple[str, ...] | None,
    ) -> ServedNote:
        self._require("comment", allowed_operations)
        note = self._visible(note_id, allowed_categories)

        text = body.strip()
        if not text:
            raise NoteError("Un comentario vacío no aporta nada a la nota.", code="EMPTY")
        if len(text) > MAX_COMMENT_LENGTH:
            raise NoteError(
                f"El comentario supera los {MAX_COMMENT_LENGTH} caracteres.", code="TOO_LONG"
            )

        self._sequence += 1
        comment = Comment(
            comment_id=f"c{self._sequence}",
            author_id=author_id,
            author_name=author_name,
            body=text,
            created_at=_now(),
        )
        updated = replace(
            note, comments=(*note.comments, comment), updated_at=comment.created_at
        )
        self.notes[note_id] = updated
        return updated

    def set_status(
        self,
        note_id: str,
        *,
        status: str,
        allowed_operations: frozenset[str],
        allowed_categories: tuple[str, ...] | None,
    ) -> ServedNote:
        self._require("status", allowed_operations)
        note = self._visible(note_id, allowed_categories)

        if status not in FIELD_STATUSES:
            raise NoteError(
                "Desde un dispositivo móvil sólo se puede mover la nota entre los estados de "
                "trabajo. Resolver exige escribir cómo se resolvió, y archivar es del "
                "responsable del proyecto.",
                code="STATUS_NOT_ALLOWED",
            )

        if note.status in ("resolved", "archived"):
            raise NoteError(
                "Esta nota ya está cerrada; reabrirla es del responsable del proyecto.",
                code="CLOSED",
            )

        updated = replace(note, status=status, updated_at=_now())
        self.notes[note_id] = updated
        return updated

    # -- internos ---------------------------------------------------------

    def _require(self, action: str, allowed_operations: frozenset[str]) -> None:
        operation = REQUIRED_OPERATION[action]
        if operation not in allowed_operations:
            raise NoteError(
                f"Su concesión no incluye «{operation}».", code="FORBIDDEN"
            )

    def _visible(
        self, note_id: str, allowed_categories: tuple[str, ...] | None
    ) -> ServedNote:
        """Busca la nota **ya recortada** por categoría.

        Importa que el recorte ocurra antes de responder y con el mismo error
        que una nota inexistente: distinguir «no existe» de «no puede verla»
        diría a un contratista que el proyecto tiene notas de mantenimiento y
        cuántas, que es parte de lo que el ámbito por categoría oculta.
        """
        note = self.notes.get(note_id)
        if note is None or not visible_notes([note], allowed_categories=allowed_categories):
            raise NoteError("No se encontró la nota.", code="NOT_FOUND")
        return note


#: Acción de auditoría por operación, para el registro de sólo-añadir.
AUDIT_ACTION: Final[dict[str, str]] = {
    "comment": "note.comment",
    "status": "note.status",
}

StatusLiteral = Literal["open", "inProgress", "blocked"]
