# Limitaciones conocidas

Este documento existe porque el plan lo exige y porque es lo primero que
debería leer quien vaya a entregar un recorrido a un cliente. Está ordenado por
lo que más puede sorprender en una entrega, no por etapas del desarrollo.

Lo que aquí dice «no está» significa que **no está**, no que esté a medias. Lo
que dice «experimental» está implementado, probado y puede fallar: el producto
lo marca en pantalla y en los paquetes que genera.

---

## 1. Lo que todavía no está

### Autenticación del servidor

El servidor comprueba permisos correctamente —rol, ámbito de planta/unidad/área,
caducidad de la concesión, categorías de nota— y lo hace en el servidor, no sólo
en la interfaz. **Pero la identidad llega por cabeceras HTTP y no se valida.**

Eso significa que cualquiera que alcance el puerto del servidor puede
presentarse como administrador. La integración con el directorio del cliente
(LDAP o SSO) sustituye la función `current_grants` y es la parte pendiente de la
etapa 11.

**Consecuencia práctica:** no exponga el servidor fuera de una red de confianza
hasta que esa integración esté hecha. El aviso está escrito en el código, junto
a la función, y en `apps/server/README.md`.

### Persistencia del servidor

El registro de auditoría del servidor es en memoria. Tiene la misma semántica
que tendrá la tabla —sólo añadir, cadena de huellas verificable— pero se pierde
al reiniciar. La persistencia en PostgreSQL y la copia de respaldo y
restauración (X18) están pendientes.

### Guardado en la versión web

La aplicación corre en el navegador para desarrollo y demostración, y ahí
**trabaja en memoria**: no puede abrir ni guardar archivos. El guardado real,
con escritura atómica y rotación de copias, vive en el contenedor de Windows.
La interfaz lo dice cuando se intenta.

### Visor portable de un solo archivo (S04)

No está. El paquete sin conexión cubre el mismo caso: se descomprime y se abre
con el navegador del equipo, sin instalar nada.

### Recorridos automáticos y evaluaciones: pantallas de autor

Los motores están implementados y probados —puntos de paso, interrupción,
puntuación con objetivos independientes— pero las pantallas para crearlos desde
el editor no. Un proyecto que ya traiga recorridos o evaluaciones los ejecuta
bien; crearlos desde cero requiere editar el proyecto por otra vía.

### Editor de interfaz por arrastrar y soltar (F01)

No está. Los *skins* se aplican si vienen en el proyecto.

### Correo: el aviso no lleva la nota (P07)

Al asignar una nota se avisa por correo a quien se le asigna. **El correo no
lleva el contenido de la nota**: dice que hay una nota asignada, en qué planta y
con qué urgencia, y un enlace para abrirla. Las notas de planta describen fugas,
incumplimientos y riesgos; un correo atraviesa servidores que nadie en el
proyecto controla, se reenvía y se queda en bandejas durante años.

El servidor SMTP se configura con `IT360_SMTP_HOST` y compañía. **Sin él, los
avisos se encolan y se declaran no entregados**, y el editor lo dice al autor en
ese momento: muchas plantas no dejan salir SMTP de la red de proceso, y aceptar
un aviso que no sale haría creer avisado a alguien que no lo está.

La cola es en memoria, como el registro de auditoría: tiene la semántica que
tendrá la tabla y se pierde al reiniciar. Los avisos de vencimiento próximo
(`note.due_soon`) están compuestos y probados pero todavía no los dispara nadie:
hace falta un proceso periódico, que llega con la persistencia.

### Notas desde el móvil: identificación sin autenticación (P09)

Las notas del proyecto se pueden consultar y comentar desde un teléfono: el
recorrido publicado las pide al servicio, que las sirve recortadas por la
concesión de quien pregunta —incluido el ámbito por categoría—. Desde el móvil
se comenta y se mueve el estado de trabajo; **no** se resuelve ni se archiva,
porque resolver exige escribir cómo se resolvió y eso es del responsable del
proyecto.

La identidad llega por cabeceras y **no se valida**, igual que en el resto del
servicio: el dispositivo guarda el identificador que la persona escribe y la
pantalla lo dice con esas palabras. Hasta que la integración con el directorio
del cliente esté hecha, esto sirve en la red de la planta y no fuera de ella.

Las notas que el servicio sirve son la copia que le manda el editor al abrir el
proyecto y al cambiar algo: el servicio no lee archivos de proyecto. Si el
editor no está abierto, lo que el móvil ve es la última copia publicada.

---

## 2. Lo que es experimental

### Realidad virtual (etapa 13): verificada en dobles, no en un visor

La sesión inmersiva está implementada de punta a punta —petición de sesión,
espacio de referencia, bucle de fotogramas, paneles de interfaz con los mismos
nodos que la versión plana, acciones con el mismo ejecutor, y recogida al
quitarse las gafas— y su ciclo de vida está probado con dobles fieles a la
especificación de WebXR.

**Lo que nadie ha podido comprobar es lo único que importa de verdad en VR:**
que se vea bien y no produzca malestar. Eso exige un visor físico y no se ha
ejecutado en ninguno. Por eso la sesión inmersiva se declara **experimental** y
no completa, y el producto lo dice en pantalla.

La publicación ya entrega un juego de panorámicas reducido por clase de visor
(4096 px para un visor autónomo, 8192 px para uno conectado a un PC), y el
recorrido carga la copia reducida sólo mientras presenta. La multimedia
emergente también funciona dentro de la sesión: el vídeo se lleva a una textura,
el audio suena con su panel de estado, y un documento —que no se puede mostrar
ahí— lo dice en lugar de dejar la acción muda.

### Conexión automática de escenas (C05–C09)

Propone marcadores de navegación entre escenas usando, por este orden: la
posición GPS de las capturas, la posición de los puntos en el plano, o el orden
temporal de captura.

**Lo que hace bien:** con GPS y rumbo de captura, el azimut del marcador sale
correcto y la distancia estimada es fiable a escala de planta.

**Lo que no puede hacer:** no mira las imágenes. No sabe si entre dos capturas
a tres metros hay una pared. Por eso ninguna propuesta llega al 100 % de
confianza, y por eso todas entran en el proyecto marcadas como **sin revisar** y
el plan de publicación las deja fuera hasta que una persona las confirma.

Si las capturas no traen GPS ni están en un plano, usa el orden de captura, que
es una señal débil: lo declara, da confianza baja y dice que la dirección del
marcador es una convención que hay que corregir a mano.

### Cosido de panorámicas (B01–B03, B05, B08)

Cose fotografías en panorámicas y **evalúa el resultado** con tres veredictos:
aceptable, requiere revisión, rechazado. Lo rechazado no se entrega.

**Lo que detecta:** pocas coincidencias verificadas, error de reproyección alto
(contornos dobles), diferencias de exposición entre tomas, huecos en el
resultado, cobertura incompleta, y el caso en que OpenCV declara éxito con una
imagen degenerada.

**Lo que no está:** Live Panorama y Adaptive HDR (B06). Los puntos de control a
mano (B07) están implementados y marcados **experimentales**: estiman la
homografía de cada par, rechazan la que no es plausible y señalan el punto peor
marcado volviendo a estimar sin él, pero con cinco puntos justos el margen es
estrecho y conviene marcar más. Las proyecciones distintas de la esférica (B04)
ya se producen: cúbica, cilíndrica, Mercator y estereográfica.

**Recomendación de uso:** fotografíe con exposición manual fija y gire poco
entre tomas —cada foto debe compartir al menos un tercio con la anterior—. Los
dos consejos están en los mensajes de rechazo porque son la causa de la mayoría
de los fallos.

---

### Vídeo del recorrido: se graba el lienzo (S07)

La previsualización graba el recorrido en vídeo con lo que trae el navegador,
sin programas aparte. **Lo que entra en el vídeo es el lienzo**: la panorámica o
el modelo con sus marcadores. Los paneles de la interfaz son HTML encima del
lienzo y no entran, y el audio de las narraciones tampoco, porque no pasa por el
lienzo. Se dice en la pantalla antes de grabar, no después.

El formato es el que admita el navegador —WebM con VP9 donde se pueda—. Para un
vídeo de la pantalla completa, con interfaz y sonido, hace falta un grabador de
pantalla.

### Vídeo: se elige, no se transcodifica (V04)

El recorrido entrega la versión del vídeo que corresponde al dispositivo y a la
red —con el ahorro de datos y una red lenta por delante de cualquier criterio de
calidad—, y la publicación avisa cuando un vídeo de alta resolución es la única
versión que hay.

**Lo que esta plataforma no hace es transcodificar.** No lleva codificador de
vídeo: añadirlo significaría arrastrar al instalador una biblioteca de cientos
de megabytes con sus propias licencias, y el resultado sería peor que el de
cualquier herramienta de edición. Las versiones las exporta quien hace el vídeo
—que ya las exporta— y se añaden al proyecto; aquí se validan, se publican y se
eligen. La comprobación que más vale es la de duración: una versión que no es el
mismo vídeo cambia lo que se ve según el dispositivo, y eso no se descubre hasta
que alguien lo abre en el dispositivo equivocado.

---

## 3. Límites por diseño

Estas no son carencias: son decisiones, y están así a propósito.

### La telemetría es sólo de lectura

No existe ninguna ruta de escritura hacia el historiador ni hacia el PLC. No es
una opción de configuración: la superficie completa de la API de telemetría son
cuatro operaciones de lectura, y toda consulta pasa por un verificador que la
rechaza si contiene palabras de escritura o de salida de red.

El producto **no controla procesos** y no va a hacerlo.

### El recorrido publicado no conoce credenciales

El paquete publicado no contiene tokens, referencias a secretos, conexiones al
historiador, usuarios, permisos ni registro de auditoría. El visor pide lecturas
por identificador de variable a un servicio, y ese servicio resuelve la
credencial en su propio proceso.

Una prueba recorre el manifiesto generado buscando las claves prohibidas, y
antes comprueba que el proyecto de prueba **sí** las tiene: así la prueba
demuestra algo.

### JavaScript del autor, deshabilitado por defecto

El plan lo declara de riesgo alto. Está deshabilitado, requiere aprobación
explícita por huella, se ejecuta en contexto aislado con límite de tiempo y sin
acceso al sistema de archivos ni a la red. Los guiones de un proyecto importado
nunca se ejecutan sin aprobarse de nuevo, y el paquete publicado los retira si
la política no los permite ahí.

### Los datos sin conexión se etiquetan como caché

Un paquete sin conexión no consulta el historiador y lo dice en pantalla: «Sin
datos de proceso en este paquete». Nunca presenta un valor antiguo como lectura
actual. El archivo LEEME del paquete lo repite por escrito, porque quien abre un
USB en una sala de control no ha leído esta documentación.

### Una variable sin reglas no se pinta de verde

Si una variable de proceso no tiene ninguna regla de condición habilitada, el
indicador muestra «Sin reglas» en gris, no «Normal» en verde. Verde significa
«lo he comprobado y está bien»; sin reglas nadie ha comprobado nada. Es la
diferencia entre un equipo sano y un equipo sin vigilancia.

### Los huecos del histórico se dibujan como huecos

Una gráfica no une dos lecturas separadas por un periodo sin datos. Esa recta
no existió y se leería como una variable estable. Una lectura aislada entre
huecos se dibuja como punto, no se descarta.

---

## 4. Límites técnicos del visor

| Límite | Valor | Motivo |
|---|---|---|
| Lado máximo de panorámica | lo que admita la GPU (se consulta al arrancar) | Por encima, la textura no se puede subir y el visor degrada la resolución |
| Tamaño de paquete `.ivp` | 8 GB | Límite del formato ZIP64 que se usa |
| Entradas por paquete | 50 000 | Protección contra paquetes manipulados |
| Relación de compresión | 200:1 | Protección contra bombas ZIP |
| Resolución mínima usable | 1366 × 768 | La exige la etapa 03; la interfaz se adapta recogiendo paneles |

Con WebGL por software —un equipo sin GPU o con controladores antiguos— el
visor funciona pero reduce la resolución y desactiva las transiciones. Lo avisa
en pantalla en lugar de ir a tirones sin explicación.
