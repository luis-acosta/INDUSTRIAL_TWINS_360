"""Pruebas de configuración.

Dos cosas importan: que el arranque falle en lugar de quedarse a medias, y que
ninguna vista de la configuración pueda publicar una credencial. La segunda es
la que se rompe con facilidad, porque el impulso al depurar es volcar la
configuración entera.
"""

from __future__ import annotations

import pytest

from app.config import ConfigError, InfluxSettings, Settings, load_settings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("IT360_"):
            monkeypatch.delenv(name, raising=False)


class TestArranque:
    def test_falla_sin_base_de_datos(self) -> None:
        # TEST-CFG-001
        with pytest.raises(ConfigError) as error:
            load_settings()
        assert "DATABASE_URL" in str(error.value)

    def test_la_telemetria_es_opcional(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # TEST-CFG-002: un servidor que sólo aloja recorridos sin datos de
        # proceso es un despliegue legítimo.
        monkeypatch.setenv("IT360_DATABASE_URL", "postgresql://u:p@host/db")
        settings = load_settings()
        assert settings.influx is None

    def test_media_configuracion_de_telemetria_no_arranca(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # TEST-CFG-003: con URL y sin token, el visor intentaría consultar y
        # fallaría en casa del cliente.
        monkeypatch.setenv("IT360_DATABASE_URL", "postgresql://u:p@host/db")
        monkeypatch.setenv("IT360_INFLUX_URL", "https://influx.local")

        with pytest.raises(ConfigError) as error:
            load_settings()
        assert "INFLUX_ORG" in str(error.value)

    def test_desactivar_tls_exige_motivo_escrito(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # TEST-CFG-004: las plantas tienen certificados internos, así que se
        # permite; lo que no se permite es desactivarlo en silencio.
        monkeypatch.setenv("IT360_DATABASE_URL", "postgresql://u:p@host/db")
        monkeypatch.setenv("IT360_INFLUX_URL", "https://influx.local")
        monkeypatch.setenv("IT360_INFLUX_ORG", "planta")
        monkeypatch.setenv("IT360_INFLUX_BUCKET", "proceso")
        monkeypatch.setenv("IT360_INFLUX_TOKEN", "secreto")
        monkeypatch.setenv("IT360_INFLUX_VERIFY_TLS", "false")

        with pytest.raises(ConfigError) as error:
            load_settings()
        assert "TLS_EXEMPTION_REASON" in str(error.value)

        monkeypatch.setenv("IT360_INFLUX_TLS_EXEMPTION_REASON", "Certificado interno de la planta")
        assert load_settings().influx is not None

    def test_un_numero_invalido_se_rechaza(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # TEST-CFG-005
        monkeypatch.setenv("IT360_DATABASE_URL", "postgresql://u:p@host/db")
        monkeypatch.setenv("IT360_TELEMETRY_CACHE_SECONDS", "muchos")

        with pytest.raises(ConfigError):
            load_settings()


class TestRedaccion:
    def test_la_vista_de_influx_no_lleva_el_token(self) -> None:
        # TEST-CFG-006
        influx = InfluxSettings(
            url="https://influx.local", org="planta", bucket="proceso", token="super-secreto"
        )
        vista = influx.redacted()

        assert vista["token"] == "[redactado]"
        assert "super-secreto" not in str(vista)

    def test_la_cadena_de_conexion_pierde_la_clave(self) -> None:
        # TEST-CFG-007: poder mostrar a qué base se conecta el servidor sin
        # publicar cómo entrar en ella.
        settings = Settings(
            database_url="postgresql://it360:clave-secreta@db.local:5432/it360",
            influx=None,
            allowed_origins=(),
            telemetry_cache_seconds=15,
            backup_dir="/tmp",
            environment="test",
        )
        vista = str(settings.redacted())

        assert "clave-secreta" not in vista
        assert "it360:[redactado]@db.local" in vista

    def test_una_cadena_sin_credenciales_no_se_altera(self) -> None:
        # TEST-CFG-008
        settings = Settings(
            database_url="postgresql:///it360",
            influx=None,
            allowed_origins=(),
            telemetry_cache_seconds=15,
            backup_dir="/tmp",
            environment="test",
        )
        assert settings.redacted()["databaseUrl"] == "postgresql:///it360"
