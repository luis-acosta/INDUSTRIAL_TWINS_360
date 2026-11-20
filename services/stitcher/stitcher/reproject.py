"""Reproyección de la panorámica cosida (B04).

El cosido produce una equirectangular: es el espacio de trabajo natural del
ajuste de haces y el que entiende el visor. Pero el requisito pide **elegir** la
proyección —esférica, cúbica y otras—, y hasta ahora el servicio validaba la
elección contra una lista y no la aplicaba: cosía en esférica siempre y
devolvía eso, con lo que el campo era un adorno.

La razón por la que no se aplicaba es real: `cv2.Stitcher` de alto nivel no
expone el deformador, de modo que no se puede pedir «cose en cilíndrica». Lo
que sí se puede hacer, y es lo correcto, es coser en esférica —donde el ajuste
converge mejor— y **reproyectar** el resultado. Para una panorámica completa
las dos cosas son equivalentes: la equirectangular contiene todas las
direcciones, así que cualquier otra proyección global es un remuestreo de ella.

Cada proyección existe para algo distinto y el módulo lo dice, porque elegir
una sin saber para qué sirve es elegir al azar:

- **Equirectangular**: la que consume el visor. Es la que hay que entregar si
  la panorámica va a un recorrido.
- **Cúbica**: seis caras de 90°. Es lo que piden los motores de juego y lo que
  usa un visor que teselea por caras; además no concentra la resolución en el
  ecuador como la equirectangular.
- **Cilíndrica**: conserva las verticales rectas. Es la que quiere quien va a
  imprimir una panorámica de una nave industrial, donde las columnas torcidas
  se notan.
- **Mercator**: conserva los ángulos localmente. Útil cuando sobre la
  panorámica se van a medir direcciones.
- **Estereográfica**: el «pequeño planeta». Es presentación, no documentación.

Todo el remuestreo es `cv2.remap` sobre mapas calculados con numpy: el bucle
por píxel en Python tardaría minutos en una panorámica de 8K.
"""

from __future__ import annotations

import math
from typing import Any, Final

#: Proyecciones que el servicio sabe entregar.
#:
#: `spherical` es la equirectangular que sale del cosido; el resto son
#: reproyecciones de ella.
PROJECTIONS: Final[tuple[str, ...]] = (
    "spherical",
    "cubemap",
    "cylindrical",
    "mercator",
    "stereographic",
)

#: Latitud máxima de la cilíndrica y la Mercator, en radianes.
#:
#: Las dos se van al infinito en los polos. El corte a 75° es el que usan los
#: programas de panorámicas: conserva la nave entera de una planta industrial
#: —donde lo que importa está entre el suelo y las cerchas— y evita que el
#: último diez por ciento de la imagen ocupe la mitad del alto.
MAX_LATITUDE: Final[float] = math.radians(75.0)

#: Radio al que cae el horizonte en la estereográfica, en fracción del borde.
#:
#: Es el parámetro perceptual de esta proyección y por eso es el que se
#: configura, en lugar de la latitud del borde. El «pequeño planeta» se
#: reconoce porque el suelo forma un disco que ocupa aproximadamente la mitad
#: del radio y el cielo llena el resto; fijando la latitud del borde en un
#: valor alto —80°, digamos— el horizonte caería al nueve por ciento del radio
#: y el suelo quedaría reducido a una moneda en el centro, que no es la imagen
#: que nadie espera.
#:
#: Con el horizonte a la mitad del radio, el borde de la imagen acaba
#: mostrando unos 37° por encima del horizonte, que es lo que se ve en un
#: «pequeño planeta» de verdad.
STEREO_HORIZON_RADIUS: Final[float] = 0.5

#: Orden de las caras en el atlas cúbico, en cuadrícula de 3 × 2.
#:
#: Es la disposición «horizontal cross» que esperan la mayoría de los motores,
#: y va documentada porque un atlas cúbico sin orden declarado es ilegible.
CUBE_FACE_ORDER: Final[tuple[str, ...]] = ("px", "nx", "py", "ny", "pz", "nz")


class ReprojectionError(ValueError):
    """Proyección desconocida o imagen de entrada inservible."""


def reproject(equirect: Any, projection: str, *, cv2: Any = None, np: Any = None) -> Any:
    """Reproyecta una equirectangular a la proyección pedida.

    `cv2` y `np` se pueden inyectar para no importarlos dos veces en el mismo
    proceso; en producción se importan aquí. La imagen de entrada tiene que ser
    una equirectangular completa, con relación 2:1 o cercana: aplicar esto a
    una panorámica parcial daría una imagen con la mitad vacía y con aspecto de
    error de cosido.
    """
    cv2_mod, np_mod = _modules(cv2, np)

    if projection not in PROJECTIONS:
        raise ReprojectionError(
            f"Proyección no admitida: {projection}. Admitidas: {', '.join(PROJECTIONS)}"
        )
    if equirect is None or getattr(equirect, "size", 0) == 0:
        raise ReprojectionError("La imagen de entrada está vacía")

    if projection == "spherical":
        # Identidad: ya está en el espacio que pide el visor. Devolver una
        # copia remuestreada sólo perdería nitidez.
        return equirect

    if projection == "cubemap":
        return cube_atlas(equirect, cv2=cv2_mod, np=np_mod)

    height, width = equirect.shape[:2]

    if projection == "cylindrical":
        out_w = width
        out_h = max(1, int(round(width / (2 * math.tan(MAX_LATITUDE)))))
        map_x, map_y = _cylindrical_maps(np_mod, out_w, out_h, width, height)
    elif projection == "mercator":
        out_w = width
        # El alto sale de la propia proyección: la Mercator de un rango de
        # latitudes tiene una altura determinada por ese rango, y forzar otra
        # la estiraría, que es exactamente lo que la Mercator evita.
        out_h = max(1, int(round(width * _mercator_y(MAX_LATITUDE) / math.pi)))
        map_x, map_y = _mercator_maps(np_mod, out_w, out_h, width, height)
    else:
        side = max(1, min(width, height * 2))
        map_x, map_y = _stereographic_maps(np_mod, side, width, height)

    return cv2_mod.remap(
        equirect,
        map_x,
        map_y,
        interpolation=cv2_mod.INTER_LINEAR,
        borderMode=cv2_mod.BORDER_WRAP,
    )


def cube_faces(equirect: Any, *, face_px: int = 0, cv2: Any = None, np: Any = None) -> dict[str, Any]:
    """Las seis caras del cubo, por nombre.

    `face_px` por omisión se deriva del ancho de la equirectangular: una cara
    de un cubo cubre 90°, de modo que a igualdad de densidad angular le
    corresponde una cuarta parte del ancho. Elegirlo más grande no añade
    información y multiplica el peso del paquete.
    """
    cv2_mod, np_mod = _modules(cv2, np)
    height, width = equirect.shape[:2]
    side = face_px if face_px > 0 else max(1, width // 4)

    faces: dict[str, Any] = {}
    for name in CUBE_FACE_ORDER:
        map_x, map_y = _cube_face_maps(np_mod, name, side, width, height)
        faces[name] = cv2_mod.remap(
            equirect,
            map_x,
            map_y,
            interpolation=cv2_mod.INTER_LINEAR,
            borderMode=cv2_mod.BORDER_WRAP,
        )
    return faces


def cube_atlas(equirect: Any, *, face_px: int = 0, cv2: Any = None, np: Any = None) -> Any:
    """Las seis caras en una sola imagen de 3 × 2, en el orden declarado."""
    cv2_mod, np_mod = _modules(cv2, np)
    faces = cube_faces(equirect, face_px=face_px, cv2=cv2_mod, np=np_mod)
    side = faces[CUBE_FACE_ORDER[0]].shape[0]
    channels = equirect.shape[2] if equirect.ndim == 3 else 1

    shape = (side * 2, side * 3, channels) if channels > 1 else (side * 2, side * 3)
    atlas = np_mod.zeros(shape, dtype=equirect.dtype)

    for index, name in enumerate(CUBE_FACE_ORDER):
        row, column = divmod(index, 3)
        atlas[row * side : (row + 1) * side, column * side : (column + 1) * side] = faces[name]
    return atlas


def describe(projection: str) -> str:
    """Para qué sirve cada proyección, en una frase.

    Va en la interfaz y en el informe del lote: un desplegable con cinco
    nombres técnicos y ninguna explicación lleva a elegir al azar.
    """
    return {
        "spherical": "Equirectangular: la que consume el visor del recorrido.",
        "cubemap": "Cúbica: seis caras de 90°, para motores 3D y teselado por caras.",
        "cylindrical": "Cilíndrica: mantiene las verticales rectas; la mejor para imprimir.",
        "mercator": "Mercator: conserva los ángulos; útil para medir direcciones.",
        "stereographic": "Estereográfica: el «pequeño planeta»; presentación, no documentación.",
    }[projection]


# ------------------------------------------------------------------ #
# Mapas de remuestreo
#
# Todos devuelven dos matrices float32 con la coordenada de origen de cada
# píxel de destino, que es lo que `cv2.remap` consume. Se construyen con
# operaciones vectorizadas: el bucle por píxel en Python tardaría minutos.
# ------------------------------------------------------------------ #


def _equirect_sample(np: Any, yaw: Any, pitch: Any, width: int, height: int) -> tuple[Any, Any]:
    """Pasa dirección a coordenada de la equirectangular.

    El medio píxel de desplazamiento no es un detalle: sin él la imagen se
    desplaza medio píxel por reproyección y, encadenando dos, el resultado sale
    visiblemente movido respecto al original.
    """
    u = (yaw / (2 * math.pi) + 0.5) * width - 0.5
    v = (0.5 - pitch / math.pi) * height - 0.5
    return u.astype(np.float32), v.astype(np.float32)


def _cylindrical_maps(np: Any, out_w: int, out_h: int, width: int, height: int) -> tuple[Any, Any]:
    xs = np.arange(out_w, dtype=np.float32)
    ys = np.arange(out_h, dtype=np.float32)
    grid_x, grid_y = np.meshgrid(xs, ys)

    yaw = (grid_x + 0.5) / out_w * 2 * math.pi - math.pi
    # La cilíndrica es lineal en la tangente de la latitud: es lo que mantiene
    # las verticales rectas, que es la razón de usarla.
    t = ((grid_y + 0.5) / out_h * 2 - 1) * math.tan(MAX_LATITUDE)
    pitch = -np.arctan(t)
    return _equirect_sample(np, yaw, pitch, width, height)


def _mercator_y(latitude: float) -> float:
    """Coordenada vertical de la Mercator para una latitud."""
    return math.log(math.tan(math.pi / 4 + latitude / 2))


def _mercator_maps(np: Any, out_w: int, out_h: int, width: int, height: int) -> tuple[Any, Any]:
    xs = np.arange(out_w, dtype=np.float32)
    ys = np.arange(out_h, dtype=np.float32)
    grid_x, grid_y = np.meshgrid(xs, ys)

    yaw = (grid_x + 0.5) / out_w * 2 * math.pi - math.pi
    limit = _mercator_y(MAX_LATITUDE)
    y = ((grid_y + 0.5) / out_h * 2 - 1) * limit
    # Inversa de la Mercator: la latitud sale del arco tangente hiperbólico.
    pitch = -(2 * np.arctan(np.exp(y)) - math.pi / 2)
    return _equirect_sample(np, yaw, pitch, width, height)


def _stereographic_maps(np: Any, side: int, width: int, height: int) -> tuple[Any, Any]:
    xs = np.arange(side, dtype=np.float32)
    grid_x, grid_y = np.meshgrid(xs, xs)

    # Coordenadas centradas en [-1, 1].
    x = (grid_x + 0.5) / side * 2 - 1
    y = (grid_y + 0.5) / side * 2 - 1

    radius = np.hypot(x, y)
    yaw = np.arctan2(x, -y)

    # Estereográfica desde el cenit sobre el plano tangente al nadir: un punto
    # a ángulo polar θ del nadir cae a radio k·tan(θ/2). El centro de la imagen
    # es entonces el suelo bajo el fotógrafo y el borde, la latitud de corte:
    # así sale el «pequeño planeta» con el suelo en medio, que es la
    # composición que la gente reconoce.
    #
    # θ = 0 en el nadir y θ = π en el cenit. `k` se fija para que el horizonte
    # —θ = π/2— caiga en el radio declarado, que es el parámetro que decide el
    # aspecto de la imagen.
    k = math.tan(math.pi / 4) / STEREO_HORIZON_RADIUS

    theta = 2 * np.arctan(radius * k)
    pitch = theta - math.pi / 2
    return _equirect_sample(np, yaw, pitch, width, height)


#: Dirección de la normal y de los ejes de cada cara del cubo.
#:
#: `forward` es hacia dónde mira la cara; `right` y `up`, sus ejes en la
#: imagen. La tabla está escrita y no calculada para que el orden de las caras
#: y su orientación se puedan leer y comprobar: una cara girada 90° no se nota
#: hasta que alguien monta el cubo en un motor.
#:
#: **Convención de giro.** El visor de este producto —como Three.js— sitúa el
#: giro cero mirando hacia −Z, de modo que el centro de la equirectangular cae
#: en la cara `nz` y no en `pz`. Se deja así, y escrito, en lugar de invertir
#: el eje: cambiarlo aquí dejaría el cubo en una convención y el visor en otra,
#: y el síntoma sería un recorrido que arranca mirando a otra pared según por
#: dónde se mire.
_CUBE_BASIS: Final[dict[str, tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]] = {
    "px": ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
    "nx": ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    "py": ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
    "ny": ((0, -1, 0), (1, 0, 0), (0, 0, -1)),
    "pz": ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    "nz": ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
}


def _cube_face_maps(np: Any, face: str, side: int, width: int, height: int) -> tuple[Any, Any]:
    forward, right, up = _CUBE_BASIS[face]

    xs = np.arange(side, dtype=np.float32)
    grid_x, grid_y = np.meshgrid(xs, xs)
    a = (grid_x + 0.5) / side * 2 - 1
    b = 1 - (grid_y + 0.5) / side * 2

    dx = forward[0] + right[0] * a + up[0] * b
    dy = forward[1] + right[1] * a + up[1] * b
    dz = forward[2] + right[2] * a + up[2] * b

    norm = np.sqrt(dx * dx + dy * dy + dz * dz)
    dx, dy, dz = dx / norm, dy / norm, dz / norm

    yaw = np.arctan2(dx, -dz)
    pitch = np.arcsin(np.clip(dy, -1, 1))
    return _equirect_sample(np, yaw, pitch, width, height)


def _modules(cv2: Any, np: Any) -> tuple[Any, Any]:
    if cv2 is None:
        import cv2 as cv2_mod  # noqa: PLC0415
    else:
        cv2_mod = cv2
    if np is None:
        import numpy as np_mod  # noqa: PLC0415
    else:
        np_mod = np
    return cv2_mod, np_mod
