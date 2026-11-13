"""Modelos de lente y preparación de las imágenes de entrada (B02).

Coser fotografías empieza por saber con qué se tomaron. Una lente estándar y un
ojo de pez producen deformaciones distintas, y el cosido falla —o, peor, sale
plausible y deformado— si se tratan igual.

La información viene de tres sitios, en este orden de fiabilidad:

1. Lo que declare el usuario. Si lo dice, se le cree: conoce su equipo.
2. Los metadatos EXIF, cuando los hay.
3. Una estimación por la relación entre la distancia focal y el tamaño del
   sensor, que es lo único que queda cuando la foto viene recortada o sin EXIF.

Cuando no se puede determinar, **no se adivina**: se devuelve `UNKNOWN` y el
trabajo se marca para revisión. Suponer «estándar» porque es lo más común
produce panorámicas con las esquinas estiradas que parecen un defecto del
cosido y no de la suposición.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Final


class LensType(str, Enum):
    """Tipo de lente, por el tratamiento que necesita."""

    STANDARD = "standard"
    WIDE = "wide"
    FISHEYE = "fisheye"
    EQUIRECTANGULAR = "equirectangular"
    UNKNOWN = "unknown"


LENS_LABELS: Final[dict[LensType, str]] = {
    LensType.STANDARD: "Estándar",
    LensType.WIDE: "Gran angular",
    LensType.FISHEYE: "Ojo de pez",
    LensType.EQUIRECTANGULAR: "Equirectangular (ya cosida)",
    LensType.UNKNOWN: "Sin determinar",
}

#: Modelo de proyección de OpenCV que corresponde a cada lente.
#:
#: Los nombres son los del módulo `cv2.detail`: el cosido necesita saber cómo
#: proyectar los píxeles de origen antes de mezclarlos, y usar el modelo
#: equivocado produce costuras que no se pueden corregir después.
WARP_MODEL: Final[dict[LensType, str]] = {
    LensType.STANDARD: "spherical",
    LensType.WIDE: "spherical",
    LensType.FISHEYE: "fisheye",
    LensType.EQUIRECTANGULAR: "spherical",
    LensType.UNKNOWN: "spherical",
}

#: Diagonal del sensor de 35 mm, en milímetros. Es la referencia con la que se
#: expresan las distancias focales equivalentes.
FULL_FRAME_DIAGONAL_MM: Final[float] = 43.27


@dataclass(frozen=True, slots=True)
class LensProfile:
    """Lo que se sabe de la lente de una imagen."""

    lens_type: LensType
    #: Campo de visión horizontal estimado, en grados. `None` si no se sabe.
    horizontal_fov_deg: float | None
    #: De dónde salió la determinación, para poder juzgarla.
    source: str
    #: Distancia focal equivalente a 35 mm, cuando se conoce.
    equivalent_focal_mm: float | None = None

    @property
    def warp_model(self) -> str:
        return WARP_MODEL[self.lens_type]

    @property
    def needs_review(self) -> bool:
        """`True` si el cosido debe marcarse para revisión humana."""
        return self.lens_type is LensType.UNKNOWN


def fov_from_focal(equivalent_focal_mm: float) -> float:
    """Campo de visión horizontal a partir de la focal equivalente.

    Se usa la diagonal del sensor y no el lado largo: la focal equivalente se
    define por la diagonal, y calcularla con el lado largo da un error de varios
    grados que luego se traduce en una costura visible.
    """
    if equivalent_focal_mm <= 0:
        raise ValueError("La distancia focal debe ser positiva")

    import math

    # Campo diagonal, convertido a horizontal suponiendo 3:2, que es la
    # relación de la mayoría de las cámaras con las que se fotografía una
    # planta. La aproximación es suficiente para elegir el modelo de lente.
    diagonal_fov = 2 * math.atan(FULL_FRAME_DIAGONAL_MM / (2 * equivalent_focal_mm))
    horizontal = 2 * math.atan(math.tan(diagonal_fov / 2) * (3 / math.sqrt(3**2 + 2**2)))
    return math.degrees(horizontal)


def classify_by_fov(horizontal_fov_deg: float) -> LensType:
    """Clasifica la lente por su campo de visión horizontal.

    Los umbrales no son arbitrarios: por encima de 120° la deformación deja de
    ser corregible con una proyección rectilínea, que es la frontera práctica
    entre gran angular y ojo de pez.
    """
    if horizontal_fov_deg <= 0:
        return LensType.UNKNOWN
    if horizontal_fov_deg >= 300:
        return LensType.EQUIRECTANGULAR
    if horizontal_fov_deg > 120:
        return LensType.FISHEYE
    if horizontal_fov_deg > 70:
        return LensType.WIDE
    return LensType.STANDARD


def profile_from_declared(lens_type: LensType, horizontal_fov_deg: float | None = None) -> LensProfile:
    """Perfil a partir de lo que declara el usuario."""
    return LensProfile(
        lens_type=lens_type,
        horizontal_fov_deg=horizontal_fov_deg,
        source="declarado por el usuario",
    )


def profile_from_exif(exif: dict[str, object]) -> LensProfile | None:
    """Perfil a partir de los metadatos de la imagen.

    Devuelve `None` cuando el EXIF no basta, en lugar de un perfil con valores
    inventados. Es la diferencia entre «no lo sé» y «creo que es estándar», y en
    el segundo caso el cosido saldría mal sin que nadie supiera por qué.
    """
    focal_35 = exif.get("FocalLengthIn35mmFilm") or exif.get("FocalLengthIn35mmFormat")

    if isinstance(focal_35, (int, float)) and focal_35 > 0:
        fov = fov_from_focal(float(focal_35))
        return LensProfile(
            lens_type=classify_by_fov(fov),
            horizontal_fov_deg=round(fov, 1),
            source="EXIF: focal equivalente a 35 mm",
            equivalent_focal_mm=float(focal_35),
        )

    focal = exif.get("FocalLength")
    crop = exif.get("CropFactor")
    if isinstance(focal, (int, float)) and isinstance(crop, (int, float)) and focal > 0 and crop > 0:
        equivalent = float(focal) * float(crop)
        fov = fov_from_focal(equivalent)
        return LensProfile(
            lens_type=classify_by_fov(fov),
            horizontal_fov_deg=round(fov, 1),
            source="EXIF: focal y factor de recorte",
            equivalent_focal_mm=equivalent,
        )

    # Algunas cámaras 360 declaran la proyección directamente.
    projection = exif.get("ProjectionType")
    if isinstance(projection, str) and projection.lower() in {"equirectangular", "equirect"}:
        return LensProfile(
            lens_type=LensType.EQUIRECTANGULAR,
            horizontal_fov_deg=360.0,
            source="EXIF: tipo de proyección declarado",
        )

    return None


def resolve_profile(
    *,
    declared: LensType | None = None,
    declared_fov_deg: float | None = None,
    exif: dict[str, object] | None = None,
) -> LensProfile:
    """Determina el perfil con la mejor información disponible.

    El orden —usuario, EXIF, nada— no es sólo una preferencia: el usuario puede
    saber que la foto está recortada, y en ese caso el EXIF miente. Darle
    prioridad al dato declarado es respetar que conoce su equipo.
    """
    if declared is not None and declared is not LensType.UNKNOWN:
        return profile_from_declared(declared, declared_fov_deg)

    if exif is not None:
        from_exif = profile_from_exif(exif)
        if from_exif is not None:
            return from_exif

    return LensProfile(
        lens_type=LensType.UNKNOWN,
        horizontal_fov_deg=None,
        source="no determinada: ni declaración ni metadatos utilizables",
    )
