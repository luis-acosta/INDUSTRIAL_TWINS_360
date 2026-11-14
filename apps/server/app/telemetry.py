"""Servicio de telemetría de sólo lectura.

Es el intermediario entre el visor publicado y el historiador. Existe por la
regla de la arquitectura: «UI no accede directamente a InfluxDB con token.
Backend local/privado consulta con credenciales protegidas».

Tres garantías, en orden de importancia:

1. **Sólo lectura.** No hay ninguna función que escriba, y toda consulta pasa
   por ``assert_read_only`` antes de salir. El usuario del token debe ser de
   sólo lectura en el servidor del cliente; esta es la segunda barrera, la que
   no depende de cómo esté configurado ese servidor.
2. **El token no sale de aquí.** Se lee del entorno al arrancar y nunca
   aparece en una respuesta, en un registro ni en un mensaje de error.
3. **El visor pide por identificador de mapeo**, no por medición. Así no puede
   construir una consulta propia ni alcanzar datos que el recorrido no
   publica.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Final, Protocol

#: Palabras que descalifican una consulta.
#:
#: Cubren escritura (``to``, ``delete``), manipulación de esquema (``drop``,
#: ``create``) y salida de red desde el propio motor (``http.post``), que es la
#: vía por la que una consulta podría sacar datos sin escribir en la base.
FORBIDDEN_FLUX: Final[tuple[str, ...]] = (
    "to(",
    "delete(",
    "drop(",
    "create ",
    "alter ",
    "insert ",
    "update ",
    "grant ",
    "revoke ",
    "http.post",
    "http.get",
    "sql.to",
    "influxdb.to",
    "experimental.to",
)

#: Operaciones que el servicio ofrece. No hay más, y no es una lista de
#: configuración: es la superficie completa de la API de telemetría.
OPERATIONS: Final[tuple[str, ...]] = ("latest", "history", "ping", "listMeasurements")


class TelemetryReader(Protocol):
    """Lo que la API necesita de un lector de telemetría.

    Es un protocolo y no una clase base porque hay dos implementaciones
    legítimas —la que habla con InfluxDB y la de las pruebas— y ninguna debe
    heredar de la otra. Tiparlo así hace que un cambio de forma en el lector
    rompa la comprobación de tipos en lugar de romper la API en ejecución.
    """

    async def latest(self, spec: MappingSpec) -> dict[str, Any]:
        """Última lectura de una variable mapeada."""
        ...

    async def history(
        self,
        spec: MappingSpec,
        start: datetime,
        end: datetime,
        window_seconds: int,
    ) -> dict[str, Any]:
        """Serie histórica agregada entre dos instantes."""
        ...

    async def ping(self) -> dict[str, object]:
        """Comprueba que el historiador responde."""
        ...


class ReadOnlyViolation(Exception):
    """La consulta contenía una operación que no es de lectura."""

    def __init__(self, token: str) -> None:
        super().__init__(f"La consulta contiene una operación que no es de lectura: {token}")
        self.token = token


def assert_read_only(flux: str) -> None:
    """Rechaza una consulta que no sea estrictamente de lectura.

    Normaliza a minúsculas y quita el espacio antes del paréntesis: un filtro
    que sólo busque ``to(`` se esquiva escribiendo ``to (``, y un verificador
    que se esquiva con un espacio no verifica nada.
    """
    normalized = flux.lower().replace(" (", "(").replace("\t", " ")
    for token in FORBIDDEN_FLUX:
        if token in normalized:
            raise ReadOnlyViolation(token)


@dataclass(frozen=True, slots=True)
class MappingSpec:
    """Lo que el servicio necesita saber de una variable para consultarla.

    Se carga de la configuración del servidor, no de la petición: si el visor
    pudiera enviar la medición y el campo, podría leer cualquier serie del
    historiador y no sólo las que el recorrido publica.
    """

    mapping_id: str
    measurement: str
    field: str
    tags: dict[str, str]
    bucket: str
    freshness_seconds: int
    aggregation: str = "last"


def _escape_flux_string(value: str) -> str:
    """Escapa una cadena para interpolarla en Flux.

    Los valores vienen de la configuración del servidor, no del visor, pero se
    escapan igual: la configuración la escribe una persona, y una comilla sin
    escapar en el nombre de una etiqueta rompería la consulta de una forma que
    sólo se ve en producción.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _tag_filters(tags: dict[str, str]) -> str:
    if not tags:
        return ""
    conditions = " and ".join(
        f'r["{_escape_flux_string(key)}"] == "{_escape_flux_string(value)}"'
        for key, value in sorted(tags.items())
    )
    return f"\n  |> filter(fn: (r) => {conditions})"


def build_latest_query(spec: MappingSpec, *, lookback_seconds: int | None = None) -> str:
    """Consulta de la última lectura de una variable.

    La ventana de búsqueda es el doble del umbral de frescura, con un mínimo de
    cinco minutos. Buscar sólo dentro del umbral haría que una variable
    obsoleta pareciera ausente: el operador necesita distinguir «no llega desde
    hace una hora» de «no existe», y para eso hay que encontrar el dato viejo.
    """
    window = lookback_seconds if lookback_seconds is not None else max(spec.freshness_seconds * 2, 300)

    query = (
        f'from(bucket: "{_escape_flux_string(spec.bucket)}")'
        f"\n  |> range(start: -{int(window)}s)"
        f'\n  |> filter(fn: (r) => r._measurement == "{_escape_flux_string(spec.measurement)}")'
        f'\n  |> filter(fn: (r) => r._field == "{_escape_flux_string(spec.field)}")'
        f"{_tag_filters(spec.tags)}"
        "\n  |> last()"
    )
    assert_read_only(query)
    return query


def build_history_query(
    spec: MappingSpec,
    *,
    start: datetime,
    end: datetime,
    window_seconds: int,
) -> str:
    """Consulta de histórico agregado.

    La agregación no es una optimización opcional: pedir un mes a resolución de
    segundo son millones de puntos que ni la red ni el lienzo soportan, y el
    usuario no vería más detalle del que caben en los píxeles de la gráfica.
    """
    if end <= start:
        raise ValueError("El fin del intervalo debe ser posterior al inicio")
    if window_seconds <= 0:
        raise ValueError("La ventana de agregación debe ser positiva")

    aggregation = spec.aggregation if spec.aggregation in {"mean", "last", "min", "max", "sum", "median"} else "mean"

    query = (
        f'from(bucket: "{_escape_flux_string(spec.bucket)}")'
        f"\n  |> range(start: {start.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')}, "
        f"stop: {end.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')})"
        f'\n  |> filter(fn: (r) => r._measurement == "{_escape_flux_string(spec.measurement)}")'
        f'\n  |> filter(fn: (r) => r._field == "{_escape_flux_string(spec.field)}")'
        f"{_tag_filters(spec.tags)}"
        f"\n  |> aggregateWindow(every: {int(window_seconds)}s, fn: {aggregation}, createEmpty: true)"
    )
    assert_read_only(query)
    return query


def recommended_window_seconds(start: datetime, end: datetime, target_points: int = 720) -> int:
    """Ventana de agregación para obtener unos 720 puntos.

    720 es el número que cabe en una gráfica de ancho razonable sin que dos
    puntos compartan píxel. Pedir más no añade detalle visible y multiplica el
    tráfico.
    """
    span = max(int((end - start).total_seconds()), 1)
    return max(span // max(target_points, 1), 1)


#: Calidad del dato. Son los mismos cinco estados del dominio, y cada uno
#: significa algo distinto para el operador: fundir «no hay dato» con «no pude
#: preguntar» sería el atajo natural y el equivocado.
QUALITIES: Final[tuple[str, ...]] = ("fresh", "stale", "missing", "error", "nonNumeric")


def assess_quality(
    *,
    value: float | None,
    raw_value: str | None,
    source_timestamp: datetime | None,
    freshness_seconds: int,
    now: datetime,
    failed: bool = False,
) -> str:
    """Clasifica la calidad de una lectura.

    Réplica de la regla del dominio, incluido el caso del reloj desfasado: un
    dato con marca de tiempo futura se trata como obsoleto y no como actual,
    porque no se puede afirmar que represente el estado presente.
    """
    if failed:
        return "error"
    if value is None and raw_value is not None:
        return "nonNumeric"
    if value is None or source_timestamp is None:
        return "missing"

    moment = source_timestamp
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)

    age = (now - moment).total_seconds()
    if age < -60:
        return "stale"
    return "fresh" if age <= freshness_seconds else "stale"


#: Patrón de un identificador de mapeo. El visor envía identificadores y nada
#: más; validarlos antes de usarlos evita que un valor extraño llegue a la
#: construcción de la consulta.
MAPPING_ID_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def valid_mapping_ids(ids: list[str], known: dict[str, MappingSpec]) -> tuple[list[str], list[str]]:
    """Separa los identificadores conocidos de los que no.

    Los desconocidos se devuelven para informar, no se ignoran en silencio: un
    visor que pide una variable que el servidor no tiene mapeada está
    desincronizado con el recorrido publicado, y eso hay que poder verlo.
    """
    valid: list[str] = []
    unknown: list[str] = []
    for mapping_id in ids:
        if MAPPING_ID_PATTERN.match(mapping_id) and mapping_id in known:
            valid.append(mapping_id)
        else:
            unknown.append(mapping_id)
    return valid, unknown


def cache_entry_is_usable(fetched_at: datetime, now: datetime, max_age_seconds: int = 60) -> bool:
    """Decide si una entrada de caché se puede servir.

    La caché existe para que veinte visitantes mirando el mismo recorrido no
    produzcan veinte consultas por segundo al historiador. Lo que se sirve de
    caché se marca como tal en la respuesta: «datos offline se etiquetan como
    caché, no como telemetría actual».
    """
    moment = fetched_at if fetched_at.tzinfo is not None else fetched_at.replace(tzinfo=timezone.utc)
    return now - moment <= timedelta(seconds=max_age_seconds)
