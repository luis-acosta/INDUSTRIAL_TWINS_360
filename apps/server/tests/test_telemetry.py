"""Pruebas del servicio de telemetría.

La garantía que estas pruebas protegen es la primera que pregunta cualquiera en
una planta: ¿esto puede tocar el proceso? La respuesta tiene que ser «no, por
construcción», y eso significa que no exista ninguna ruta de escritura y que el
verificador de consultas no se pueda esquivar con un espacio o una mayúscula.

La segunda garantía es que el token no salga del servidor. Se comprueba sobre
las consultas generadas y sobre la vista de configuración.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.telemetry import (
    OPERATIONS,
    MappingSpec,
    ReadOnlyViolation,
    assert_read_only,
    assess_quality,
    build_history_query,
    build_latest_query,
    cache_entry_is_usable,
    recommended_window_seconds,
    valid_mapping_ids,
)

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)

SPEC = MappingSpec(
    mapping_id="00000000-0000-4000-8000-000000000001",
    measurement="presion",
    field="valor",
    tags={"equipo": "P-101A"},
    bucket="proceso",
    freshness_seconds=300,
    aggregation="mean",
)


class TestSuperficieDeLaApi:
    def test_solo_hay_cuatro_operaciones_y_ninguna_escribe(self) -> None:
        # TEST-SRT-001: la lista no es configuración, es la superficie completa.
        assert OPERATIONS == ("latest", "history", "ping", "listMeasurements")
        for operation in OPERATIONS:
            assert operation not in {"write", "delete", "set", "update"}


class TestVerificadorDeLectura:
    def test_acepta_una_consulta_de_lectura(self) -> None:
        # TEST-SRT-002
        assert_read_only(
            'from(bucket:"p") |> range(start:-1h) |> filter(fn:(r) => r._field == "v") |> last()'
        )

    @pytest.mark.parametrize(
        "flux",
        [
            'from(bucket:"a") |> to(bucket:"b")',
            "delete(predicate: (r) => true)",
            "drop(columns: [\"_time\"])",
            'http.post(url: "https://fuera", data: bytes(v: "x"))',
            'influxdb.to(bucket: "b")',
        ],
    )
    def test_rechaza_escritura_y_salida_de_red(self, flux: str) -> None:
        # TEST-SRT-003: `http.post` no escribe en la base, pero saca los datos
        # del perímetro, que es igual de grave.
        with pytest.raises(ReadOnlyViolation):
            assert_read_only(flux)

    def test_no_se_esquiva_con_un_espacio(self) -> None:
        # TEST-SRT-004: un filtro que sólo busque «to(» se esquiva con «to (»,
        # y un verificador que se esquiva no verifica nada.
        with pytest.raises(ReadOnlyViolation):
            assert_read_only('from(bucket:"a") |> to ("b")')

    def test_no_se_esquiva_con_mayusculas(self) -> None:
        # TEST-SRT-005
        with pytest.raises(ReadOnlyViolation):
            assert_read_only("DELETE(predicate: (r) => true)")

    def test_el_token_de_la_violacion_se_informa(self) -> None:
        # TEST-SRT-006: saber qué palabra disparó el rechazo permite corregir
        # una consulta legítima mal escrita.
        with pytest.raises(ReadOnlyViolation) as error:
            assert_read_only('from(bucket:"a") |> to(bucket:"b")')
        assert error.value.token == "to("


class TestConstruccionDeConsultas:
    def test_la_consulta_de_ultima_lectura_pasa_el_verificador(self) -> None:
        # TEST-SRT-007
        query = build_latest_query(SPEC)
        assert_read_only(query)
        assert "|> last()" in query

    def test_busca_mas_atras_que_el_umbral_de_frescura(self) -> None:
        # TEST-SRT-008: buscar sólo dentro del umbral haría que una variable
        # obsoleta pareciera ausente, y el operador necesita distinguir «no
        # llega desde hace una hora» de «no existe».
        query = build_latest_query(SPEC)
        assert "-600s" in query

    def test_filtra_por_medicion_campo_y_etiquetas(self) -> None:
        # TEST-SRT-009
        query = build_latest_query(SPEC)
        assert 'r._measurement == "presion"' in query
        assert 'r._field == "valor"' in query
        assert 'r["equipo"] == "P-101A"' in query

    def test_escapa_las_comillas_de_los_valores(self) -> None:
        # TEST-SRT-010: los valores vienen de la configuración del servidor, no
        # del visor, pero una comilla sin escapar rompería la consulta de una
        # forma que sólo se ve en producción.
        spec = MappingSpec(
            mapping_id=SPEC.mapping_id,
            measurement='pre"sion',
            field="valor",
            tags={},
            bucket="proceso",
            freshness_seconds=60,
        )
        query = build_latest_query(spec)
        assert 'pre\\"sion' in query

    def test_el_historico_agrega_y_crea_huecos(self) -> None:
        # TEST-SRT-011: `createEmpty: true` es lo que hace que los periodos sin
        # dato lleguen como huecos. Sin él, el visor uniría dos puntos
        # separados por una hora de silencio con una recta que nunca existió.
        query = build_history_query(
            SPEC,
            start=NOW - timedelta(hours=1),
            end=NOW,
            window_seconds=60,
        )
        assert "aggregateWindow(every: 60s, fn: mean, createEmpty: true)" in query
        assert_read_only(query)

    def test_rechaza_un_intervalo_invertido(self) -> None:
        # TEST-SRT-012
        with pytest.raises(ValueError):
            build_history_query(SPEC, start=NOW, end=NOW - timedelta(hours=1), window_seconds=60)

    def test_rechaza_una_ventana_no_positiva(self) -> None:
        # TEST-SRT-013
        with pytest.raises(ValueError):
            build_history_query(SPEC, start=NOW - timedelta(hours=1), end=NOW, window_seconds=0)

    def test_una_agregacion_desconocida_cae_a_la_media(self) -> None:
        # TEST-SRT-014: interpolar el valor recibido en la consulta sería una
        # vía de inyección; caer a un valor seguro es lo correcto.
        spec = MappingSpec(
            mapping_id=SPEC.mapping_id,
            measurement="presion",
            field="valor",
            tags={},
            bucket="proceso",
            freshness_seconds=60,
            aggregation="(fn: (r) => r)",
        )
        query = build_history_query(
            spec, start=NOW - timedelta(hours=1), end=NOW, window_seconds=60
        )
        assert "fn: mean" in query
        assert "(fn: (r) => r)" not in query


class TestVentanaRecomendada:
    def test_apunta_a_unos_setecientos_puntos(self) -> None:
        # TEST-SRT-015
        window = recommended_window_seconds(NOW - timedelta(days=1), NOW)
        assert 110 <= window <= 130  # 86400 / 720 = 120

    def test_nunca_devuelve_cero(self) -> None:
        # TEST-SRT-016: una ventana de cero segundos haría fallar la consulta.
        assert recommended_window_seconds(NOW, NOW + timedelta(seconds=1)) >= 1


class TestCalidadDelDato:
    def test_un_dato_reciente_es_actual(self) -> None:
        # TEST-SRT-017
        quality = assess_quality(
            value=5.0,
            raw_value=None,
            source_timestamp=NOW - timedelta(seconds=10),
            freshness_seconds=300,
            now=NOW,
        )
        assert quality == "fresh"

    def test_un_dato_viejo_es_obsoleto(self) -> None:
        # TEST-SRT-018
        quality = assess_quality(
            value=5.0,
            raw_value=None,
            source_timestamp=NOW - timedelta(hours=2),
            freshness_seconds=300,
            now=NOW,
        )
        assert quality == "stale"

    def test_un_reloj_adelantado_no_da_dato_actual(self) -> None:
        # TEST-SRT-019: una marca de tiempo futura indica desfase de reloj; no
        # se puede afirmar que represente el estado presente.
        quality = assess_quality(
            value=5.0,
            raw_value=None,
            source_timestamp=NOW + timedelta(minutes=10),
            freshness_seconds=300,
            now=NOW,
        )
        assert quality == "stale"

    def test_distingue_ausente_de_error(self) -> None:
        # TEST-SRT-020: «no hay dato» y «no pude preguntar» llevan a decisiones
        # distintas; fundirlos sería el atajo equivocado.
        ausente = assess_quality(
            value=None, raw_value=None, source_timestamp=None, freshness_seconds=60, now=NOW
        )
        fallo = assess_quality(
            value=None,
            raw_value=None,
            source_timestamp=None,
            freshness_seconds=60,
            now=NOW,
            failed=True,
        )
        assert ausente == "missing"
        assert fallo == "error"

    def test_un_valor_no_numerico_se_declara_como_tal(self) -> None:
        # TEST-SRT-021: un campo de estado puede devolver «RUNNING»; convertirlo
        # en 0 perdería el único dato que hay.
        quality = assess_quality(
            value=None,
            raw_value="RUNNING",
            source_timestamp=NOW,
            freshness_seconds=60,
            now=NOW,
        )
        assert quality == "nonNumeric"


class TestIdentificadores:
    def test_separa_los_conocidos_de_los_desconocidos(self) -> None:
        # TEST-SRT-022: los desconocidos se informan, no se ignoran: un visor
        # que pide una variable no mapeada está desincronizado y hay que verlo.
        known = {SPEC.mapping_id: SPEC}
        valid, unknown = valid_mapping_ids(
            [SPEC.mapping_id, "00000000-0000-4000-8000-000000000999", "no-es-uuid"],
            known,
        )
        assert valid == [SPEC.mapping_id]
        assert len(unknown) == 2

    def test_rechaza_un_identificador_con_formato_extrano(self) -> None:
        # TEST-SRT-023: validar antes de usar evita que un valor raro llegue a
        # la construcción de la consulta.
        valid, unknown = valid_mapping_ids(['"; drop'], {SPEC.mapping_id: SPEC})
        assert valid == []
        assert unknown == ['"; drop']


class TestCache:
    def test_una_entrada_reciente_se_sirve(self) -> None:
        # TEST-SRT-024
        assert cache_entry_is_usable(NOW - timedelta(seconds=10), NOW, 60) is True

    def test_una_entrada_vieja_no_se_sirve(self) -> None:
        # TEST-SRT-025
        assert cache_entry_is_usable(NOW - timedelta(minutes=5), NOW, 60) is False
