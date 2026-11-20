"""Pruebas de las notas servidas con control de acceso (P09).

Lo que se verifica aquí es un control, no una comodidad. El modelo de acceso
tenía desde la etapa 11 el ámbito por categoría de nota —la pieza que permite
que un contratista trabaje sobre el mismo proyecto y no vea las notas internas
de mantenimiento— y hasta ahora sólo lo aplicaba una pantalla del editor. Un
recorte que vive en la interfaz lo salta cualquiera que llame a la API: eso no es
un control, es una cortesía.

Y el límite deliberado: desde un teléfono se comenta y se mueve el estado de
trabajo, pero no se resuelve ni se archiva. Resolver exige escribir cómo se
resolvió; permitirlo con un toque convertiría «ya está» en el fin de la nota sin
que nadie pueda saber después qué se hizo.
"""

from __future__ import annotations

import pytest

from app.access_model import ROLE_PERMISSIONS
from app.notes import (
    FIELD_STATUSES,
    NoteError,
    NoteStore,
    ServedNote,
    visible_notes,
)

PROJECT = "planta-norte"

EDITOR_OPS = ROLE_PERMISSIONS["editor"]
VIEWER_OPS = ROLE_PERMISSIONS["viewer"]


def note(
    note_id: str,
    *,
    category: str = "safety",
    status: str = "open",
    scene: str | None = None,
    assignee: str | None = None,
    due: str | None = None,
) -> ServedNote:
    return ServedNote(
        note_id=note_id,
        project_id=PROJECT,
        title=f"Observación {note_id}",
        body="",
        category_id=category,
        status=status,
        priority="normal",
        scene_id=scene,
        asset_id=None,
        assignee_id=assignee,
        assignee_name=None if assignee is None else assignee,
        due_date=due,
        updated_at="2026-03-01T09:00:00Z",
    )


@pytest.fixture()
def store() -> NoteStore:
    store = NoteStore()
    store.replace_project(
        PROJECT,
        [
            note("n1", category="safety", due="2026-02-01T00:00:00Z"),
            note("n2", category="maintenance", scene="escena-1"),
            note("n3", category="safety", status="resolved"),
            note("n4", category="other", assignee="tecnico.ruiz"),
        ],
    )
    return store


# --------------------------------------------------------------------- #
# Recorte por categoría
# --------------------------------------------------------------------- #


def test_sin_restriccion_se_ven_todas(store: NoteStore) -> None:
    """TEST-SRN-001: `None` es «sin restricción».

    Si significara «ninguna», un administrador con permisos generales se
    quedaría sin ver una sola nota, y el fallo parecería una base de datos
    vacía.
    """
    found = store.list_for_project(
        PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=None
    )

    assert {entry.note_id for entry in found} == {"n1", "n2", "n3", "n4"}


def test_ninguna_categoria_no_ve_nada(store: NoteStore) -> None:
    """TEST-SRN-002: la tupla vacía es «ninguna», y es un estado legítimo."""
    found = store.list_for_project(
        PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=()
    )

    assert found == []


def test_recorta_a_las_categorias_concedidas(store: NoteStore) -> None:
    """TEST-SRN-003: el caso del contratista, que es para lo que existe."""
    found = store.list_for_project(
        PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=("safety",)
    )

    assert {entry.note_id for entry in found} == {"n1", "n3"}


def test_el_recorte_tambien_protege_una_nota_concreta(store: NoteStore) -> None:
    """TEST-SRN-004: y lo hace con el mismo error que una nota inexistente.

    Distinguir «no existe» de «no puede verla» diría al contratista que el
    proyecto tiene notas de mantenimiento, que es parte de lo que el ámbito por
    categoría oculta.
    """
    with pytest.raises(NoteError) as error:
        store.add_comment(
            "n2",
            author_id="contrata.perez",
            author_name="Pérez",
            body="visto",
            allowed_operations=EDITOR_OPS,
            allowed_categories=("safety",),
        )

    assert error.value.code == "NOT_FOUND"


def test_visible_notes_distingue_none_de_vacio() -> None:
    """TEST-SRN-005: la distinción, aislada de todo lo demás."""
    entries = [note("n1", category="safety")]

    assert visible_notes(entries, allowed_categories=None) == entries
    assert visible_notes(entries, allowed_categories=()) == []


# --------------------------------------------------------------------- #
# Permisos
# --------------------------------------------------------------------- #


def test_sin_note_read_no_se_listan(store: NoteStore) -> None:
    """TEST-SRN-006: el permiso se comprueba antes del filtro.

    Al revés, un usuario sin permiso de lectura descubriría cuántas notas hay
    por el tiempo que tarda la respuesta.
    """
    with pytest.raises(NoteError) as error:
        store.list_for_project(
            PROJECT, allowed_operations=frozenset(), allowed_categories=None
        )

    assert error.value.code == "FORBIDDEN"


def test_un_lector_no_comenta(store: NoteStore) -> None:
    """TEST-SRN-007: comentar es modificar la nota, y el rol lector no modifica.

    Es la comprobación que impide que «participar desde el móvil» se convierta
    en una puerta por la que escribe cualquiera que pueda leer.
    """
    assert "note.read" in VIEWER_OPS
    assert "note.update" not in VIEWER_OPS

    with pytest.raises(NoteError) as error:
        store.add_comment(
            "n1",
            author_id="visita.lopez",
            author_name="López",
            body="una cosa",
            allowed_operations=VIEWER_OPS,
            allowed_categories=None,
        )

    assert error.value.code == "FORBIDDEN"


# --------------------------------------------------------------------- #
# Participación
# --------------------------------------------------------------------- #


def test_comentar_deja_el_comentario_firmado(store: NoteStore) -> None:
    """TEST-SRN-008: con nombre y fecha.

    Una nota sin firma no sirve para preguntarle nada a nadie después, que es
    para lo que se comenta una nota de planta.
    """
    updated = store.add_comment(
        "n1",
        author_id="tecnico.ruiz",
        author_name="Ruiz",
        body="  La brida sigue goteando  ",
        allowed_operations=EDITOR_OPS,
        allowed_categories=None,
    )

    assert len(updated.comments) == 1
    comment = updated.comments[0]
    assert comment.body == "La brida sigue goteando"
    assert comment.author_name == "Ruiz"
    assert comment.created_at.endswith("Z")
    assert updated.updated_at == comment.created_at


def test_un_comentario_vacio_se_rechaza(store: NoteStore) -> None:
    """TEST-SRN-009: en un teclado de teléfono, el envío accidental es normal."""
    with pytest.raises(NoteError) as error:
        store.add_comment(
            "n1",
            author_id="tecnico.ruiz",
            author_name="Ruiz",
            body="   \n  ",
            allowed_operations=EDITOR_OPS,
            allowed_categories=None,
        )

    assert error.value.code == "EMPTY"


def test_mover_el_estado_de_trabajo(store: NoteStore) -> None:
    """TEST-SRN-010: es la otra mitad de «participar»."""
    updated = store.set_status(
        "n1",
        status="inProgress",
        allowed_operations=EDITOR_OPS,
        allowed_categories=None,
    )

    assert updated.status == "inProgress"


def test_no_se_resuelve_desde_el_movil(store: NoteStore) -> None:
    """TEST-SRN-011: el límite deliberado de esta superficie.

    Resolver exige escribir cómo se resolvió, y archivar es del responsable del
    proyecto. Ofrecerlos aquí convertiría «ya está» en un toque de pantalla y la
    nota se cerraría sin que nadie pueda saber después qué se hizo.
    """
    assert "resolved" not in FIELD_STATUSES
    assert "archived" not in FIELD_STATUSES

    for status in ("resolved", "archived"):
        with pytest.raises(NoteError) as error:
            store.set_status(
                "n1",
                status=status,
                allowed_operations=EDITOR_OPS,
                allowed_categories=None,
            )
        assert error.value.code == "STATUS_NOT_ALLOWED"


def test_una_nota_cerrada_no_se_reabre_desde_el_movil(store: NoteStore) -> None:
    """TEST-SRN-012: reabrir deshace una decisión que alguien documentó."""
    with pytest.raises(NoteError) as error:
        store.set_status(
            "n3",
            status="open",
            allowed_operations=EDITOR_OPS,
            allowed_categories=None,
        )

    assert error.value.code == "CLOSED"


# --------------------------------------------------------------------- #
# Filtros y orden
# --------------------------------------------------------------------- #


def test_filtra_por_estado_escena_y_responsable(store: NoteStore) -> None:
    """TEST-SRN-013: son los tres filtros que se usan de pie en una planta."""
    assert [
        entry.note_id
        for entry in store.list_for_project(
            PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=None, status="resolved"
        )
    ] == ["n3"]

    assert [
        entry.note_id
        for entry in store.list_for_project(
            PROJECT,
            allowed_operations=EDITOR_OPS,
            allowed_categories=None,
            scene_id="escena-1",
        )
    ] == ["n2"]

    assert [
        entry.note_id
        for entry in store.list_for_project(
            PROJECT,
            allowed_operations=EDITOR_OPS,
            allowed_categories=None,
            assignee_id="tecnico.ruiz",
        )
    ] == ["n4"]


def test_lo_vencido_va_primero(store: NoteStore) -> None:
    """TEST-SRN-014: es el orden con el que alguien mira esta lista en planta."""
    found = store.list_for_project(
        PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=None
    )

    assert found[0].note_id == "n1"


def test_recargar_el_proyecto_borra_lo_que_el_editor_borro(store: NoteStore) -> None:
    """TEST-SRN-015: sustituir y no fusionar.

    Fusionando, una nota borrada en el editor volvería a aparecer en el teléfono
    de alguien, que seguiría trabajando sobre algo que ya no existe.
    """
    store.replace_project(PROJECT, [note("n9")])

    found = store.list_for_project(
        PROJECT, allowed_operations=EDITOR_OPS, allowed_categories=None
    )

    assert [entry.note_id for entry in found] == ["n9"]


def test_recargar_un_proyecto_no_toca_otro(store: NoteStore) -> None:
    """TEST-SRN-016: el servicio sirve varios proyectos a la vez."""
    store.replace_project("otra-planta", [note("x1")])
    store.replace_project(PROJECT, [note("n9")])

    assert [
        entry.note_id
        for entry in store.list_for_project(
            "otra-planta", allowed_operations=EDITOR_OPS, allowed_categories=None
        )
    ] == ["x1"]
