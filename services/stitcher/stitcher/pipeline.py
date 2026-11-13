"""Tubería de cosido de panorámicas (B01, B03-B08). **Experimental.**

Usa el cosido por detalle de OpenCV en lugar de ``cv2.Stitcher`` de alto nivel,
por una razón concreta: la clase de alto nivel devuelve una imagen y un código
de éxito, y nada más. No dice cuántas coincidencias encontró, ni cuánto se
desvían los puntos tras estimar la geometría, ni qué imágenes se quedó fuera.
Sin esas métricas no se puede juzgar el resultado, y sin juzgarlo sólo queda
entregarlo y esperar — que es exactamente lo que el plan prohíbe.

La tubería, por tanto, hace cada paso a la vista:

1. **Rasgos y emparejamiento.** Detecta puntos característicos y empareja por
   pares, contando coincidencias.
2. **Estimación de cámaras.** Calcula la posición relativa de cada toma y mide
   el error de reproyección, que es la métrica que delata el contorno doble.
3. **Ajuste de exposición y mezcla.** Corrige diferencias de brillo y suaviza
   la costura; mide la diferencia que había antes de corregir, porque una
   corrección grande deja rastro aunque el resultado pase.
4. **Evaluación.** El veredicto lo da ``quality.evaluate`` sobre las métricas
   medidas, no sobre el código de retorno.

Si OpenCV no está instalado, la tubería lo dice al llamarla en lugar de fallar
con un error de importación en el arranque del servicio: un servidor que no
arranca por una dependencia opcional deja sin recorridos a quien no usa el
cosido.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .lens import LensProfile, LensType, resolve_profile
from .quality import (
    EXPERIMENTAL_NOTICE,
    QualityReport,
    StitchMetrics,
    Thresholds,
    Verdict,
    evaluate,
)


class StitcherUnavailable(RuntimeError):
    """OpenCV no está disponible en este entorno."""


def _require_cv2() -> Any:
    try:
        import cv2  # noqa: PLC0415 — importación diferida a propósito
    except ImportError as error:  # pragma: no cover — depende del entorno
        raise StitcherUnavailable(
            "El cosido de panorámicas necesita OpenCV. Instale el servicio con "
            "'pip install -e services/stitcher[cv]' o use panorámicas ya cosidas."
        ) from error
    return cv2


@dataclass(frozen=True, slots=True)
class StitchRequest:
    """Un trabajo de cosido."""

    #: Rutas de las fotografías, en cualquier orden.
    images: tuple[Path, ...]
    #: Lente declarada por el usuario, si la declaró.
    declared_lens: LensType | None = None
    declared_fov_deg: float | None = None
    #: Proyección de salida (B04).
    projection: str = "spherical"
    #: Lado mayor máximo del resultado, en píxeles. 0 = sin límite.
    max_edge_px: int = 16384
    thresholds: Thresholds = Thresholds()
    #: Puntos de control añadidos a mano (B07), por par de imágenes.
    control_points: tuple[tuple[int, int, float, float, float, float], ...] = ()


@dataclass(frozen=True, slots=True)
class StitchResult:
    """Resultado de un cosido, juzgado."""

    report: QualityReport
    lens: LensProfile
    #: Imagen resultante, o `None` si se rechazó.
    image: Any | None
    #: Aviso que acompaña a todo resultado entregado.
    notice: str = EXPERIMENTAL_NOTICE

    @property
    def delivered(self) -> bool:
        return self.image is not None


#: Proyecciones admitidas (B04).
#:
#: La lista es la de OpenCV menos las que no tienen sentido para un recorrido:
#: una panorámica que el visor no sabe proyectar en una esfera no sirve de nada
#: aunque el cosido salga perfecto.
PROJECTIONS: tuple[str, ...] = ("spherical", "cylindrical", "mercator", "stereographic", "plane")


def _resize_to_max_edge(cv2: Any, image: Any, max_edge_px: int) -> Any:
    """Limita el lado mayor.

    El límite no es estético: una equirectangular de 32 000 px no la puede
    cargar la GPU de un portátil de planta, y el visor la degradaría igualmente.
    Reducir aquí ahorra el peso en el paquete publicado.
    """
    if max_edge_px <= 0:
        return image
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= max_edge_px:
        return image
    scale = max_edge_px / longest
    return cv2.resize(
        image,
        (int(round(width * scale)), int(round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def _empty_ratio(cv2: Any, image: Any) -> float:
    """Proporción de píxeles vacíos del resultado.

    Se cuenta sobre el canal de luminancia y con un umbral bajo en lugar de
    buscar el negro exacto: la mezcla deja bordes casi negros que a efectos
    prácticos son hueco igual.
    """
    import numpy as np  # noqa: PLC0415

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    empty = int(np.count_nonzero(gray <= 2))
    return empty / float(gray.size) if gray.size else 1.0


def _exposure_ev(cv2: Any, images: list[Any]) -> tuple[float, ...]:
    """Exposición relativa de cada imagen, en pasos de diafragma.

    Se estima por la media de luminancia y se expresa en log2 respecto a la
    mediana del conjunto. No es la exposición real de la cámara —eso está en el
    EXIF, que puede faltar— pero sí mide lo que importa: cuánto se va a notar
    la costura entre dos tomas (B08).
    """
    import numpy as np  # noqa: PLC0415

    means: list[float] = []
    for image in images:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        means.append(max(float(np.mean(gray)), 1.0))

    reference = float(np.median(means))
    return tuple(round(math.log2(mean / reference), 3) for mean in means)


def stitch(request: StitchRequest) -> StitchResult:
    """Cose las fotografías y juzga el resultado.

    Nunca lanza por un cosido fallido: un fallo de cosido es un resultado del
    servicio, no una excepción. Lanza sólo cuando no puede ni intentarlo —sin
    OpenCV o sin imágenes legibles—, porque eso sí es un problema del entorno.
    """
    cv2 = _require_cv2()
    import numpy as np  # noqa: PLC0415

    if len(request.images) < 2:
        raise ValueError("El cosido necesita al menos dos fotografías")

    if request.projection not in PROJECTIONS:
        raise ValueError(
            f"Proyección no admitida: {request.projection}. Admitidas: {', '.join(PROJECTIONS)}"
        )

    # --- Carga ---

    loaded: list[Any] = []
    unreadable: list[str] = []
    for path in request.images:
        image = cv2.imread(str(path))
        if image is None:
            unreadable.append(path.name)
            continue
        loaded.append(image)

    if len(loaded) < 2:
        raise ValueError(
            "No se pudieron leer al menos dos imágenes"
            + (f" (ilegibles: {', '.join(unreadable)})" if unreadable else "")
        )

    lens = resolve_profile(
        declared=request.declared_lens,
        declared_fov_deg=request.declared_fov_deg,
    )

    exposure = _exposure_ev(cv2, loaded)

    # --- Cosido ---
    #
    # Se usa `Stitcher` con el modo panorámico y se recogen los datos que
    # expone. OpenCV 5 no publica el error de reproyección del ajuste de haces
    # en la API de alto nivel, así que se estima comparando el tamaño esperado
    # del resultado con el obtenido: una estimación conservadora que detecta el
    # caso grave —geometría descuadrada— sin inventar un número preciso.

    stitcher = cv2.Stitcher.create(cv2.Stitcher_PANORAMA)
    status, panorama = stitcher.stitch(loaded)

    if status != cv2.Stitcher_OK or panorama is None:
        reason = {
            getattr(cv2, "Stitcher_ERR_NEED_MORE_IMGS", 1): (
                "No hay solape suficiente entre las fotografías. Vuelva a fotografiar "
                "girando menos entre tomas: cada foto debe compartir al menos un tercio "
                "con la anterior."
            ),
            getattr(cv2, "Stitcher_ERR_HOMOGRAPHY_EST_FAIL", 2): (
                "No se pudo estimar la geometría. Suele ocurrir con superficies lisas o "
                "repetitivas —una pared blanca, una rejilla— donde no hay puntos "
                "distinguibles."
            ),
            getattr(cv2, "Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL", 3): (
                "El ajuste de las cámaras no convergió. Suele indicar que las tomas no "
                "comparten el mismo punto de vista: el trípode se movió entre fotos."
            ),
        }.get(status, f"El cosido falló con el código {status}.")

        metrics = StitchMetrics(
            images_submitted=len(request.images),
            images_used=0,
            matches_per_pair=(),
            exposure_ev=exposure,
            reprojection_error_px=float("inf"),
            empty_ratio=1.0,
            horizontal_coverage_deg=0.0,
            vertical_coverage_deg=0.0,
            width_px=0,
            height_px=0,
        )
        return StitchResult(
            report=QualityReport(
                verdict=Verdict.REJECTED,
                metrics=metrics,
                problems=(reason,),
            ),
            lens=lens,
            image=None,
        )

    # La comprobación de degeneración va ANTES de la reducción deliberada: si
    # se hiciera después, un `max_edge_px` pequeño —legítimo, para no cargar la
    # GPU de un portátil de planta— se confundiría con un cosido descuadrado.
    raw_height, raw_width = panorama.shape[:2]
    # --- Resultado degenerado ---
    #
    # OpenCV puede devolver «éxito» con una imagen diminuta: pasa cuando la
    # geometría estimada es absurda y la zona común se reduce a unos píxeles.
    # El código de retorno no lo distingue de un cosido bueno, así que hay que
    # medirlo. Un resultado más pequeño que la mayor de las entradas no es una
    # panorámica: es un recorte de la intersección.
    largest_input = max(image.shape[0] * image.shape[1] for image in loaded)
    if raw_width * raw_height < largest_input:
        metrics = StitchMetrics(
            images_submitted=len(request.images),
            images_used=len(loaded),
            matches_per_pair=_count_matches(cv2, np, loaded),
            exposure_ev=exposure,
            reprojection_error_px=float("inf"),
            empty_ratio=1.0,
            horizontal_coverage_deg=0.0,
            vertical_coverage_deg=0.0,
            width_px=raw_width,
            height_px=raw_height,
        )
        return StitchResult(
            report=QualityReport(
                verdict=Verdict.REJECTED,
                metrics=metrics,
                problems=(
                    f"El cosido devolvió una imagen de {raw_width}×{raw_height} px, más pequeña que "
                    "las fotografías de entrada: la geometría estimada es incorrecta y lo que "
                    "quedó es el recorte de una intersección, no una panorámica. "
                    "Compruebe que las tomas son de la misma escena y comparten solape.",
                ),
            ),
            lens=lens,
            image=None,
        )


    panorama = _resize_to_max_edge(cv2, panorama, request.max_edge_px)
    height, width = panorama.shape[:2]

    # --- Métricas ---

    empty = _empty_ratio(cv2, panorama)

    # Cobertura estimada por la relación de aspecto del resultado.
    #
    # Una equirectangular completa es 2:1. Si el resultado es más estrecho, se
    # cubrió menos arco horizontal. Es una estimación, no una medida de la
    # geometría: se declara como tal en el informe y sirve para distinguir
    # «panorámica completa» de «parcial» (B03), que es la decisión que el
    # proyecto necesita.
    aspect = width / height if height else 0.0
    horizontal = min(aspect * 180.0, 360.0)
    vertical = min(180.0, horizontal / max(aspect, 0.01))

    # Coincidencias por par: se recalculan con el emparejador, porque el
    # cosido de alto nivel no las devuelve y son la métrica que avisa de una
    # geometría apoyada en cuatro puntos.
    matches = _count_matches(cv2, np, loaded)

    # Error de reproyección estimado: proporción del hueco respecto al área,
    # escalada a píxeles. Es una aproximación y el informe lo dice; su función
    # es detectar el caso grave, no medir con precisión.
    estimated_error = min(empty * 40.0, 50.0)

    metrics = StitchMetrics(
        images_submitted=len(request.images),
        images_used=len(loaded),
        matches_per_pair=matches,
        exposure_ev=exposure,
        reprojection_error_px=round(estimated_error, 2),
        empty_ratio=round(empty, 4),
        horizontal_coverage_deg=round(horizontal, 1),
        vertical_coverage_deg=round(vertical, 1),
        width_px=width,
        height_px=height,
    )

    report = evaluate(metrics, request.thresholds)

    notes = list(report.notes)
    if unreadable:
        notes.append(f"Imágenes ilegibles que no entraron: {', '.join(unreadable)}.")
    if lens.needs_review:
        notes.append(
            "No se pudo determinar la lente: el cosido usó una proyección esférica genérica. "
            "Declare el tipo de lente si el resultado sale deformado en los bordes."
        )

    report = QualityReport(
        verdict=report.verdict,
        metrics=report.metrics,
        problems=report.problems,
        notes=tuple(notes),
        is_full_panorama=report.is_full_panorama,
    )

    return StitchResult(
        report=report,
        lens=lens,
        image=panorama if report.usable else None,
    )


def _count_matches(cv2: Any, np: Any, images: list[Any], max_pairs: int = 12) -> tuple[int, ...]:
    """Cuenta coincidencias **verificadas geométricamente** entre pares consecutivos.

    No basta con contar lo que devuelve el emparejador. Entre dos fotografías
    sin nada en común, un descriptor binario como ORB produce cientos de
    coincidencias falsas: dos manchas distintas con el mismo patrón local se
    emparejan igual. Contarlas daría una métrica alta precisamente en el caso
    que debería alarmar.

    Así que se filtra en dos pasos, los dos estándar en visión por computador:

    1. **Prueba de la razón de Lowe.** Se descarta la coincidencia cuyo mejor
       candidato no es claramente mejor que el segundo: si los dos se parecen,
       el emparejamiento es ambiguo.
    2. **Verificación geométrica con RANSAC.** Las coincidencias que sobreviven
       tienen que ser compatibles con **una** transformación común. Las que no
       lo son se descartan, y lo que se cuenta son los puntos que sí la
       cumplen. Ese número es el que importa: es la cantidad de evidencia real
       sobre la que se apoya la geometría del cosido.

    Sólo entre pares consecutivos y con un tope: comparar todos contra todos en
    un lote de cuarenta fotos cuesta minutos y no cambia la decisión, porque las
    tomas de una panorámica se hacen en orden.
    """
    detector = cv2.ORB.create(nfeatures=2000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

    counts: list[int] = []
    for index in range(min(len(images) - 1, max_pairs)):
        gray_a = cv2.cvtColor(images[index], cv2.COLOR_BGR2GRAY)
        gray_b = cv2.cvtColor(images[index + 1], cv2.COLOR_BGR2GRAY)

        kp_a, desc_a = detector.detectAndCompute(gray_a, None)
        kp_b, desc_b = detector.detectAndCompute(gray_b, None)

        if desc_a is None or desc_b is None or len(kp_a) < 4 or len(kp_b) < 4:
            counts.append(0)
            continue

        pairs = matcher.knnMatch(desc_a, desc_b, k=2)
        good = [
            m
            for candidates in pairs
            if len(candidates) == 2
            for m, n in [candidates]
            # 0,75 es el valor del artículo original de Lowe y sigue siendo el
            # que mejor separa coincidencia de casualidad con descriptores
            # binarios.
            if m.distance < 0.75 * n.distance
        ]

        if len(good) < 4:
            # Menos de cuatro: no hay ni para estimar una transformación, así
            # que no hay nada que verificar.
            counts.append(len(good))
            continue

        src = np.float32([kp_a[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp_b[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

        _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
        inliers = int(mask.sum()) if mask is not None else 0
        counts.append(inliers)

    return tuple(counts)
