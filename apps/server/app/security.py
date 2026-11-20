"""Autorización del servidor.

Implementa la misma decisión de acceso que el dominio: rol, ámbito (planta,
unidad, área), caducidad de la concesión y categorías de nota accesibles. La
tabla de permisos no se escribe aquí, se genera desde el dominio
(``access_model.py``), de modo que una operación nueva no pueda quedar
concedida en el servidor y oculta en la interfaz, ni al contrario.

La regla de la arquitectura que este módulo materializa es: «Permisos
verificados en backend, nunca solo en UI». Cada ruta de la API pide una
operación, y la decisión se toma aquí con la concesión del usuario, no con lo
que el cliente diga de sí mismo.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from .access_model import OPERATIONS, ROLE_PERMISSIONS


class AccessError(Exception):
    """Acceso denegado, con el motivo que se puede mostrar al usuario."""

    def __init__(self, reason: str, *, operation: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.operation = operation


@dataclass(frozen=True, slots=True)
class Scope:
    """Ámbito de una concesión.

    ``None`` significa «cualquiera» en ese nivel, igual que en el dominio. Es
    más expresivo que una lista de identificadores y no obliga a reasignar
    permisos cuando el cliente crea un área nueva.
    """

    plant_id: str | None = None
    unit_id: str | None = None
    area_id: str | None = None
    note_category_ids: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class Grant:
    """Concesión de un rol a un usuario, con ámbito y caducidad."""

    user_id: str
    role: str
    scope: Scope = field(default_factory=Scope)
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Resource:
    """Recurso sobre el que se pide la operación."""

    plant_id: str | None = None
    unit_id: str | None = None
    area_id: str | None = None
    note_category_id: str | None = None
    #: Autor del recurso, para las reglas sobre lo propio.
    owner_id: str | None = None


@dataclass(frozen=True, slots=True)
class Decision:
    allowed: bool
    reason: str
    #: Concesión que concedió el permiso, si alguna.
    via_role: str | None = None


def is_active(grant: Grant, now: datetime) -> bool:
    """Una concesión caducada no concede nada.

    La caducidad existe para los contratistas: se les da acceso por la duración
    de la parada y deja de valer sin que nadie tenga que acordarse de
    retirarlo. Un servidor que ignorara la fecha convertiría ese mecanismo en
    decorativo.
    """
    if grant.expires_at is None:
        return True
    expires = grant.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires > now


def scope_covers(scope: Scope, resource: Resource) -> bool:
    """Comprueba que el ámbito de la concesión cubre el recurso.

    Un nivel declarado en la concesión exige coincidencia; ``None`` acepta
    cualquiera. El orden importa poco porque los tres niveles se comprueban,
    pero la jerarquía sí: una concesión sobre la unidad U-200 no cubre un
    recurso de otra unidad aunque compartan planta.
    """
    if scope.plant_id is not None and scope.plant_id != resource.plant_id:
        return False
    if scope.unit_id is not None and scope.unit_id != resource.unit_id:
        return False
    if scope.area_id is not None and scope.area_id != resource.area_id:
        return False

    if scope.note_category_ids and resource.note_category_id is not None:
        # Categorías restringidas: una concesión limitada a «seguridad» no da
        # acceso a las notas de «mantenimiento». Sin esta comprobación, el
        # filtro de categorías sería sólo un filtro de presentación.
        if resource.note_category_id not in scope.note_category_ids:
            return False

    return True


def can_perform(
    *,
    operation: str,
    grants: list[Grant],
    resource: Resource | None = None,
    now: datetime | None = None,
) -> Decision:
    """Decide si el usuario puede ejecutar la operación sobre el recurso."""
    if operation not in OPERATIONS:
        # Una operación desconocida se deniega. Permitirla «porque no está en la
        # lista» convertiría un error de escritura en un permiso.
        return Decision(False, f"Operación desconocida: {operation}")

    moment = now or datetime.now(timezone.utc)
    target = resource or Resource()

    if not grants:
        return Decision(False, "El usuario no tiene ninguna concesión de acceso")

    expired_only = True
    out_of_scope = False

    for grant in grants:
        if not is_active(grant, moment):
            continue
        expired_only = False

        permissions = ROLE_PERMISSIONS.get(grant.role)
        if permissions is None or operation not in permissions:
            continue

        if not scope_covers(grant.scope, target):
            out_of_scope = True
            continue

        return Decision(True, f"Concedido por el rol {grant.role}", via_role=grant.role)

    if expired_only:
        return Decision(False, "Todas las concesiones del usuario han caducado")
    if out_of_scope:
        return Decision(
            False,
            "El rol permite la operación pero el recurso queda fuera del ámbito concedido",
        )
    return Decision(False, "Ninguno de los roles del usuario permite esta operación")


def can_perform_anywhere(
    *,
    operation: str,
    grants: list[Grant],
    now: datetime | None = None,
) -> Decision:
    """Decide una operación que no es sobre un recurso concreto.

    Hace falta porque ``can_perform`` sin recurso compara el ámbito de la
    concesión con un recurso vacío, y entonces **toda** concesión con ámbito
    queda fuera: un revisor con permiso sobre la planta norte —el caso normal
    en una instalación con varias plantas— no podía listar la cola de revisión,
    y el motivo que recibía («el recurso queda fuera del ámbito concedido»)
    hablaba de un recurso que no existía en la petición.

    Esta función responde a la pregunta que de verdad se hace una ruta así:
    ¿alguna concesión activa de este usuario permite la operación en algún
    ámbito? Lo que **no** hace es filtrar por ámbito lo que se devuelva: eso es
    responsabilidad de la ruta, y donde no se pueda filtrar hay que denegar en
    lugar de devolver de más.
    """
    if operation not in OPERATIONS:
        return Decision(False, f"Operación desconocida: {operation}")

    moment = now or datetime.now(timezone.utc)
    if not grants:
        return Decision(False, "El usuario no tiene ninguna concesión de acceso")

    active = [grant for grant in grants if is_active(grant, moment)]
    if not active:
        return Decision(False, "Todas las concesiones del usuario han caducado")

    for grant in active:
        permissions = ROLE_PERMISSIONS.get(grant.role)
        if permissions is not None and operation in permissions:
            return Decision(True, f"Concedido por el rol {grant.role}", via_role=grant.role)

    return Decision(False, "Ninguno de los roles del usuario permite esta operación")


def is_global(grant: Grant) -> bool:
    """`True` si la concesión no está limitada a planta, unidad ni área.

    Lo usan las rutas que devuelven información de toda la instalación y no
    pueden filtrarla por ámbito, como el registro de auditoría: sus eventos no
    llevan planta, de modo que servirlos a un usuario con ámbito de una sola
    planta le mostraría lo que ocurre en las demás.
    """
    return grant.scope.plant_id is None and grant.scope.unit_id is None and grant.scope.area_id is None


def require(
    *,
    operation: str,
    grants: list[Grant],
    resource: Resource | None = None,
    now: datetime | None = None,
) -> Decision:
    """Como ``can_perform``, pero lanza cuando deniega.

    Las rutas usan esta variante para que un olvido —comprobar y no mirar el
    resultado— no se traduzca en acceso concedido.
    """
    decision = can_perform(operation=operation, grants=grants, resource=resource, now=now)
    if not decision.allowed:
        raise AccessError(decision.reason, operation=operation)
    return decision


def effective_operations(grants: list[Grant], now: datetime | None = None) -> frozenset[str]:
    """Operaciones que el usuario puede ejecutar en algún ámbito.

    Sirve para que la interfaz oculte lo que no se puede hacer. No sustituye a
    la comprobación por recurso: un usuario puede tener ``note.resolve`` en su
    unidad y no en otra, y esta lista no distingue.
    """
    moment = now or datetime.now(timezone.utc)
    result: set[str] = set()
    for grant in grants:
        if not is_active(grant, moment):
            continue
        result |= set(ROLE_PERMISSIONS.get(grant.role, frozenset()))
    return frozenset(result)
