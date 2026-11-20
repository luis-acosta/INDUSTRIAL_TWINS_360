"""Puntos de control del cosido (B07).

Cuando el cosido automático falla —una pared blanca, una rejilla repetida, una
nave con poca textura— no hay nada que el operador pueda ajustar: el
emparejamiento automático no encuentra puntos distinguibles y el trabajo se
pierde. Los puntos de control son la salida: la persona señala en dos fotos el
mismo punto físico —la esquina de un cuadro eléctrico, un tornillo, el vértice
de una bandeja— y de ahí sale la geometría.

El campo `control_points` existía en la petición desde el primer día y no se
usaba en ninguna parte: el servicio lo aceptaba y lo ignoraba, de modo que un
operador podía marcar veinte puntos y obtener exactamente el mismo fallo.

Qué hace este módulo y qué no:

- **Sí**: estimar la homografía de un par a partir de los puntos marcados a
  mano, componer el par con ella, y medir el error de reproyección de esos
  mismos puntos, que es una medida honesta de si la geometría cuadra.
- **No**: sustituir al ajuste de haces de varias imágenes. Con tres o más
  fotos se encadenan homografías por pares, lo que acumula error; se dice en el
  informe y el resultado queda marcado como experimental, igual que el resto
  del cosido.

La homografía exige **cuatro** puntos por par: con tres, el sistema está
indeterminado y la imagen sale deformada de una manera que parece un error de
cosido. Esa es una comprobación y no un detalle de implementación.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Final

#: Puntos mínimos por par para estimar una homografía.
#:
#: Cuatro es el mínimo **matemático**: ocho grados de libertad, dos ecuaciones
#: por punto. Pero con exactamente cuatro, la homografía pasa por los cuatro de
#: forma exacta sea cual sea su posición, de modo que el error de reproyección
#: sale cero incluso si el operador marcó mal uno de ellos: no hay forma de
#: detectar la equivocación, y el resultado es una panorámica torcida sin
#: ningún aviso.
#:
#: Con cinco, el sistema está sobredeterminado y el residuo delata al punto
#: equivocado. Se pide uno más a cambio de poder decir «revise el punto 3», que
#: es lo que convierte esta función en utilizable. Marcar un quinto punto cuesta
#: segundos; descubrir a ojo cuál de cuatro está mal, no.
MIN_POINTS_PER_PAIR: Final[int] = 5

#: Error de reproyección por encima del cual los puntos no son coherentes.
#:
#: Tres píxeles es lo que se desvía una marca puesta a mano con cuidado. Por
#: encima de eso, lo normal es que dos de los puntos marcados no sean el mismo
#: punto físico —es el error humano más frecuente—, y seguir adelante daría una
#: panorámica torcida sin decir por qué.
MAX_POINT_ERROR_PX: Final[float] = 3.0


@dataclass(frozen=True, slots=True)
class ControlPoint:
    """El mismo punto físico señalado en dos fotografías.

    Los índices son posiciones en la lista de imágenes de la petición, no
    nombres de archivo: la lista es el orden en el que el operador las ve.
    """

    image_a: int
    image_b: int
    x_a: float
    y_a: float
    x_b: float
    y_b: float


@dataclass(frozen=True, slots=True)
class PairEstimate:
    """Geometría de un par, estimada a partir de sus puntos."""

    image_a: int
    image_b: int
    #: Homografía que lleva coordenadas de B a coordenadas de A.
    homography: Any
    #: Error de reproyección medio de los puntos marcados, en píxeles.
    error_px: float
    points_used: int


class ControlPointError(ValueError):
    """Los puntos marcados no permiten estimar la geometría."""

    def __init__(self, reason: str, *, code: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


def parse_control_points(
    raw: tuple[tuple[int, int, float, float, float, float], ...],
    image_count: int,
) -> list[ControlPoint]:
    """Valida la forma cruda que llega en la petición.

    Se valida aquí y no al usarlos porque un índice fuera de rango o un par
    consigo mismo son errores del cliente, y detectarlos al principio da un
    mensaje que señala el punto concreto en lugar de un fallo a mitad del
    cosido.
    """
    points: list[ControlPoint] = []
    for index, entry in enumerate(raw):
        if len(entry) != 6:
            raise ControlPointError(
                f"El punto de control {index + 1} no tiene seis valores "
                "(índice A, índice B, xA, yA, xB, yB)",
                code="malformed",
            )
        a, b, x_a, y_a, x_b, y_b = entry
        if not (0 <= a < image_count) or not (0 <= b < image_count):
            raise ControlPointError(
                f"El punto de control {index + 1} apunta a una imagen que no existe",
                code="out_of_range",
            )
        if a == b:
            raise ControlPointError(
                f"El punto de control {index + 1} une una imagen consigo misma",
                code="same_image",
            )
        # Se normaliza el orden del par para que (0,1) y (1,0) cuenten como el
        # mismo par: si no, marcar cuatro puntos en un sentido y cuatro en el
        # otro daría dos pares de cuatro en lugar de uno de ocho.
        if a < b:
            points.append(ControlPoint(a, b, float(x_a), float(y_a), float(x_b), float(y_b)))
        else:
            points.append(ControlPoint(b, a, float(x_b), float(y_b), float(x_a), float(y_a)))
    return points


def group_by_pair(points: list[ControlPoint]) -> dict[tuple[int, int], list[ControlPoint]]:
    """Agrupa los puntos por par de imágenes."""
    groups: dict[tuple[int, int], list[ControlPoint]] = {}
    for point in points:
        groups.setdefault((point.image_a, point.image_b), []).append(point)
    return groups


def estimate_pair(
    points: list[ControlPoint],
    *,
    cv2: Any,
    np: Any,
) -> PairEstimate:
    """Estima la homografía de un par y mide su error.

    Se usa el ajuste directo y no RANSAC: los puntos los puso una persona a
    mano, de modo que no hay valores aberrantes que descartar, y RANSAC con
    cuatro puntos descartaría alguno y dejaría el sistema indeterminado.
    """
    if len(points) < MIN_POINTS_PER_PAIR:
        raise ControlPointError(
            f"El par {points[0].image_a + 1}–{points[0].image_b + 1} tiene "
            f"{len(points)} punto(s) y hacen falta {MIN_POINTS_PER_PAIR}. Con cuatro, "
            "la geometría encaja siempre de forma exacta y una marca mal puesta no se "
            "puede detectar; con cinco se puede decir cuál revisar.",
            code="not_enough_points",
        )

    source = np.array([[p.x_b, p.y_b] for p in points], dtype=np.float64)
    target = np.array([[p.x_a, p.y_a] for p in points], dtype=np.float64)

    homography, _ = cv2.findHomography(source, target, 0)
    if homography is None:
        raise ControlPointError(
            f"El par {points[0].image_a + 1}–{points[0].image_b + 1} no admite una geometría: "
            "los puntos marcados son colineales o coinciden. Marque puntos repartidos por "
            "la zona común, no alineados.",
            code="degenerate",
        )

    plausibility = _implausible_reason(homography, np=np)
    if plausibility is not None:
        # Comprobación que no depende de los residuos, y por eso vale también
        # cuando hay justo los puntos mínimos: una homografía que da la vuelta
        # a la imagen o la escala veinte veces no puede venir de dos fotos de
        # la misma escena, aunque encaje con los puntos marcados.
        raise ControlPointError(
            f"El par {points[0].image_a + 1}–{points[0].image_b + 1} da una geometría "
            f"imposible ({plausibility}). Compruebe que los puntos marcados se "
            "corresponden de verdad entre las dos fotografías.",
            code="implausible",
        )

    error = _mean_reprojection_error(homography, source, target, np=np)
    return PairEstimate(
        image_a=points[0].image_a,
        image_b=points[0].image_b,
        homography=homography,
        error_px=round(error, 3),
        points_used=len(points),
    )


def _implausible_reason(homography: Any, np: Any) -> str | None:
    """Motivo por el que una homografía no puede venir de dos fotos vecinas.

    Dos tomas consecutivas de una panorámica se diferencian por un giro
    pequeño: la transformación entre ellas conserva aproximadamente el área y
    la orientación. Una que invierte la imagen o la escala un orden de magnitud
    viene de puntos mal emparejados, y detectarlo así —por la forma de la
    transformación y no por los residuos— funciona incluso con el número mínimo
    de puntos, donde los residuos no dicen nada.
    """
    linear = homography[:2, :2]
    determinant = float(np.linalg.det(linear))

    if abs(determinant) < 1e-6:
        return "la transformación colapsa la imagen"
    if determinant < 0:
        return "la transformación invierte la imagen como un espejo"
    scale = math.sqrt(abs(determinant))
    if scale > 8 or scale < 1 / 8:
        return f"la transformación escala la imagen {scale:.1f} veces"
    return None


def _mean_reprojection_error(homography: Any, source: Any, target: Any, *, np: Any) -> float:
    """Error medio de los puntos tras aplicar la homografía.

    Es la medida honesta de si los puntos marcados son coherentes entre sí: si
    el operador señaló por error dos puntos físicos distintos, este número
    sube y se puede decir cuál revisar.
    """
    ones = np.ones((source.shape[0], 1), dtype=np.float64)
    homogeneous = np.hstack([source, ones])
    projected = homogeneous @ homography.T

    w = projected[:, 2:3]
    # Un punto proyectado al infinito significa una homografía degenerada; se
    # evita la división y se devuelve un error grande, que es lo que es.
    if np.any(np.abs(w) < 1e-9):
        return float("inf")

    projected = projected[:, :2] / w
    distances = np.linalg.norm(projected - target, axis=1)
    return float(np.mean(distances))


def worst_point(
    estimate: PairEstimate,
    points: list[ControlPoint],
    *,
    cv2: Any,
    np: Any,
) -> int:
    """Índice del punto que probablemente está mal marcado.

    No se usa el residuo de cada punto, aunque sea lo primero que uno
    intentaría: el ajuste por mínimos cuadrados **reparte** el error entre
    todos los puntos, de modo que el residuo más grande suele caer en un punto
    correcto que quedó al otro lado del tirón. Se comprobó: con cinco puntos y
    el tercero mal marcado, el residuo mayor estaba en el quinto.

    Lo que sí funciona es dejar uno fuera: se reestima la geometría sin cada
    punto y se mira con cuál de las exclusiones el resto encaja mejor. El punto
    cuya ausencia más mejora el ajuste es el que estaba mal. Cuesta tantas
    estimaciones como puntos haya, que para un puñado de marcas puestas a mano
    es gratis.

    Esto exige que al quitar uno queden al menos cuatro, que es precisamente el
    motivo de que el servicio pida cinco.
    """
    if len(points) <= MIN_POINTS_PER_PAIR - 1:
        # Sin margen para dejar uno fuera: se devuelve el de mayor residuo,
        # que es lo único disponible, aunque sea menos fiable.
        return _largest_residual(estimate, points, np=np)

    best_index = 0
    best_error = float("inf")

    for index in range(len(points)):
        remaining = [point for position, point in enumerate(points) if position != index]
        source = np.array([[p.x_b, p.y_b] for p in remaining], dtype=np.float64)
        target = np.array([[p.x_a, p.y_a] for p in remaining], dtype=np.float64)

        homography, _ = cv2.findHomography(source, target, 0)
        if homography is None:
            continue

        error = _mean_reprojection_error(homography, source, target, np=np)
        if error < best_error:
            best_error = error
            best_index = index

    return best_index


def _largest_residual(estimate: PairEstimate, points: list[ControlPoint], *, np: Any) -> int:
    """Punto con el residuo mayor. Reserva para cuando no se puede dejar uno fuera."""
    source = np.array([[p.x_b, p.y_b] for p in points], dtype=np.float64)
    target = np.array([[p.x_a, p.y_a] for p in points], dtype=np.float64)
    ones = np.ones((source.shape[0], 1), dtype=np.float64)
    projected = np.hstack([source, ones]) @ estimate.homography.T

    w = projected[:, 2:3]
    w = np.where(np.abs(w) < 1e-9, 1e-9, w)
    projected = projected[:, :2] / w
    distances = np.linalg.norm(projected - target, axis=1)
    return int(np.argmax(distances))


def compose_pair(
    image_a: Any,
    image_b: Any,
    estimate: PairEstimate,
    *,
    cv2: Any,
    np: Any,
    max_edge_px: int = 16384,
) -> Any:
    """Compone dos imágenes con la geometría estimada a mano.

    El lienzo se calcula a partir de las esquinas de B transformadas, de modo
    que no se recorta nada: con un lienzo del tamaño de A, la parte de B que
    cae fuera —que es justamente lo que se quería añadir— se perdería.

    La mezcla es un promedio en la zona común. No es una mezcla multibanda, que
    es lo que elimina la costura visible, y por eso el resultado va marcado:
    sirve para recuperar un cosido que de otro modo se perdía, no para
    sustituir al automático cuando éste funciona.
    """
    h_a, w_a = image_a.shape[:2]
    h_b, w_b = image_b.shape[:2]

    corners_b = np.array(
        [[0, 0], [w_b, 0], [w_b, h_b], [0, h_b]], dtype=np.float64
    ).reshape(-1, 1, 2)
    warped_corners = cv2.perspectiveTransform(corners_b, estimate.homography).reshape(-1, 2)

    xs = np.concatenate([warped_corners[:, 0], np.array([0.0, float(w_a)])])
    ys = np.concatenate([warped_corners[:, 1], np.array([0.0, float(h_a)])])

    min_x, max_x = float(np.min(xs)), float(np.max(xs))
    min_y, max_y = float(np.min(ys)), float(np.max(ys))

    width = int(math.ceil(max_x - min_x))
    height = int(math.ceil(max_y - min_y))
    if width <= 0 or height <= 0 or width * height > 1 << 30:
        raise ControlPointError(
            "La geometría estimada produce un lienzo imposible: revise que los puntos "
            "marcados se corresponden de verdad entre las dos fotografías.",
            code="degenerate",
        )

    # Traslación para que todo caiga en coordenadas positivas.
    offset = np.array([[1, 0, -min_x], [0, 1, -min_y], [0, 0, 1]], dtype=np.float64)

    canvas = cv2.warpPerspective(
        image_b, offset @ estimate.homography, (width, height), flags=cv2.INTER_LINEAR
    )
    placed_a = cv2.warpPerspective(image_a, offset, (width, height), flags=cv2.INTER_LINEAR)

    # Máscaras de lo que ha escrito cada imagen, para promediar sólo donde las
    # dos aportan y no oscurecer los bordes con el negro de la otra.
    mask_a = cv2.warpPerspective(
        np.full((h_a, w_a), 255, dtype=np.uint8), offset, (width, height), flags=cv2.INTER_NEAREST
    )
    mask_b = cv2.warpPerspective(
        np.full((h_b, w_b), 255, dtype=np.uint8),
        offset @ estimate.homography,
        (width, height),
        flags=cv2.INTER_NEAREST,
    )

    both = (mask_a > 0) & (mask_b > 0)
    only_a = (mask_a > 0) & ~both

    result = canvas.copy()
    result[only_a] = placed_a[only_a]
    if np.any(both):
        blended = (placed_a[both].astype(np.float32) + canvas[both].astype(np.float32)) / 2
        result[both] = blended.astype(result.dtype)

    if max_edge_px > 0 and max(width, height) > max_edge_px:
        scale = max_edge_px / max(width, height)
        result = cv2.resize(
            result,
            (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    return result


def describe_estimate(estimate: PairEstimate) -> str:
    """Resumen legible, para el informe del trabajo."""
    quality = "coherentes" if estimate.error_px <= MAX_POINT_ERROR_PX else "incoherentes"
    return (
        f"Par {estimate.image_a + 1}–{estimate.image_b + 1}: "
        f"{estimate.points_used} puntos {quality}, "
        f"error medio {estimate.error_px:.2f} px."
    )
