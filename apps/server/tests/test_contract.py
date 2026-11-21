"""Prueba del contrato público del servicio (X19).

Para qué existe: la API es la superficie que otros van a programar contra. Una
integración del cliente —un panel de mantenimiento, un cuadro de mando, un
servicio que vuelca las notas a su gestor de incidencias— se escribe una vez y
se queda funcionando durante años. Lo que la rompe no es un cambio grande y
anunciado: es un parámetro que pasa a ser obligatorio, un campo que se renombra
o una ruta que se mueve, hechos con la mejor intención y sin que nadie se dé
cuenta de que eran públicos.

Esta prueba compara la superficie generada con una instantánea guardada en
`contract/openapi-surface.json`. No impide cambiar la API: obliga a cambiarla
**a propósito**, actualizando la instantánea en el mismo commit, de modo que el
cambio aparece en la revisión en lugar de descubrirse en producción.

Lo que vigila: rutas, métodos, parámetros con su obligatoriedad y los campos del
cuerpo con la suya. Lo que no: descripciones y ejemplos, que se mejoran a menudo
y no rompen a nadie.

Cuando falla, lo que hay que preguntarse es si el cambio es compatible:

- Añadir una ruta, un parámetro opcional o un campo opcional: compatible.
- Quitar algo, renombrarlo o volverlo obligatorio: **rompe** a quien ya la usa.
  Eso pide una versión nueva de la API (`/api/v2`), no una edición de la
  instantánea.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.main import create_app

CONTRACT = Path(__file__).resolve().parent.parent / "contract" / "openapi-surface.json"

METHODS = ("get", "post", "put", "patch", "delete")


def current_surface() -> dict[str, Any]:
    """Superficie que el servicio expone ahora.

    Se construye del esquema que genera FastAPI y no de una lista escrita a
    mano: una lista a mano se queda desfasada y la prueba dejaría de comparar
    lo que existe para comparar lo que alguien recordó.
    """
    app = create_app(mappings={}, reader=None)
    spec = app.openapi()
    surface: dict[str, Any] = {}

    for path, ops in sorted(spec["paths"].items()):
        for method, op in sorted(ops.items()):
            if method not in METHODS:
                continue

            params = sorted(
                f"{p['name']}:{p['in']}{'!' if p.get('required') else ''}"
                for p in op.get("parameters", [])
            )

            fields: list[str] = []
            body = op.get("requestBody")
            if body is not None:
                ref = body["content"]["application/json"]["schema"].get("$ref")
                if ref is not None:
                    schema = spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]
                    required = set(schema.get("required", []))
                    fields = sorted(
                        f"{name}{'!' if name in required else ''}"
                        for name in schema.get("properties", {})
                    )

            surface[f"{method.upper()} {path}"] = {"parameters": params, "body": fields}

    return surface


def test_la_superficie_publica_no_cambia_sin_querer() -> None:
    """TEST-API-X19-001: el contrato y el código dicen lo mismo.

    Si esto falla, el mensaje dice exactamente qué operación cambió. Lea la
    cabecera de este archivo antes de actualizar la instantánea: hay cambios
    que piden una versión nueva de la API y no una edición de este archivo.
    """
    guardado = json.loads(CONTRACT.read_text(encoding="utf-8"))["operaciones"]
    actual = current_surface()

    faltan = sorted(set(guardado) - set(actual))
    sobran = sorted(set(actual) - set(guardado))

    assert faltan == [], f"Operaciones del contrato que ya no existen: {faltan}"
    assert sobran == [], (
        f"Operaciones nuevas sin declarar en el contrato: {sobran}. "
        "Añádalas a contract/openapi-surface.json en este mismo cambio."
    )

    for operacion in sorted(guardado):
        assert actual[operacion] == guardado[operacion], (
            f"«{operacion}» cambió de forma. Guardado: {guardado[operacion]}. "
            f"Ahora: {actual[operacion]}."
        )


def test_todas_las_rutas_llevan_la_version_en_el_camino() -> None:
    """TEST-API-X19-002: la versión va en la ruta, no en una cabecera.

    Con la versión en una cabecera, una integración que no la manda recibe la
    versión que haya ese día, y el día que cambie fallará sin haber tocado
    nada. En la ruta, una integración escrita contra `/api/v1` sigue hablando
    con v1 mientras v1 exista.
    """
    for operacion in current_surface():
        _, path = operacion.split(" ", 1)
        assert path.startswith("/api/v1/"), f"«{operacion}» no está versionada"


def test_la_identidad_viaja_igual_en_todo_lo_que_la_exige() -> None:
    """TEST-API-X19-003: las mismas cabeceras en todas partes.

    Una integración que tiene que mandar `x-usuario` en unas rutas y algo
    distinto en otras acaba mandándolo mal en una de ellas, y el fallo aparece
    semanas después en la ruta que menos se usa.

    Quedan fuera dos superficies, las dos a propósito y las dos comprobadas en
    la prueba siguiente: `health`, que es lo que consulta un orquestador, y la
    telemetría de lectura, que la pide el recorrido publicado sin identidad.
    """
    surface = current_surface()

    for operacion, forma in surface.items():
        _, path = operacion.split(" ", 1)
        if path.endswith("/health") or "/telemetry" in path:
            continue
        params = set(forma["parameters"])
        assert "x-usuario:header" in params, f"«{operacion}» no acepta x-usuario"
        assert "x-rol:header" in params, f"«{operacion}» no acepta x-rol"


def test_solo_la_telemetria_y_la_salud_son_anonimas() -> None:
    """TEST-API-X19-004: la lista de superficies anónimas es cerrada.

    La telemetría de lectura no pide identidad porque la consulta el recorrido
    publicado, que no tiene ninguna, y lo que puede devolver está limitado por
    la lista blanca de variables del servidor. Es una decisión, y por eso se
    escribe aquí: lo que esta prueba impide es que **otra** operación se vuelva
    anónima sin que nadie lo note, que es como una API acaba sirviendo las notas
    de una planta a quien pase por delante.
    """
    anonimas = sorted(
        operacion
        for operacion, forma in current_surface().items()
        if "x-usuario:header" not in set(forma["parameters"])
    )

    assert anonimas == [
        "GET /api/v1/health",
        "GET /api/v1/telemetry/ping",
        "GET /api/v1/telemetry/{mapping_id}/history",
        "POST /api/v1/telemetry/latest",
    ]


def test_ninguna_operacion_escribe_telemetria() -> None:
    """TEST-API-X19-004: la telemetría es de sólo lectura, y se ve en la API.

    Las especificaciones lo exigen —«no se desarrollará control de PLC ni
    escritura de variables de proceso; la telemetría es exclusivamente
    lectura»—. Un extremo de escritura no se añade por descuido, pero si
    alguien lo añadiera, esta prueba es lo que lo pararía: la lista de métodos
    por ruta es la forma más clara de verlo.
    """
    for operacion in current_surface():
        method, path = operacion.split(" ", 1)
        if "/telemetry" not in path:
            continue
        # POST /telemetry/latest es una consulta con cuerpo: la lista de
        # variables no cabe en una cadena de consulta. No escribe nada.
        assert method in ("GET", "POST"), f"«{operacion}» no es de lectura"
        assert method != "PUT" and method != "PATCH" and method != "DELETE"
