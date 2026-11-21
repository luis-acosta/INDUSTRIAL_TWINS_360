"""Pruebas de los archivos de despliegue contra el código (X20).

Esto no prueba que el despliegue funcione —para eso hace falta una máquina—
sino que los archivos de despliegue y el código digan lo mismo. Es la clase de
fallo más difícil de encontrar de todo el producto: el servicio arranca, ignora
una variable cuyo nombre no coincide y se comporta como si no estuviera
configurada. Nadie sospecha de un archivo que no se ha tocado en meses.

Qué se comprueba:

- Que **cada variable** del `.env.example` sea una que el código lee de verdad.
  Una variable de más es documentación que miente.
- Que cada variable que el código lee esté documentada. Una de menos es una
  función que el cliente no puede activar porque no sabe que existe.
- Que el compose no publique los puertos que no deben salir.
- Que el proxy apunte al puerto en el que el servicio escucha de verdad.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app import config

DEPLOY = Path(__file__).resolve().parents[3] / "deploy"


def _env_example_names() -> set[str]:
    """Nombres declarados en el ejemplo, incluidos los comentados.

    Los comentados cuentan: están ahí para que el cliente los descomente, y uno
    mal escrito no se descubre hasta que alguien intenta usar esa función.
    """
    text = (DEPLOY / ".env.example").read_text(encoding="utf-8")
    return set(re.findall(r"^#?(IT360_[A-Z0-9_]+)=", text, re.MULTILINE))


def _names_read_by_code() -> set[str]:
    """Variables que `config.py` lee, extraídas de sus propias llamadas.

    Se leen del código fuente y no de una lista escrita a mano: una lista a mano
    es otro sitio que se queda desfasado, y entonces la prueba dejaría de
    detectar lo que existe para comprobar lo que alguien recordó.
    """
    source = Path(config.__file__).read_text(encoding="utf-8")
    calls = re.findall(r'_(?:get|require|get_int|get_bool)\(\s*"([A-Z0-9_]+)"', source)
    return {f"{config.PREFIX}{name}" for name in calls}


def test_el_ejemplo_no_declara_variables_que_el_codigo_no_lee() -> None:
    """TEST-DEP-001: una variable de más es documentación que miente.

    El cliente la rellena, el servicio la ignora y la función que creía haber
    activado no funciona, sin un solo error en el registro.
    """
    extra = _env_example_names() - _names_read_by_code()

    assert extra == set(), f"El ejemplo declara variables que el código no lee: {sorted(extra)}"


def test_el_codigo_no_lee_variables_sin_documentar() -> None:
    """TEST-DEP-002: una variable de menos es una función inalcanzable.

    El cliente no puede activar algo cuyo nombre no aparece en ninguna parte.
    """
    missing = _names_read_by_code() - _env_example_names()

    assert missing == set(), f"Variables del código sin documentar: {sorted(missing)}"


def test_la_base_de_datos_es_obligatoria_y_esta_sin_comentar() -> None:
    """TEST-DEP-003: lo obligatorio no puede venir comentado.

    `IT360_DATABASE_URL` es obligatoria en `load_settings`: comentada en el
    ejemplo, el primer arranque falla con una excepción de configuración y el
    cliente no sabe si el archivo es el equivocado o el producto está roto.
    """
    text = (DEPLOY / ".env.example").read_text(encoding="utf-8")

    assert re.search(r"^IT360_DATABASE_URL=", text, re.MULTILINE) is not None


def test_el_compose_no_publica_la_base_ni_el_servicio() -> None:
    """TEST-DEP-004: sólo el proxy está expuesto.

    Publicar 5432 «para poder mirar con el cliente gráfico» es cómo acaba una
    base de planta expuesta a la red corporativa. Y publicar el servicio se
    saltaría el único sitio donde se termina el TLS.
    """
    compose = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")

    # Un solo bloque de puertos en todo el archivo, el del proxy.
    assert compose.count("ports:") == 1
    assert "5432:" not in compose
    assert "8787:" not in compose


def test_el_proxy_apunta_al_puerto_en_que_el_servicio_escucha() -> None:
    """TEST-DEP-005: el fallo clásico de copiar una configuración de otro sitio.

    Si no coinciden, el recorrido carga, la telemetría devuelve 502 y el visor
    informa de un fallo de red que no lo es.
    """
    nginx = (DEPLOY / "nginx.conf").read_text(encoding="utf-8")
    dockerfile = (DEPLOY / "Dockerfile.server").read_text(encoding="utf-8")

    puerto = re.search(r"--port\",\s*\"(\d+)\"", dockerfile)
    assert puerto is not None
    assert f"http://servicio:{puerto.group(1)}" in nginx


def test_el_servicio_no_corre_como_root() -> None:
    """TEST-DEP-006: si alguna vez se encuentra una ejecución de código en una
    dependencia, esto es la diferencia entre un incidente y una tarde."""
    dockerfile = (DEPLOY / "Dockerfile.server").read_text(encoding="utf-8")

    assert re.search(r"^USER it360$", dockerfile, re.MULTILINE) is not None


def test_las_imagenes_llevan_version_exacta() -> None:
    """TEST-DEP-007: ni «latest» ni una etiqueta de versión mayor.

    Una imagen que sigue a «3» o a «16» cambia de versión menor sola, y el día
    que eso rompa algo nadie va a sospechar del archivo que no se ha tocado.
    """
    for archivo in ("docker-compose.yml", "Dockerfile.server"):
        text = (DEPLOY / archivo).read_text(encoding="utf-8")
        for imagen in re.findall(r"(?:image:|FROM)\s+(\S+)", text):
            assert ":" in imagen, f"{archivo}: «{imagen}» sin etiqueta"
            etiqueta = imagen.split(":", 1)[1]
            assert etiqueta != "latest", f"{archivo}: «{imagen}» usa latest"
            assert re.match(r"^\d+\.\d+", etiqueta), (
                f"{archivo}: «{imagen}» no fija versión menor"
            )


def test_el_despliegue_advierte_de_la_autenticacion_pendiente() -> None:
    """TEST-DEP-008: es la advertencia que decide si el despliegue es seguro.

    La identidad llega por cabeceras y el servicio no la valida. Un compose que
    no lo diga se publica en Internet con toda la buena fe del mundo.
    """
    compose = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")

    assert "autenticación de usuarios está pendiente" in compose
    assert "LIMITACIONES" in compose


@pytest.mark.parametrize("archivo", ["docker-compose.yml", "Dockerfile.server", "nginx.conf", ".env.example"])
def test_ningun_archivo_de_despliegue_lleva_credenciales(archivo: str) -> None:
    """TEST-DEP-009: ni de ejemplo que parezca real.

    Una contraseña escrita en un archivo del repositorio acaba en producción
    porque alguien no la cambió, y el ejemplo con «CAMBIEME» es precisamente lo
    que hace que se note.
    """
    text = (DEPLOY / archivo).read_text(encoding="utf-8")

    # Un token o una contraseña con valor: lo que se busca es «=algo» en una
    # variable de credencial, no la variable vacía ni el marcador.
    for linea in text.splitlines():
        limpia = linea.strip().lstrip("#").strip()
        match = re.match(r"(IT360_\w*(?:TOKEN|PASSWORD)\w*)=(.+)", limpia)
        if match is None:
            continue
        valor = match.group(2).strip()
        assert valor in ("", "CAMBIEME") or valor.startswith("${"), (
            f"{archivo}: «{match.group(1)}» trae un valor que parece real"
        )
