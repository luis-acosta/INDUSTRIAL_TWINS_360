# Cosido de panorámicas — **función experimental**

El plan declara el cosido como algoritmo no trivial y exige no presentarlo como
terminado si no alcanza calidad. Este servicio está construido alrededor de esa
exigencia.

## Qué lo hace distinto de llamar a `cv2.Stitcher`

`cv2.Stitcher` devuelve una imagen y un código de éxito, y nada más. No dice
cuántas coincidencias encontró, ni cuánto se desvían los puntos tras estimar la
geometría, ni qué imágenes dejó fuera. Sin esas métricas no se puede juzgar el
resultado, y sin juzgarlo sólo queda entregarlo y esperar.

Aquí todo cosido se mide y recibe uno de tres veredictos:

| Veredicto | Qué significa | Se entrega |
|---|---|---|
| `accepted` | las métricas están dentro de lo razonable | sí, marcado experimental |
| `needsReview` | algo no cuadra y una persona debe mirarlo | sí, marcado y con los motivos |
| `rejected` | el resultado no sirve | **no**, con el motivo y qué hacer distinto |

Un caso real que esto detecta: OpenCV puede devolver «éxito» con una imagen de
57×30 píxeles cuando la geometría estimada es absurda. El código de retorno no
lo distingue de un cosido bueno. La comprobación de tamaño degenerado sí
(`tests/test_pipeline.py`).

## Las métricas y lo que detecta cada una

- **Coincidencias verificadas por par.** No las que devuelve el emparejador
  —entre dos fotos sin nada en común, ORB produce cientos de falsas— sino las
  que sobreviven a la prueba de la razón de Lowe y a la verificación con
  RANSAC. Es la evidencia real sobre la que se apoya la geometría.
- **Error de reproyección.** Delata el contorno doble cerca de la costura.
- **Dispersión de exposición.** Se mide por rango y no por desviación típica:
  una sola foto mal expuesta produce un escalón de brillo visible, y la
  desviación típica la diluiría entre las demás (B08).
- **Proporción de píxeles vacíos.** Bordes negros al girar la vista.
- **Cobertura horizontal y vertical.** Distingue panorámica completa de parcial
  (B03). Una parcial es un resultado legítimo, pero quien fotografió en círculo
  tiene que enterarse de que no se cerró.

## Lentes (B02)

La lente se determina por lo que declare el usuario, luego por EXIF, y si no se
puede, **se declara sin determinar**. Suponer «estándar» porque es lo más común
produce bordes estirados que parecen un defecto del cosido y no de la
suposición.

## Lotes (B05)

Ningún trabajo detiene el lote. El informe ordena los resultados poniendo
primero lo que hay que volver a fotografiar, porque es lo que obliga a volver a
la planta y conviene leerlo antes de desmontar el trípode.

## Lo que falta

- **Puntos de control a mano (B07).** El campo existe en la petición y todavía
  no se usa en la estimación.
- **Live Panorama y Adaptive HDR (B06).** Sin empezar.
- **Proyecciones distintas de la esférica (B04).** Declaradas y validadas en la
  entrada; la tubería usa hoy el modo panorámico de OpenCV, que proyecta en
  esférica.

## Pruebas

```
python3 -m pytest services/stitcher
```

Las pruebas del cosido real generan escenas sintéticas con textura suficiente
para el emparejamiento: no hay fotografías en el repositorio y la verdad de
referencia se conoce, porque los recortes se hacen con un desplazamiento
conocido. Las que necesitan OpenCV se saltan si no está instalado.
