"""Evaluación de la calidad de un cosido.

Este módulo es la razón por la que el servicio de cosido puede existir sin
mentir. El plan lo dice con claridad: «No simular funciones como terminadas; si
un algoritmo avanzado no alcanza calidad, dejarlo marcado experimental». Coser
panorámicas es un algoritmo avanzado que a veces sale mal, y lo único
inaceptable es entregar un resultado malo como si fuera bueno.

Así que todo cosido pasa por aquí y recibe un veredicto de tres estados:

- ``accepted``: las métricas están dentro de lo razonable. Sigue siendo
  experimental y el proyecto lo marca como tal, pero se puede usar.
- ``needsReview``: hay algo que no cuadra —pocas coincidencias, exposiciones
  dispares, cobertura incompleta— y una persona tiene que mirarlo antes de
  usarlo.
- ``rejected``: el resultado no sirve. Se devuelve el motivo y **no** se
  entrega la imagen: una panorámica con el horizonte partido en dos no es un
  punto de partida, es basura que hay que detectar antes de que entre en el
  proyecto.

Las métricas se calculan sobre el resultado del cosido, no sobre la intención.
Un cosido que OpenCV declara exitoso puede tener una costura que atraviesa el
cuadro, y la única forma de saberlo es medirla.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Final


class Verdict(str, Enum):
    ACCEPTED = "accepted"
    NEEDS_REVIEW = "needsReview"
    REJECTED = "rejected"


VERDICT_LABELS: Final[dict[Verdict, str]] = {
    Verdict.ACCEPTED: "Aceptable (experimental)",
    Verdict.NEEDS_REVIEW: "Requiere revisión humana",
    Verdict.REJECTED: "Rechazado",
}


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Umbrales de la evaluación.

    Son valores de partida, ajustables por el cliente, y cada uno responde a un
    modo concreto de salir mal:
    """

    #: Coincidencias por par de imágenes por debajo de las cuales la geometría
    #: del cosido se apoya en muy pocos puntos y basta un reflejo para
    #: desviarla.
    min_matches_per_pair: int = 30

    #: Proporción de imágenes que el algoritmo consiguió encajar. Si se quedan
    #: fuera, falta parte de la escena y la panorámica tiene un agujero.
    min_images_used_ratio: float = 0.9

    #: Diferencia de exposición entre imágenes contiguas, en pasos de
    #: diafragma. Por encima, la costura se ve como un escalón de brillo
    #: aunque la geometría sea perfecta (B08).
    max_exposure_spread_ev: float = 1.5

    #: Proporción de píxeles negros en el resultado. Un cosido que deja
    #: esquinas vacías produce un recorte agresivo o un borde visible al girar.
    max_empty_ratio: float = 0.08

    #: Error de reproyección medio, en píxeles. Mide cuánto se desvían los
    #: puntos coincidentes después de aplicar la geometría estimada: es la
    #: métrica que detecta el fantasma y el doble contorno (B08).
    max_reprojection_error_px: float = 3.0

    #: Cobertura horizontal mínima para declarar la panorámica completa (B03).
    full_coverage_min_deg: float = 350.0


DEFAULT_THRESHOLDS: Final[Thresholds] = Thresholds()


@dataclass(frozen=True, slots=True)
class StitchMetrics:
    """Lo que se mide de un cosido terminado."""

    images_submitted: int
    images_used: int
    #: Coincidencias por par, tal como las contó el emparejador.
    matches_per_pair: tuple[int, ...]
    #: Exposición relativa de cada imagen, en pasos de diafragma.
    exposure_ev: tuple[float, ...]
    reprojection_error_px: float
    empty_ratio: float
    horizontal_coverage_deg: float
    vertical_coverage_deg: float
    width_px: int
    height_px: int

    @property
    def images_used_ratio(self) -> float:
        if self.images_submitted == 0:
            return 0.0
        return self.images_used / self.images_submitted

    @property
    def min_matches(self) -> int:
        return min(self.matches_per_pair) if self.matches_per_pair else 0

    @property
    def exposure_spread_ev(self) -> float:
        """Diferencia entre la imagen más clara y la más oscura.

        Se usa el rango y no la desviación típica: una sola imagen mal expuesta
        produce una costura visible, y la desviación típica la diluiría entre
        las demás.
        """
        if len(self.exposure_ev) < 2:
            return 0.0
        return max(self.exposure_ev) - min(self.exposure_ev)


@dataclass(frozen=True, slots=True)
class QualityReport:
    """Veredicto con sus motivos, listo para mostrar al usuario."""

    verdict: Verdict
    metrics: StitchMetrics
    #: Motivos del rechazo o de la revisión, en español y concretos.
    problems: tuple[str, ...] = ()
    #: Observaciones que no bloquean pero conviene conocer.
    notes: tuple[str, ...] = ()
    #: `True` si la panorámica cubre la esfera completa (B03).
    is_full_panorama: bool = False

    @property
    def usable(self) -> bool:
        """`True` si el resultado se puede entregar al proyecto.

        Incluye `needsReview`: lo que necesita revisión se entrega marcado, no
        se esconde. Esconderlo obligaría a repetir el cosido para verlo.
        """
        return self.verdict is not Verdict.REJECTED


def evaluate(
    metrics: StitchMetrics,
    thresholds: Thresholds = DEFAULT_THRESHOLDS,
) -> QualityReport:
    """Emite el veredicto de un cosido.

    Un solo problema grave rechaza; los problemas menores acumulan revisión.
    La distinción no es cosmética: rechazar por una diferencia de exposición
    corregible haría que el servicio no sirviera para nada, y aceptar un
    horizonte partido haría que sirviera para algo peor que nada.
    """
    problems: list[str] = []
    notes: list[str] = []
    fatal = False

    # --- Imágenes que no se pudieron encajar ---

    if metrics.images_used < 2:
        return QualityReport(
            verdict=Verdict.REJECTED,
            metrics=metrics,
            problems=(
                f"Sólo se pudo encajar {metrics.images_used} de {metrics.images_submitted} "
                "imágenes: no hay solape suficiente entre las fotografías.",
            ),
        )

    if metrics.images_used_ratio < thresholds.min_images_used_ratio:
        quedaron = metrics.images_submitted - metrics.images_used
        message = (
            f"{quedaron} de {metrics.images_submitted} imágenes quedaron fuera del cosido: "
            "falta parte de la escena."
        )
        # Si se queda fuera más de un tercio, el resultado no representa lo que
        # se fotografió y no es un punto de partida válido.
        if metrics.images_used_ratio < 0.65:
            problems.append(message)
            fatal = True
        else:
            problems.append(message)

    # --- Geometría ---

    if metrics.min_matches < thresholds.min_matches_per_pair:
        problems.append(
            f"Hay un par de imágenes con sólo {metrics.min_matches} coincidencias "
            f"(mínimo recomendado: {thresholds.min_matches_per_pair}). La geometría se apoya "
            "en muy pocos puntos y un reflejo o una superficie repetitiva puede desviarla."
        )

    if metrics.reprojection_error_px > thresholds.max_reprojection_error_px:
        message = (
            f"Error de reproyección de {metrics.reprojection_error_px:.1f} px "
            f"(máximo: {thresholds.max_reprojection_error_px:.1f}). Es el síntoma del doble "
            "contorno: los objetos cercanos a la costura pueden aparecer duplicados."
        )
        problems.append(message)
        # Por encima del triple del umbral el resultado tiene contornos dobles
        # visibles a simple vista.
        if metrics.reprojection_error_px > thresholds.max_reprojection_error_px * 3:
            fatal = True

    # --- Fotometría ---

    if metrics.exposure_spread_ev > thresholds.max_exposure_spread_ev:
        problems.append(
            f"Diferencia de exposición de {metrics.exposure_spread_ev:.1f} pasos entre las "
            "imágenes: la costura se verá como un escalón de brillo. Vuelva a fotografiar con "
            "exposición manual fija."
        )

    # --- Huecos ---

    if metrics.empty_ratio > thresholds.max_empty_ratio:
        message = (
            f"El {metrics.empty_ratio * 100:.0f} % del resultado son píxeles vacíos: "
            "quedarán bordes negros al girar la vista."
        )
        problems.append(message)
        if metrics.empty_ratio > 0.25:
            fatal = True

    # --- Cobertura ---

    is_full = metrics.horizontal_coverage_deg >= thresholds.full_coverage_min_deg
    if is_full:
        notes.append("Cobertura horizontal completa: la panorámica se puede usar como esfera.")
    else:
        # No es un problema: una panorámica parcial es un resultado legítimo
        # (B03) y el visor la limita al arco cubierto. Pero el usuario tiene
        # que saberlo, porque esperaba 360 si fotografió en círculo.
        notes.append(
            f"Cobertura horizontal de {metrics.horizontal_coverage_deg:.0f}°: la panorámica es "
            "parcial y el visor limitará el giro a ese arco."
        )

    if metrics.vertical_coverage_deg < 60:
        notes.append(
            f"Cobertura vertical de {metrics.vertical_coverage_deg:.0f}°: una franja estrecha "
            "deja poco margen para mirar arriba o abajo."
        )

    if fatal:
        verdict = Verdict.REJECTED
    elif problems:
        verdict = Verdict.NEEDS_REVIEW
    else:
        verdict = Verdict.ACCEPTED

    return QualityReport(
        verdict=verdict,
        metrics=metrics,
        problems=tuple(problems),
        notes=tuple(notes),
        is_full_panorama=is_full,
    )


def describe(report: QualityReport) -> str:
    """Resumen en una línea, para registros y listados de lote."""
    label = VERDICT_LABELS[report.verdict]
    used = f"{report.metrics.images_used}/{report.metrics.images_submitted} imágenes"
    coverage = f"{report.metrics.horizontal_coverage_deg:.0f}°×{report.metrics.vertical_coverage_deg:.0f}°"
    detail = f"; {len(report.problems)} problema(s)" if report.problems else ""
    return f"{label}: {used}, {coverage}{detail}"


#: Advertencia que acompaña a todo resultado entregado.
#:
#: Se define aquí, en el módulo que juzga la calidad, para que no haya forma de
#: entregar un cosido sin ella. El plan exige dejar marcado lo experimental, y
#: un texto que vive en la pantalla que lo muestra se olvida en la siguiente
#: pantalla que lo muestre.
EXPERIMENTAL_NOTICE: Final[str] = (
    "Cosido automático: función experimental. Revise el resultado antes de usarlo en un "
    "recorrido que vaya a entregarse. Los defectos típicos —contornos dobles cerca de la "
    "costura, escalones de brillo y horizonte inclinado— se ven mejor girando la vista que en "
    "la miniatura."
)
