"""Lectura real contra InfluxDB (X09, X10).

Hasta ahora el servidor tenía todo lo que rodea a la consulta —construcción
del Flux, validación de sólo lectura, evaluación de calidad, reglas de caché,
superficie HTTP— y ninguna implementación que hablase con el historiador: la
única que existía era la falsa de las pruebas. Esto es lo que faltaba.

Cuatro decisiones que conviene no reconstruir a mano:

**La consulta se vuelve a validar aquí.** `assert_read_only` ya se ejecuta
donde se construye el Flux, y se repite justo antes de enviarlo. No es
desconfianza del compañero: es que esta función es el único punto por el que
sale una consulta hacia la planta, y una validación en el único punto de
salida sobrevive a cualquier refactorización del que la construye.

**Un fallo del historiador no es una excepción, es una lectura sin dato.** El
servidor contesta una lista de muestras, una por variable; si una serie falla,
lo que el operador necesita ver es esa variable marcada y las demás con su
valor, no un error que tira la respuesta entera.

**Lo que se sirve de caché se etiqueta como caché.** Cuando el historiador no
responde se devuelve la última lectura buena con `fromCache`, y la interfaz lo
dice. Un valor de hace diez minutos presentado como actual es peor que un
hueco: alguien puede decidir sobre él.

**El token no sale de aquí.** No se registra, no se devuelve y no entra en
ningún mensaje de error. La configuración ya tiene `redacted()` para cuando
hay que volcarla, porque el impulso natural al depurar es volcarla entera.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from .config import InfluxSettings
from .telemetry import (
    MappingSpec,
    assert_read_only,
    build_history_query,
    build_latest_query,
    cache_entry_is_usable,
)

#: Ruta de consulta de InfluxDB 2.x.
QUERY_PATH = "/api/v2/query"

#: Ruta de comprobación de vida. No trae datos.
PING_PATH = "/ping"


@dataclass
class _CachedReading:
    value: float | None
    raw_value: Any
    source_timestamp: datetime | None
    fetched_at: datetime


def parse_influx_csv(body: str) -> list[tuple[datetime | None, Any]]:
    """Extrae los pares (instante, valor) de la respuesta CSV anotada.

    InfluxDB responde CSV con líneas de anotación que empiezan por ``#`` y una
    fila de encabezados cuyo primer campo está vacío. Se buscan las columnas
    por nombre y no por posición: el orden cambia según la consulta, y leer la
    columna seis porque hoy es la del valor es un error que aparece el día que
    alguien añade un ``group by``.
    """
    rows: list[tuple[datetime | None, Any]] = []
    header: list[str] | None = None

    for fields in csv.reader(io.StringIO(body)):
        if not fields:
            continue
        first = fields[0].strip()
        if first.startswith("#"):
            # Anotación de tipos o de grupo: una tabla nueva empieza después,
            # así que se olvida el encabezado anterior.
            header = None
            continue
        if "_value" in fields and "_time" in fields:
            header = [name.strip() for name in fields]
            continue
        if header is None:
            continue

        try:
            value_at = header.index("_value")
            time_at = header.index("_time")
        except ValueError:
            continue
        if len(fields) <= max(value_at, time_at):
            continue

        rows.append((_parse_time(fields[time_at]), _parse_value(fields[value_at])))

    return rows


def _parse_time(raw: str) -> datetime | None:
    text = raw.strip()
    if text == "":
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _parse_value(raw: str) -> Any:
    """Convierte el valor a número cuando lo es, y lo deja tal cual si no.

    Un campo de texto o booleano es legítimo —el estado de una bomba se guarda
    muchas veces como cadena— y convertirlo a la fuerza daría ``NaN`` donde hay
    un dato perfectamente válido.
    """
    text = raw.strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return text


class InfluxReader:
    """Lector de sólo lectura contra un InfluxDB 2.x.

    ``transport`` existe para las pruebas: permite responder sin un servidor,
    que es la única forma de probar el análisis del CSV y el camino de error
    sin montar un historiador.
    """

    def __init__(
        self,
        settings: InfluxSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        cache_max_age_seconds: int = 60,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._cache: dict[str, _CachedReading] = {}
        self._cache_max_age = cache_max_age_seconds

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._settings.url,
            timeout=self._settings.timeout_seconds,
            verify=self._settings.verify_tls,
            transport=self._transport,
            headers={
                "Authorization": f"Token {self._settings.token}",
                # Flux por cuerpo y CSV de vuelta: es el contrato de la 2.x.
                "Content-Type": "application/vnd.flux",
                "Accept": "application/csv",
            },
        )

    async def _query(self, flux: str) -> list[tuple[datetime | None, Any]]:
        """Envía una consulta y devuelve sus filas.

        Se valida que sea de sólo lectura inmediatamente antes de enviarla:
        este método es el único punto por el que una consulta sale hacia la
        planta, y una comprobación aquí sobrevive a cualquier cambio en quien
        la construye.
        """
        assert_read_only(flux)

        async with self._client() as client:
            response = await client.post(
                QUERY_PATH,
                params={"org": self._settings.org},
                content=flux.encode("utf-8"),
            )

        if response.status_code >= 400:
            # El cuerpo de InfluxDB puede traer la consulta entera; se recorta
            # para que un mensaje de error no acabe siendo un volcado.
            detail = response.text.strip().replace("\n", " ")[:200]
            raise InfluxQueryError(
                f"el historiador respondió {response.status_code}: {detail}"
            )

        return parse_influx_csv(response.text)

    async def latest(self, spec: MappingSpec) -> dict[str, Any]:
        """Última lectura de una variable, en la forma que espera la API.

        Nunca lanza: una variable que falla se devuelve marcada, para que las
        demás lleguen con su valor.
        """
        now = datetime.now(timezone.utc)

        try:
            rows = await self._query(build_latest_query(spec))
        except (InfluxQueryError, httpx.HTTPError) as error:
            return self._from_cache_or_failure(spec, now, str(error))

        if not rows:
            # Sin filas no hay dato, y eso no es un fallo: la serie puede estar
            # simplemente sin escribir desde hace tiempo. Se distingue del
            # error para que la interfaz no acuse al historiador.
            return {
                "value": None,
                "rawValue": None,
                "sourceTimestamp": None,
                "failed": False,
                "errorMessage": None,
                "fromCache": False,
            }

        source_timestamp, raw = rows[-1]
        value = raw if isinstance(raw, float) else None

        self._cache[spec.mapping_id] = _CachedReading(
            value=value,
            raw_value=raw,
            source_timestamp=source_timestamp,
            fetched_at=now,
        )

        return {
            "value": value,
            "rawValue": raw,
            "sourceTimestamp": source_timestamp,
            "failed": False,
            "errorMessage": None,
            "fromCache": False,
        }

    def _from_cache_or_failure(
        self, spec: MappingSpec, now: datetime, message: str
    ) -> dict[str, Any]:
        cached = self._cache.get(spec.mapping_id)

        if cached is not None and cache_entry_is_usable(
            cached.fetched_at, now, self._cache_max_age
        ):
            return {
                "value": cached.value,
                "rawValue": cached.raw_value,
                "sourceTimestamp": cached.source_timestamp,
                "failed": False,
                # Etiquetado como caché: un valor de hace un minuto presentado
                # como actual es peor que un hueco.
                "fromCache": True,
                "errorMessage": f"Sin conexión con el historiador: {message}",
            }

        return {
            "value": None,
            "rawValue": None,
            "sourceTimestamp": None,
            "failed": True,
            "fromCache": False,
            "errorMessage": message,
        }

    async def history(
        self,
        spec: MappingSpec,
        start: datetime,
        end: datetime,
        window_seconds: int,
    ) -> dict[str, Any]:
        """Serie histórica agregada (X13)."""
        flux = build_history_query(spec, start=start, end=end, window_seconds=window_seconds)

        try:
            rows = await self._query(flux)
        except (InfluxQueryError, httpx.HTTPError) as error:
            return {"points": [], "failed": True, "errorMessage": str(error)}

        return {
            "points": [
                {"t": moment.isoformat() if moment is not None else None, "v": value}
                for moment, value in rows
            ],
            "failed": False,
            "errorMessage": None,
        }

    async def ping(self) -> dict[str, object]:
        """Comprueba que el historiador responde, sin traer datos."""
        started = datetime.now(timezone.utc)

        try:
            async with self._client() as client:
                response = await client.get(PING_PATH)
            reachable = response.status_code < 500
            message: str | None = None
        except httpx.HTTPError as error:
            reachable = False
            message = str(error)

        latency = (datetime.now(timezone.utc) - started).total_seconds() * 1000

        out: dict[str, object] = {
            "reachable": reachable,
            "latencyMs": round(latency, 1),
        }
        if message is not None:
            out["errorMessage"] = message
        return out


class InfluxQueryError(RuntimeError):
    """El historiador contestó algo que no es una respuesta válida."""


def reader_from_settings(settings: InfluxSettings | None) -> InfluxReader | None:
    """Lector si hay historiador configurado, y ``None`` si no.

    Devolver ``None`` es lo que hace que el servidor conteste 503 en los
    extremos de telemetría en lugar de arrancar como si hubiera datos: un
    servidor sin historiador configurado es un estado legítimo —se usa para
    permisos y auditoría— y no un error.
    """
    return None if settings is None else InfluxReader(settings)
