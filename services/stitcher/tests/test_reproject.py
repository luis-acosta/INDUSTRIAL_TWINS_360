"""Pruebas de la reproyección (B04).

El servicio validaba la proyección pedida contra una lista y la ignoraba: cosía
en esférica siempre. Estas pruebas comprueban que ahora se aplica y que es
geométricamente correcta, y lo hacen con panorámicas sintéticas donde se sabe
de antemano dónde tiene que acabar cada cosa: una franja en el ecuador, un
cuadrado en el nadir, un color por cuadrante. Una prueba que sólo comprobara
«la imagen cambió de tamaño» no distinguiría una proyección correcta de un
remuestreo al azar.
"""

from __future__ import annotations

import math

import pytest

cv2 = pytest.importorskip("cv2", reason="La reproyección necesita OpenCV")
np = pytest.importorskip("numpy")

from stitcher.reproject import (  # noqa: E402
    CUBE_FACE_ORDER,
    MAX_LATITUDE,
    PROJECTIONS,
    STEREO_HORIZON_RADIUS,
    ReprojectionError,
    cube_atlas,
    cube_faces,
    describe,
    reproject,
)

WIDTH = 512
HEIGHT = 256


def equirect_quadrants() -> np.ndarray:
    """Equirectangular con un color por cuadrante horizontal.

    Permite comprobar a dónde va cada dirección: el cuadrante que contiene el
    yaw 0 —el centro de la imagen— tiene que seguir en el centro de la
    cilíndrica y en la cara +Z del cubo.
    """
    image = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
    for index, color in enumerate(colors):
        x0 = index * WIDTH // 4
        x1 = (index + 1) * WIDTH // 4
        image[:, x0:x1] = color
    return image


def equirect_poles() -> np.ndarray:
    """Equirectangular con un casquete blanco arriba y otro negro abajo.

    Los casquetes son estrechos —1/32 del alto, unos 5,6° de latitud— para que
    queden POR ENCIMA de la latitud de corte de la cilíndrica y la Mercator.
    Con casquetes anchos, el corte a 75° seguiría incluyéndolos y la prueba del
    recorte pasaría sin comprobar nada.
    """
    image = np.full((HEIGHT, WIDTH, 3), 128, dtype=np.uint8)
    image[: HEIGHT // 32, :] = 255
    image[-HEIGHT // 32 :, :] = 0
    return image


class TestContrato:
    def test_la_lista_de_proyecciones_incluye_la_esferica_y_la_cubica(self) -> None:
        # TEST-RPJ-001: el requisito nombra «esféricas, cúbicas y otras»; si la
        # cúbica no estuviera, el requisito no estaría cumplido por mucho que
        # hubiera cinco nombres en la lista.
        assert "spherical" in PROJECTIONS
        assert "cubemap" in PROJECTIONS

    def test_una_proyeccion_desconocida_se_rechaza_con_la_lista(self) -> None:
        # TEST-RPJ-002: el mensaje tiene que decir qué sí se admite, o el
        # cliente prueba nombres a ciegas.
        with pytest.raises(ReprojectionError) as error:
            reproject(equirect_quadrants(), "fisheye", cv2=cv2, np=np)
        assert "spherical" in str(error.value)

    def test_una_imagen_vacia_se_rechaza(self) -> None:
        # TEST-RPJ-003: remuestrear una imagen vacía devolvería otra vacía, que
        # se confundiría con un cosido en negro.
        with pytest.raises(ReprojectionError):
            reproject(np.zeros((0, 0, 3), dtype=np.uint8), "cylindrical", cv2=cv2, np=np)

    def test_cada_proyeccion_explica_para_que_sirve(self) -> None:
        # TEST-RPJ-004: un desplegable con cinco nombres técnicos y ninguna
        # explicación lleva a elegir al azar.
        for projection in PROJECTIONS:
            assert len(describe(projection)) > 30

    def test_la_esferica_devuelve_la_misma_imagen(self) -> None:
        # TEST-RPJ-005: ya está en el espacio que pide el visor; remuestrearla
        # sólo perdería nitidez.
        source = equirect_quadrants()
        assert reproject(source, "spherical", cv2=cv2, np=np) is source


class TestCilindrica:
    def test_conserva_el_centro_y_el_orden_de_los_cuadrantes(self) -> None:
        # TEST-RPJ-006: la cilíndrica no cambia la coordenada horizontal, sólo
        # la vertical. Si rotara el panorama, las verticales rectas que es su
        # razón de ser llegarían en el sitio equivocado.
        result = reproject(equirect_quadrants(), "cylindrical", cv2=cv2, np=np)
        middle = result[result.shape[0] // 2]

        source_middle = equirect_quadrants()[HEIGHT // 2]
        for fraction in (0.12, 0.37, 0.62, 0.87):
            got = middle[int(fraction * result.shape[1])]
            expected = source_middle[int(fraction * WIDTH)]
            assert tuple(int(c) for c in got) == tuple(int(c) for c in expected)

    def test_recorta_los_polos(self) -> None:
        # TEST-RPJ-007: la cilíndrica se va al infinito en los polos. Sin el
        # corte, el último diez por ciento de la esfera ocuparía la mitad del
        # alto y el resultado sería inservible.
        result = reproject(equirect_poles(), "cylindrical", cv2=cv2, np=np)

        # El borde superior corresponde a la latitud de corte, que está por
        # debajo del polo: no debe ser blanco puro.
        top = int(result[0, result.shape[1] // 2, 0])
        assert top < 255

    def test_su_alto_sale_de_la_latitud_de_corte(self) -> None:
        # TEST-RPJ-008: el alto no es una preferencia: lo fija la proyección.
        # Forzar otro la estiraría, que es precisamente lo que la cilíndrica
        # evita.
        result = reproject(equirect_quadrants(), "cylindrical", cv2=cv2, np=np)
        expected = round(WIDTH / (2 * math.tan(MAX_LATITUDE)))
        assert abs(result.shape[0] - expected) <= 1


class TestMercator:
    def test_conserva_el_orden_horizontal(self) -> None:
        # TEST-RPJ-009
        result = reproject(equirect_quadrants(), "mercator", cv2=cv2, np=np)
        middle = result[result.shape[0] // 2]
        source_middle = equirect_quadrants()[HEIGHT // 2]
        assert tuple(int(c) for c in middle[int(0.12 * result.shape[1])]) == tuple(
            int(c) for c in source_middle[int(0.12 * WIDTH)]
        )

    def test_estira_las_latitudes_altas_mas_que_la_cilindrica(self) -> None:
        # TEST-RPJ-010: es la diferencia entre las dos y el motivo de tener
        # ambas. Si salieran iguales, una de las dos sería un adorno.
        cilindrica = reproject(equirect_poles(), "cylindrical", cv2=cv2, np=np)
        mercator = reproject(equirect_poles(), "mercator", cv2=cv2, np=np)
        assert mercator.shape[0] != cilindrica.shape[0]


class TestCubica:
    def test_devuelve_seis_caras(self) -> None:
        # TEST-RPJ-011: seis, con nombres, porque un atlas cúbico sin orden
        # declarado es ilegible para quien lo monta en un motor.
        faces = cube_faces(equirect_quadrants(), cv2=cv2, np=np)
        assert sorted(faces) == sorted(CUBE_FACE_ORDER)

    def test_las_caras_son_cuadradas_y_del_tamaño_derivado(self) -> None:
        # TEST-RPJ-012: una cara cubre 90°, de modo que a igualdad de densidad
        # angular le corresponde una cuarta parte del ancho. Más grande no
        # añade información y multiplica el peso del paquete.
        faces = cube_faces(equirect_quadrants(), cv2=cv2, np=np)
        for face in faces.values():
            assert face.shape[0] == face.shape[1] == WIDTH // 4

    def test_la_cara_frontal_mira_al_centro_de_la_equirectangular(self) -> None:
        # TEST-RPJ-013: el visor de este producto sitúa el giro cero mirando
        # hacia −Z, igual que Three.js, de modo que el centro de la
        # equirectangular cae en la cara «nz». La prueba fija esa convención:
        # si alguien invierte el eje para que sea «pz», el cubo y el visor
        # quedarían en convenciones distintas y el recorrido arrancaría
        # mirando a otra pared según por dónde se mire.
        source = equirect_quadrants()
        faces = cube_faces(source, cv2=cv2, np=np)
        center_face = faces["nz"]
        side = center_face.shape[0]

        # Se mira un punto desplazado del centro exacto y no el centro: el
        # centro de la cara cae justo en la frontera entre dos cuadrantes del
        # patrón, de modo que la interpolación da un empate y la comprobación
        # sería ambigua sin que nada estuviera mal.
        x = side // 2 + side // 10
        a = (x + 0.5) / side * 2 - 1
        # Dirección de ese píxel en la cara «nz»: forward (0,0,−1) más el eje
        # horizontal (−1,0,0) escalado.
        yaw = math.atan2(-a, 1.0)
        u = int(((yaw / (2 * math.pi)) + 0.5) * WIDTH) % WIDTH

        got = tuple(int(c) for c in center_face[side // 2, x])
        expected = tuple(int(c) for c in source[HEIGHT // 2, u])
        assert got == expected

    def test_las_caras_opuestas_miran_a_lados_opuestos(self) -> None:
        # TEST-RPJ-014: +X y −X tienen que recoger cuadrantes distintos; si
        # coincidieran, la tabla de orientaciones estaría mal y el cubo saldría
        # con dos caras repetidas.
        faces = cube_faces(equirect_quadrants(), cv2=cv2, np=np)
        side = faces["px"].shape[0]
        px = tuple(int(c) for c in faces["px"][side // 2, side // 2])
        nx = tuple(int(c) for c in faces["nx"][side // 2, side // 2])
        assert px != nx

    def test_los_polos_caen_en_las_caras_verticales(self) -> None:
        # TEST-RPJ-015: +Y es el cenit y −Y el nadir. Confundirlos pone el
        # cielo bajo los pies, que es el error más visible posible.
        faces = cube_faces(equirect_poles(), cv2=cv2, np=np)
        side = faces["py"].shape[0]
        arriba = int(faces["py"][side // 2, side // 2, 0])
        abajo = int(faces["ny"][side // 2, side // 2, 0])

        assert arriba > 200
        assert abajo < 55

    def test_el_atlas_coloca_las_caras_en_tres_por_dos(self) -> None:
        # TEST-RPJ-016: el orden es parte del contrato; quien lo consume corta
        # el atlas por esa cuadrícula.
        atlas = cube_atlas(equirect_quadrants(), cv2=cv2, np=np)
        side = WIDTH // 4
        assert atlas.shape[0] == side * 2
        assert atlas.shape[1] == side * 3

        faces = cube_faces(equirect_quadrants(), cv2=cv2, np=np)
        for index, name in enumerate(CUBE_FACE_ORDER):
            row, column = divmod(index, 3)
            block = atlas[row * side : (row + 1) * side, column * side : (column + 1) * side]
            assert np.array_equal(block, faces[name])

    def test_el_tamaño_de_cara_se_puede_fijar(self) -> None:
        # TEST-RPJ-017: un motor concreto puede exigir 1024 por cara.
        faces = cube_faces(equirect_quadrants(), face_px=64, cv2=cv2, np=np)
        assert faces["pz"].shape[0] == 64


class TestEstereografica:
    def test_el_centro_es_el_nadir(self) -> None:
        # TEST-RPJ-018: el «pequeño planeta» se reconoce porque el suelo está
        # en el medio. Con el cenit en el centro saldría un túnel.
        result = reproject(equirect_poles(), "stereographic", cv2=cv2, np=np)
        side = result.shape[0]
        assert int(result[side // 2, side // 2, 0]) < 55

    def test_el_horizonte_cae_al_radio_declarado(self) -> None:
        # TEST-RPJ-019: es el parámetro perceptual de esta proyección. Con el
        # horizonte al nueve por ciento del radio —lo que sale al normalizar
        # por la latitud del borde— el suelo quedaría en una moneda en el
        # centro, que no es la imagen que nadie espera.
        source = np.full((HEIGHT, WIDTH, 3), 0, dtype=np.uint8)
        # Franja clara justo por encima del ecuador: en la proyección tiene que
        # aparecer alrededor del radio declarado.
        source[HEIGHT // 2 - 4 : HEIGHT // 2, :] = 255

        result = reproject(source, "stereographic", cv2=cv2, np=np)
        side = result.shape[0]
        center = side // 2
        radius = int(STEREO_HORIZON_RADIUS * side / 2)

        # Hacia la derecha desde el centro, la franja aparece cerca del radio
        # del horizonte y no en el borde ni pegada al centro.
        column = result[center, center : center + side // 2, 0]
        brightest = int(np.argmax(column))
        assert abs(brightest - radius) < side * 0.08

    def test_es_cuadrada(self) -> None:
        # TEST-RPJ-020: la proyección es radial; un lienzo rectangular
        # recortaría el planeta por los lados.
        result = reproject(equirect_quadrants(), "stereographic", cv2=cv2, np=np)
        assert result.shape[0] == result.shape[1]
