"""Pruebas del procesamiento por lotes.

Lo que se protege aquí es que un lote de doscientos trabajos sobreviva a los
tres o cuatro que van a salir mal, y que el informe final sea útil para quien
tiene que decidir si vuelve a la planta con la cámara.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from stitcher.batch import (
    BatchItem,
    ProgressTracker,
    format_report,
    run_batch,
)
from stitcher.quality import Verdict

cv2 = pytest.importorskip("cv2", reason="El cosido necesita OpenCV")
np = pytest.importorskip("numpy")

from tests.test_pipeline import scene  # noqa: E402 — depende de importorskip


@pytest.fixture()
def good_pair(tmp_path: Path) -> tuple[Path, ...]:
    full = scene(1600, 700)
    first = tmp_path / "buena-1.jpg"
    second = tmp_path / "buena-2.jpg"
    cv2.imwrite(str(first), full[:, 0:900])
    cv2.imwrite(str(second), full[:, 500:1400])
    return (first, second)


@pytest.fixture()
def bad_pair(tmp_path: Path) -> tuple[Path, ...]:
    first = tmp_path / "mala-1.jpg"
    second = tmp_path / "mala-2.jpg"
    cv2.imwrite(str(first), scene(800, 600))
    cv2.imwrite(str(second), scene(800, 600)[::-1, ::-1])
    return (first, second)


class TestResistenciaDelLote:
    def test_un_trabajo_fallido_no_detiene_el_lote(
        self, good_pair: tuple[Path, ...], bad_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-001: en un lote de doscientos, parar en el primero malo
        # desperdicia media hora de máquina.
        report = run_batch(
            [
                BatchItem(name="sala-bombas", images=good_pair),
                BatchItem(name="imposible", images=bad_pair),
                BatchItem(name="plataforma", images=good_pair),
            ]
        )

        assert len(report.outcomes) == 3
        assert len(report.accepted) + len(report.needs_review) == 2
        assert len(report.rejected) == 1

    def test_una_carpeta_con_una_sola_foto_se_anota_y_se_sigue(
        self, good_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-002: una carpeta mal armada es un error del usuario, no del
        # servicio, y no debe costarle el lote entero.
        report = run_batch(
            [
                BatchItem(name="incompleta", images=(good_pair[0],)),
                BatchItem(name="completa", images=good_pair),
            ]
        )

        assert len(report.failed) == 1
        assert report.failed[0].name == "incompleta"
        assert "al menos dos" in (report.failed[0].failure or "")
        assert len(report.outcomes) == 2

    def test_un_lote_vacio_no_es_un_error(self) -> None:
        # TEST-STB-003
        report = run_batch([])
        assert report.outcomes == ()
        assert report.duration_seconds >= 0


class TestProgreso:
    def test_informa_del_trabajo_en_curso_y_no_solo_del_recuento(
        self, good_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-004: «23 de 40» no dice nada cuando uno tarda cuatro
        # minutos; con el nombre se sabe si se atascó en algo concreto.
        tracker = ProgressTracker()
        run_batch(
            [
                BatchItem(name="primera", images=good_pair),
                BatchItem(name="segunda", images=good_pair),
            ],
            on_progress=tracker,
        )

        assert tracker.total == 2
        assert tracker.history == ["primera", "segunda"]
        assert "segunda" in tracker.describe()

    def test_la_fraccion_avanza(self, good_pair: tuple[Path, ...]) -> None:
        # TEST-STB-005
        avances: list[float] = []
        tracker = ProgressTracker()

        def spy(index: int, total: int, name: str) -> None:
            tracker(index, total, name)
            avances.append(tracker.fraction)

        run_batch([BatchItem(name=f"t{i}", images=good_pair) for i in range(3)], on_progress=spy)

        assert avances == [0.0, pytest.approx(1 / 3), pytest.approx(2 / 3)]

    def test_sin_trabajos_el_progreso_no_divide_por_cero(self) -> None:
        # TEST-STB-006
        tracker = ProgressTracker()
        assert tracker.fraction == 0.0
        assert tracker.describe() == "Sin trabajos"


class TestInforme:
    def test_lo_que_hay_que_volver_a_fotografiar_va_primero(
        self, good_pair: tuple[Path, ...], bad_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-007: es lo que obliga a volver a la planta, y conviene
        # leerlo antes de desmontar el trípode.
        report = run_batch(
            [
                BatchItem(name="buena", images=good_pair),
                BatchItem(name="mala", images=bad_pair),
            ]
        )
        texto = format_report(report)

        posicion_rechazo = texto.index("Hay que volver a fotografiar")
        assert "Aceptables" not in texto or posicion_rechazo < texto.index("Aceptables")

    def test_el_informe_explica_el_motivo_de_cada_rechazo(
        self, bad_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-008: «falló» a secas no le dice al fotógrafo qué hacer.
        report = run_batch([BatchItem(name="mala", images=bad_pair)])
        texto = format_report(report)

        assert "mala" in texto
        assert len(report.rejected) == 1
        # Alguno de los problemas concretos aparece en el informe.
        problema = report.rejected[0].result
        assert problema is not None
        assert problema.report.problems[0][:40] in texto

    def test_el_informe_recuerda_que_la_funcion_es_experimental(
        self, good_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-009: incluso los trabajos aceptables entran marcados.
        report = run_batch([BatchItem(name="buena", images=good_pair)])
        texto = format_report(report)

        assert "experimental" in texto.lower()
        assert "girar" in texto.lower()

    def test_los_trabajos_que_no_se_pudieron_intentar_se_distinguen_de_los_rechazados(
        self, good_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-010: «tu carpeta está mal armada» y «estas fotos no se
        # pueden coser» llevan a acciones distintas.
        report = run_batch(
            [
                BatchItem(name="carpeta-mala", images=(good_pair[0],)),
                BatchItem(name="buena", images=good_pair),
            ]
        )
        texto = format_report(report)

        assert "No se pudieron intentar" in texto
        assert report.failed[0].verdict is None
        assert all(o.verdict is not None for o in report.rejected)


class TestClasificacion:
    def test_cada_trabajo_cae_en_una_sola_categoria(
        self, good_pair: tuple[Path, ...], bad_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-011: un trabajo contado dos veces haría que los totales del
        # informe no cuadrasen con la lista.
        report = run_batch(
            [
                BatchItem(name="a", images=good_pair),
                BatchItem(name="b", images=bad_pair),
                BatchItem(name="c", images=(good_pair[0],)),
            ]
        )

        total = (
            len(report.accepted)
            + len(report.needs_review)
            + len(report.rejected)
            + len(report.failed)
        )
        assert total == len(report.outcomes) == 3

    def test_lo_entregable_coincide_con_lo_no_rechazado(
        self, good_pair: tuple[Path, ...]
    ) -> None:
        # TEST-STB-012: lo que necesita revisión se entrega marcado, no se
        # esconde: esconderlo obligaría a repetir el cosido para verlo.
        report = run_batch([BatchItem(name="a", images=good_pair)])

        for outcome in report.outcomes:
            if outcome.verdict in (Verdict.ACCEPTED, Verdict.NEEDS_REVIEW):
                assert outcome.usable is True
            elif outcome.verdict is Verdict.REJECTED:
                assert outcome.usable is False
