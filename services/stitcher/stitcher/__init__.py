"""Servicio de cosido de panorámicas. Función experimental.

El plan declara el cosido como algoritmo no trivial y exige que no se presente
como terminado si no alcanza calidad. Este paquete está construido alrededor de
esa exigencia: todo resultado pasa por una evaluación que puede rechazarlo, y lo
que se entrega va acompañado del aviso de que es experimental.
"""

from .lens import LensProfile, LensType, resolve_profile
from .quality import EXPERIMENTAL_NOTICE, QualityReport, StitchMetrics, Thresholds, Verdict, evaluate

__all__ = [
    "EXPERIMENTAL_NOTICE",
    "LensProfile",
    "LensType",
    "QualityReport",
    "StitchMetrics",
    "Thresholds",
    "Verdict",
    "evaluate",
    "resolve_profile",
]
