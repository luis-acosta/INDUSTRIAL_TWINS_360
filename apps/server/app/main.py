"""API del servidor de INDUSTRIAL TWINS 360.

Dos clientes y dos superficies distintas:

- El **visor publicado** pide lecturas de telemetría por identificador de
  mapeo. No se autentica: el recorrido puede estar en una intranet abierta, y
  lo que devuelve esta superficie son valores de proceso de sólo lectura que ya
  están en el recorrido. No puede listar mapeos ni alcanzar series que el
  recorrido no publique.
- La **aplicación de escritorio y los administradores** usan el resto, que
  exige identidad y comprueba permisos por operación y por ámbito.

El servidor no sirve el recorrido. Eso lo hace un servidor web estático o el
propio paquete: mantener los dos oficios separados permite publicar un
recorrido sin desplegar nada.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .access_model import MODEL_FINGERPRINT, OPERATIONS
from .audit import AuditEvent, AuditLog
from .security import AccessError, Grant, Resource, Scope, can_perform, effective_operations
from .telemetry import (
    MappingSpec,
    assess_quality,
    valid_mapping_ids,
)

API_PREFIX = "/api/v1"


class SampleOut(BaseModel):
    """Lectura tal como la recibe el visor.

    Coincide campo por campo con el esquema del dominio: el visor la valida al
    recibirla, y una diferencia de nombres aquí se traduciría en muestras
    descartadas allí.
    """

    mappingId: str
    value: float | None
    rawValue: str | None = None
    sourceTimestamp: str | None
    fetchedAt: str
    quality: str
    errorMessage: str | None = None
    fromCache: bool = False


class LatestIn(BaseModel):
    """Petición del visor: identificadores y nada más."""

    mappingIds: list[str] = Field(min_length=1, max_length=200)


class HealthOut(BaseModel):
    status: str
    environment: str
    #: Huella del modelo de permisos, para detectar un servidor desalineado.
    accessModel: str
    telemetryConfigured: bool


def create_app(
    *,
    mappings: dict[str, MappingSpec] | None = None,
    reader: Any | None = None,
    audit: AuditLog | None = None,
    environment: str = "test",
    allowed_origins: tuple[str, ...] = (),
) -> FastAPI:
    """Construye la aplicación.

    Las dependencias se inyectan en lugar de leerse de un módulo global para
    que las pruebas puedan ejercitar las rutas sin PostgreSQL ni historiador.
    No es sólo comodidad de prueba: un servidor cuyas rutas sólo se pueden
    ejercitar con la infraestructura completa termina sin pruebas.
    """
    known_mappings = mappings or {}
    audit_log = audit or AuditLog()

    app = FastAPI(
        title="INDUSTRIAL TWINS 360",
        version="0.14.0",
        description=(
            "API del servidor. La telemetría es de sólo lectura por construcción: "
            "no existe ninguna ruta de escritura hacia el historiador ni hacia el PLC."
        ),
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
    )

    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(allowed_origins),
            # Sin credenciales: el visor no tiene sesión, y permitirlas abriría
            # la puerta a que una página de terceros use la del navegador.
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["content-type"],
        )

    @app.exception_handler(AccessError)
    async def access_denied(request: Request, error: AccessError) -> JSONResponse:
        """Deniega y lo registra.

        El registro del intento denegado es la mitad del valor de un sistema de
        permisos: sin él, nadie se entera de que alguien está probando puertas.
        """
        audit_log.append(
            AuditEvent(
                event_id=f"denied-{len(audit_log.events) + 1}",
                action="access.denied",
                actor_id=request.headers.get("x-usuario", "anónimo"),
                actor_name=request.headers.get("x-usuario-nombre", "anónimo"),
                occurred_at=datetime.now(timezone.utc),
                entity="api",
                entity_id=str(request.url.path),
                detail={"operation": error.operation, "reason": error.reason},
            )
        )
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"code": "PERMISSION_DENIED", "message": error.reason, "operation": error.operation},
        )

    # ------------------------------------------------------------------ #
    # Estado
    # ------------------------------------------------------------------ #

    @app.get(f"{API_PREFIX}/health", response_model=HealthOut, tags=["estado"])
    async def health() -> HealthOut:
        return HealthOut(
            status="ok",
            environment=environment,
            accessModel=MODEL_FINGERPRINT,
            telemetryConfigured=reader is not None and bool(known_mappings),
        )

    # ------------------------------------------------------------------ #
    # Telemetría: superficie del visor publicado
    # ------------------------------------------------------------------ #

    @app.post(f"{API_PREFIX}/telemetry/latest", response_model=list[SampleOut], tags=["telemetría"])
    async def telemetry_latest(payload: LatestIn) -> list[SampleOut]:
        """Última lectura de cada variable solicitada.

        Los identificadores desconocidos no se ignoran en silencio: se
        devuelven como muestras en estado ``missing`` con el motivo. Un visor
        que pide una variable que el servidor no tiene mapeada está
        desincronizado con el recorrido, y eso hay que poder verlo desde el
        navegador.
        """
        if reader is None or not known_mappings:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Este servidor no tiene telemetría configurada",
            )

        valid, unknown = valid_mapping_ids(payload.mappingIds, known_mappings)
        now = datetime.now(timezone.utc)
        out: list[SampleOut] = []

        for mapping_id in valid:
            spec = known_mappings[mapping_id]
            reading = await reader.latest(spec)

            out.append(
                SampleOut(
                    mappingId=mapping_id,
                    value=reading.get("value"),
                    rawValue=reading.get("rawValue"),
                    sourceTimestamp=_iso(reading.get("sourceTimestamp")),
                    fetchedAt=now.isoformat(),
                    quality=assess_quality(
                        value=reading.get("value"),
                        raw_value=reading.get("rawValue"),
                        source_timestamp=reading.get("sourceTimestamp"),
                        freshness_seconds=spec.freshness_seconds,
                        now=now,
                        failed=reading.get("failed", False),
                    ),
                    errorMessage=reading.get("errorMessage"),
                    fromCache=reading.get("fromCache", False),
                )
            )

        for mapping_id in unknown:
            out.append(
                SampleOut(
                    mappingId=mapping_id,
                    value=None,
                    rawValue=None,
                    sourceTimestamp=None,
                    fetchedAt=now.isoformat(),
                    quality="missing",
                    errorMessage="El servidor no tiene esta variable mapeada",
                )
            )

        return out

    @app.get(f"{API_PREFIX}/telemetry/ping", tags=["telemetría"])
    async def telemetry_ping() -> dict[str, object]:
        """Comprueba que el historiador responde, sin traer datos."""
        if reader is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Este servidor no tiene telemetría configurada",
            )
        return await reader.ping()

    # ------------------------------------------------------------------ #
    # Superficie autenticada
    # ------------------------------------------------------------------ #

    async def current_grants(
        usuario: str | None = Header(default=None, alias="x-usuario"),
        rol: str | None = Header(default=None, alias="x-rol"),
        planta: str | None = Header(default=None, alias="x-planta"),
    ) -> list[Grant]:
        """Concesiones del usuario de la petición.

        En esta versión la identidad llega por cabeceras, que es lo que permite
        desarrollar y probar contra el servidor sin un proveedor de identidad
        montado. **No es autenticación**: la integración con el directorio del
        cliente —LDAP o SSO— sustituye esta función y es la parte pendiente de
        la etapa 11. Se deja escrito aquí y no en un documento aparte para que
        nadie despliegue esto creyendo que valida algo.
        """
        if usuario is None or rol is None:
            raise AccessError(
                "La petición no identifica al usuario", operation="project.read"
            )
        return [Grant(user_id=usuario, role=rol, scope=Scope(plant_id=planta))]

    @app.get(f"{API_PREFIX}/me/operations", tags=["acceso"])
    async def my_operations(
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Operaciones que el usuario puede ejecutar en algún ámbito.

        La interfaz la usa para ocultar lo que no se puede hacer. No sustituye
        a la comprobación por recurso, y la respuesta lo dice.
        """
        operations = sorted(effective_operations(grants))
        return {
            "operations": operations,
            "total": len(OPERATIONS),
            "aviso": (
                "Esta lista es por rol, no por recurso: una operación puede estar "
                "permitida en una unidad y no en otra."
            ),
        }

    @app.get(f"{API_PREFIX}/audit", tags=["acceso"])
    async def read_audit(
        limit: int = 100,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Lee el registro de auditoría. Exige el permiso correspondiente."""
        decision = can_perform(operation="audit.read", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="audit.read")

        events = audit_log.events[-max(1, min(limit, 1000)) :]
        valid, broken_at = audit_log.verify_chain()

        return {
            "events": [
                {
                    "eventId": event.event_id,
                    "action": event.action,
                    "actorId": event.actor_id,
                    "actorName": event.actor_name,
                    "occurredAt": event.occurred_at.isoformat(),
                    "entity": event.entity,
                    "entityId": event.entity_id,
                    "detail": event.detail,
                    "eventHash": event.digest(),
                }
                for event in events
            ],
            "chainValid": valid,
            "chainBrokenAt": broken_at,
        }

    @app.post(f"{API_PREFIX}/access/check", tags=["acceso"])
    async def check_access(
        operation: str,
        plant_id: str | None = None,
        unit_id: str | None = None,
        area_id: str | None = None,
        note_category_id: str | None = None,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Comprueba una operación concreta sobre un recurso concreto.

        Es la ruta que usa la aplicación antes de ofrecer una acción cuyo
        permiso depende del ámbito. Devuelve el motivo además de la decisión:
        «no puedes» sin explicación genera un ticket de soporte.
        """
        decision = can_perform(
            operation=operation,
            grants=grants,
            resource=Resource(
                plant_id=plant_id,
                unit_id=unit_id,
                area_id=area_id,
                note_category_id=note_category_id,
            ),
        )
        return {"allowed": decision.allowed, "reason": decision.reason, "viaRole": decision.via_role}

    app.state.audit_log = audit_log
    app.state.mappings = known_mappings
    return app


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat()
    return str(value)
