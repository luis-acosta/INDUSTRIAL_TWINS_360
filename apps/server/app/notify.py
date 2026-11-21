"""Avisos por correo electrónico (P07).

Para qué sirve de verdad: una nota de seguridad asignada a alguien que no abre
el editor en tres días no es una tarea, es un apunte. El aviso por correo es lo
que convierte la asignación en algo que alguien ha visto.

Las decisiones que gobiernan este módulo, en orden de importancia:

**Sin SMTP configurado no se finge.** El servicio puede desplegarse sin
servidor de correo —muchas plantas no dejan salir SMTP de la red de proceso— y
en ese caso los avisos se encolan, se cuentan y se declaran **no entregados**.
Lo contrario —aceptar la petición y perderla— haría que un responsable creyera
avisado a alguien que no lo está.

**Nunca se escribe el contenido de la nota en el correo.** El asunto y el cuerpo
dicen que hay una nota asignada, en qué planta y con qué urgencia, y un enlace
para abrirla. Las notas de planta describen fugas, incumplimientos y riesgos: un
correo atraviesa servidores que nadie en el proyecto controla, se reenvía y se
queda en bandejas durante años. Lo que el correo lleva es el aviso, no el
contenido.

**Las direcciones no se registran en la auditoría.** Queda el identificador del
destinatario, no su correo: el registro es de sólo añadir y se exporta, y una
dirección personal dentro no se puede retirar después.

**Un aviso que no se puede entregar no desaparece.** Se encola con su motivo,
que es lo que permite reintentarlo y lo que permite decir cuántos están
pendientes en lugar de que nadie se entere.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Final, Protocol

#: Motivos por los que se avisa. Lista cerrada a propósito: un aviso por cada
#: cambio convierte el correo en ruido y la gente crea un filtro que lo
#: archiva todo, incluido el que importaba.
REASONS: Final[tuple[str, ...]] = (
    "note.assigned",
    "note.due_soon",
    "note.resolved",
    "revision.submitted",
    "revision.changes_requested",
)

#: Horas de antelación con las que se avisa de un vencimiento.
DUE_SOON_HOURS: Final[int] = 24

MAX_SUBJECT_LENGTH: Final[int] = 180

#: Dirección mínimamente plausible. No se valida más: la comprobación de verdad
#: la hace el servidor de correo, y una expresión estricta rechaza direcciones
#: válidas raras que existen en los directorios de empresa.
_ADDRESS = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_address(value: str) -> bool:
    return bool(_ADDRESS.match(value.strip()))


class NotifyError(Exception):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Notification:
    """Un aviso: a quién, por qué y sobre qué."""

    notification_id: str
    reason: str
    recipient_id: str
    recipient_address: str
    subject: str
    body: str
    created_at: str
    sent_at: str | None = None
    #: Motivo por el que todavía no se ha entregado, si procede.
    pending_reason: str | None = None
    attempts: int = 0


class Mailer(Protocol):
    """Lo que este módulo necesita de un servidor de correo.

    Se declara como protocolo para poder probar la composición y la cola sin
    SMTP: lo que importa aquí es qué se manda y cuándo, no el transporte.
    """

    def send(self, message: EmailMessage) -> None: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def compose(
    *,
    reason: str,
    recipient_name: str,
    project_title: str,
    plant: str | None,
    priority: str,
    note_title: str,
    link: str | None,
) -> tuple[str, str]:
    """Asunto y cuerpo del aviso.

    El título de la nota **no** entra en el correo. Entra que hay una nota, su
    urgencia y dónde: con eso, quien lo recibe sabe si tiene que dejar lo que
    está haciendo, y para saber qué dice la nota abre el proyecto, que es donde
    el acceso está controlado.

    Un asunto que empieza por la urgencia y la planta se puede triar desde la
    lista del cliente de correo sin abrirlo, que es como se leen los correos en
    una planta: de pie y con el teléfono en la mano.
    """
    if reason not in REASONS:
        raise NotifyError(f"Motivo de aviso no contemplado: {reason}", code="UNKNOWN_REASON")

    where = plant or project_title
    urgency = "URGENTE — " if priority == "urgent" else ""

    headline = {
        "note.assigned": "Se le ha asignado una nota",
        "note.due_soon": "Una nota suya vence pronto",
        "note.resolved": "Se ha resuelto una nota suya",
        "revision.submitted": "Hay una revisión esperando su aprobación",
        "revision.changes_requested": "Le han pedido cambios en una revisión",
    }[reason]

    subject = f"{urgency}{where}: {headline}"[:MAX_SUBJECT_LENGTH]

    lines = [
        f"{recipient_name},",
        "",
        f"{headline} en «{project_title}».",
    ]
    if plant is not None:
        lines.append(f"Planta: {plant}.")
    if priority == "urgent":
        lines.append("Está marcada como urgente.")
    if link is not None:
        lines += ["", f"Para verla: {link}"]
    lines += [
        "",
        (
            "Este aviso no incluye el contenido de la nota a propósito: las notas "
            "describen situaciones de planta y el correo sale de la red del proyecto. "
            "Ábrala en el proyecto para leerla."
        ),
    ]

    # El título llega en el argumento y se ignora adrede: está en la firma para
    # que quien llame no tenga que decidir si lo manda, y no se usa para que no
    # pueda acabar en el correo por un cambio distraído.
    _ = note_title

    return subject, "\n".join(lines)


@dataclass
class NotificationQueue:
    """Cola de avisos, con lo pendiente a la vista.

    En memoria, como el registro de auditoría y por el mismo motivo declarado:
    tiene la semántica que tendrá la tabla y se pierde al reiniciar. Lo que no
    hace es desaparecer en silencio: `pending()` dice cuántos avisos no se han
    entregado y por qué, de modo que un despliegue sin correo se nota.
    """

    sender: str = "it360@localhost"
    mailer: Mailer | None = None
    items: list[Notification] = field(default_factory=list)
    _sequence: int = 0

    def enqueue(
        self,
        *,
        reason: str,
        recipient_id: str,
        recipient_address: str,
        subject: str,
        body: str,
    ) -> Notification:
        if not is_address(recipient_address):
            raise NotifyError(
                "La dirección de correo del destinatario no es válida.", code="BAD_ADDRESS"
            )

        self._sequence += 1
        notification = Notification(
            notification_id=f"n{self._sequence}",
            reason=reason,
            recipient_id=recipient_id,
            recipient_address=recipient_address.strip(),
            subject=subject,
            body=body,
            created_at=_now(),
            pending_reason=None if self.mailer is not None else "Sin servidor de correo configurado",
        )
        self.items.append(notification)
        return notification

    def flush(self) -> tuple[int, int]:
        """Intenta entregar lo pendiente. Devuelve (entregados, pendientes).

        Un fallo de un destinatario no detiene a los demás: en una lista de
        quince avisos, una dirección que ya no existe dejaría sin avisar a los
        catorce restantes.
        """
        if self.mailer is None:
            for index, item in enumerate(self.items):
                if item.sent_at is None:
                    self.items[index] = replace(
                        item, pending_reason="Sin servidor de correo configurado"
                    )
            return (0, self.pending_count())

        sent = 0
        for index, item in enumerate(self.items):
            if item.sent_at is not None:
                continue

            message = EmailMessage()
            message["From"] = self.sender
            message["To"] = item.recipient_address
            message["Subject"] = item.subject
            message.set_content(item.body)

            try:
                self.mailer.send(message)
            except Exception as error:  # noqa: BLE001 - el motivo se guarda, no se traga
                self.items[index] = replace(
                    item,
                    attempts=item.attempts + 1,
                    pending_reason=f"{type(error).__name__}: {error}"[:200],
                )
                continue

            self.items[index] = replace(
                item, sent_at=_now(), pending_reason=None, attempts=item.attempts + 1
            )
            sent += 1

        return (sent, self.pending_count())

    def pending_count(self) -> int:
        return sum(1 for item in self.items if item.sent_at is None)

    def pending(self) -> list[Notification]:
        return [item for item in self.items if item.sent_at is None]

    def redacted(self) -> list[dict[str, object]]:
        """Estado de la cola sin direcciones.

        Lo consulta un administrador para saber si los avisos están saliendo.
        Las direcciones no entran: la lista se mira en pantalla, se pega en un
        correo y se manda, y una dirección personal no debería viajar por eso.
        """
        return [
            {
                "id": item.notification_id,
                "reason": item.reason,
                "recipientId": item.recipient_id,
                "createdAt": item.created_at,
                "sentAt": item.sent_at,
                "attempts": item.attempts,
                "pendingReason": item.pending_reason,
            }
            for item in self.items
        ]


@dataclass(frozen=True)
class SmtpMailer:
    """Entrega por SMTP.

    Abre y cierra la conexión en cada envío. Es más lento que mantenerla, y es
    lo correcto aquí: los avisos salen a ráfagas de dos o tres cuando alguien
    asigna tareas, y una conexión abierta durante horas contra el servidor de
    correo de una empresa se cae sin avisar y el primer aviso que se pierde es
    el que nadie estaba mirando.
    """

    host: str
    port: int
    use_tls: bool = True
    username: str | None = None
    password: str | None = None
    timeout_seconds: int = 10

    def send(self, message: EmailMessage) -> None:
        # La importación va aquí y no arriba para que el módulo se pueda cargar
        # —y probar— en un entorno donde `smtplib` no se use nunca.
        import smtplib

        with smtplib.SMTP(self.host, self.port, timeout=self.timeout_seconds) as client:
            if self.use_tls:
                client.starttls()
            if self.username is not None and self.password is not None:
                client.login(self.username, self.password)
            client.send_message(message)
