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

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .access_model import MODEL_FINGERPRINT, OPERATIONS
from .audit import AuditEvent, AuditLog
from .security import (
    AccessError,
    Grant,
    Resource,
    Scope,
    can_perform,
    can_perform_anywhere,
    effective_operations,
    is_global,
)
from .config import load_mappings, load_settings
from .influx import InfluxReader
from .review import ReviewError, ReviewStore, Revision
from .telemetry import (
    MappingSpec,
    TelemetryReader,
    assess_quality,
    recommended_window_seconds,
    valid_mapping_ids,
)

API_PREFIX = "/api/v1"

#: Intervalo máximo que se acepta en una consulta de histórico.
#:
#: Un año y un día: cubre la comparación interanual, que es el caso más amplio
#: que un responsable de planta pide, y acota lo que un cliente mal escrito
#: puede exigirle al historiador.
MAX_RANGE_SECONDS = 366 * 24 * 3600

#: Ventana de agregación máxima: un día. Más gruesa no es una gráfica.
MAX_WINDOW_SECONDS = 24 * 3600


class HistoryPointOut(BaseModel):
    """Un punto agregado de la serie."""

    timestamp: str | None
    value: float | str | None


class HistoryOut(BaseModel):
    """Serie histórica tal como la consume la gráfica del editor.

    ``windowSeconds`` y ``fromCache`` no son adornos: sin el primero el eje de
    tiempo es ambiguo, y sin el segundo la gráfica presentaría caché como
    telemetría actual.
    """

    mappingId: str
    points: list[HistoryPointOut]
    windowSeconds: int
    fromCache: bool = False
    failed: bool = False
    errorMessage: str | None = None


class RevisionIn(BaseModel):
    """Borrador que abre un autor.

    Se piden los resúmenes por sección y no el proyecto: el servicio coordina
    la revisión y no guarda el trabajo de nadie, que es el diseño local-first
    del producto. Con los resúmenes basta para detectar solapes (X17).
    """

    projectId: str = Field(min_length=1, max_length=64)
    summary: str = Field(min_length=1, max_length=2000)
    sections: dict[str, str] = Field(default_factory=dict)
    contentDigest: str = Field(min_length=1, max_length=128)


class RevisionActionIn(BaseModel):
    """Transición pedida sobre una revisión."""

    action: str = Field(min_length=1, max_length=32)
    comment: str = Field(default="", max_length=2000)


class ConflictOut(BaseModel):
    """Sección que dos revisiones cambiaron de forma distinta."""

    section: str
    base: str | None
    incoming: str
    published: str | None


class RevisionOut(BaseModel):
    """Estado de una revisión."""

    revisionId: str
    projectId: str
    authorId: str
    state: str
    summary: str
    baseRevisionId: str | None
    approvedBy: str | None
    comments: list[str]
    createdAt: str
    updatedAt: str
    conflicts: list[ConflictOut] = Field(default_factory=list)


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
    reader: TelemetryReader | None = None,
    audit: AuditLog | None = None,
    reviews: ReviewStore | None = None,
    environment: str = "test",
    allowed_origins: tuple[str, ...] = (),
) -> FastAPI:
    """Construye la aplicación.

    Las dependencias se inyectan en lugar de leerse de un módulo global para
    que las pruebas puedan ejercitar las rutas sin PostgreSQL ni historiador.
    No es sólo comodidad de prueba: un servidor cuyas rutas sólo se pueden
    ejercitar con la infraestructura completa termina sin pruebas.
    """
    """La configuración se lee del entorno cuando no se inyecta nada.

    Hace falta porque la forma documentada de arrancar el servidor es
    «uvicorn app.main:create_app --factory», que llama a esta función **sin
    argumentos**: así, en producción no había lector ni variables y los
    extremos de telemetría contestaban 503 siempre, mientras las pruebas
    pasaban porque inyectan los suyos.
    """
    if mappings is None and reader is None:
        settings = load_settings()
        known_mappings = load_mappings()
        reader = (
            InfluxReader(settings.influx, cache_max_age_seconds=settings.telemetry_cache_seconds)
            if settings.influx is not None
            else None
        )
        if not allowed_origins:
            allowed_origins = settings.allowed_origins
        if environment == "test":
            environment = settings.environment
    else:
        known_mappings = mappings or {}

    audit_log = audit or AuditLog()
    review_store = reviews or ReviewStore(audit_log)

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

    @app.get(
        f"{API_PREFIX}/telemetry/{{mapping_id}}/history",
        response_model=HistoryOut,
        tags=["telemetría"],
    )
    async def telemetry_history(
        mapping_id: str,
        from_: str = Query(alias="from"),
        to: str = Query(...),
        window: int | None = Query(default=None, ge=1, le=MAX_WINDOW_SECONDS),
    ) -> HistoryOut:
        """Serie histórica agregada de una variable mapeada (X13).

        El intervalo lo elige quien mira la gráfica, pero la ventana de
        agregación la decide el servidor cuando no viene dada: un mes a
        resolución de segundo son millones de puntos que no caben ni en la red
        ni en los píxeles del lienzo. La ventana que se usó viaja en la
        respuesta porque el eje de la gráfica no significa lo mismo con
        agregados de diez segundos que de una hora, y quien la lee debe
        saberlo.
        """
        if reader is None or not known_mappings:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Este servidor no tiene telemetría configurada",
            )

        spec = known_mappings.get(mapping_id)
        if spec is None:
            # Igual que en «latest», el visor pide por identificador de mapeo y
            # no por medición: un identificador que no está en el allowlist no
            # se busca en el historiador.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="El servidor no tiene esta variable mapeada",
            )

        start = _parse_instant(from_, "from")
        end = _parse_instant(to, "to")
        if end <= start:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El fin del intervalo debe ser posterior al inicio",
            )
        if (end - start) > timedelta(seconds=MAX_RANGE_SECONDS):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El intervalo solicitado excede el máximo de 366 días",
            )

        # La ventana pedida nunca manda por debajo de la recomendada: un
        # cliente que pida un año con ventana de un segundo tumbaría el
        # historiador, y el límite tiene que estar aquí y no en la interfaz.
        recommended = recommended_window_seconds(start, end)
        window_seconds = recommended if window is None else max(window, recommended)

        series = await reader.history(spec, start, end, window_seconds)
        points = [
            HistoryPointOut(timestamp=point.get("t"), value=point.get("v"))
            for point in series.get("points", [])
            if isinstance(point, dict)
        ]

        return HistoryOut(
            mappingId=mapping_id,
            points=points,
            windowSeconds=window_seconds,
            fromCache=bool(series.get("fromCache", False)),
            failed=bool(series.get("failed", False)),
            errorMessage=series.get("errorMessage"),
        )

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
        decision = can_perform_anywhere(operation="audit.read", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="audit.read")

        # El registro es de toda la instalación y sus eventos no llevan planta,
        # de modo que no se puede recortar por ámbito. Servirlo a quien sólo
        # tiene concedida una planta le mostraría lo que pasa en las demás, así
        # que se deniega con el motivo en lugar de devolver de más. Recortarlo
        # exige que los eventos lleven ámbito, que es trabajo del propio
        # registro y no de esta ruta.
        if not any(is_global(grant) for grant in grants):
            raise AccessError(
                "El registro de auditoría abarca toda la instalación: su concesión "
                "está limitada a un ámbito y todavía no se puede recortar el registro por ámbito",
                operation="audit.read",
            )

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

    @app.post(f"{API_PREFIX}/revisions", response_model=RevisionOut, tags=["revisión"])
    async def create_revision(
        body: RevisionIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> RevisionOut:
        """Abre un borrador sobre la última revisión publicada (X16)."""
        actor = grants[0].user_id
        try:
            revision = review_store.create(
                project_id=body.projectId,
                author_id=actor,
                summary=body.summary,
                sections=dict(body.sections),
                content_digest=body.contentDigest,
                allowed_operations=effective_operations(grants),
            )
        except ReviewError as error:
            raise _review_http(error) from error
        return _revision_out(revision, review_store)

    @app.get(f"{API_PREFIX}/revisions", tags=["revisión"])
    async def list_revisions(
        projectId: str = Query(min_length=1, max_length=64),
        state: str | None = Query(default=None, max_length=32),
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Cola de revisión de un proyecto."""
        # Sin recurso: la cola es de un proyecto, y este servicio no sabe a qué
        # planta pertenece cada proyecto, de modo que no hay ámbito que
        # comprobar. Comprobarlo contra un recurso vacío denegaría a todo
        # usuario con ámbito, que son casi todos.
        decision = can_perform_anywhere(operation="project.read", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="project.read")

        revisions = review_store.list_for_project(projectId, state=state)
        return {
            "revisions": [_revision_out(revision, review_store).model_dump() for revision in revisions],
            "published": (
                None
                if review_store.published_revision(projectId) is None
                else review_store.published_revision(projectId).revision_id  # type: ignore[union-attr]
            ),
        }

    @app.post(
        f"{API_PREFIX}/revisions/{{revision_id}}/actions",
        response_model=RevisionOut,
        tags=["revisión"],
    )
    async def act_on_revision(
        revision_id: str,
        body: RevisionActionIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> RevisionOut:
        """Aplica una transición: enviar, aprobar, pedir cambios, publicar o retirar.

        Una sola ruta para las cinco acciones porque las cinco comparten
        exactamente las mismas comprobaciones —estado, permiso y separación de
        funciones— y repartirlas en cinco rutas es la forma de que una de ellas
        acabe sin una de las tres.
        """
        actor = grants[0].user_id
        try:
            revision = review_store.act(
                revision_id=revision_id,
                action=body.action,
                actor_id=actor,
                allowed_operations=effective_operations(grants),
                comment=body.comment,
            )
        except ReviewError as error:
            raise _review_http(error) from error
        return _revision_out(revision, review_store)

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


def _revision_out(revision: Revision, store: ReviewStore) -> RevisionOut:
    """Pasa una revisión a la respuesta, con sus conflictos al día.

    Los conflictos se calculan al responder y no al guardar: lo publicado puede
    haber cambiado desde entonces, y un conflicto caducado es peor que ninguno
    porque manda a resolver algo que ya no existe.
    """
    return RevisionOut(
        revisionId=revision.revision_id,
        projectId=revision.project_id,
        authorId=revision.author_id,
        state=revision.state,
        summary=revision.summary,
        baseRevisionId=revision.base_revision_id,
        approvedBy=revision.approved_by,
        comments=list(revision.comments),
        createdAt=revision.created_at.isoformat(),
        updatedAt=revision.updated_at.isoformat(),
        conflicts=[
            ConflictOut(
                section=conflict.section,
                base=conflict.base,
                incoming=conflict.incoming,
                published=conflict.published,
            )
            for conflict in store.conflicts_for(revision)
        ],
    )


def _review_http(error: ReviewError) -> HTTPException:
    """Traduce el motivo del rechazo al código HTTP que le corresponde.

    La distinción no es cosmética: un 409 le dice al cliente «vuelve a leer y
    reintenta», y un 403 «no insistas». Devolver 400 para todo obliga a leer el
    texto del mensaje para decidir, que es lo que ningún cliente hace bien.
    """
    codes = {
        "not_found": status.HTTP_404_NOT_FOUND,
        "permission_denied": status.HTTP_403_FORBIDDEN,
        "separation_of_duties": status.HTTP_403_FORBIDDEN,
        "invalid_transition": status.HTTP_409_CONFLICT,
        "conflict": status.HTTP_409_CONFLICT,
        "summary_required": status.HTTP_400_BAD_REQUEST,
        "unknown_action": status.HTTP_400_BAD_REQUEST,
    }
    return HTTPException(
        status_code=codes.get(error.code, status.HTTP_400_BAD_REQUEST),
        detail={"code": error.code, "message": error.reason},
    )


def _parse_instant(raw: str, field: str) -> datetime:
    """Instante ISO-8601 del cliente, siempre con zona.

    Una marca sin zona no es un instante: interpretarla como hora local del
    servidor desplazaría la gráfica tantas horas como separen al servidor del
    operador, y el desplazamiento pasaría por un dato raro en lugar de por un
    error. Así que se rechaza.
    """
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"«{field}» no es un instante ISO-8601 válido",
        ) from error

    if parsed.tzinfo is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"«{field}» debe indicar la zona horaria",
        )
    return parsed.astimezone(timezone.utc)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat()
    return str(value)
