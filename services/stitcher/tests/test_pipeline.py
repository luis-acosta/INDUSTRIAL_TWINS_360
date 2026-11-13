"""Pruebas de la tubería de cosido, con OpenCV de verdad.

Las imágenes se generan por código: dos recortes solapados de una misma escena
sintética con textura suficiente para que haya puntos característicos. Es la
única forma de probar un cosido sin meter fotografías en el repositorio, y tiene
una ventaja: la verdad de referencia se conoce, porque los recortes se hicieron
con un desplazamiento conocido.

Las pruebas que necesitan OpenCV se saltan si no está instalado, en lugar de
fallar. El cosido es opcional y un entorno sin él es legítimo; lo que no sería
legítimo es que la suite entera dejara de pasar por una dependencia opcional.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from stitcher.lens import LensType
from stitcher.pipeline import PROJECTIONS, StitchRequest, StitcherUnavailable, stitch
from stitcher.quality import Verdict

cv2 = pytest.importorskip("cv2", reason="El cosido necesita OpenCV")
np = pytest.importorskip("numpy")


def scene(width: int = 1200, height: int = 600) -> "np.ndarray":
    """Escena sintética con textura suficiente para el emparejamiento.

    Una pared lisa no se puede coser —no hay puntos distinguibles— y una prueba
    con una pared lisa no probaría el cosido, sino el fallo. Se generan manchas
    y líneas pseudoaleatorias deterministas: textura rica y reproducible.
    """
    generator = np.random.default_rng(seed=20260301)
    image = np.zeros((height, width, 3), dtype=np.uint8)

    # Degradado de fondo, para que las zonas sin mancha no sean negras.
    for y in range(height):
        image[y, :, :] = int(40 + 120 * (y / height))

    for _ in range(600):
        x = int(generator.integers(0, width))
        y = int(generator.integers(0, height))
        radius = int(generator.integers(4, 22))
        color = tuple(int(c) for c in generator.integers(30, 230, size=3))
        cv2.circle(image, (x, y), radius, color, -1)

    for _ in range(80):
        x1, y1, x2, y2 = (int(v) for v in generator.integers(0, min(width, height), size=4))
        color = tuple(int(c) for c in generator.integers(60, 250, size=3))
        cv2.line(image, (x1, y1), (x2 % width, y2 % height), color, 2)

    return image


@pytest.fixture()
def overlapping_pair(tmp_path: Path) -> tuple[Path, ...]:
    """Dos recortes con un 45 % de solape."""
    full = scene(1600, 700)
    left = full[:, 0:900]
    right = full[:, 500:1400]

    first = tmp_path / "toma-1.jpg"
    second = tmp_path / "toma-2.jpg"
    cv2.imwrite(str(first), left)
    cv2.imwrite(str(second), right)
    return (first, second)


@pytest.fixture()
def disjoint_pair(tmp_path: Path) -> tuple[Path, ...]:
    """Dos imágenes sin nada en común: el cosido debe fallar y decirlo."""
    first = tmp_path / "a.jpg"
    second = tmp_path / "b.jpg"
    cv2.imwrite(str(first), scene(800, 600))
    cv2.imwrite(str(second), scene(800, 600)[::-1, ::-1])
    return (first, second)


class TestValidacionDeEntrada:
    def test_una_sola_imagen_no_es_un_cosido(self, tmp_path: Path) -> None:
        # TEST-STP-001
        path = tmp_path / "sola.jpg"
        cv2.imwrite(str(path), scene(400, 300))

        with pytest.raises(ValueError, match="al menos dos"):
            stitch(StitchRequest(images=(path,)))

    def test_una_proyeccion_inventada_se_rechaza(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-002: pasarla a OpenCV produciría un error incomprensible.
        with pytest.raises(ValueError, match="Proyección no admitida"):
            stitch(StitchRequest(images=overlapping_pair, projection="plana-rara"))

    def test_las_proyecciones_admitidas_estan_declaradas(self) -> None:
        # TEST-STP-003 (B04)
        assert "spherical" in PROJECTIONS
        assert "cylindrical" in PROJECTIONS
        assert len(PROJECTIONS) >= 4

    def test_imagenes_ilegibles_se_informan(self, tmp_path: Path) -> None:
        # TEST-STP-004: un archivo corrupto entre veinte no debe tumbar el
        # lote sin decir cuál era.
        good = tmp_path / "buena.jpg"
        cv2.imwrite(str(good), scene(400, 300))
        bad = tmp_path / "corrupta.jpg"
        bad.write_bytes(b"esto no es un JPEG")

        with pytest.raises(ValueError, match="corrupta.jpg"):
            stitch(StitchRequest(images=(good, bad)))


class TestCosidoReal:
    def test_cose_dos_tomas_solapadas(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-005: la prueba que demuestra que la tubería funciona de
        # verdad y no sólo que juzga bien.
        result = stitch(StitchRequest(images=overlapping_pair))

        assert result.report.verdict is not Verdict.REJECTED, result.report.problems
        assert result.image is not None
        # El resultado es más ancho que cualquiera de las dos tomas: se unieron.
        assert result.image.shape[1] > 900

    def test_el_resultado_entregado_lleva_el_aviso(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-006
        result = stitch(StitchRequest(images=overlapping_pair))
        assert "experimental" in result.notice.lower()

    def test_mide_las_coincidencias_por_par(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-007: sin esta métrica no se puede saber si la geometría se
        # apoya en cuatro puntos, y es la razón de no usar la API de alto nivel
        # a secas.
        result = stitch(StitchRequest(images=overlapping_pair))

        assert len(result.report.metrics.matches_per_pair) == 1
        assert result.report.metrics.min_matches > 0

    def test_mide_la_exposicion_de_cada_toma(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-008 (B08)
        result = stitch(StitchRequest(images=overlapping_pair))

        assert len(result.report.metrics.exposure_ev) == 2
        # Los dos recortes vienen de la misma escena: la dispersión es pequeña.
        assert result.report.metrics.exposure_spread_ev < 1.0

    def test_limita_el_lado_mayor(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-009: una equirectangular de 32 000 px no la carga la GPU de
        # un portátil de planta.
        result = stitch(StitchRequest(images=overlapping_pair, max_edge_px=600))

        assert result.image is not None
        assert max(result.image.shape[:2]) <= 600


class TestCosidoQueFalla:
    def test_dos_imagenes_sin_solape_se_rechazan_con_motivo_util(
        self, disjoint_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STP-010: el motivo tiene que decirle al fotógrafo qué hacer
        # distinto, no devolverle un código de error.
        result = stitch(StitchRequest(images=disjoint_pair))

        assert result.report.verdict is Verdict.REJECTED
        assert result.image is None
        assert result.delivered is False

        motivo = " ".join(result.report.problems)
        assert any(
            pista in motivo
            for pista in ("solape", "geometría", "punto de vista", "cosido falló")
        )

    def test_el_fallo_no_lanza_una_excepcion(self, disjoint_pair: tuple[Path, ...]) -> None:
        # TEST-STP-011: un cosido fallido es un resultado del servicio, no un
        # error del programa. Si lanzara, un lote de cuarenta se detendría en
        # la primera foto mala.
        result = stitch(StitchRequest(images=disjoint_pair))
        assert result.report.metrics.images_submitted == 2


class TestLente:
    def test_sin_declaracion_la_lente_queda_sin_determinar_y_se_avisa(
        self, overlapping_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STP-012: suponer «estándar» produciría bordes estirados que
        # parecen un defecto del cosido y no de la suposición.
        result = stitch(StitchRequest(images=overlapping_pair))

        assert result.lens.lens_type is LensType.UNKNOWN
        assert result.lens.needs_review is True
        assert any("no se pudo determinar la lente" in note.lower() for note in result.report.notes)

    def test_la_lente_declarada_se_respeta(self, overlapping_pair: tuple[Path, ...]) -> None:
        # TEST-STP-013 (B02): el usuario conoce su equipo, y puede saber que la
        # foto está recortada, caso en el que el EXIF miente.
        result = stitch(
            StitchRequest(images=overlapping_pair, declared_lens=LensType.FISHEYE)
        )

        assert result.lens.lens_type is LensType.FISHEYE
        assert result.lens.warp_model == "fisheye"
        assert result.lens.needs_review is False


class TestEntornoSinOpenCv:
    def test_la_ausencia_de_opencv_se_explica(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # TEST-STP-014: un servidor que no arranca por una dependencia opcional
        # deja sin recorridos a quien no usa el cosido.
        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args: object, **kwargs: object) -> object:
            if name == "cv2":
                raise ImportError("sin cv2")
            return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(builtins, "__import__", fake_import)

        with pytest.raises(StitcherUnavailable, match="OpenCV"):
            stitch(StitchRequest(images=(Path("a.jpg"), Path("b.jpg"))))
