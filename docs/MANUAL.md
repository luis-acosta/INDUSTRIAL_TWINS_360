# Manual de uso

Para quien va a construir un recorrido, no para quien va a programar la
aplicación. Si busca cómo compilar, vea `docs/INSTALACION.md`.

---

## 1. Un recorrido en diez minutos

1. **Abra la aplicación.** Arranca con un proyecto de demostración: una unidad
   de bombeo con escenas, activos, notas y variables de proceso simuladas. Sirve
   para ver cómo queda todo antes de empezar el suyo.
2. **Cree el proyecto real.** `Abrir` → carpeta de destino, o empiece sobre el
   de demostración y cambie el título en **Ajustes**.
3. **Añada escenas.** Una escena es una panorámica. En el panel izquierdo,
   `Añadir escena`.
4. **Coloque marcadores.** Pulse el icono de marcador en la barra del lienzo y
   después sobre la panorámica, donde quiera el punto.
5. **Conecte las escenas.** Seleccione el marcador y, en el inspector, añada una
   acción «Ir a escena».
6. **Publique.** Módulo **Publicación** → elija destino → `Generar paquete`.

---

## 2. La pantalla

```
┌─ barra de comandos ────────────────────────────────────────────┐
│ marca · proyecto · deshacer/rehacer · abrir/guardar · integridad│
├──┬──────────────┬──────────────────────────────┬──────────────┤
│  │              │                              │              │
│ r│   panel      │          lienzo              │  inspector   │
│ a│ contextual   │   (la panorámica)            │ (propiedades)│
│ i│              │                              │              │
│ l│              │                              │              │
├──┴──────────────┴──────────────────────────────┴──────────────┤
│ barra de estado: recuentos · condición general · integridad    │
└────────────────────────────────────────────────────────────────┘
```

El **raíl** de la izquierda cambia de módulo. Con `Alt` y un dígito se alcanza
cada uno sin soltar el teclado, incluso mientras se escribe en un campo.

| Módulo | Atajo | Para qué |
|---|---|---|
| Escenas y marcadores | `Alt+1` | Construir el recorrido |
| Catálogo de activos | `Alt+2` | Equipos, TAG, documentos |
| Notas y tareas | `Alt+3` | Observaciones de campo |
| Telemetría | `Alt+4` | Variables de proceso |
| Recorridos y formación | `Alt+5` | Recorridos guiados y evaluaciones |
| Publicación | `Alt+6` | Generar el paquete |

**Deshacer** (`Ctrl+Z`) cubre todas las ediciones del proyecto. Un arrastre
completo o el tecleo de un título se deshacen de una vez, no carácter por
carácter.

---

## 3. Escenas y marcadores

### Vista inicial

Cada escena tiene una vista inicial: lo que ve el visitante al llegar. Oriente
la cámara como quiera y pulse `Fijar vista`.

### Modos de entrada

Cuando un marcador lleva a otra escena, hay cuatro formas de decidir hacia dónde
mira el visitante al llegar:

| Modo | Qué hace | Cuándo usarlo |
|---|---|---|
| **Entrada inteligente** | Mira hacia donde seguiría avanzando, no hacia el punto del que viene | Casi siempre: es lo que hace que un recorrido se sienta continuo |
| Vista inicial | La vista inicial de la escena destino | Cuando la escena tiene un punto de vista «correcto» |
| Misma orientación | Conserva el rumbo | Para subir un piso sin perder la referencia |
| Vista personalizada | La que usted fije | Para dirigir la atención a algo concreto |

### Marcadores amontonados

Si coloca un marcador muy cerca de otro, la aplicación lo avisa. Dos marcadores
a dos grados son imposibles de pulsar en una tableta.

### Propuestas automáticas

Con **funciones experimentales** activadas en Ajustes, el menú de escenas ofrece
`Proponer conexiones automáticamente`. Usa el GPS de las capturas, el plano o el
orden de las fotos.

Lo que proponga entra **sin revisar** y con un distintivo naranja en el árbol.
Esos marcadores **no se publican** hasta que los confirme uno a uno en el
inspector. No es una molestia burocrática: el algoritmo no mira las imágenes y
no sabe si entre dos capturas cercanas hay una pared.

---

## 4. Activos y documentos

Un activo es un equipo con su TAG industrial. La jerarquía va de planta a
componente: planta → unidad → área → equipo → componente.

- **TAG único.** Por defecto se exige único por planta. Se puede cambiar en
  Ajustes.
- **Buscar por TAG.** En el catálogo, escriba el TAG. El resultado conserva sus
  ancestros, para que vea en qué unidad está.
- **Ver en el recorrido.** Desde la ficha, abre la escena donde está señalado.
- **Documentos con revisión.** Cada documento lleva su código, su revisión y su
  estado. La aplicación marca cuál es la vigente dentro de cada código: la
  aprobada más reciente.

---

## 5. Notas y tareas

Una nota es una observación anclada a un punto del recorrido o a un activo.
Tiene prioridad, responsable, fecha comprometida y estado.

Los estados siguen una máquina de transiciones: no se puede pasar de
«archivada» a «en curso» sin reabrirla. **Para cerrar una nota hay que escribir
cómo se resolvió**; la aplicación no deja cerrarla sin eso. En seis meses, nadie
recordará por qué se cerró.

Las notas vencidas aparecen en rojo en la lista y se pueden filtrar.

---

## 6. Telemetría

### Qué significa cada indicador

Hay **dos ejes distintos** y la pantalla no los confunde:

| Eje | Dónde se ve | Qué dice |
|---|---|---|
| **Condición operacional** | borde izquierdo del indicador y pastilla inferior | Si la variable está normal, en atención o en alarma, según las reglas |
| **Calidad del dato** | pastilla con punto de color y texto | Si el dato es actual, obsoleto, ausente, erróneo o no numérico |

Son dos cosas y no una: *«la bomba está mal»* y *«no sé cómo está la bomba
porque no llega el dato»* llevan a acciones opuestas.

Consecuencias que conviene conocer:

- **Una variable sin reglas no se pinta de verde.** Dice «Sin reglas» en gris.
  Verde significa «lo he comprobado y está bien»; sin reglas nadie ha
  comprobado nada.
- **Con el dato ausente, la condición es «Indeterminado»**, nunca «Normal».
- **El dato de caché se etiqueta.** Si lo que ve viene de la caché local y no de
  una consulta en vivo, lo dice.
- **Los huecos del histórico son huecos.** La gráfica no une dos lecturas
  separadas por un periodo sin datos; esa recta no existió.

### Umbral de frescura

Cada variable declara cuántos segundos puede pasar antes de considerarse
obsoleta. No hay un valor universal: una temperatura de tanque cambia en minutos
y una vibración en milisegundos.

### Lo que la aplicación no puede hacer

**No escribe nada.** No puede cambiar un valor, mover una válvula ni tocar el
PLC. No es una opción que se pueda activar: no existe la función.

---

## 7. Publicación

### Comprobación previa

Antes de ofrecer el botón, la aplicación comprueba siete cosas y enseña el
resultado. Las que fallan **bloquean** la publicación; los avisos dejan
continuar.

Se comprueba: integridad referencial, que haya escenas publicables, que la
escena de entrada exista y se publique, propuestas sin revisar, que todas las
escenas tengan imagen, que el manifiesto no lleve credenciales, y la política
de guiones.

### Destinos

| Destino | Qué produce | Para qué |
|---|---|---|
| **Sitio web estático** | carpeta con HTML, imágenes y manifiesto | Subir al servidor del cliente |
| **Paquete sin conexión** | un ZIP | Memoria USB, sin servidor ni instalación |
| **Visor portable** | *pendiente* | — |
| **SCORM 1.2** | ZIP para el LMS | Formación corporativa |

Junto al paquete se escribe `INFORME-PUBLICACION.txt`: qué se publicó, qué se
dejó fuera y por qué. Cuando el cliente pregunte por qué falta una escena, la
respuesta está escrita.

### Lo que nunca sale del equipo

Tokens, referencias a secretos, conexiones al historiador, usuarios, permisos y
registro de auditoría. El paquete se revisa antes de entregarse y la generación
se detiene si algo de eso apareciera.

---

## 8. Guardado y recuperación

- **Guardado atómico.** Se escribe un temporal, se vuelca a disco, se rotan las
  copias y se renombra. Un corte de corriente no deja el proyecto a medias.
- **Copias de respaldo.** Tres por defecto. Con una sola, guardar dos veces
  seguidas destruye la última versión buena.
- **Recuperación.** Si la aplicación terminó de golpe, al reabrir el proyecto
  ofrece el trabajo recuperable que encuentre al lado.
- **Guardar de todas formas.** Si el proyecto tiene referencias rotas, el
  guardado normal se niega. En el menú de archivo hay `Guardar de todas formas`:
  perder el trabajo de una tarde por un marcador que apunta a una escena
  borrada sería peor.

---

## 9. Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+Z` | Deshacer |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Rehacer |
| `Alt+1`…`Alt+6` | Cambiar de módulo |
| `Esc` | Cerrar diálogo o cancelar edición de un campo |
| `Tab` / `Shift+Tab` | Recorrer la interfaz con el teclado |

Toda la interfaz se puede usar con teclado: los árboles, las tablas y los menús
responden a las flechas, `Inicio`, `Fin` y `Enter`.

---

## 10. Tema

Oscuro, claro o según el sistema. El contraste de los dos temas está verificado
contra WCAG 2.1 AA por una prueba automática, y los cinco estados de calidad del
dato se distinguen entre sí por algo más que el color.
