"""Configuración del servidor.

Todo viene del entorno. Ninguna credencial se escribe en el repositorio, en un
archivo de configuración versionado ni en un valor por defecto: la regla del
plan es «Nunca introducir credenciales en repositorio, logs o exportaciones», y
un valor por defecto que funcione es la forma más común de romperla sin darse
cuenta.

El arranque falla si falta algo imprescindible. Arrancar a medias —sin token de
telemetría, por ejemplo— daría un servidor que responde a todo menos a lo que
le pidan de verdad, y el fallo aparecería en la primera consulta del cliente.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Final

from .telemetry import MappingSpec

#: Prefijo de las variables de entorno. Un prefijo propio evita colisiones en
#: un servidor que aloja varios servicios.
PREFIX: Final[str] = "IT360_"


class ConfigError(Exception):
    """Falta configuración imprescindible o tiene un valor inválido."""


def _get(name: str, default: str | None = None) -> str | None:
    return os.environ.get(f"{PREFIX}{name}", default)


def _require(name: str) -> str:
    value = _get(name)
    if value is None or value.strip() == "":
        raise ConfigError(
            f"Falta la variable de entorno {PREFIX}{name}. "
            "El servidor no arranca sin ella para no quedar a medias."
        )
    return value


def _get_int(name: str, default: int) -> int:
    raw = _get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ConfigError(f"{PREFIX}{name} debe ser un número entero: {raw!r}") from error


def _get_bool(name: str, default: bool) -> bool:
    raw = _get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "si", "sí"}


@dataclass(frozen=True, slots=True)
class InfluxSettings:
    """Conexión al historiador. El token vive sólo aquí y en el entorno."""

    url: str
    org: str
    bucket: str
    token: str
    timeout_seconds: int = 8
    verify_tls: bool = True

    def redacted(self) -> dict[str, object]:
        """Vista sin credenciales, para registros y diagnóstico.

        Existe porque el impulso natural al depurar es volcar la configuración
        entera, y sin una versión segura de esa operación el token acaba en un
        archivo de registro.
        """
        return {
            "url": self.url,
            "org": self.org,
            "bucket": self.bucket,
            "token": "[redactado]",
            "timeoutSeconds": self.timeout_seconds,
            "verifyTls": self.verify_tls,
        }


@dataclass(frozen=True, slots=True)
class Settings:
    """Configuración completa del servicio."""

    database_url: str
    influx: InfluxSettings | None
    #: Orígenes autorizados para CORS. Vacío = ninguno, que es lo correcto
    #: cuando el visor se sirve desde el mismo servidor.
    allowed_origins: tuple[str, ...]
    #: Segundos que se sirve una lectura de caché antes de volver a consultar.
    telemetry_cache_seconds: int
    #: Carpeta de las copias de respaldo.
    backup_dir: str
    environment: str

    def redacted(self) -> dict[str, object]:
        return {
            "databaseUrl": _redact_dsn(self.database_url),
            "influx": self.influx.redacted() if self.influx is not None else None,
            "allowedOrigins": list(self.allowed_origins),
            "telemetryCacheSeconds": self.telemetry_cache_seconds,
            "backupDir": self.backup_dir,
            "environment": self.environment,
        }


def _redact_dsn(dsn: str) -> str:
    """Oculta la contraseña de una cadena de conexión.

    ``postgresql://usuario:clave@host/base`` deja de llevar la clave. Es la
    forma de poder mostrar a qué base se conecta el servidor sin publicar cómo
    entrar en ella.
    """
    if "@" not in dsn or "//" not in dsn:
        return dsn
    scheme, rest = dsn.split("//", 1)
    credentials, _, host = rest.partition("@")
    if ":" not in credentials:
        return dsn
    user, _, _ = credentials.partition(":")
    return f"{scheme}//{user}:[redactado]@{host}"


def load_settings() -> Settings:
    """Lee la configuración del entorno.

    La telemetría es opcional: un servidor que sólo aloja recorridos sin datos
    de proceso no necesita historiador, y exigirlo impediría ese despliegue. Si
    se declara la URL, el token pasa a ser obligatorio: media configuración de
    telemetría es peor que ninguna, porque el visor intentaría consultar.
    """
    influx_url = _get("INFLUX_URL")
    influx: InfluxSettings | None = None

    if influx_url is not None and influx_url.strip() != "":
        influx = InfluxSettings(
            url=influx_url.rstrip("/"),
            org=_require("INFLUX_ORG"),
            bucket=_require("INFLUX_BUCKET"),
            token=_require("INFLUX_TOKEN"),
            timeout_seconds=_get_int("INFLUX_TIMEOUT_SECONDS", 8),
            verify_tls=_get_bool("INFLUX_VERIFY_TLS", True),
        )

        if not influx.verify_tls:
            # Se permite, porque las plantas tienen certificados internos, pero
            # queda escrito en el arranque: una desactivación silenciosa de la
            # verificación TLS es una puerta abierta que nadie recuerda.
            reason = _get("INFLUX_TLS_EXEMPTION_REASON")
            if reason is None or reason.strip() == "":
                raise ConfigError(
                    f"{PREFIX}INFLUX_VERIFY_TLS está desactivado. "
                    f"Declare el motivo en {PREFIX}INFLUX_TLS_EXEMPTION_REASON."
                )

    origins = _get("ALLOWED_ORIGINS", "")
    return Settings(
        database_url=_require("DATABASE_URL"),
        influx=influx,
        allowed_origins=tuple(o.strip() for o in (origins or "").split(",") if o.strip() != ""),
        telemetry_cache_seconds=_get_int("TELEMETRY_CACHE_SECONDS", 15),
        backup_dir=_get("BACKUP_DIR", "/var/lib/it360/backups") or "/var/lib/it360/backups",
        environment=_get("ENVIRONMENT", "production") or "production",
    )


# --------------------------------------------------------------------- #
# Variables de proceso autorizadas
# --------------------------------------------------------------------- #


def load_mappings(path: str | None = None) -> dict[str, MappingSpec]:
    """Variables que este servidor permite consultar (X10).

    Se declaran en un archivo del servidor y no llegan en la petición. Es la
    propiedad de seguridad que sostiene todo lo demás: si el visor pudiera
    enviar la medición y el campo, cualquiera con el enlace del recorrido
    podría leer cualquier serie del historiador, no sólo las que el recorrido
    publica.

    Sin archivo declarado se devuelve vacío, y los extremos de telemetría
    contestan 503. Es preferible a arrancar permitiendo cualquier consulta.
    """
    source = path if path is not None else _get("MAPPINGS_FILE")
    if source is None or source.strip() == "":
        return {}

    try:
        with open(source, encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError as error:
        raise ConfigError(
            f"No se encontró el archivo de variables «{source}». "
            "Indique la ruta correcta o quite la variable de entorno."
        ) from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"El archivo de variables «{source}» no es JSON válido: {error}") from error

    if not isinstance(raw, list):
        raise ConfigError(
            f"El archivo de variables «{source}» debe contener una lista de variables."
        )

    out: dict[str, MappingSpec] = {}
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ConfigError(f"La variable {index + 1} del archivo no es un objeto.")

        try:
            mapping_id = str(entry["mappingId"])
            spec = MappingSpec(
                mapping_id=mapping_id,
                measurement=str(entry["measurement"]),
                field=str(entry["field"]),
                tags={str(k): str(v) for k, v in (entry.get("tags") or {}).items()},
                bucket=str(entry["bucket"]),
                freshness_seconds=int(entry.get("freshnessSeconds", 120)),
                aggregation=str(entry.get("aggregation", "last")),
            )
        except KeyError as error:
            raise ConfigError(
                f"A la variable {index + 1} del archivo le falta el campo {error}."
            ) from error

        # Un identificador repetido dejaría una de las dos variables sin servir
        # y el síntoma sería una lectura que nunca llega, sin ningún error.
        if mapping_id in out:
            raise ConfigError(f"El identificador de variable «{mapping_id}» está repetido.")
        out[mapping_id] = spec

    return out
