"""Pruebas del lector real de InfluxDB (X09, X10, X13).

El servidor tenía todo lo que rodea a la consulta y ninguna implementación que
hablase con el historiador: la única era la falsa de estas pruebas. Lo que se
vigila aquí es lo que más daño haría en una planta:

- que no salga una consulta que escriba,
- que el token no aparezca en ningún mensaje,
- que un historiador caído dé la última lectura **etiquetada como caché** y no
  un valor presentado como actual,
- y que el análisis del CSV busque las columnas por nombre, porque el orden
  cambia con la consulta.

Se responde con un transporte simulado de httpx, que viene en la propia
biblioteca: montar un InfluxDB para probar esto sería montar un InfluxDB para
no probar nada más.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.config import InfluxSettings
from app.influx import (
    InfluxReader,
    parse_influx_csv,
    reader_from_settings,
)
from app.telemetry import MappingSpec

SETTINGS = InfluxSettings(
    url="https://historiador.planta.local:8086",
    org="pdi",
    bucket="proceso",
    token="influxdb-token-secretisimo",
    timeout_seconds=3,
)

SPEC = MappingSpec(
    mapping_id="m1",
    measurement="sensores",
    field="presion",
    tags={"equipo": "P-101A"},
    bucket="proceso",
    freshness_seconds=120,
)

CSV_OK = """#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string
#group,false,false,true,true,false,false,true,true
,result,table,_start,_stop,_time,_value,_field,_measurement
,_result,0,2026-11-01T00:00:00Z,2026-11-01T01:00:00Z,2026-11-01T00:59:00Z,12.5,presion,sensores
"""


def reader_with(handler) -> InfluxReader:
    return InfluxReader(SETTINGS, transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------- #
# Análisis del CSV
# --------------------------------------------------------------------- #


def test_inf_001_lee_instante_y_valor() -> None:
    rows = parse_influx_csv(CSV_OK)

    assert len(rows) == 1
    moment, value = rows[0]
    assert value == 12.5
    assert moment == datetime(2026, 11, 1, 0, 59, tzinfo=timezone.utc)


def test_inf_002_busca_las_columnas_por_nombre_no_por_posicion() -> None:
    """El orden cambia según la consulta: leer la columna seis porque hoy es la
    del valor falla el día que alguien añade una agrupación."""
    body = """#datatype,string,long,double,dateTime:RFC3339
,result,table,_value,_time
,_result,0,3.25,2026-11-01T10:00:00Z
"""
    rows = parse_influx_csv(body)

    assert rows == [(datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc), 3.25)]


def test_inf_003_un_valor_de_texto_no_se_fuerza_a_numero() -> None:
    """El estado de una bomba se guarda muchas veces como cadena: convertirlo
    daría NaN donde hay un dato válido."""
    body = """,result,table,_time,_value
,_result,0,2026-11-01T10:00:00Z,ARRANCADA
"""
    rows = parse_influx_csv(body)

    assert rows == [(datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc), "ARRANCADA")]


def test_inf_004_una_respuesta_vacia_no_rompe_el_analisis() -> None:
    assert parse_influx_csv("") == []
    assert parse_influx_csv("\n\n") == []


def test_inf_005_varias_tablas_se_leen_todas() -> None:
    body = CSV_OK + """
#group,false,false,true,true,false,false,true,true
,result,table,_start,_stop,_time,_value,_field,_measurement
,_result,1,2026-11-01T00:00:00Z,2026-11-01T01:00:00Z,2026-11-01T01:00:00Z,13.5,presion,sensores
"""
    rows = parse_influx_csv(body)

    assert [value for _, value in rows] == [12.5, 13.5]


# --------------------------------------------------------------------- #
# Última lectura
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_inf_006_devuelve_la_ultima_lectura() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v2/query"
        assert request.url.params["org"] == "pdi"
        return httpx.Response(200, text=CSV_OK)

    reading = await reader_with(handler).latest(SPEC)

    assert reading["value"] == 12.5
    assert reading["failed"] is False
    assert reading["fromCache"] is False


@pytest.mark.asyncio
async def test_inf_007_la_consulta_enviada_es_de_solo_lectura() -> None:
    """La validación se repite justo antes de enviar: este es el único punto por
    el que una consulta sale hacia la planta."""
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.content.decode("utf-8"))
        return httpx.Response(200, text=CSV_OK)

    await reader_with(handler).latest(SPEC)

    assert len(sent) == 1
    flux = sent[0]
    assert "from(bucket:" in flux
    for forbidden in ("to(", "delete(", "drop("):
        assert forbidden not in flux


@pytest.mark.asyncio
async def test_inf_008_el_token_viaja_en_la_cabecera_y_no_en_la_consulta() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization", "")
        seen["body"] = request.content.decode("utf-8")
        return httpx.Response(200, text=CSV_OK)

    await reader_with(handler).latest(SPEC)

    assert seen["auth"] == "Token influxdb-token-secretisimo"
    assert "secretisimo" not in seen["body"]


@pytest.mark.asyncio
async def test_inf_009_un_error_del_historiador_no_lleva_el_token_al_mensaje() -> None:
    """Es el camino por el que una credencial acaba en un registro: el mensaje
    de error se propaga, se registra y se enseña."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized access")

    reading = await reader_with(handler).latest(SPEC)

    assert reading["failed"] is True
    assert "secretisimo" not in str(reading["errorMessage"])


@pytest.mark.asyncio
async def test_inf_010_un_cuerpo_de_error_enorme_se_recorta() -> None:
    """InfluxDB devuelve la consulta entera en algunos errores: un mensaje así
    acaba siendo un volcado en el registro."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="x" * 5_000)

    reading = await reader_with(handler).latest(SPEC)

    assert len(str(reading["errorMessage"])) < 400


@pytest.mark.asyncio
async def test_inf_011_sin_filas_no_es_un_fallo() -> None:
    """La serie puede estar sin escribir desde hace tiempo. Confundirlo con un
    error haría acusar al historiador de algo que no pasa."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="")

    reading = await reader_with(handler).latest(SPEC)

    assert reading["value"] is None
    assert reading["failed"] is False


@pytest.mark.asyncio
async def test_inf_012_con_el_historiador_caido_se_sirve_cache_etiquetada() -> None:
    """Un valor de hace un minuto presentado como actual es peor que un hueco:
    alguien puede decidir sobre él."""
    estado = {"caido": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if estado["caido"]:
            raise httpx.ConnectError("sin ruta al host")
        return httpx.Response(200, text=CSV_OK)

    reader = reader_with(handler)
    primera = await reader.latest(SPEC)
    assert primera["fromCache"] is False

    estado["caido"] = True
    segunda = await reader.latest(SPEC)

    assert segunda["value"] == 12.5
    assert segunda["fromCache"] is True
    assert segunda["failed"] is False
    assert "Sin conexión" in str(segunda["errorMessage"])


@pytest.mark.asyncio
async def test_inf_013_una_cache_vieja_no_se_sirve() -> None:
    """Pasado el plazo, mejor sin dato que con un dato de hace media hora."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin ruta al host")

    reader = InfluxReader(
        SETTINGS, transport=httpx.MockTransport(handler), cache_max_age_seconds=0
    )
    reading = await reader.latest(SPEC)

    assert reading["value"] is None
    assert reading["failed"] is True
    assert reading["fromCache"] is False


@pytest.mark.asyncio
async def test_inf_014_sin_lectura_previa_no_se_inventa_una() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin ruta al host")

    reading = await reader_with(handler).latest(SPEC)

    assert reading["value"] is None
    assert reading["fromCache"] is False
    assert reading["failed"] is True


# --------------------------------------------------------------------- #
# Histórico (X13)
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_inf_015_el_historico_devuelve_los_puntos_agregados() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=CSV_OK)

    end = datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc)
    history = await reader_with(handler).history(
        SPEC, start=end - timedelta(hours=1), end=end, window_seconds=60
    )

    assert history["failed"] is False
    assert history["points"] == [{"t": "2026-11-01T00:59:00+00:00", "v": 12.5}]


@pytest.mark.asyncio
async def test_inf_016_un_historico_que_falla_no_lanza() -> None:
    """La gráfica tiene que poder decir «no se pudo cargar» en su sitio."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="service unavailable")

    end = datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc)
    history = await reader_with(handler).history(
        SPEC, start=end - timedelta(hours=1), end=end, window_seconds=60
    )

    assert history["failed"] is True
    assert history["points"] == []


# --------------------------------------------------------------------- #
# Vida y configuración
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_inf_017_el_ping_no_trae_datos() -> None:
    rutas: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        rutas.append(request.url.path)
        return httpx.Response(204)

    out = await reader_with(handler).ping()

    assert rutas == ["/ping"]
    assert out["reachable"] is True
    assert isinstance(out["latencyMs"], float)


@pytest.mark.asyncio
async def test_inf_018_un_historiador_inalcanzable_se_informa_sin_lanzar() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("agotado")

    out = await reader_with(handler).ping()

    assert out["reachable"] is False
    assert "errorMessage" in out


def test_inf_019_sin_historiador_configurado_no_hay_lector() -> None:
    """Un servidor sin historiador es un estado legítimo —se usa para permisos
    y auditoría—, no un error de arranque."""
    assert reader_from_settings(None) is None
    assert isinstance(reader_from_settings(SETTINGS), InfluxReader)


# --------------------------------------------------------------------- #
# Variables autorizadas y arranque (X10)
# --------------------------------------------------------------------- #


def test_inf_020_las_variables_se_leen_del_archivo_del_servidor(tmp_path) -> None:
    """Es la propiedad de seguridad que sostiene todo lo demás: si el visor
    pudiera enviar la medición y el campo, cualquiera con el enlace del
    recorrido podría leer cualquier serie del historiador."""
    import json as _json

    from app.config import load_mappings

    path = tmp_path / "variables.json"
    path.write_text(
        _json.dumps(
            [
                {
                    "mappingId": "m1",
                    "measurement": "sensores",
                    "field": "presion",
                    "bucket": "proceso",
                    "tags": {"equipo": "P-101A"},
                    "freshnessSeconds": 60,
                }
            ]
        ),
        encoding="utf-8",
    )

    mappings = load_mappings(str(path))

    assert set(mappings) == {"m1"}
    assert mappings["m1"].field == "presion"
    assert mappings["m1"].tags == {"equipo": "P-101A"}
    assert mappings["m1"].freshness_seconds == 60


def test_inf_021_sin_archivo_no_se_permite_nada(tmp_path) -> None:
    """Preferible a arrancar permitiendo cualquier consulta."""
    from app.config import load_mappings

    assert load_mappings("") == {}


def test_inf_022_un_identificador_repetido_se_denuncia(tmp_path) -> None:
    """Dejaría una de las dos variables sin servir, y el síntoma sería una
    lectura que nunca llega sin ningún error."""
    import json as _json

    from app.config import ConfigError, load_mappings

    path = tmp_path / "variables.json"
    entry = {
        "mappingId": "m1",
        "measurement": "s",
        "field": "f",
        "bucket": "b",
    }
    path.write_text(_json.dumps([entry, entry]), encoding="utf-8")

    with pytest.raises(ConfigError, match="repetido"):
        load_mappings(str(path))


def test_inf_023_un_campo_que_falta_se_denuncia_con_su_nombre(tmp_path) -> None:
    import json as _json

    from app.config import ConfigError, load_mappings

    path = tmp_path / "variables.json"
    path.write_text(_json.dumps([{"mappingId": "m1", "measurement": "s"}]), encoding="utf-8")

    with pytest.raises(ConfigError, match="field"):
        load_mappings(str(path))


def test_inf_024_un_archivo_que_no_existe_se_denuncia(tmp_path) -> None:
    from app.config import ConfigError, load_mappings

    with pytest.raises(ConfigError, match="no se encontró|No se encontró"):
        load_mappings(str(tmp_path / "no-esta.json"))


def test_inf_025_un_json_invalido_se_denuncia(tmp_path) -> None:
    from app.config import ConfigError, load_mappings

    path = tmp_path / "variables.json"
    path.write_text("{no es json", encoding="utf-8")

    with pytest.raises(ConfigError, match="JSON"):
        load_mappings(str(path))
