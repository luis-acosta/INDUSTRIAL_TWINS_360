"""Pruebas de los avisos por correo (P07).

Dos cosas se vigilan aquí, y las dos son de las que no se ven hasta que hacen
daño:

**Que el correo no publique el contenido de una nota.** Las notas de planta
describen fugas, incumplimientos y riesgos. Un correo atraviesa servidores que
nadie en el proyecto controla, se reenvía y se queda en bandejas durante años.
El aviso dice que hay una nota; lo que dice la nota se lee en el proyecto, que
es donde el acceso está controlado.

**Que un aviso que no se entrega no desaparezca.** Sin servidor de correo, los
avisos quedan en cola, contados y con su motivo. Aceptarlos y perderlos haría
que un responsable creyera avisado a alguien que no lo está, y eso es peor que
no tener avisos.
"""

from __future__ import annotations

from email.message import EmailMessage

import pytest

from app.notify import (
    DUE_SOON_HOURS,
    MAX_SUBJECT_LENGTH,
    REASONS,
    NotificationQueue,
    NotifyError,
    compose,
    is_address,
)


class RecordingMailer:
    """Servidor de correo de prueba: guarda lo que se le manda."""

    def __init__(self, fail_for: str | None = None) -> None:
        self.sent: list[EmailMessage] = []
        self.fail_for = fail_for

    def send(self, message: EmailMessage) -> None:
        if self.fail_for is not None and message["To"] == self.fail_for:
            raise OSError("buzón inexistente")
        self.sent.append(message)


def composed(reason: str = "note.assigned", **overrides: object) -> tuple[str, str]:
    kwargs: dict[str, object] = {
        "reason": reason,
        "recipient_name": "Ruiz",
        "project_title": "Planta Norte",
        "plant": "Unidad 2",
        "priority": "normal",
        "note_title": "Fuga de ácido en la brida del reactor",
        "link": "https://planta.local/recorrido#nota=n1",
    }
    kwargs.update(overrides)
    return compose(**kwargs)  # type: ignore[arg-type]


# --------------------------------------------------------------------- #
# Lo que el correo no lleva
# --------------------------------------------------------------------- #


def test_el_correo_no_lleva_el_contenido_de_la_nota() -> None:
    """TEST-NTF-001: es la razón de ser de este compositor.

    El título entra en la llamada porque quien llama lo tiene a mano, y se
    descarta a propósito. Si apareciera, «Fuga de ácido en la brida del
    reactor» quedaría en la bandeja de entrada de cualquiera a quien se le
    reenvíe el aviso.
    """
    subject, body = composed()

    assert "ácido" not in subject
    assert "ácido" not in body
    assert "brida" not in body


def test_dice_que_no_lleva_el_contenido_y_por_que() -> None:
    """TEST-NTF-002: quien recibe el aviso no debe pensar que está incompleto."""
    _, body = composed()

    assert "no incluye el contenido" in body
    assert "Ábrala en el proyecto" in body


def test_el_asunto_permite_triar_sin_abrirlo() -> None:
    """TEST-NTF-003: urgencia y sitio delante.

    Un correo de planta se lee de pie y con el teléfono en la mano: lo que no
    se pueda decidir desde la lista no se decide.
    """
    subject, _ = composed(priority="urgent")

    assert subject.startswith("URGENTE — Unidad 2:")
    assert len(subject) <= MAX_SUBJECT_LENGTH


def test_sin_planta_el_asunto_usa_el_proyecto() -> None:
    """TEST-NTF-004: un asunto que empieza por dos puntos no dice nada."""
    subject, _ = composed(plant=None)

    assert subject.startswith("Planta Norte:")


def test_cada_motivo_tiene_su_titular() -> None:
    """TEST-NTF-005: cinco motivos y cinco textos distintos.

    Un titular genérico —«hay novedades»— es lo que lleva a la gente a crear un
    filtro que lo archiva todo, incluido el aviso que importaba.
    """
    titulares = {composed(reason)[0] for reason in REASONS}

    assert len(titulares) == len(REASONS)


def test_un_motivo_desconocido_se_rechaza() -> None:
    """TEST-NTF-006: la lista es cerrada a propósito."""
    with pytest.raises(NotifyError) as error:
        composed("note.algo_nuevo")

    assert error.value.code == "UNKNOWN_REASON"


def test_el_enlace_es_opcional() -> None:
    """TEST-NTF-007: un paquete en una intranet puede no tener dirección
    pública, y un enlace inventado lleva a una página de error."""
    _, body = composed(link=None)

    assert "Para verla" not in body


# --------------------------------------------------------------------- #
# Cola y entrega
# --------------------------------------------------------------------- #


def test_sin_servidor_de_correo_se_encola_y_se_declara() -> None:
    """TEST-NTF-008: es la comprobación que impide el daño.

    Muchas plantas no dejan salir SMTP de la red de proceso. Lo que no puede
    pasar es que el aviso se acepte y se pierda: quien asigna la tarea creería
    avisado a alguien que no lo está.
    """
    queue = NotificationQueue()
    subject, body = composed()
    queue.enqueue(
        reason="note.assigned",
        recipient_id="tecnico.ruiz",
        recipient_address="ruiz@planta.local",
        subject=subject,
        body=body,
    )

    delivered, pending = queue.flush()

    assert delivered == 0
    assert pending == 1
    assert queue.pending()[0].pending_reason == "Sin servidor de correo configurado"


def test_con_servidor_se_entrega_y_queda_la_marca() -> None:
    """TEST-NTF-009"""
    mailer = RecordingMailer()
    queue = NotificationQueue(sender="it360@planta.local", mailer=mailer)
    subject, body = composed()
    queue.enqueue(
        reason="note.assigned",
        recipient_id="tecnico.ruiz",
        recipient_address="ruiz@planta.local",
        subject=subject,
        body=body,
    )

    delivered, pending = queue.flush()

    assert (delivered, pending) == (1, 0)
    assert mailer.sent[0]["To"] == "ruiz@planta.local"
    assert mailer.sent[0]["From"] == "it360@planta.local"
    assert queue.items[0].sent_at is not None


def test_un_destinatario_que_falla_no_detiene_a_los_demas() -> None:
    """TEST-NTF-010: en una lista de quince avisos, una dirección que ya no
    existe dejaría sin avisar a los catorce restantes."""
    mailer = RecordingMailer(fail_for="fuera@planta.local")
    queue = NotificationQueue(mailer=mailer)
    subject, body = composed()

    for address in ("ruiz@planta.local", "fuera@planta.local", "lopez@planta.local"):
        queue.enqueue(
            reason="note.assigned",
            recipient_id=address.split("@")[0],
            recipient_address=address,
            subject=subject,
            body=body,
        )

    delivered, pending = queue.flush()

    assert delivered == 2
    assert pending == 1
    assert "buzón inexistente" in (queue.pending()[0].pending_reason or "")


def test_reintentar_no_duplica_lo_ya_entregado() -> None:
    """TEST-NTF-011: el reintento es la forma de recuperar lo pendiente, y
    recibir el mismo aviso tres veces enseña a ignorarlos."""
    mailer = RecordingMailer()
    queue = NotificationQueue(mailer=mailer)
    subject, body = composed()
    queue.enqueue(
        reason="note.assigned",
        recipient_id="tecnico.ruiz",
        recipient_address="ruiz@planta.local",
        subject=subject,
        body=body,
    )

    queue.flush()
    queue.flush()

    assert len(mailer.sent) == 1


def test_una_direccion_invalida_se_rechaza_al_encolar() -> None:
    """TEST-NTF-012: antes de intentar nada.

    Encolarla haría que la cola de pendientes creciera con algo que nunca va a
    salir, y entonces el número de pendientes deja de significar «hay un
    problema con el correo».
    """
    queue = NotificationQueue()

    with pytest.raises(NotifyError) as error:
        queue.enqueue(
            reason="note.assigned",
            recipient_id="x",
            recipient_address="no-es-un-correo",
            subject="x",
            body="x",
        )

    assert error.value.code == "BAD_ADDRESS"
    assert queue.pending_count() == 0


def test_el_estado_de_la_cola_no_lleva_direcciones() -> None:
    """TEST-NTF-013: el estado se mira en pantalla, se pega en un correo y se
    manda. Una dirección personal no debería viajar por eso."""
    queue = NotificationQueue()
    subject, body = composed()
    queue.enqueue(
        reason="note.assigned",
        recipient_id="tecnico.ruiz",
        recipient_address="ruiz@planta.local",
        subject=subject,
        body=body,
    )

    estado = queue.redacted()

    assert estado[0]["recipientId"] == "tecnico.ruiz"
    assert "ruiz@planta.local" not in str(estado)


def test_direcciones_plausibles_y_no_plausibles() -> None:
    """TEST-NTF-014: la comprobación es mínima a propósito.

    La de verdad la hace el servidor de correo; una expresión estricta rechaza
    direcciones válidas raras que existen en los directorios de empresa.
    """
    assert is_address("ruiz@planta.local")
    assert is_address("a.b+c@sub.dominio.es")
    assert not is_address("ruiz@planta")
    assert not is_address("ruiz planta.local")
    assert not is_address("")


def test_la_antelacion_del_vencimiento_esta_declarada() -> None:
    """TEST-NTF-015: un día.

    Avisar con una hora no da tiempo a nada en una planta; avisar con una
    semana hace que el aviso se olvide antes de la fecha.
    """
    assert DUE_SOON_HOURS == 24
