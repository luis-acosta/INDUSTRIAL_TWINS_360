"""Pruebas de los puntos de control (B07).

El campo `control_points` existía en la petición desde el primer día y no se
usaba en ninguna parte: marcar veinte puntos daba exactamente el mismo fallo
que no marcar ninguno. Estas pruebas fijan lo que ahora hace, y sobre todo lo
que se niega a hacer: con menos de cuatro puntos no estima, con puntos
incoherentes no compone y dice cuál revisar, y con pares sueltos no inventa una
panorámica.

Las imágenes de prueba son recortes de una misma imagen con un desplazamiento
conocido. Eso permite comprobar el resultado contra la respuesta correcta —el
desplazamiento que se metió— en lugar de comprobar que «salió algo».
"""

from __future__ import annotations

import pytest

cv2 = pytest.importorskip("cv2", reason="El cosido necesita OpenCV")
np = pytest.importorskip("numpy")

from stitcher.control_points import (  # noqa: E402
    MAX_POINT_ERROR_PX,
    MIN_POINTS_PER_PAIR,
    ControlPointError,
    compose_pair,
    describe_estimate,
    estimate_pair,
    group_by_pair,
    parse_control_points,
    worst_point,
)
from stitcher.pipeline import StitchRequest, stitch  # noqa: E402


def textured(width: int, height: int, seed: int = 1) -> np.ndarray:
    """Imagen con textura suficiente para que las esquinas sean distinguibles."""
    rng = np.random.default_rng(seed)
    image = rng.integers(40, 215, size=(height, width, 3), dtype=np.uint8)
    for index in range(12):
        x = int(rng.integers(20, width - 20))
        y = int(rng.integers(20, height - 20))
        cv2.rectangle(image, (x - 12, y - 12), (x + 12, y + 12), (255, 255, 255), 2)
    return image


def pair_with_shift(shift: int = 120) -> tuple[np.ndarray, np.ndarray, int]:
    """Dos recortes de la misma escena con un desplazamiento conocido."""
    scene = textured(700, 400, seed=7)
    left = scene[:, :500].copy()
    right = scene[:, shift : shift + 500].copy()
    return left, right, shift


#: Cinco posiciones repartidas por la zona común.
#:
#: Cinco y no cuatro porque es el mínimo que acepta el servicio: con cuatro, la
#: homografía encaja de forma exacta sea cual sea su posición y una marca mal
#: puesta no se puede detectar.
POSITIONS = ((200, 80), (420, 90), (210, 320), (430, 300), (320, 200))


def exact_points(
    shift: int, pair: tuple[int, int] = (0, 1)
) -> tuple[tuple[int, int, float, float, float, float], ...]:
    """Puntos correctos: el mismo sitio físico en los dos recortes.

    Un punto que en la izquierda está en x cae en la derecha en x − shift, por
    construcción de los recortes. Que la respuesta sea conocida es lo que
    permite comprobar la geometría y no sólo que «no falló».
    """
    a, b = pair
    return tuple(
        (a, b, float(x), float(y), float(x - shift), float(y)) for x, y in POSITIONS
    )


class TestValidacion:
    def test_un_indice_fuera_de_rango_se_rechaza(self) -> None:
        # TEST-CPT-001: es un error del cliente y detectarlo al principio da un
        # mensaje que señala el punto concreto, en lugar de un fallo a mitad
        # del cosido.
        with pytest.raises(ControlPointError) as error:
            parse_control_points(((0, 5, 1, 1, 2, 2),), 2)
        assert error.value.code == "out_of_range"

    def test_un_par_consigo_mismo_se_rechaza(self) -> None:
        # TEST-CPT-002: no aporta geometría y suele venir de un error de
        # interfaz al elegir la segunda imagen.
        with pytest.raises(ControlPointError) as error:
            parse_control_points(((1, 1, 1, 1, 2, 2),), 2)
        assert error.value.code == "same_image"

    def test_una_tupla_incompleta_se_rechaza(self) -> None:
        # TEST-CPT-003: seis valores; con cinco, el último se interpretaría
        # como otra cosa y el punto quedaría en un sitio arbitrario.
        with pytest.raises(ControlPointError) as error:
            parse_control_points(((0, 1, 1, 1, 2),), 2)  # type: ignore[arg-type]
        assert error.value.code == "malformed"

    def test_el_orden_del_par_se_normaliza(self) -> None:
        # TEST-CPT-004: marcar cuatro puntos en un sentido y cuatro en el otro
        # tiene que dar un par de ocho, no dos pares de cuatro —que serían dos
        # pares insuficientes y el cosido se negaría a usarlos—.
        points = parse_control_points(
            ((0, 1, 10, 10, 20, 20), (1, 0, 30, 30, 40, 40)),
            2,
        )
        groups = group_by_pair(points)
        assert list(groups) == [(0, 1)]
        assert len(groups[(0, 1)]) == 2

    def test_al_normalizar_las_coordenadas_siguen_a_su_imagen(self) -> None:
        # TEST-CPT-005: al dar la vuelta al par hay que dar la vuelta también a
        # las coordenadas. Sin eso, el punto invertido señalaría el sitio
        # equivocado y la geometría saldría mal sin ningún aviso.
        [point] = parse_control_points(((1, 0, 30, 31, 40, 41),), 2)
        assert (point.image_a, point.image_b) == (0, 1)
        assert (point.x_a, point.y_a) == (40, 41)
        assert (point.x_b, point.y_b) == (30, 31)


class TestEstimacion:
    def test_necesita_cuatro_puntos(self) -> None:
        # TEST-CPT-006: cuatro es el mínimo matemático. Aceptar tres daría una
        # imagen deformada que el operador leería como un fallo del programa.
        points = parse_control_points(exact_points(120)[:4], 2)
        with pytest.raises(ControlPointError) as error:
            estimate_pair(points, cv2=cv2, np=np)
        assert error.value.code == "not_enough_points"
        assert str(MIN_POINTS_PER_PAIR) in error.value.reason

    def test_recupera_el_desplazamiento_conocido(self) -> None:
        # TEST-CPT-007: la prueba central. Los puntos describen un
        # desplazamiento de 120 px y la homografía tiene que reproducirlo.
        shift = 120
        points = parse_control_points(exact_points(shift), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)

        assert estimate.error_px < 0.01
        # La homografía lleva de B a A: el origen de B cae en x = shift de A.
        origin = cv2.perspectiveTransform(
            np.array([[[0.0, 0.0]]], dtype=np.float64), estimate.homography
        )
        assert abs(float(origin[0, 0, 0]) - shift) < 0.5
        assert abs(float(origin[0, 0, 1])) < 0.5

    def test_puntos_colineales_se_rechazan(self) -> None:
        # TEST-CPT-008: cuatro puntos en línea no determinan una homografía.
        # OpenCV devuelve algo, y ese algo deforma la imagen de un modo que
        # parece un fallo de cosido.
        collinear = tuple((0, 1, float(100 + 50 * i), 200.0, float(50 * i), 200.0) for i in range(5))
        points = parse_control_points(collinear, 2)
        estimate_or_error: object
        try:
            estimate = estimate_pair(points, cv2=cv2, np=np)
            # Si OpenCV no lo rechaza, el error de reproyección tiene que
            # delatarlo: lo que no puede es pasar por bueno.
            estimate_or_error = estimate.error_px
            assert estimate.error_px == float("inf") or estimate.error_px > MAX_POINT_ERROR_PX
        except ControlPointError as error:
            estimate_or_error = error.code
            assert error.code in {"degenerate", "implausible"}
        assert estimate_or_error is not None

    def test_senala_el_punto_que_mas_se_desvia(self) -> None:
        # TEST-CPT-009: «los puntos no cuadran» no es accionable; «revise el
        # punto 3» sí. Con una marca mal puesta entre ocho, encontrarla a ojo
        # lleva más que volver a marcarlas todas.
        shift = 120
        raw = list(exact_points(shift))
        # Se estropea el tercero: 60 px de error en una sola marca.
        a, b, x_a, y_a, x_b, y_b = raw[2]
        raw[2] = (a, b, x_a, y_a, x_b + 60, y_b - 40)

        points = parse_control_points(tuple(raw), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)

        assert estimate.error_px > MAX_POINT_ERROR_PX
        assert worst_point(estimate, points, cv2=cv2, np=np) == 2

    def test_el_resumen_dice_si_los_puntos_son_coherentes(self) -> None:
        # TEST-CPT-010: el informe del lote lo lee alguien que no estaba
        # delante cuando se marcaron.
        points = parse_control_points(exact_points(120), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)
        assert "coherentes" in describe_estimate(estimate)


class TestComposicion:
    def test_el_lienzo_abarca_las_dos_imagenes(self) -> None:
        # TEST-CPT-011: con un lienzo del tamaño de la primera, la parte de la
        # segunda que cae fuera —que es justamente lo que se quería añadir— se
        # perdería, y el resultado sería la primera imagen con otro nombre.
        left, right, shift = pair_with_shift()
        points = parse_control_points(exact_points(shift), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)

        result = compose_pair(left, right, estimate, cv2=cv2, np=np)

        assert result.shape[1] >= left.shape[1] + shift - 2
        assert result.shape[0] >= left.shape[0] - 2

    def test_la_zona_comun_coincide_con_el_original(self) -> None:
        # TEST-CPT-012: es la comprobación de que la geometría es correcta y no
        # sólo de que el lienzo tiene el tamaño adecuado. En la zona donde las
        # dos imágenes son la misma escena, el promedio tiene que parecerse
        # mucho a la escena.
        left, right, shift = pair_with_shift()
        points = parse_control_points(exact_points(shift), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)
        result = compose_pair(left, right, estimate, cv2=cv2, np=np)

        # Franja interior de la zona común, lejos de los bordes.
        got = result[100:300, shift + 40 : shift + 300].astype(np.int32)
        expected = left[100:300, shift + 40 : shift + 300].astype(np.int32)
        difference = float(np.mean(np.abs(got - expected)))
        assert difference < 6

    def test_respeta_el_lado_maximo(self) -> None:
        # TEST-CPT-013: el límite existe para no entregar una imagen que la GPU
        # de un portátil de planta no puede cargar.
        left, right, shift = pair_with_shift()
        points = parse_control_points(exact_points(shift), 2)
        estimate = estimate_pair(points, cv2=cv2, np=np)

        result = compose_pair(left, right, estimate, cv2=cv2, np=np, max_edge_px=200)
        assert max(result.shape[:2]) <= 200


class TestIntegracionConElCosido:
    def test_los_puntos_marcados_gobiernan_el_resultado(self, tmp_path) -> None:
        # TEST-CPT-014: la prueba que justifica el requisito. Antes, el campo
        # se aceptaba y se ignoraba; ahora, marcar los puntos produce una
        # panorámica cuyo ancho corresponde al desplazamiento declarado.
        left, right, shift = pair_with_shift()
        first = tmp_path / "a.png"
        second = tmp_path / "b.png"
        cv2.imwrite(str(first), left)
        cv2.imwrite(str(second), right)

        result = stitch(
            StitchRequest(
                images=(first, second),
                control_points=exact_points(shift),
                max_edge_px=0,
            )
        )

        assert result.image is not None
        assert result.image.shape[1] >= left.shape[1] + shift - 4
        assert any("puntos de control" in note.lower() for note in result.report.notes)

    def test_unos_puntos_incoherentes_no_se_usan_y_se_explica(self, tmp_path) -> None:
        # TEST-CPT-015: si se usaran, la panorámica saldría torcida sin que
        # nadie supiera por qué. El cosido automático sigue intentándolo y el
        # informe dice qué punto revisar.
        left, right, shift = pair_with_shift()
        first = tmp_path / "a.png"
        second = tmp_path / "b.png"
        cv2.imwrite(str(first), left)
        cv2.imwrite(str(second), right)

        raw = list(exact_points(shift))
        a, b, x_a, y_a, x_b, y_b = raw[1]
        raw[1] = (a, b, x_a, y_a, x_b + 90, y_b + 70)

        result = stitch(
            StitchRequest(images=(first, second), control_points=tuple(raw), max_edge_px=0)
        )

        avisos = " ".join(result.report.notes)
        assert "no utilizados" in avisos
        assert "punto 2" in avisos

    def test_faltar_un_par_de_la_cadena_se_explica(self, tmp_path) -> None:
        # TEST-CPT-016: un conjunto de pares sueltos no define una panorámica.
        # Pretender lo contrario pegaría trozos al azar.
        scene = textured(900, 400, seed=11)
        paths = []
        for index in range(3):
            path = tmp_path / f"{index}.png"
            cv2.imwrite(str(path), scene[:, index * 150 : index * 150 + 500].copy())
            paths.append(path)

        result = stitch(
            StitchRequest(
                images=tuple(paths),
                # Sólo el primer par: falta el 2–3.
                control_points=exact_points(150),
                max_edge_px=0,
            )
        )

        avisos = " ".join(result.report.notes)
        assert "falta el par 2–3" in avisos

    def test_con_tres_imagenes_avisa_de_la_acumulacion_de_error(self, tmp_path) -> None:
        # TEST-CPT-017: encadenar homografías no es un ajuste global, y
        # callarlo sería prometer una precisión que no se tiene.
        scene = textured(900, 400, seed=13)
        paths = []
        for index in range(3):
            path = tmp_path / f"{index}.png"
            cv2.imwrite(str(path), scene[:, index * 150 : index * 150 + 500].copy())
            paths.append(path)

        points = (*exact_points(150), *exact_points(150, pair=(1, 2)))

        result = stitch(StitchRequest(images=tuple(paths), control_points=points, max_edge_px=0))
        avisos = " ".join(result.report.notes)
        assert "se acumula" in avisos
