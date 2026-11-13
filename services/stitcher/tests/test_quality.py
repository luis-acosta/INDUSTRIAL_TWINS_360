"""Pruebas de la evaluación de calidad.

Son las pruebas que sostienen la honestidad del servicio. El cosido automático
sale mal con cierta frecuencia —es un algoritmo avanzado sobre fotografías que
no controlamos— y lo único inaceptable es entregar un resultado malo como si
fuera bueno. Cada prueba de aquí describe una forma concreta de salir mal y
comprueba que el veredicto la recoge.
"""

from __future__ import annotations

import pytest

from stitcher.quality import (
    EXPERIMENTAL_NOTICE,
    DEFAULT_THRESHOLDS,
    StitchMetrics,
    Thresholds,
    Verdict,
    describe,
    evaluate,
)


def metrics(**overrides: object) -> StitchMetrics:
    """Cosido bueno, con lo que se le indique cambiado."""
    base: dict[str, object] = {
        "images_submitted": 8,
        "images_used": 8,
        "matches_per_pair": (120, 98, 140, 88, 110, 95, 130),
        "exposure_ev": (0.0, 0.1, -0.1, 0.05, 0.0, -0.05, 0.02, -0.02),
        "reprojection_error_px": 1.2,
        "empty_ratio": 0.01,
        "horizontal_coverage_deg": 360.0,
        "vertical_coverage_deg": 180.0,
        "width_px": 8192,
        "height_px": 4096,
    }
    base.update(overrides)
    return StitchMetrics(**base)  # type: ignore[arg-type]


class TestCosidoBueno:
    def test_un_cosido_limpio_se_acepta(self) -> None:
        # TEST-STQ-001
        report = evaluate(metrics())

        assert report.verdict is Verdict.ACCEPTED
        assert report.problems == ()
        assert report.usable is True
        assert report.is_full_panorama is True

    def test_incluso_aceptado_sigue_llevando_el_aviso_experimental(self) -> None:
        # TEST-STQ-002: el aviso vive en el módulo que juzga, no en la pantalla
        # que muestra, para que no haya forma de entregar un cosido sin él.
        assert "experimental" in EXPERIMENTAL_NOTICE.lower()
        assert "Revise el resultado" in EXPERIMENTAL_NOTICE


class TestImagenesQueNoEncajan:
    def test_con_menos_de_dos_imagenes_encajadas_se_rechaza(self) -> None:
        # TEST-STQ-003
        report = evaluate(metrics(images_used=1))

        assert report.verdict is Verdict.REJECTED
        assert report.usable is False
        assert "solape suficiente" in report.problems[0]

    def test_perder_una_imagen_pide_revision(self) -> None:
        # TEST-STQ-004: falta parte de la escena, pero lo cosido puede servir.
        report = evaluate(metrics(images_submitted=8, images_used=7))

        assert report.verdict is Verdict.NEEDS_REVIEW
        assert "quedaron fuera" in report.problems[0]

    def test_perder_un_tercio_de_las_imagenes_rechaza(self) -> None:
        # TEST-STQ-005: el resultado ya no representa lo que se fotografió, así
        # que no es un punto de partida válido.
        report = evaluate(metrics(images_submitted=9, images_used=5))

        assert report.verdict is Verdict.REJECTED


class TestGeometria:
    def test_pocas_coincidencias_piden_revision(self) -> None:
        # TEST-STQ-006: con cuatro puntos, un reflejo desvía la geometría.
        report = evaluate(metrics(matches_per_pair=(120, 12, 140)))

        assert report.verdict is Verdict.NEEDS_REVIEW
        assert any("coincidencias" in problem for problem in report.problems)

    def test_el_par_peor_es_el_que_decide(self) -> None:
        # TEST-STQ-007: promediar escondería el eslabón débil, que es el que
        # parte la panorámica.
        report = evaluate(metrics(matches_per_pair=(500, 500, 10, 500)))
        assert report.verdict is Verdict.NEEDS_REVIEW

    def test_error_de_reproyeccion_alto_pide_revision(self) -> None:
        # TEST-STQ-008: es el síntoma del contorno doble.
        report = evaluate(metrics(reprojection_error_px=5.0))

        assert report.verdict is Verdict.NEEDS_REVIEW
        assert any("doble contorno" in problem for problem in report.problems)

    def test_error_de_reproyeccion_desastroso_rechaza(self) -> None:
        # TEST-STQ-009: por encima del triple del umbral los contornos dobles
        # se ven a simple vista.
        report = evaluate(metrics(reprojection_error_px=20.0))
        assert report.verdict is Verdict.REJECTED


class TestFotometria:
    def test_exposiciones_dispares_piden_revision(self) -> None:
        # TEST-STQ-010: la costura se ve como un escalón de brillo aunque la
        # geometría sea perfecta.
        report = evaluate(metrics(exposure_ev=(0.0, 2.5, 0.1)))

        assert report.verdict is Verdict.NEEDS_REVIEW
        assert any("exposición" in problem for problem in report.problems)
        assert any("exposición manual fija" in problem for problem in report.problems)

    def test_el_rango_y_no_la_desviacion_decide(self) -> None:
        # TEST-STQ-011: una sola imagen mal expuesta produce una costura
        # visible; la desviación típica la diluiría entre las demás.
        muchas_bien_una_mal = (0.0,) * 20 + (3.0,)
        report = evaluate(metrics(exposure_ev=muchas_bien_una_mal))

        assert report.metrics.exposure_spread_ev == pytest.approx(3.0)
        assert report.verdict is Verdict.NEEDS_REVIEW

    def test_una_sola_imagen_no_tiene_dispersion(self) -> None:
        # TEST-STQ-012
        assert metrics(exposure_ev=(0.5,)).exposure_spread_ev == 0.0


class TestHuecos:
    def test_algunos_huecos_piden_revision(self) -> None:
        # TEST-STQ-013
        report = evaluate(metrics(empty_ratio=0.15))

        assert report.verdict is Verdict.NEEDS_REVIEW
        assert any("píxeles vacíos" in problem for problem in report.problems)

    def test_muchos_huecos_rechazan(self) -> None:
        # TEST-STQ-014
        assert evaluate(metrics(empty_ratio=0.4)).verdict is Verdict.REJECTED


class TestCobertura:
    def test_una_panoramica_parcial_es_un_resultado_legitimo(self) -> None:
        # TEST-STQ-015: B03 admite panorámicas parciales; no es un problema,
        # pero el usuario que fotografió en círculo tiene que enterarse.
        report = evaluate(metrics(horizontal_coverage_deg=180.0, vertical_coverage_deg=90.0))

        assert report.verdict is Verdict.ACCEPTED
        assert report.is_full_panorama is False
        assert any("parcial" in note for note in report.notes)

    def test_la_cobertura_completa_se_declara(self) -> None:
        # TEST-STQ-016
        report = evaluate(metrics(horizontal_coverage_deg=358.0))

        assert report.is_full_panorama is True
        assert any("completa" in note for note in report.notes)

    def test_una_franja_estrecha_se_advierte_sin_bloquear(self) -> None:
        # TEST-STQ-017
        report = evaluate(metrics(vertical_coverage_deg=40.0))

        assert report.verdict is Verdict.ACCEPTED
        assert any("franja estrecha" in note for note in report.notes)


class TestUmbralesAjustables:
    def test_el_cliente_puede_endurecer_los_umbrales(self) -> None:
        # TEST-STQ-018: un cliente que entrega recorridos a terceros puede
        # querer un criterio más estricto que el de partida.
        estricto = Thresholds(max_exposure_spread_ev=0.2, min_matches_per_pair=200)
        report = evaluate(metrics(), estricto)

        assert report.verdict is Verdict.NEEDS_REVIEW

    def test_los_umbrales_de_partida_aceptan_un_cosido_normal(self) -> None:
        # TEST-STQ-019: un criterio de partida que rechaza lo normal haría que
        # el servicio no sirviera para nada.
        assert evaluate(metrics(), DEFAULT_THRESHOLDS).verdict is Verdict.ACCEPTED


class TestResumen:
    def test_el_resumen_cabe_en_una_linea_y_dice_lo_esencial(self) -> None:
        # TEST-STQ-020: es lo que se ve en un listado de lote de cuarenta
        # trabajos, donde no cabe el informe completo.
        report = evaluate(metrics(images_used=7, images_submitted=8))
        line = describe(report)

        assert "Requiere revisión" in line
        assert "7/8 imágenes" in line
        assert "360°×180°" in line
        assert "\n" not in line
