"""Procesamiento por lotes (B05).

Un cliente que digitaliza una planta llega con cuarenta o doscientos grupos de
fotografías, no con dos. El lote es el caso normal, y tiene exigencias propias
que el cosido de un solo grupo no plantea:

- **Un fallo no detiene el resto.** La foto treinta y siete está borrosa; las
  otras ciento sesenta y tres tienen que coserse igual. Por eso el cosido
  devuelve un resultado y no lanza.
- **El progreso tiene que ser visible.** Cuarenta cosidos son media hora de
  máquina, y una barra que no se mueve es indistinguible de un cuelgue.
- **El informe final importa más que las imágenes.** Quien revisa un lote
  necesita saber qué salió bien, qué necesita mirarse y qué hay que volver a
  fotografiar — y lo último es lo más valioso, porque implica volver a la
  planta y conviene saberlo antes de desmontar el trípode.

El agrupamiento de las fotografías en trabajos lo decide quien llama. Aquí no se
adivina por nombre de archivo ni por marca de tiempo: un agrupamiento
equivocado produce cosidos absurdos, y es mejor que el usuario lo declare.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .lens import LensType
from .pipeline import StitchRequest, StitchResult, StitcherUnavailable, stitch
from .reproject import describe as describe_projection
from .quality import Thresholds, Verdict, describe


@dataclass(frozen=True, slots=True)
class BatchItem:
    """Un trabajo del lote: un grupo de fotografías con su nombre."""

    name: str
    images: tuple[Path, ...]
    declared_lens: LensType | None = None
    declared_fov_deg: float | None = None
    #: Puntos de control de este trabajo (B07).
    #:
    #: Van por trabajo y no por lote porque las marcas son de unas fotografías
    #: concretas: un lote procesa grupos distintos, y unos puntos aplicados al
    #: grupo equivocado producirían una geometría absurda.
    control_points: tuple[tuple[int, int, float, float, float, float], ...] = ()


@dataclass(frozen=True, slots=True)
class BatchItemOutcome:
    """Lo que pasó con un trabajo."""

    name: str
    verdict: Verdict | None
    summary: str
    #: Imagen resultante, cuando se entregó.
    result: StitchResult | None = None
    #: Mensaje del fallo cuando no se pudo ni intentar.
    failure: str | None = None

    @property
    def usable(self) -> bool:
        return self.result is not None and self.result.delivered


@dataclass(frozen=True, slots=True)
class BatchReport:
    """Resultado del lote completo."""

    started_at: datetime
    finished_at: datetime
    outcomes: tuple[BatchItemOutcome, ...] = ()

    @property
    def accepted(self) -> tuple[BatchItemOutcome, ...]:
        return tuple(o for o in self.outcomes if o.verdict is Verdict.ACCEPTED)

    @property
    def needs_review(self) -> tuple[BatchItemOutcome, ...]:
        return tuple(o for o in self.outcomes if o.verdict is Verdict.NEEDS_REVIEW)

    @property
    def rejected(self) -> tuple[BatchItemOutcome, ...]:
        return tuple(o for o in self.outcomes if o.verdict is Verdict.REJECTED)

    @property
    def failed(self) -> tuple[BatchItemOutcome, ...]:
        """Trabajos que no se pudieron ni intentar: entrada inválida o entorno."""
        return tuple(o for o in self.outcomes if o.verdict is None)

    @property
    def duration_seconds(self) -> float:
        return (self.finished_at - self.started_at).total_seconds()


#: Función de progreso: recibe el índice (desde 1), el total y el nombre.
ProgressCallback = Callable[[int, int, str], None]


def run_batch(
    items: Iterable[BatchItem],
    *,
    thresholds: Thresholds = Thresholds(),
    projection: str = "spherical",
    max_edge_px: int = 16384,
    on_progress: ProgressCallback | None = None,
) -> BatchReport:
    """Cose todos los trabajos del lote.

    Ningún trabajo puede detener el lote. Las excepciones de entrada —menos de
    dos imágenes, proyección inválida— y la ausencia de OpenCV se capturan y se
    anotan como fallo del trabajo, porque en un lote de doscientos la
    alternativa es perder el trabajo de media hora por una carpeta mal armada.
    """
    started = datetime.now(timezone.utc)
    queue = list(items)
    outcomes: list[BatchItemOutcome] = []

    for index, item in enumerate(queue, start=1):
        if on_progress is not None:
            on_progress(index, len(queue), item.name)

        try:
            result = stitch(
                StitchRequest(
                    images=item.images,
                    declared_lens=item.declared_lens,
                    declared_fov_deg=item.declared_fov_deg,
                    projection=projection,
                    max_edge_px=max_edge_px,
                    thresholds=thresholds,
                    control_points=item.control_points,
                )
            )
        except StitcherUnavailable as error:
            # Sin OpenCV ningún trabajo va a salir: se anota y se sigue para
            # que el informe lo diga de todos, en lugar de parar en el primero.
            outcomes.append(
                BatchItemOutcome(
                    name=item.name,
                    verdict=None,
                    summary="No se pudo intentar el cosido",
                    failure=str(error),
                )
            )
            continue
        except ValueError as error:
            outcomes.append(
                BatchItemOutcome(
                    name=item.name,
                    verdict=None,
                    summary="Entrada no válida",
                    failure=str(error),
                )
            )
            continue

        outcomes.append(
            BatchItemOutcome(
                name=item.name,
                verdict=result.report.verdict,
                summary=describe(result.report),
                result=result,
            )
        )

    return BatchReport(
        started_at=started,
        finished_at=datetime.now(timezone.utc),
        outcomes=tuple(outcomes),
    )


def format_report(report: BatchReport) -> str:
    """Informe del lote en texto.

    El orden no es casual: primero lo que hay que volver a fotografiar, porque
    es lo que obliga a volver a la planta y conviene leerlo antes de guardar el
    equipo. Lo que salió bien va al final: no exige nada de nadie.
    """
    lines = [
        "Informe de cosido por lotes",
        "===========================",
        f"Trabajos: {len(report.outcomes)}",
        f"Duración: {report.duration_seconds:.0f} s",
        "",
    ]

    if report.failed:
        lines += ["No se pudieron intentar", "-----------------------"]
        for outcome in report.failed:
            lines.append(f"- {outcome.name}: {outcome.failure}")
        lines.append("")

    if report.rejected:
        lines += [
            "Hay que volver a fotografiar",
            "---------------------------",
            "Estos cosidos no se pueden usar. El motivo dice qué hacer distinto:",
            "",
        ]
        for outcome in report.rejected:
            lines.append(f"- {outcome.name}: {outcome.summary}")
            if outcome.result is not None:
                for problem in outcome.result.report.problems:
                    lines.append(f"    {problem}")
        lines.append("")

    if report.needs_review:
        lines += [
            "Requieren revisión antes de usarse",
            "----------------------------------",
        ]
        for outcome in report.needs_review:
            lines.append(f"- {outcome.name}: {outcome.summary}")
            if outcome.result is not None:
                for problem in outcome.result.report.problems:
                    lines.append(f"    {problem}")
        lines.append("")

    if report.accepted:
        lines += ["Aceptables", "----------"]
        for outcome in report.accepted:
            lines.append(f"- {outcome.name}: {outcome.summary}")
            # La proyección entregada puede no ser la pedida: una panorámica
            # parcial se entrega siempre en equirectangular. Decirlo aquí evita
            # que alguien busque en el archivo una cúbica que no está.
            if outcome.result is not None and outcome.result.projection != "spherical":
                lines.append(
                    f"    Proyección entregada: {describe_projection(outcome.result.projection)}"
                )
            if outcome.result is not None:
                for note in outcome.result.report.notes:
                    if "puntos de control" in note.lower() or "proyección" in note.lower():
                        lines.append(f"    {note}")
        lines.append("")

    lines += [
        "Recordatorio",
        "------------",
        "El cosido automático es una función experimental. Incluso los trabajos",
        "aceptables entran en el proyecto marcados como tales, y conviene girar",
        "la vista en cada uno antes de entregarlo: los defectos de costura se ven",
        "mal en una miniatura.",
        "",
    ]

    return "\n".join(lines)


@dataclass(slots=True)
class ProgressTracker:
    """Acumula el progreso para mostrarlo.

    Se guarda el nombre del trabajo en curso además del recuento: «23 de 40» no
    dice nada cuando uno tarda cuatro minutos, y «23 de 40 — Sala de bombas
    nivel 2» permite saber si se quedó atascado en algo concreto.
    """

    total: int = 0
    done: int = 0
    current: str = ""
    history: list[str] = field(default_factory=list)

    def __call__(self, index: int, total: int, name: str) -> None:
        self.total = total
        self.done = index - 1
        self.current = name
        self.history.append(name)

    @property
    def fraction(self) -> float:
        return self.done / self.total if self.total else 0.0

    def describe(self) -> str:
        if self.total == 0:
            return "Sin trabajos"
        return f"{self.done} de {self.total} — {self.current}"
