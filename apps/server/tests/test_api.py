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
        self.history_calls: list[tuple[str, datetime, datetime, int]] = []
        self.series: dict[str, Any] = {
            "points": [
                {"t": "2026-03-01T11:00:00+00:00", "v": 1.0},
                {"t": "2026-03-01T11:30:00+00:00", "v": 2.0},
            ],
            "failed": False,
            "errorMessage": None,
        }

    async def latest(self, spec: MappingSpec) -> dict[str, Any]:
        self.calls.append(spec.mapping_id)
        return self.reading

    async def history(
        self,
        spec: MappingSpec,
        start: datetime,
        end: datetime,
        window_seconds: int,
    ) -> dict[str, Any]:
        self.history_calls.append((spec.mapping_id, start, end, window_seconds))
        return self.series

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


class TestHistorico:
    """Serie histórica de una variable mapeada (X13)."""

    @pytest.fixture()
    def reader(self) -> FakeReader:
        return FakeReader()

    @pytest.fixture()
    def app_client(self, reader: FakeReader, audit: AuditLog) -> TestClient:
        return TestClient(create_app(mappings={MAPPING_ID: SPEC}, reader=reader, audit=audit))

    def test_devuelve_la_serie_con_la_ventana_aplicada(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-018: la gráfica necesita saber con qué agregación se
        # construyó la serie; sin la ventana, el eje de tiempo es ambiguo.
        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2026-03-01T11:00:00Z", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["mappingId"] == MAPPING_ID
        assert len(body["points"]) == 2
        assert body["points"][0]["value"] == 1.0
        assert body["windowSeconds"] >= 1
        assert body["failed"] is False
        assert reader.history_calls[0][0] == MAPPING_ID

    def test_una_variable_no_mapeada_no_llega_al_historiador(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-019: el visor pide por identificador de mapeo. Si pudiera
        # pedir cualquiera, el allowlist del operador no serviría para nada.
        response = app_client.get(
            "/api/v1/telemetry/00000000-0000-4000-8000-00000000ffff/history",
            params={"from": "2026-03-01T11:00:00Z", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 404
        assert reader.history_calls == []

    def test_rechaza_un_intervalo_invertido(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-020: un intervalo al revés produciría una consulta Flux que
        # el historiador rechaza; vale más rechazarla aquí con un motivo.
        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2026-03-01T12:00:00Z", "to": "2026-03-01T11:00:00Z"},
        )

        assert response.status_code == 400
        assert reader.history_calls == []

    def test_rechaza_una_marca_sin_zona_horaria(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-021: interpretarla como hora local del servidor desplazaría
        # la gráfica sin avisar, y el desplazamiento pasaría por un dato raro.
        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2026-03-01T11:00:00", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 400
        assert reader.history_calls == []

    def test_rechaza_un_intervalo_mayor_de_un_ano(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-022: sin tope, un cliente mal escrito puede pedirle al
        # historiador una década de datos y tumbarlo.
        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2020-03-01T11:00:00Z", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 400
        assert reader.history_calls == []

    def test_la_ventana_pedida_no_baja_de_la_recomendada(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-023: el límite tiene que estar en el servidor. Un cliente
        # que pida un año con ventana de un segundo pediría treinta millones de
        # puntos, y la interfaz no es el sitio donde defender al historiador.
        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={
                "from": "2026-01-01T00:00:00Z",
                "to": "2026-03-01T00:00:00Z",
                "window": 1,
            },
        )

        assert response.status_code == 200
        applied = response.json()["windowSeconds"]
        assert applied > 1
        assert reader.history_calls[0][3] == applied

    def test_un_fallo_del_historiador_viaja_marcado(
        self, app_client: TestClient, reader: FakeReader
    ) -> None:
        # TEST-API-024: una serie vacía y una serie que no se pudo recuperar no
        # significan lo mismo. Sin la bandera, la gráfica mostraría un lienzo
        # vacío que se lee como «no hay datos».
        reader.series = {"points": [], "failed": True, "errorMessage": "sin respuesta"}

        response = app_client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2026-03-01T11:00:00Z", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["failed"] is True
        assert body["errorMessage"] == "sin respuesta"
        assert body["points"] == []

    def test_un_servidor_sin_telemetria_contesta_503(self, audit: AuditLog) -> None:
        # TEST-API-025: un servidor que sólo sirve permisos y auditoría es un
        # estado legítimo; lo que no vale es que la gráfica crea que hay datos.
        client = TestClient(create_app(mappings={}, reader=None, audit=audit))
        response = client.get(
            f"/api/v1/telemetry/{MAPPING_ID}/history",
            params={"from": "2026-03-01T11:00:00Z", "to": "2026-03-01T12:00:00Z"},
        )

        assert response.status_code == 503


class TestRevisionesApi:
    """Flujo de revisión por HTTP (X16, X19)."""

    @pytest.fixture()
    def app_client(self, audit: AuditLog) -> TestClient:
        return TestClient(create_app(mappings={}, reader=None, audit=audit))

    @staticmethod
    def _headers(user: str, role: str) -> dict[str, str]:
        return {"x-usuario": user, "x-rol": role, "x-planta": "norte"}

    def _crear(self, client: TestClient, *, sections: dict[str, str] | None = None) -> str:
        response = client.post(
            "/api/v1/revisions",
            headers=self._headers("tecnico", "editor"),
            json={
                "projectId": "planta-norte",
                "summary": "Rótulos de la sala de bombas",
                "sections": sections or {"scene:1": "a1"},
                "contentDigest": "d1",
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["revisionId"]

    def test_el_flujo_completo_por_http(self, app_client: TestClient) -> None:
        # TEST-API-026: la API es la que usarán las integraciones del cliente
        # (X19); el flujo tiene que poder recorrerse sin tocar el almacén.
        revision_id = self._crear(app_client)

        enviar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("tecnico", "editor"),
            json={"action": "submit"},
        )
        assert enviar.json()["state"] == "in_review"

        aprobar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("jefa", "reviewer"),
            json={"action": "approve", "comment": "Conforme"},
        )
        assert aprobar.json()["state"] == "approved"
        assert aprobar.json()["approvedBy"] == "jefa"

        publicar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("jefa", "reviewer"),
            json={"action": "publish"},
        )
        assert publicar.json()["state"] == "published"

    def test_el_autor_que_puede_aprobar_recibe_403(self, app_client: TestClient) -> None:
        # TEST-API-027: la separación de funciones se aplica en el servidor y
        # se distingue del fallo de permisos por el código del cuerpo, no sólo
        # por el texto.
        response = app_client.post(
            "/api/v1/revisions",
            headers=self._headers("jefa", "administrator"),
            json={
                "projectId": "planta-norte",
                "summary": "Cambio propio",
                "sections": {},
                "contentDigest": "d",
            },
        )
        revision_id = response.json()["revisionId"]

        app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("jefa", "administrator"),
            json={"action": "submit"},
        )
        aprobar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("jefa", "administrator"),
            json={"action": "approve"},
        )

        assert aprobar.status_code == 403
        assert aprobar.json()["detail"]["code"] == "separation_of_duties"

    def test_una_transicion_imposible_devuelve_409(self, app_client: TestClient) -> None:
        # TEST-API-028: 409 le dice al cliente «vuelve a leer el estado»; un
        # 400 le haría leer el mensaje para decidir, que es lo que ningún
        # cliente hace bien.
        revision_id = self._crear(app_client)
        aprobar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("jefa", "reviewer"),
            json={"action": "approve"},
        )
        assert aprobar.status_code == 409
        assert aprobar.json()["detail"]["code"] == "invalid_transition"

    def test_un_editor_no_puede_aprobar(self, app_client: TestClient) -> None:
        # TEST-API-029: el permiso se comprueba aquí y no en la interfaz.
        revision_id = self._crear(app_client)
        app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("tecnico", "editor"),
            json={"action": "submit"},
        )
        aprobar = app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("otro", "editor"),
            json={"action": "approve"},
        )
        assert aprobar.status_code == 403
        assert aprobar.json()["detail"]["code"] == "permission_denied"

    def test_la_cola_se_consulta_por_proyecto_y_estado(self, app_client: TestClient) -> None:
        # TEST-API-030: el revisor quiere su cola, no todos los borradores de
        # la planta.
        pendiente = self._crear(app_client)
        app_client.post(
            f"/api/v1/revisions/{pendiente}/actions",
            headers=self._headers("tecnico", "editor"),
            json={"action": "submit"},
        )
        self._crear(app_client)

        cola = app_client.get(
            "/api/v1/revisions",
            headers=self._headers("jefa", "reviewer"),
            params={"projectId": "planta-norte", "state": "in_review"},
        )
        assert cola.status_code == 200
        assert [r["revisionId"] for r in cola.json()["revisions"]] == [pendiente]

    def test_una_revision_inexistente_devuelve_404(self, app_client: TestClient) -> None:
        # TEST-API-031: distinguible de «lo pediste mal».
        response = app_client.post(
            "/api/v1/revisions/00000000-0000-0000-0000-000000000000/actions",
            headers=self._headers("jefa", "reviewer"),
            json={"action": "approve"},
        )
        assert response.status_code == 404

    def test_sin_identidad_no_se_abre_ninguna_revision(self, app_client: TestClient) -> None:
        # TEST-API-032: la identidad llega por cabeceras en esta versión, pero
        # su ausencia no puede significar «anónimo con permisos».
        response = app_client.post(
            "/api/v1/revisions",
            json={"projectId": "p", "summary": "s", "sections": {}, "contentDigest": "d"},
        )
        assert response.status_code in (401, 403)

    def test_las_transiciones_quedan_en_la_auditoria(self, app_client: TestClient) -> None:
        # TEST-API-033: «quién aprobó esto» se responde con el registro, y el
        # registro se lee por la API con su permiso.
        revision_id = self._crear(app_client)
        app_client.post(
            f"/api/v1/revisions/{revision_id}/actions",
            headers=self._headers("tecnico", "editor"),
            json={"action": "submit"},
        )

        # Sin «x-planta»: el registro abarca toda la instalación y una
        # concesión limitada a una planta no puede leerlo, que se comprueba en
        # su propia prueba.
        registro = app_client.get(
            "/api/v1/audit", headers={"x-usuario": "jefa", "x-rol": "administrator"}
        )
        assert registro.status_code == 200
        acciones = [event["action"] for event in registro.json()["events"]]
        assert "revision.created" in acciones
        assert "revision.submitted" in acciones
        assert registro.json()["chainValid"] is True

    def test_una_concesion_con_ambito_no_lee_el_registro_global(self, app_client: TestClient) -> None:
        # TEST-API-034: los eventos del registro no llevan planta, de modo que
        # no se puede recortar por ámbito. Servirlo a quien sólo tiene una
        # planta concedida le mostraría lo que ocurre en las demás, así que se
        # deniega y se dice por qué. Antes se denegaba también, pero con un
        # motivo que hablaba de un recurso que la petición no tenía.
        response = app_client.get(
            "/api/v1/audit", headers=self._headers("jefa", "administrator")
        )

        assert response.status_code == 403
        assert "ámbito" in response.json()["message"]

    def test_un_revisor_con_ambito_si_lista_la_cola(self, app_client: TestClient) -> None:
        # TEST-API-035: es el caso normal en una instalación con varias
        # plantas, y antes quedaba denegado: la comprobación de ámbito se hacía
        # contra un recurso vacío, que ninguna concesión con ámbito cubre.
        self._crear(app_client)
        cola = app_client.get(
            "/api/v1/revisions",
            headers=self._headers("jefa", "reviewer"),
            params={"projectId": "planta-norte"},
        )

        assert cola.status_code == 200
        assert len(cola.json()["revisions"]) == 1


class TestAmbitosDelUsuario:
    """La respuesta de permisos incluye los ámbitos concedidos (P04)."""

    @pytest.fixture()
    def app_client(self, audit: AuditLog) -> TestClient:
        return TestClient(create_app(mappings={}, reader=None, audit=audit))

    def test_sin_restriccion_las_categorias_son_nulas(self, app_client: TestClient) -> None:
        # TEST-API-036: «sin restricción» y «ninguna categoría» son estados
        # distintos. Si una concesión sin categorías devolviera lista vacía, el
        # editor ocultaría todas las notas a un usuario con permisos generales,
        # que es el modo de fallo más desconcertante posible.
        response = app_client.get(
            "/api/v1/me/operations", headers={"x-usuario": "jefa", "x-rol": "administrator"}
        )

        assert response.status_code == 200
        assert response.json()["noteCategoryIds"] is None

    def test_publica_el_ambito_de_cada_concesion(self, app_client: TestClient) -> None:
        # TEST-API-037: el editor necesita los ámbitos para recortar lo que
        # muestra; con sólo la lista de operaciones no puede saber de qué
        # planta ni de qué categorías de nota se trata.
        response = app_client.get(
            "/api/v1/me/operations",
            headers={"x-usuario": "tecnico", "x-rol": "editor", "x-planta": "norte"},
        )

        scopes = response.json()["scopes"]
        assert len(scopes) == 1
        assert scopes[0]["plantId"] == "norte"
        assert scopes[0]["role"] == "editor"

    def test_la_lista_de_operaciones_sigue_estando(self, app_client: TestClient) -> None:
        # TEST-API-038: la respuesta ya se usaba para ocultar acciones; añadir
        # campos no puede romper a quien sólo lee los que había.
        response = app_client.get(
            "/api/v1/me/operations", headers={"x-usuario": "tecnico", "x-rol": "editor"}
        )

        body = response.json()
        assert "project.update" in body["operations"]
        assert body["total"] > 0
        assert "aviso" in body
