"""Pruebas de la API.

Ejercitan las rutas a través del cliente de prueba de FastAPI, con un lector de
telemetría de mentira. Lo que se comprueba es el contrato que ve el visor y el
que ve la aplicación: que el visor no pueda alcanzar nada más que lecturas, que
los permisos se verifiquen en el servidor, y que un intento denegado quede
registrado.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.audit import AuditEvent, AuditLog
from app.main import create_app
from app.telemetry import MappingSpec

MAPPING_ID = "00000000-0000-4000-8000-000000000001"
NOW = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)

SPEC = MappingSpec(
    mapping_id=MAPPING_ID,
    measurement="presion",
    field="valor",
    tags={},
    bucket="proceso",
    freshness_seconds=300,
)


class FakeReader:
    """Lector de telemetría de prueba.

    Devuelve lo que se le indique y cuenta las llamadas: así se puede comprobar
    que el servidor no consulta variables que no se le pidieron.
    """

    def __init__(self, reading: dict[str, Any] | None = None) -> None:
        self.reading = reading or {
            "value": 5.2,
            "rawValue": None,
            "sourceTimestamp": datetime.now(timezone.utc),
            "failed": False,
            "fromCache": False,
        }
        self.calls: list[str] = []

    async def latest(self, spec: MappingSpec) -> dict[str, Any]:
        self.calls.append(spec.mapping_id)
        return self.reading

    async def ping(self) -> dict[str, object]:
        return {"reachable": True, "latencyMs": 12}


@pytest.fixture()
def audit() -> AuditLog:
    return AuditLog()


@pytest.fixture()
def client(audit: AuditLog) -> TestClient:
    app = create_app(mappings={MAPPING_ID: SPEC}, reader=FakeReader(), audit=audit)
    return TestClient(app)


class TestEstado:
    def test_informa_de_la_huella_del_modelo_de_permisos(self, client: TestClient) -> None:
        # TEST-API-001: permite detectar un servidor desplegado con un modelo
        # de permisos distinto del de la aplicación, que es un desajuste
        # silencioso y peligroso.
        response = client.get("/api/v1/health")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert len(body["accessModel"]) == 64
        assert body["telemetryConfigured"] is True


class TestTelemetriaDelVisor:
    def test_devuelve_la_lectura_pedida(self, client: TestClient) -> None:
        # TEST-API-002
        response = client.post("/api/v1/telemetry/latest", json={"mappingIds": [MAPPING_ID]})

        assert response.status_code == 200
        samples = response.json()
        assert len(samples) == 1
        assert samples[0]["mappingId"] == MAPPING_ID
        assert samples[0]["quality"] == "fresh"

    def test_la_respuesta_no_lleva_datos_de_conexion(self, client: TestClient) -> None:
        # TEST-API-003: el visor no debe conocer la URL, la organización ni el
        # token, y la respuesta es la única cosa que recibe.
        response = client.post("/api/v1/telemetry/latest", json={"mappingIds": [MAPPING_ID]})
        texto = response.text.lower()

        for prohibido in ("token", "influx", "bucket", "org", "password"):
            assert prohibido not in texto

    def test_una_variable_no_mapeada_se_informa_en_lugar_de_ignorarse(
        self, client: TestClient
    ) -> None:
        # TEST-API-004: un visor que pide algo que el servidor no tiene está
        # desincronizado con el recorrido publicado, y hay que poder verlo.
        desconocida = "00000000-0000-4000-8000-000000000999"
        response = client.post("/api/v1/telemetry/latest", json={"mappingIds": [desconocida]})

        samples = response.json()
        assert samples[0]["quality"] == "missing"
        assert "no tiene esta variable mapeada" in (samples[0]["errorMessage"] or "")

    def test_no_consulta_variables_que_no_se_pidieron(self, audit: AuditLog) -> None:
        # TEST-API-005: el servidor conoce todas las variables del proyecto;
        # devolver más de las pedidas filtraría datos de otros activos.
        reader = FakeReader()
        otra = MappingSpec(
            mapping_id="00000000-0000-4000-8000-000000000002",
            measurement="caudal",
            field="valor",
            tags={},
            bucket="proceso",
            freshness_seconds=60,
        )
        app = create_app(
            mappings={MAPPING_ID: SPEC, otra.mapping_id: otra}, reader=reader, audit=audit
        )
        client = TestClient(app)

        client.post("/api/v1/telemetry/latest", json={"mappingIds": [MAPPING_ID]})

        assert reader.calls == [MAPPING_ID]

    def test_rechaza_una_peticion_sin_identificadores(self, client: TestClient) -> None:
        # TEST-API-006: una lista vacía costaría una ida y vuelta para nada.
        response = client.post("/api/v1/telemetry/latest", json={"mappingIds": []})
        assert response.status_code == 422

    def test_sin_telemetria_configurada_responde_503_y_no_un_error_de_programa(
        self, audit: AuditLog
    ) -> None:
        # TEST-API-007: un servidor que sólo aloja recorridos sin datos de
        # proceso es un despliegue legítimo, y debe decirlo con claridad.
        client = TestClient(create_app(mappings={}, reader=None, audit=audit))
        response = client.post("/api/v1/telemetry/latest", json={"mappingIds": [MAPPING_ID]})

        assert response.status_code == 503
        assert "no tiene telemetría configurada" in response.json()["detail"]

    def test_no_existe_ninguna_ruta_de_escritura_de_telemetria(self, client: TestClient) -> None:
        # TEST-API-008: la garantía de sólo lectura se comprueba sobre el
        # esquema publicado, no sobre la documentación.
        schema = client.get("/api/v1/openapi.json").json()

        for path, operations in schema["paths"].items():
            if "/telemetry" not in path:
                continue
            for method in operations:
                assert method in {"get", "post"}, f"{method.upper()} {path} no debería existir"

        # Y ninguna ruta de telemetría menciona escritura en su identificador.
        telemetry_ops = [
            operation.get("operationId", "")
            for path, methods in schema["paths"].items()
            if "/telemetry" in path
            for operation in methods.values()
        ]
        for operation_id in telemetry_ops:
            assert not any(word in operation_id.lower() for word in ("write", "delete", "set"))


class TestPermisos:
    def test_sin_identidad_no_se_accede(self, client: TestClient) -> None:
        # TEST-API-009
        response = client.get("/api/v1/me/operations")

        assert response.status_code == 403
        assert response.json()["code"] == "PERMISSION_DENIED"

    def test_un_lector_no_puede_leer_la_auditoria(self, client: TestClient) -> None:
        # TEST-API-010: el permiso se verifica en el servidor aunque la
        # interfaz ya oculte la pantalla.
        response = client.get(
            "/api/v1/audit",
            headers={"x-usuario": "u1", "x-rol": "viewer"},
        )

        assert response.status_code == 403
        assert "Ninguno de los roles" in response.json()["message"]

    def test_un_revisor_si_puede(self, client: TestClient) -> None:
        # TEST-API-011
        response = client.get(
            "/api/v1/audit",
            headers={"x-usuario": "u2", "x-rol": "reviewer"},
        )

        assert response.status_code == 200
        assert response.json()["chainValid"] is True

    def test_el_intento_denegado_queda_registrado(self, client: TestClient, audit: AuditLog) -> None:
        # TEST-API-012: sin registrar los intentos denegados, nadie se enteraría
        # de que alguien está probando puertas.
        client.get("/api/v1/audit", headers={"x-usuario": "curioso", "x-rol": "viewer"})

        denied = [event for event in audit.events if event.action == "access.denied"]
        assert len(denied) == 1
        assert denied[0].actor_id == "curioso"
        assert denied[0].detail["operation"] == "audit.read"

    def test_la_lista_de_operaciones_advierte_de_su_limitacion(self, client: TestClient) -> None:
        # TEST-API-013: es por rol, no por recurso. Sin el aviso, la interfaz
        # podría usarla como si fuera la decisión final.
        response = client.get(
            "/api/v1/me/operations",
            headers={"x-usuario": "u1", "x-rol": "editor"},
        )

        body = response.json()
        assert "project.update" in body["operations"]
        assert "no por recurso" in body["aviso"]

    def test_la_comprobacion_por_recurso_respeta_el_ambito(self, client: TestClient) -> None:
        # TEST-API-014
        permitido = client.post(
            "/api/v1/access/check",
            params={"operation": "asset.update", "plant_id": "p1"},
            headers={"x-usuario": "u1", "x-rol": "editor", "x-planta": "p1"},
        )
        denegado = client.post(
            "/api/v1/access/check",
            params={"operation": "asset.update", "plant_id": "p2"},
            headers={"x-usuario": "u1", "x-rol": "editor", "x-planta": "p1"},
        )

        assert permitido.json()["allowed"] is True
        assert denegado.json()["allowed"] is False
        assert "ámbito" in denegado.json()["reason"]


class TestAuditoria:
    def test_la_cadena_detecta_un_evento_manipulado(self, audit: AuditLog) -> None:
        # TEST-API-015: la cadena no impide manipular la base —quien tiene
        # acceso de administrador puede hacerlo— pero deja la manipulación
        # detectable, que es lo que se puede garantizar de verdad.
        for index in range(3):
            audit.append(
                AuditEvent(
                    event_id=f"e{index}",
                    action="note.created",
                    actor_id="u1",
                    actor_name="Usuario",
                    occurred_at=NOW + timedelta(minutes=index),
                    entity="note",
                    entity_id=f"n{index}",
                )
            )

        assert audit.verify_chain() == (True, None)

        # Se reemplaza el segundo evento conservando su huella anterior falsa.
        manipulado = AuditEvent(
            event_id="e1",
            action="note.deleted",
            actor_id="otro",
            actor_name="Otro",
            occurred_at=NOW,
            entity="note",
            entity_id="n1",
            previous_hash="0" * 64,
        )
        audit._events[1] = manipulado  # noqa: SLF001 — se fuerza para la prueba

        valido, roto_en = audit.verify_chain()
        assert valido is False
        assert roto_en == "e1"

    def test_el_detalle_no_guarda_credenciales(self, audit: AuditLog) -> None:
        # TEST-API-016: la tentación de volcar «todo el objeto por si acaso» es
        # constante, y un token en la auditoría es un token en texto plano en
        # una tabla que mucha gente puede leer.
        event = audit.append(
            AuditEvent(
                event_id="e1",
                action="telemetry.configured",
                actor_id="u1",
                actor_name="Usuario",
                occurred_at=NOW,
                entity="telemetry",
                detail={
                    "url": "https://influx.local",
                    "token": "super-secreto",
                    "nested": {"apiKey": "otra-cosa"},
                },
            )
        )

        assert event.detail["token"] == "[redactado]"
        assert event.detail["nested"]["apiKey"] == "[redactado]"
        # La URL sí se conserva: sirve para auditar y no es una credencial.
        assert event.detail["url"] == "https://influx.local"

    def test_una_accion_no_contemplada_se_rechaza(self, audit: AuditLog) -> None:
        # TEST-API-017: un registro donde cada módulo inventa su etiqueta no se
        # puede consultar.
        with pytest.raises(ValueError):
            audit.append(
                AuditEvent(
                    event_id="e1",
                    action="cosa.rara",
                    actor_id="u1",
                    actor_name="Usuario",
                    occurred_at=NOW,
                    entity="x",
                )
            )
