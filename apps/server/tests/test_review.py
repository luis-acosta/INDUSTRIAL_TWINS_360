"""Pruebas del flujo de revisión y publicación controlada (X16, X17).

Lo que se verifica aquí son controles, no comodidades: que quien redacta no
aprueba lo que redactó, que una transición no declarada se rechaza, que
publicar sobre una base que ya se movió no sobrescribe el trabajo de otro, y
que cada paso queda en el registro de auditoría encadenado. Un fallo en
cualquiera de estos convierte «publicación controlada» en un botón con otro
nombre.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from app.access_model import ROLE_PERMISSIONS
from app.audit import AuditLog
from app.review import (
    STATES,
    TRANSITIONS,
    Conflict,
    ReviewError,
    ReviewStore,
    detect_conflicts,
)

PROJECT = "planta-norte"
AUTOR = "tecnico.ruiz"
REVISOR = "jefa.area"

EDITOR_OPS = ROLE_PERMISSIONS["editor"]
REVISOR_OPS = ROLE_PERMISSIONS["reviewer"]
VIEWER_OPS = ROLE_PERMISSIONS["viewer"]
# El administrador es el único rol que puede editar y aprobar a la vez, de modo
# que es el único con el que la separación de funciones se puede comprobar: en
# los demás, el reparto de permisos ya impide el caso.
ADMIN_OPS = ROLE_PERMISSIONS["administrator"]
ADMIN = "jefa.planta"


NOW = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)


@pytest.fixture()
def audit() -> AuditLog:
    return AuditLog()


@pytest.fixture()
def store(audit: AuditLog) -> ReviewStore:
    return ReviewStore(audit)


def draft(store: ReviewStore, *, author: str = AUTOR, sections: dict[str, str] | None = None):
    return store.create(
        project_id=PROJECT,
        author_id=author,
        summary="Se actualizan los rótulos de la sala de bombas",
        sections=sections or {"scene:1": "a1", "scene:2": "b1"},
        content_digest="d1",
        allowed_operations=EDITOR_OPS,
        now=NOW,
    )


class TestCicloNormal:
    """El camino que se recorre todos los días."""

    def test_un_borrador_nace_en_draft(self, store: ReviewStore) -> None:
        # TEST-REV-001: nace como borrador y no en revisión: enviar a revisar
        # es una decisión del autor, no un efecto de guardar.
        revision = draft(store)
        assert revision.state == "draft"
        assert revision.author_id == AUTOR
        assert revision.base_revision_id is None

    def test_el_recorrido_completo_publica(self, store: ReviewStore) -> None:
        # TEST-REV-002: borrador, revisión, aprobación y publicación, cada paso
        # con el permiso que le corresponde.
        revision = draft(store)
        enviada = store.act(
            revision_id=revision.revision_id,
            action="submit",
            actor_id=AUTOR,
            allowed_operations=EDITOR_OPS,
        )
        assert enviada.state == "in_review"

        aprobada = store.act(
            revision_id=revision.revision_id,
            action="approve",
            actor_id=REVISOR,
            allowed_operations=REVISOR_OPS,
            comment="Conforme con el cambio de rótulos",
        )
        assert aprobada.state == "approved"
        assert aprobada.approved_by == REVISOR
        assert aprobada.comments == ("Conforme con el cambio de rótulos",)

        publicada = store.act(
            revision_id=revision.revision_id,
            action="publish",
            actor_id=REVISOR,
            allowed_operations=REVISOR_OPS,
        )
        assert publicada.state == "published"
        assert store.published_revision(PROJECT) is not None
        assert store.published_revision(PROJECT).revision_id == revision.revision_id  # type: ignore[union-attr]

    def test_pedir_cambios_devuelve_al_autor(self, store: ReviewStore) -> None:
        # TEST-REV-003: y desde ahí se puede volver a enviar, que es el caso
        # normal de una revisión con observaciones.
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)
        devuelta = store.act(
            revision_id=revision.revision_id,
            action="request_changes",
            actor_id=REVISOR,
            allowed_operations=REVISOR_OPS,
            comment="Falta el rótulo de la válvula V-12",
        )
        assert devuelta.state == "changes_requested"

        reenviada = store.act(
            revision_id=revision.revision_id,
            action="submit",
            actor_id=AUTOR,
            allowed_operations=EDITOR_OPS,
        )
        assert reenviada.state == "in_review"
        assert "V-12" in reenviada.comments[0]

    def test_una_revision_sin_resumen_no_se_abre(self, store: ReviewStore) -> None:
        # TEST-REV-004: el resumen es lo que lee el revisor para saber qué
        # aprueba. Sin él, aprobar es firmar en blanco.
        with pytest.raises(ReviewError) as error:
            store.create(
                project_id=PROJECT,
                author_id=AUTOR,
                summary="   ",
                sections={},
                content_digest="d",
                allowed_operations=EDITOR_OPS,
            )
        assert error.value.code == "summary_required"


class TestSeparacionDeFunciones:
    """El control que convierte la publicación en controlada."""

    def test_el_autor_no_aprueba_su_propia_revision(self, store: ReviewStore) -> None:
        # TEST-REV-005: ni aunque tenga permiso para aprobar. Un permiso dice
        # qué puede hacer una persona; la separación de funciones dice qué no
        # puede hacer sobre su propio trabajo.
        revision = store.create(
            project_id=PROJECT,
            author_id=ADMIN,
            summary="Cambio redactado por quien también puede aprobar",
            sections={"scene:1": "a1"},
            content_digest="d1",
            allowed_operations=ADMIN_OPS,
        )
        store.act(revision_id=revision.revision_id, action="submit", actor_id=ADMIN, allowed_operations=ADMIN_OPS)

        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="approve",
                actor_id=ADMIN,
                allowed_operations=ADMIN_OPS,
            )
        assert error.value.code == "separation_of_duties"

    def test_el_autor_tampoco_publica_lo_que_redacto(self, store: ReviewStore) -> None:
        # TEST-REV-006: si pudiera publicar lo aprobado por otro siendo él el
        # autor, bastaría una aprobación de cortesía para saltarse el control.
        revision = store.create(
            project_id=PROJECT,
            author_id=ADMIN,
            summary="Cambio redactado por quien también puede publicar",
            sections={"scene:1": "a1"},
            content_digest="d1",
            allowed_operations=ADMIN_OPS,
        )
        store.act(revision_id=revision.revision_id, action="submit", actor_id=ADMIN, allowed_operations=ADMIN_OPS)
        store.act(
            revision_id=revision.revision_id,
            action="approve",
            actor_id=REVISOR,
            allowed_operations=REVISOR_OPS,
        )

        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="publish",
                actor_id=ADMIN,
                allowed_operations=ADMIN_OPS,
            )
        assert error.value.code == "separation_of_duties"

    def test_el_autor_si_puede_retirar_su_borrador(self, store: ReviewStore) -> None:
        # TEST-REV-007: retirar no se salta ningún control, y un borrador
        # abandonado tiene que poder salir de la cola.
        revision = draft(store)
        retirada = store.act(
            revision_id=revision.revision_id,
            action="withdraw",
            actor_id=AUTOR,
            allowed_operations=EDITOR_OPS,
        )
        assert retirada.state == "withdrawn"

    def test_un_editor_no_aprueba(self, store: ReviewStore) -> None:
        # TEST-REV-008: aprobar exige «project.publish», que el rol de editor
        # no tiene. Es la comprobación en el servidor que exige la
        # arquitectura: «permisos verificados en backend, nunca solo en UI».
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)

        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="approve",
                actor_id="otro.editor",
                allowed_operations=EDITOR_OPS,
            )
        assert error.value.code == "permission_denied"

    def test_un_visor_no_abre_borradores(self, store: ReviewStore) -> None:
        # TEST-REV-009: quien sólo mira no edita.
        with pytest.raises(ReviewError) as error:
            store.create(
                project_id=PROJECT,
                author_id="visitante",
                summary="algo",
                sections={},
                content_digest="d",
                allowed_operations=VIEWER_OPS,
            )
        assert error.value.code == "permission_denied"


class TestTransiciones:
    """La tabla de estados es el contrato."""

    def test_no_se_puede_aprobar_un_borrador_sin_enviar(self, store: ReviewStore) -> None:
        # TEST-REV-010: saltarse la revisión es exactamente lo que el flujo
        # existe para impedir.
        revision = draft(store)
        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="approve",
                actor_id=REVISOR,
                allowed_operations=REVISOR_OPS,
            )
        assert error.value.code == "invalid_transition"

    def test_no_se_puede_publicar_sin_aprobar(self, store: ReviewStore) -> None:
        # TEST-REV-011: el estado «aprobado» es el que justifica la publicación.
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)

        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="publish",
                actor_id=REVISOR,
                allowed_operations=REVISOR_OPS,
            )
        assert error.value.code == "invalid_transition"

    def test_una_revision_publicada_es_definitiva(self, store: ReviewStore) -> None:
        # TEST-REV-012: lo publicado no se edita; se abre una revisión nueva.
        # Si se pudiera reabrir, el histórico dejaría de decir qué se publicó.
        revision = draft(store)
        for action, actor, ops in (
            ("submit", AUTOR, EDITOR_OPS),
            ("approve", REVISOR, REVISOR_OPS),
            ("publish", REVISOR, REVISOR_OPS),
        ):
            store.act(revision_id=revision.revision_id, action=action, actor_id=actor, allowed_operations=ops)

        for action in ("submit", "approve", "withdraw", "request_changes"):
            with pytest.raises(ReviewError) as error:
                store.act(
                    revision_id=revision.revision_id,
                    action=action,
                    actor_id=REVISOR,
                    allowed_operations=REVISOR_OPS,
                )
            assert error.value.code == "invalid_transition"

    def test_una_accion_desconocida_se_rechaza(self, store: ReviewStore) -> None:
        # TEST-REV-013: un cliente con una versión más nueva podría pedir una
        # acción que este servidor no tiene; el motivo debe decirlo.
        revision = draft(store)
        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=revision.revision_id,
                action="merge",
                actor_id=AUTOR,
                allowed_operations=EDITOR_OPS,
            )
        assert error.value.code == "unknown_action"

    def test_la_tabla_cubre_todos_los_estados(self) -> None:
        # TEST-REV-014: un estado sin entrada en la tabla provocaría un
        # KeyError en producción en lugar de un rechazo con motivo.
        assert set(TRANSITIONS) == set(STATES)
        for targets in TRANSITIONS.values():
            for target in targets.values():
                assert target in STATES


class TestConflictos:
    """Ediciones simultáneas (X17)."""

    def test_sin_solape_no_hay_conflicto(self) -> None:
        # TEST-REV-015: dos personas trabajando en escenas distintas es el caso
        # normal en una planta grande; marcarlo como conflicto haría que nadie
        # usara el flujo.
        base = {"scene:1": "a1", "scene:2": "b1"}
        mia = {"scene:1": "a2", "scene:2": "b1"}
        publicada = {"scene:1": "a1", "scene:2": "b2"}
        assert detect_conflicts(base, mia, publicada) == []

    def test_la_misma_seccion_cambiada_por_los_dos_es_conflicto(self) -> None:
        # TEST-REV-016: y se nombra la sección, que es la diferencia entre
        # corregir una escena y rehacer una semana de trabajo.
        base = {"scene:1": "a1"}
        conflicts = detect_conflicts(base, {"scene:1": "a2"}, {"scene:1": "a3"})
        assert conflicts == [Conflict(section="scene:1", base="a1", incoming="a2", published="a3")]

    def test_el_mismo_cambio_en_los_dos_lados_no_es_conflicto(self) -> None:
        # TEST-REV-017: dos personas que corrigen la misma errata no tienen
        # nada que resolver.
        base = {"scene:1": "a1"}
        assert detect_conflicts(base, {"scene:1": "a2"}, {"scene:1": "a2"}) == []

    def test_una_seccion_nueva_en_ambos_lados_es_conflicto(self) -> None:
        # TEST-REV-018: dos activos distintos con el mismo identificador es un
        # solape real, aunque no existiera en la base.
        conflicts = detect_conflicts({}, {"asset:P-101": "x"}, {"asset:P-101": "y"})
        assert [c.section for c in conflicts] == ["asset:P-101"]

    def test_borrar_lo_que_otro_cambio_es_conflicto(self) -> None:
        # TEST-REV-019: la ausencia es un cambio. Si no se contara, publicar
        # haría desaparecer en silencio el trabajo del otro.
        base = {"scene:9": "v1"}
        conflicts = detect_conflicts(base, {}, {"scene:9": "v2"})
        assert [(c.section, c.incoming) for c in conflicts] == [("scene:9", "")]

    def test_borrar_lo_que_nadie_cambio_no_es_conflicto(self) -> None:
        # TEST-REV-020: borrar una escena que nadie más tocó es una decisión
        # legítima del autor y la revisión es donde se discute.
        base = {"scene:9": "v1"}
        assert detect_conflicts(base, {}, {"scene:9": "v1"}) == []

    def test_publicar_sobre_una_base_movida_se_rechaza(self, store: ReviewStore) -> None:
        # TEST-REV-021: es el control que evita perder trabajo. Sin él, la
        # segunda publicación sobrescribe la primera y nadie se entera.
        primera = draft(store, sections={"scene:1": "a1"})
        for action, actor, ops in (
            ("submit", AUTOR, EDITOR_OPS),
            ("approve", REVISOR, REVISOR_OPS),
            ("publish", REVISOR, REVISOR_OPS),
        ):
            store.act(revision_id=primera.revision_id, action=action, actor_id=actor, allowed_operations=ops)

        # La segunda se abrió antes de que se publicara la primera: su base es
        # anterior y toca la misma escena.
        segunda = store.create(
            project_id=PROJECT,
            author_id="otro.tecnico",
            summary="Otro cambio en la misma escena",
            sections={"scene:1": "a9"},
            content_digest="d9",
            allowed_operations=EDITOR_OPS,
            now=NOW + timedelta(minutes=5),
        )
        # Se fuerza una base anterior, que es lo que ocurre de verdad cuando el
        # autor llevaba el borrador abierto desde antes de la publicación.
        store._revisions[segunda.revision_id] = replace(segunda, base_revision_id=None)

        store.act(revision_id=segunda.revision_id, action="submit", actor_id="otro.tecnico", allowed_operations=EDITOR_OPS)
        store.act(revision_id=segunda.revision_id, action="approve", actor_id=REVISOR, allowed_operations=REVISOR_OPS)

        with pytest.raises(ReviewError) as error:
            store.act(
                revision_id=segunda.revision_id,
                action="publish",
                actor_id=REVISOR,
                allowed_operations=REVISOR_OPS,
            )
        assert error.value.code == "conflict"

    def test_una_revision_nueva_parte_de_lo_publicado(self, store: ReviewStore) -> None:
        # TEST-REV-022: y entonces no hay conflicto, porque su base es la
        # versión que está publicada.
        primera = draft(store, sections={"scene:1": "a1"})
        for action, actor, ops in (
            ("submit", AUTOR, EDITOR_OPS),
            ("approve", REVISOR, REVISOR_OPS),
            ("publish", REVISOR, REVISOR_OPS),
        ):
            store.act(revision_id=primera.revision_id, action=action, actor_id=actor, allowed_operations=ops)

        segunda = draft(store, sections={"scene:1": "a2"})
        assert segunda.base_revision_id == primera.revision_id
        assert store.conflicts_for(segunda) == []


class TestAuditoria:
    """Cada paso queda registrado (X17)."""

    def test_cada_transicion_deja_un_evento_encadenado(self, store: ReviewStore, audit: AuditLog) -> None:
        # TEST-REV-023: el registro es la respuesta a «quién aprobó esto».
        # Encadenado, además, para que no se pueda quitar un paso del medio.
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)
        store.act(revision_id=revision.revision_id, action="approve", actor_id=REVISOR, allowed_operations=REVISOR_OPS)

        acciones = [event.action for event in audit.events]
        assert acciones == ["revision.created", "revision.submitted", "revision.approved"]

        valido, roto = audit.verify_chain()
        assert valido is True
        assert roto is None

    def test_el_evento_dice_de_donde_y_a_donde(self, store: ReviewStore, audit: AuditLog) -> None:
        # TEST-REV-024: sin el estado de origen, el registro no permite
        # reconstruir el recorrido de una revisión.
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)

        evento = audit.events[-1]
        assert evento.detail["from"] == "draft"
        assert evento.detail["to"] == "in_review"
        assert evento.detail["projectId"] == PROJECT

    def test_las_acciones_de_revision_son_del_vocabulario(self, store: ReviewStore, audit: AuditLog) -> None:
        # TEST-REV-025: el vocabulario del registro es cerrado y `to_row`
        # rechaza lo que no esté en él. Una acción nueva sin declarar no
        # fallaría al registrarse, sino al volcar el registro.
        revision = draft(store)
        store.act(revision_id=revision.revision_id, action="withdraw", actor_id=AUTOR, allowed_operations=EDITOR_OPS)

        for event in audit.events:
            assert event.to_row()["action"] == event.action

    def test_un_rechazo_no_deja_rastro_de_transicion(self, store: ReviewStore, audit: AuditLog) -> None:
        # TEST-REV-026: registrar un intento fallido como si fuera un cambio
        # de estado haría ilegible el histórico.
        revision = draft(store)
        with pytest.raises(ReviewError):
            store.act(
                revision_id=revision.revision_id,
                action="approve",
                actor_id=REVISOR,
                allowed_operations=REVISOR_OPS,
            )
        assert [event.action for event in audit.events] == ["revision.created"]


class TestConsulta:
    def test_lista_de_la_mas_reciente_a_la_mas_antigua(self, store: ReviewStore) -> None:
        # TEST-REV-027: la cola de revisión se lee por arriba.
        primera = draft(store)
        segunda = store.create(
            project_id=PROJECT,
            author_id=AUTOR,
            summary="Segunda",
            sections={},
            content_digest="d2",
            allowed_operations=EDITOR_OPS,
            now=NOW + timedelta(hours=1),
        )
        ids = [r.revision_id for r in store.list_for_project(PROJECT)]
        assert ids == [segunda.revision_id, primera.revision_id]

    def test_filtra_por_estado(self, store: ReviewStore) -> None:
        # TEST-REV-028: el revisor quiere ver lo que está en revisión y no
        # todos los borradores de la planta.
        pendiente = draft(store)
        store.act(revision_id=pendiente.revision_id, action="submit", actor_id=AUTOR, allowed_operations=EDITOR_OPS)
        draft(store)

        en_revision = store.list_for_project(PROJECT, state="in_review")
        assert [r.revision_id for r in en_revision] == [pendiente.revision_id]

    def test_una_revision_inexistente_se_distingue(self, store: ReviewStore) -> None:
        # TEST-REV-029: 404 y no 400: el cliente tiene que poder distinguir
        # «no existe» de «lo pediste mal».
        with pytest.raises(ReviewError) as error:
            store.get("00000000-0000-0000-0000-000000000000")
        assert error.value.code == "not_found"

    def test_los_proyectos_no_se_mezclan(self, store: ReviewStore) -> None:
        # TEST-REV-030: en una instalación con varias plantas, ver la cola de
        # otra planta es una fuga de información y un error de operación.
        draft(store)
        otra = store.create(
            project_id="planta-sur",
            author_id=AUTOR,
            summary="Cambio en la otra planta",
            sections={},
            content_digest="d",
            allowed_operations=EDITOR_OPS,
        )
        assert [r.revision_id for r in store.list_for_project("planta-sur")] == [otra.revision_id]
