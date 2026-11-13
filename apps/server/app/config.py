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

import os
from dataclasses import dataclass
from typing import Final

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
