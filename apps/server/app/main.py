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
    is_active,
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
from .notes import (
    AUDIT_ACTION as NOTE_AUDIT_ACTION,
    FIELD_STATUSES,
    NoteError,
    NoteStore,
    ServedNote,
)
from .notify import (
    NotificationQueue,
    NotifyError,
    SmtpMailer,
    compose,
    is_address,
)
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


class NoteCommentIn(BaseModel):
    """Comentario que se añade a una nota desde un cliente móvil (P09)."""

    body: str = Field(min_length=1, max_length=5000)
    #: Nombre con el que firma. Si falta, se firma con el identificador: una
    #: nota sin firma no sirve para preguntarle nada a nadie después.
    authorName: str = Field(default="", max_length=200)


class NoteStatusIn(BaseModel):
    """Estado de trabajo que se pide (P09)."""

    status: str = Field(min_length=1, max_length=32)


class NoteLoadItem(BaseModel):
    """Nota tal como la entrega la aplicación de escritorio (P09)."""

    id: str = Field(min_length=1, max_length=64)
    title: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=20000)
    categoryId: str = Field(default="", max_length=64)
    status: str = Field(default="open", max_length=32)
    priority: str = Field(default="normal", max_length=32)
    sceneId: str | None = None
    assetId: str | None = None
    assigneeId: str | None = None
    assigneeName: str | None = None
    dueDate: str | None = None
    updatedAt: str = Field(default="", max_length=64)


class NotesLoadIn(BaseModel):
    projectId: str = Field(min_length=1, max_length=64)
    notes: list[NoteLoadItem] = Field(default_factory=list)


class NotifyIn(BaseModel):
    """Aviso que se pide mandar (P07).

    Lleva el título de la nota porque quien llama ya lo tiene a mano, y el
    compositor lo descarta a propósito: el correo no publica el contenido de una
    nota de planta.
    """

    reason: str = Field(min_length=1, max_length=48)
    noteId: str = Field(default="", max_length=64)
    recipientId: str = Field(min_length=1, max_length=120)
    recipientAddress: str = Field(min_length=3, max_length=320)
    recipientName: str = Field(default="", max_length=200)
    projectTitle: str = Field(min_length=1, max_length=200)
    plant: str | None = None
    priority: str = Field(default="normal", max_length=32)
    noteTitle: str = Field(default="", max_length=200)
    link: str | None = None


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
    notes_store: NoteStore | None = None,
    notifications: NotificationQueue | None = None,
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
    settings = None
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
    note_store = notes_store or NoteStore()

    # Cola de avisos por correo (P07). Sin SMTP configurado se construye igual:
    # los avisos se encolan y se declaran no entregados, que es lo honesto.
    # Aceptarlos y perderlos haría creer avisado a quien no lo está.
    if notifications is not None:
        notify_queue = notifications
    elif settings is not None and settings.smtp is not None:
        notify_queue = NotificationQueue(
            sender=settings.smtp.sender,
            mailer=SmtpMailer(
                host=settings.smtp.host,
                port=settings.smtp.port,
                use_tls=settings.smtp.use_tls,
                username=settings.smtp.username,
                password=settings.smtp.password,
                timeout_seconds=settings.smtp.timeout_seconds,
            ),
        )
    else:
        notify_queue = NotificationQueue()

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
        categorias: str | None = Header(default=None, alias="x-categorias-nota"),
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
        # Las categorías de nota concedidas viajan como el resto del ámbito y
        # con la misma advertencia: esto no autentica nada. Vacío o ausente
        # significa «sin restricción», igual que en todo el modelo de acceso.
        note_categories = frozenset(
            part.strip() for part in (categorias or "").split(",") if part.strip()
        )
        return [
            Grant(
                user_id=usuario,
                role=rol,
                scope=Scope(plant_id=planta, note_category_ids=note_categories),
            )
        ]

    @app.get(f"{API_PREFIX}/me/operations", tags=["acceso"])
    async def my_operations(
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Operaciones que el usuario puede ejecutar en algún ámbito.

        La interfaz la usa para ocultar lo que no se puede hacer. No sustituye
        a la comprobación por recurso, y la respuesta lo dice.
        """
        operations = sorted(effective_operations(grants))
        moment = datetime.now(timezone.utc)
        active = [grant for grant in grants if is_active(grant, moment)]

        # Las categorías de nota concedidas (P04).
        #
        # Hacen falta en la respuesta porque las notas viven en el proyecto del
        # equipo del autor —el diseño local-first del producto— y es el editor
        # quien tiene que ocultar las que el usuario no puede ver. Sin esta
        # lista, el editor no tiene con qué filtrar y la restricción por
        # categoría quedaba declarada en el modelo y sin aplicarse en ninguna
        # parte.
        #
        # Una concesión sin categorías no está restringida, igual que en
        # `scope_covers`: el conjunto vacío significa «todas». Si aquí
        # significara «ninguna», un usuario con permisos generales se quedaría
        # sin ver nota alguna.
        unrestricted = any(not grant.scope.note_category_ids for grant in active)
        categories: set[str] = set()
        for grant in active:
            categories.update(grant.scope.note_category_ids)

        return {
            "operations": operations,
            "total": len(OPERATIONS),
            "scopes": [
                {
                    "role": grant.role,
                    "plantId": grant.scope.plant_id,
                    "unitId": grant.scope.unit_id,
                    "areaId": grant.scope.area_id,
                    "noteCategoryIds": sorted(grant.scope.note_category_ids),
                }
                for grant in active
            ],
            # `null` significa «sin restricción por categoría»; una lista, las
            # únicas que puede ver. Se distingue del array vacío a propósito:
            # vacío sería «ninguna», que es un estado legítimo y distinto.
            "noteCategoryIds": None if unrestricted else sorted(categories),
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

    @app.get(f"{API_PREFIX}/notes", tags=["notas"])
    async def list_notes(
        projectId: str = Query(min_length=1, max_length=64),
        status: str | None = Query(default=None, max_length=32),
        sceneId: str | None = Query(default=None, max_length=64),
        mine: bool = Query(default=False),
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Notas que esta identidad puede ver (P09).

        El recorte por categoría se hace **aquí** y no en la interfaz. Que el
        editor lo haga en su pantalla está bien para no mostrar lo que no toca;
        que sea lo único que lo haga significa que cualquiera que llame a la API
        lo salta, y entonces el ámbito por categoría no protege nada.
        """
        actor = grants[0].user_id
        try:
            notes = note_store.list_for_project(
                projectId,
                allowed_operations=effective_operations(grants),
                allowed_categories=_allowed_categories(grants),
                status=status,
                scene_id=sceneId,
                assignee_id=actor if mine else None,
            )
        except NoteError as error:
            raise _note_http(error) from error

        return {
            "notes": [_note_out(note) for note in notes],
            # Los estados que este cliente puede poner, para que la interfaz no
            # tenga que repetir la regla y acabe ofreciendo uno que el servicio
            # rechaza.
            "fieldStatuses": list(FIELD_STATUSES),
        }

    @app.post(f"{API_PREFIX}/notes/{{note_id}}/comments", tags=["notas"])
    async def comment_note(
        note_id: str,
        body: NoteCommentIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Añade un comentario a una nota (P09)."""
        actor = grants[0].user_id
        try:
            note = note_store.add_comment(
                note_id,
                author_id=actor,
                author_name=body.authorName or actor,
                body=body.body,
                allowed_operations=effective_operations(grants),
                allowed_categories=_allowed_categories(grants),
            )
        except NoteError as error:
            raise _note_http(error) from error

        audit_log.append(
            AuditEvent(
                event_id=f"note-comment-{len(audit_log.events) + 1}",
                action=NOTE_AUDIT_ACTION["comment"],
                actor_id=actor,
                actor_name=body.authorName or actor,
                occurred_at=datetime.now(timezone.utc),
                entity="note",
                entity_id=note_id,
                detail={"comments": len(note.comments), "client": "mobile"},
            )
        )
        return {"note": _note_out(note)}

    @app.post(f"{API_PREFIX}/notes/{{note_id}}/status", tags=["notas"])
    async def set_note_status(
        note_id: str,
        body: NoteStatusIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Mueve la nota entre los estados de trabajo (P09).

        Resolver y archivar no están: resolver exige escribir cómo se resolvió y
        archivar es una decisión del responsable del proyecto. Permitirlos aquí
        convertiría «ya está» en un toque de pantalla y la nota se cerraría sin
        que nadie pueda saber después qué se hizo.
        """
        actor = grants[0].user_id
        try:
            note = note_store.set_status(
                note_id,
                status=body.status,
                allowed_operations=effective_operations(grants),
                allowed_categories=_allowed_categories(grants),
            )
        except NoteError as error:
            raise _note_http(error) from error

        audit_log.append(
            AuditEvent(
                event_id=f"note-status-{len(audit_log.events) + 1}",
                action=NOTE_AUDIT_ACTION["status"],
                actor_id=actor,
                actor_name=actor,
                occurred_at=datetime.now(timezone.utc),
                entity="note",
                entity_id=note_id,
                detail={"status": note.status, "client": "mobile"},
            )
        )
        return {"note": _note_out(note)}

    @app.put(f"{API_PREFIX}/notes", tags=["notas"])
    async def load_notes(
        body: NotesLoadIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Carga las notas de un proyecto en el servicio (P09).

        La llama la aplicación de escritorio al abrir el proyecto: el servicio
        no lee archivos de proyecto —no sabe dónde están ni debe— así que su
        copia es la que le entrega quien sí lo tiene. Exige `project.update`
        porque sustituye lo que el servicio sirve: con `note.read` bastando,
        cualquiera que pueda leer podría vaciar la lista de los demás.
        """
        decision = can_perform_anywhere(operation="project.update", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="project.update")

        note_store.replace_project(
            body.projectId,
            [
                ServedNote(
                    note_id=note.id,
                    project_id=body.projectId,
                    title=note.title,
                    body=note.body,
                    category_id=note.categoryId,
                    status=note.status,
                    priority=note.priority,
                    scene_id=note.sceneId,
                    asset_id=note.assetId,
                    assignee_id=note.assigneeId,
                    assignee_name=note.assigneeName,
                    due_date=note.dueDate,
                    updated_at=note.updatedAt,
                )
                for note in body.notes
            ],
        )
        return {"loaded": len(body.notes)}

    @app.post(f"{API_PREFIX}/notifications", tags=["avisos"])
    async def notify(
        body: NotifyIn,
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Encola un aviso y lo intenta entregar (P07).

        Exige `note.assign`: avisar es parte de asignar trabajo, y quien no
        puede asignar no debería poder mandar correos en nombre del proyecto.

        La respuesta dice si **se entregó**, no si se aceptó. Sin servidor de
        correo configurado, `delivered` es cero y `pending` dice cuántos
        esperan: quien asigna tiene que poder saber que nadie ha sido avisado.
        """
        decision = can_perform_anywhere(operation="note.assign", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="note.assign")

        if not is_address(body.recipientAddress):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "BAD_ADDRESS",
                    "message": "La dirección de correo del destinatario no es válida.",
                },
            )

        try:
            subject, text = compose(
                reason=body.reason,
                recipient_name=body.recipientName or body.recipientId,
                project_title=body.projectTitle,
                plant=body.plant,
                priority=body.priority,
                note_title=body.noteTitle,
                link=body.link,
            )
            notify_queue.enqueue(
                reason=body.reason,
                recipient_id=body.recipientId,
                recipient_address=body.recipientAddress,
                subject=subject,
                body=text,
            )
        except NotifyError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": error.code, "message": str(error)},
            ) from error

        delivered, pending = notify_queue.flush()

        audit_log.append(
            AuditEvent(
                event_id=f"notify-{len(audit_log.events) + 1}",
                action="notification.sent" if delivered > 0 else "notification.queued",
                actor_id=grants[0].user_id,
                actor_name=grants[0].user_id,
                occurred_at=datetime.now(timezone.utc),
                entity="note",
                entity_id=body.noteId,
                # El identificador del destinatario, no su dirección: el
                # registro es de sólo añadir y se exporta, y una dirección
                # personal dentro no se puede retirar después.
                detail={"reason": body.reason, "recipientId": body.recipientId},
            )
        )

        return {"delivered": delivered, "pending": pending}

    @app.get(f"{API_PREFIX}/notifications", tags=["avisos"])
    async def notifications_state(
        grants: list[Grant] = Depends(current_grants),
    ) -> dict[str, object]:
        """Estado de la cola de avisos, sin direcciones (P07).

        Lo consulta un administrador para saber si los avisos están saliendo.
        Que un despliegue sin correo se note es la mitad del valor de esto.
        """
        decision = can_perform_anywhere(operation="audit.read", grants=grants)
        if not decision.allowed:
            raise AccessError(decision.reason, operation="audit.read")

        return {
            "configured": notify_queue.mailer is not None,
            "pending": notify_queue.pending_count(),
            "notifications": notify_queue.redacted(),
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


def _allowed_categories(grants: list[Grant]) -> tuple[str, ...] | None:
    """Categorías de nota que estas concesiones permiten ver (P09).

    `None` es «sin restricción», y lo decide una sola concesión sin categorías:
    el conjunto vacío significa «todas» en todo el modelo de acceso, igual que
    en `scope_covers`. Si aquí significara «ninguna», un administrador con
    permisos generales se quedaría sin ver una sola nota.
    """
    now = datetime.now(timezone.utc)
    active = [grant for grant in grants if is_active(grant, now)]
    if any(not grant.scope.note_category_ids for grant in active):
        return None

    categories: set[str] = set()
    for grant in active:
        categories.update(grant.scope.note_category_ids)
    return tuple(sorted(categories))


def _note_out(note: ServedNote) -> dict[str, object]:
    """Nota tal como la ve un cliente móvil.

    No lleva los adjuntos: en una pantalla de teléfono y con la red de una
    planta, una lista que arrastra fotografías no acaba de cargar. Se piden al
    abrir la nota, cuando exista esa pantalla.
    """
    return {
        "id": note.note_id,
        "title": note.title,
        "body": note.body,
        "categoryId": note.category_id,
        "status": note.status,
        "priority": note.priority,
        "sceneId": note.scene_id,
        "assetId": note.asset_id,
        "assigneeId": note.assignee_id,
        "assigneeName": note.assignee_name,
        "dueDate": note.due_date,
        "updatedAt": note.updated_at,
        "comments": [
            {
                "id": comment.comment_id,
                "authorId": comment.author_id,
                "authorName": comment.author_name,
                "body": comment.body,
                "createdAt": comment.created_at,
            }
            for comment in note.comments
        ],
    }


def _note_http(error: NoteError) -> HTTPException:
    """Código HTTP del fallo de una nota.

    «No existe» y «no puede verla» comparten el 404 a propósito: distinguirlos
    diría a un contratista que el proyecto tiene notas de categorías que no
    puede ver, y cuántas, que es parte de lo que el ámbito por categoría oculta.
    """
    codes = {
        "NOT_FOUND": status.HTTP_404_NOT_FOUND,
        "FORBIDDEN": status.HTTP_403_FORBIDDEN,
        "STATUS_NOT_ALLOWED": status.HTTP_403_FORBIDDEN,
        "CLOSED": status.HTTP_409_CONFLICT,
        "EMPTY": status.HTTP_400_BAD_REQUEST,
        "TOO_LONG": status.HTTP_400_BAD_REQUEST,
    }
    return HTTPException(
        status_code=codes.get(error.code, status.HTTP_400_BAD_REQUEST),
        detail={"code": error.code, "message": str(error)},
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
