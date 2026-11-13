"""Pruebas de autorización.

Lo que se comprueba es que el servidor deniegue lo que debe denegar, incluso
cuando la interfaz ya lo habría ocultado. El plan es explícito: «Permisos
verificados en backend, nunca solo en UI», y una prueba que sólo verifique los
casos permitidos no dice nada sobre eso.

El modelo de permisos se genera desde el dominio, así que aquí no se repite la
tabla: se comprueba el comportamiento, y la correspondencia entre las dos copias
la verifica ``tools/emit-access-model.mjs --check``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.access_model import MODEL_FINGERPRINT, OPERATIONS, ROLE_PERMISSIONS, ROLES
from app.security import (
    AccessError,
    Decision,
    Grant,
    Resource,
    Scope,
    can_perform,
    effective_operations,
    is_active,
    require,
    scope_covers,
)

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)


def grant(role: str, **scope: object) -> Grant:
    return Grant(user_id="u1", role=role, scope=Scope(**scope))  # type: ignore[arg-type]


class TestModeloGenerado:
    def test_el_modelo_trae_los_cinco_roles(self) -> None:
        # TEST-SRV-001
        assert set(ROLES) == {"viewer", "contributor", "editor", "reviewer", "administrator"}
        assert len(MODEL_FINGERPRINT) == 64

    def test_cada_rol_declara_permisos(self) -> None:
        # TEST-SRV-002
        for role in ROLES:
            assert role in ROLE_PERMISSIONS
            assert len(ROLE_PERMISSIONS[role]) > 0

    def test_todo_permiso_es_una_operacion_conocida(self) -> None:
        # TEST-SRV-003: un permiso que no corresponde a ninguna operación sería
        # un permiso que nunca se puede ejercer, o peor, una errata que oculta
        # que falta el permiso de verdad.
        for role, permissions in ROLE_PERMISSIONS.items():
            desconocidas = permissions - set(OPERATIONS)
            assert desconocidas == set(), f"{role} declara operaciones inexistentes: {desconocidas}"

    def test_el_administrador_lo_puede_todo_y_el_lector_casi_nada(self) -> None:
        # TEST-SRV-004
        assert ROLE_PERMISSIONS["administrator"] == frozenset(OPERATIONS)
        assert ROLE_PERMISSIONS["viewer"] < ROLE_PERMISSIONS["administrator"]
        # Un lector no puede cambiar nada, ni publicar, ni ver la auditoría.
        for operation in ("project.update", "project.publish", "audit.read", "user.manage"):
            assert operation not in ROLE_PERMISSIONS["viewer"]


class TestOperacionesDesconocidas:
    def test_una_operacion_inventada_se_deniega(self) -> None:
        # TEST-SRV-005: permitirla «porque no está en la lista» convertiría una
        # errata en un permiso.
        decision = can_perform(operation="project.destroy", grants=[grant("administrator")], now=NOW)
        assert decision.allowed is False
        assert "desconocida" in decision.reason


class TestSinConcesiones:
    def test_sin_concesiones_no_hay_acceso(self) -> None:
        # TEST-SRV-006
        decision = can_perform(operation="project.read", grants=[], now=NOW)
        assert decision.allowed is False
        assert "ninguna concesión" in decision.reason


class TestCaducidad:
    def test_una_concesion_caducada_no_concede(self) -> None:
        # TEST-SRV-007: el mecanismo existe para los contratistas; si el
        # servidor ignorara la fecha, sería decorativo.
        caducada = Grant(
            user_id="u1",
            role="administrator",
            expires_at=NOW - timedelta(days=1),
        )
        decision = can_perform(operation="project.update", grants=[caducada], now=NOW)

        assert decision.allowed is False
        assert "caducado" in decision.reason

    def test_una_concesion_vigente_concede(self) -> None:
        # TEST-SRV-008
        vigente = Grant(user_id="u1", role="editor", expires_at=NOW + timedelta(days=1))
        assert can_perform(operation="project.update", grants=[vigente], now=NOW).allowed is True

    def test_sin_caducidad_siempre_vigente(self) -> None:
        # TEST-SRV-009
        assert is_active(Grant(user_id="u1", role="viewer"), NOW) is True

    def test_una_fecha_sin_zona_se_interpreta_en_utc(self) -> None:
        # TEST-SRV-010: una fecha ingenua comparada con una consciente lanza en
        # Python. Asumir UTC es lo correcto aquí porque todo el sistema guarda
        # en UTC, y lanzar dejaría al usuario sin acceso por un detalle de
        # serialización.
        ingenua = Grant(user_id="u1", role="editor", expires_at=datetime(2026, 3, 2, 12, 0))
        assert is_active(ingenua, NOW) is True


class TestAmbito:
    def test_el_ambito_global_cubre_cualquier_recurso(self) -> None:
        # TEST-SRV-011
        assert scope_covers(Scope(), Resource(plant_id="p1", unit_id="u1")) is True

    def test_una_concesion_de_planta_no_cubre_otra_planta(self) -> None:
        # TEST-SRV-012
        decision = can_perform(
            operation="project.update",
            grants=[grant("editor", plant_id="p1")],
            resource=Resource(plant_id="p2"),
            now=NOW,
        )
        assert decision.allowed is False
        assert "fuera del ámbito" in decision.reason

    def test_una_concesion_de_unidad_no_cubre_otra_unidad_de_la_misma_planta(self) -> None:
        # TEST-SRV-013
        decision = can_perform(
            operation="asset.update",
            grants=[grant("editor", plant_id="p1", unit_id="u200")],
            resource=Resource(plant_id="p1", unit_id="u300"),
            now=NOW,
        )
        assert decision.allowed is False

    def test_una_concesion_de_planta_cubre_cualquier_unidad_suya(self) -> None:
        # TEST-SRV-014: `None` significa «cualquiera», y es lo que evita tener
        # que reasignar permisos cuando el cliente crea un área nueva.
        decision = can_perform(
            operation="asset.update",
            grants=[grant("editor", plant_id="p1")],
            resource=Resource(plant_id="p1", unit_id="u300", area_id="a7"),
            now=NOW,
        )
        assert decision.allowed is True

    def test_las_categorias_de_nota_restringen_de_verdad(self) -> None:
        # TEST-SRV-015: sin esta comprobación, el filtro de categorías sería
        # sólo de presentación y la API devolvería las demás.
        limitado = grant("editor", note_category_ids=frozenset({"seguridad"}))

        permitido = can_perform(
            operation="note.read",
            grants=[limitado],
            resource=Resource(note_category_id="seguridad"),
            now=NOW,
        )
        denegado = can_perform(
            operation="note.read",
            grants=[limitado],
            resource=Resource(note_category_id="mantenimiento"),
            now=NOW,
        )

        assert permitido.allowed is True
        assert denegado.allowed is False

    def test_sin_categorias_declaradas_se_accede_a_todas(self) -> None:
        # TEST-SRV-016
        decision = can_perform(
            operation="note.read",
            grants=[grant("editor")],
            resource=Resource(note_category_id="mantenimiento"),
            now=NOW,
        )
        assert decision.allowed is True


class TestVariasConcesiones:
    def test_basta_una_concesion_que_permita(self) -> None:
        # TEST-SRV-017: un usuario puede ser lector en toda la planta y editor
        # en su unidad; la decisión debe mirar todas sus concesiones.
        decision = can_perform(
            operation="asset.update",
            grants=[grant("viewer"), grant("editor", unit_id="u200")],
            resource=Resource(unit_id="u200"),
            now=NOW,
        )
        assert decision.allowed is True
        assert decision.via_role == "editor"

    def test_distingue_falta_de_permiso_de_falta_de_ambito(self) -> None:
        # TEST-SRV-018: los dos mensajes llevan a acciones distintas —pedir
        # otro rol o pedir ampliación de ámbito—, así que no se pueden fundir.
        sin_permiso = can_perform(operation="user.manage", grants=[grant("editor")], now=NOW)
        fuera_de_ambito = can_perform(
            operation="asset.update",
            grants=[grant("editor", plant_id="p1")],
            resource=Resource(plant_id="p9"),
            now=NOW,
        )

        assert "Ninguno de los roles" in sin_permiso.reason
        assert "fuera del ámbito" in fuera_de_ambito.reason


class TestRequire:
    def test_lanza_al_denegar(self) -> None:
        # TEST-SRV-019: comprobar y no mirar el resultado es el olvido típico;
        # `require` lo convierte en imposible.
        with pytest.raises(AccessError) as error:
            require(operation="user.manage", grants=[grant("viewer")], now=NOW)

        assert error.value.operation == "user.manage"

    def test_devuelve_la_decision_al_permitir(self) -> None:
        # TEST-SRV-020
        decision = require(operation="project.read", grants=[grant("viewer")], now=NOW)
        assert isinstance(decision, Decision)
        assert decision.allowed is True


class TestOperacionesEfectivas:
    def test_une_los_permisos_de_todos_los_roles_vigentes(self) -> None:
        # TEST-SRV-021
        operations = effective_operations(
            [grant("viewer"), grant("reviewer")],
            NOW,
        )
        assert "project.publish" in operations  # del revisor
        assert "scene.read" in operations  # del lector

    def test_ignora_las_concesiones_caducadas(self) -> None:
        # TEST-SRV-022
        operations = effective_operations(
            [Grant(user_id="u1", role="administrator", expires_at=NOW - timedelta(seconds=1))],
            NOW,
        )
        assert operations == frozenset()
