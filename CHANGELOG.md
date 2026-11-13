# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Las versiones siguen [SemVer](https://semver.org/lang/es/).

El producto está en desarrollo y no ha tenido una entrega pública. Hasta la
1.0.0, la versión menor marca hitos de desarrollo.

## [Sin publicar]

### Añadido

- **Ventanas dentro del recorrido (E02, E03, E05, E06, E07, E08, D06).** Todo
  lo que abría un marcador —una foto, un PDF, un enlace— se abría en una
  pestaña nueva: el visitante salía del recorrido y **un álbum de fotografías
  era imposible**, porque en una pestaña nueva no hay «siguiente». Ahora la
  ventana vive dentro del recorrido, con el foco atrapado mientras está
  abierta y devuelto al cerrarla, Escape para cerrar y flechas para recorrer el
  álbum. El álbum **no da la vuelta** al llegar al final: así se sabe si se ha
  visto entero, que en una inspección es la diferencia entre haber mirado todas
  las fotos del equipo y creer que sí.
  Para mostrar un PDF embebido, la política pasa de `frame-src 'none'` a
  `'self'` más **los orígenes que el autor declaró de verdad**, recogidos del
  proyecto al publicar. La salida fácil habría sido un comodín, que convertiría
  cada marco en una ventana a la que ni el autor ni el cliente han dado el visto
  bueno, y lo haría también en los recorridos que no usan ningún Webframe.
  `object-src` se queda en `'none'`: un `iframe` basta y abrirlo admitiría
  además los complementos del navegador.
  Un documento que el navegador no sabe mostrar no se promete embebido —un
  recuadro en blanco hace creer que algo ha fallado— y el nombre de una
  descarga se sanea, porque uno con `../` escrito en el proyecto no debe poder
  decidir dónde se guarda el archivo.
- **Realidad virtual: el subconjunto compatible, comprobado (N06, N07).** La
  detección de capacidades distingue «este navegador no admite VR» de «no hay
  visor conectado», que son dos consejos distintos: lo segundo en un portátil
  sin gafas es lo normal, y decir lo primero mandaría al usuario a cambiar de
  navegador para nada. Una consulta que falle no revienta la página: el botón
  de VR no debe poder tirar un recorrido al cargarlo.
  La comprobación previa a publicar avisa de los marcadores y los componentes
  de interfaz que, con las gafas puestas, **no van a estar** —un contenido web
  embebido no recibe los eventos del mando, y lo que falta puede ser justo el
  marcador que lleva a la escena siguiente—. Es aviso y no bloqueo: un
  recorrido puede publicarse para escritorio a sabiendas.
  El giro con mando es por pasos de 30° y no continuo, porque el giro continuo
  es la causa principal del malestar en VR: el oído interno no registra la
  rotación que los ojos ven. Los paneles se comprueban legibles a su distancia,
  que es lo que detecta una interfaz de pantalla llevada a VR sin ajustar.
  **La sesión inmersiva en sí sigue pendiente**: no se puede verificar sin un
  visor y no se cuenta como hecha.
- **Respaldo y restauración (X18).** Un respaldo es el propio paquete `.ivp`,
  con una ficha `.json` al lado, y se construye **por el mismo camino que
  guardar**: inventar un contenedor aparte habría significado mantener una
  segunda vía de empaquetado, y la que casi nunca se ejercita es la que falla
  el día que hace falta restaurar. La copia se relee antes de darla por buena,
  porque un paquete corrupto escrito sin comprobar da la misma tranquilidad que
  uno bueno y sólo se descubre el día malo.
  La limpieza conserva **por antigüedad y no por número**: doce copias de la
  última hora no protegen de un error que se arrastra desde ayer, porque todas
  lo llevan dentro; se guarda una al día durante dos semanas y una a la semana
  durante tres meses, y nunca se queda sin ninguna. Restaurar no sobrescribe
  nada: un respaldo **es** un proyecto y se abre como tal, así que no existe
  ningún paso capaz de machacar el que se tiene abierto.
- **Modelos 3D industriales (L01–L04, L08, L09, L12, V03).** Una escena puede
  ser un modelo GLB además de una panorámica. El archivo **se comprueba antes
  de cargarlo**: un GLB truncado —el caso real, copiado de un recurso de red
  que se cortó— hacía que el cargador lanzara desde dentro de una promesa y
  dejaba el lienzo en negro sin decir por qué; ahora se miran doce bytes de
  cabecera y se dice qué pasa y qué hacer. El modelo se centra y se escala al
  abrirlo **sin tocar el archivo del cliente**, que llega en milímetros, en
  pulgadas o con el origen a kilómetros.
  Tres modos de cámara —orbital, sobrevuelo y primera persona— sobre un mismo
  estado: cambiar de modo no teletransporta al observador, porque un salto en
  una inspección hace perder la referencia de dónde se está mirando y
  recuperarla cuesta más que el movimiento que se ahorró. En primera persona se
  mantiene la altura de los ojos: un observador que puede volar no transmite la
  escala del espacio, que es la razón de usar ese modo.
  Resolución adaptativa que baja la nitidez antes que los fotogramas, porque un
  modelo a 50 fps algo borroso sirve para inspeccionar y uno nítido a 6 fps no.
  Visibilidad por pieza y selección por malla con la normal llevada a espacio de
  mundo, que es lo que necesita un marcador adherido para no quedar atravesado.
- **Editor de interfaces (F01–F06, F11, F12, Y06).** La interfaz del recorrido
  —la navegación, el plano, los paneles que el visitante ve encima de la
  panorámica— se construye con un lienzo de arrastrar y soltar. El lienzo
  coloca los componentes con **el mismo cálculo que el recorrido publicado**, y
  no con una aproximación propia: si el editor usara su aritmética, el autor
  ajustaría una cabecera hasta dejarla bien aquí y saldría desplazada allí, y
  eso no se descubre hasta después de publicar. Soltar sobre un contenedor mete
  dentro; el tirador de la esquina cambia el tamaño con el ratón o con las
  flechas, porque un editor que sólo responde al arrastre deja fuera a quien no
  puede usarlo.
  Cuatro plantillas —mínima, recorrido industrial, formación, inspección— que
  pasan la validación del propio producto, y que son punto de partida y no
  tema: no queda vínculo vivo con ellas, porque una interfaz que cambiara sola
  al actualizar el producto rompería recorridos que el cliente ya tiene
  publicados y revisados.
  Biblioteca de componentes guardados dentro del proyecto, más copiar, pegar y
  duplicar: todos renuevan los identificadores y reescriben las acciones
  internas, para que un botón que ocultaba a su hermano siga ocultando a la
  copia de su hermano y no al original.
- **Notas de campo en el recorrido publicado (P01).** El visor deja anclar una
  observación al punto que se está mirando, con asunto, categoría, prioridad y
  el nombre de quien la toma. Se guarda en el navegador de inmediato: el
  recorrido puede estar en una tableta dentro de una planta, sin cobertura, y
  una nota tomada delante del equipo no se puede volver a tomar. El almacén no
  lanza nunca —`localStorage` falla de verdad en modo privado, con la cuota
  llena y en navegadores de quiosco—; informa y conserva lo que haya en
  pantalla. De ahí sale un archivo que el editor importa con informe previo, y
  que distingue lo nuevo, lo ya importado y lo rechazado con su motivo: el mismo
  archivo entregado dos veces no duplica nada. Las notas entran **abiertas y sin
  responsable** —quien las tomó describió lo que vio— y con el autor marcado
  como **declarado, no verificado**, porque el recorrido publicado no autentica
  a nadie. Hay una prueba de extremo a extremo que escribe una nota en un
  navegador real, recarga la página y comprueba que sigue ahí.
- **Autoría de notas: conversación, categorías, adjuntos y cierre (P02, P03,
  P06, P08, X08).** Las observaciones dejan de ser un registro de sólo lectura.
  Comentarios con autor y marca de edición —`editedAt` no es decorativo: en una
  observación de seguridad importa saber que el texto cambió después de que
  alguien actuara sobre él—. **Resolver** exige decir cómo se resolvió, en el
  propio momento de cerrar; **archivar** es un acto distinto, para lo que dejó
  de aplicar, y no cuenta como resuelta en el recuento de pendientes.
  Adjuntos de archivo del proyecto y de enlace externo. Categorías que se crean,
  se renombran arrastrando sus notas en una sola operación, y no se eliminan si
  alguna las usa: reasignarlas a «Otro» automáticamente sería cómodo y
  mentiroso. Las notas con una categoría que el proyecto no define se avisan en
  lugar de desaparecer del filtro.
- **Editor de clases de activo (X03).** Crear y editar clases con sus atributos
  propios, viendo en gris los heredados y de qué clase vienen. La herencia no
  admite ciclos. Un atributo de tipo magnitud no se guarda sin su unidad
  declarada, porque el contrato prohíbe inferirla. Lo que afecta a activos que
  ya existen se cuenta antes de guardar, con el número exacto: quitar un
  atributo que tiene datos rellenos, o hacer obligatorio uno que no lo era.
  Esos casos avisan y dejan guardar —un atributo puesto por error hay que poder
  quitarlo—; lo que deja el proyecto incoherente bloquea. Una clase en uso, o de
  la que heredan otras, no se puede eliminar, y el mensaje dice qué reasignar.
  Con esto la **etapa 05 queda completa**: X01–X07.
- **Editor de activos (X01, X02, X04, X07).** El catálogo deja de ser de sólo
  lectura. Alta y edición con el TAG validado en el alcance de unicidad que el
  proyecto declara, elección de elemento superior que sólo ofrece niveles por
  encima y descarta la propia descendencia, valores de la ficha técnica según
  los atributos que la clase declara —incluidos los heredados de su clase
  padre—, ubicaciones en varias panorámicas con una preferente, y documentos
  con su código, revisión y estado, señalando cuál es la vigente. Los problemas
  se separan en bloqueantes y avisos: un TAG duplicado impide guardar, un activo
  publicado sin fabricante sólo avisa. El borrado dice cuántos activos,
  ubicaciones y documentos arrastra antes del clic, y se deshace.
  Toda la validación vive en `@it360/domain/asset-draft`, fuera de React y con
  34 pruebas propias, porque son las mismas reglas que necesitan la importación
  y el servidor.
- **Catálogo en CSV (X06).** Importación con informe previo: se lee el archivo,
  se planifica y se muestran altas, actualizaciones y rechazos —cada uno con su
  número de línea y su motivo— antes de escribir nada. La jerarquía se resuelve
  por TAG del padre en dos pasadas, de modo que la hoja puede traer el hijo
  antes que el padre. Una fila mal escrita no cancela el archivo. La celda
  vacía no borra el dato que ya estaba, y el padre sólo es obligatorio al crear.
  La exportación escribe el TAG del padre y no el identificador interno, para
  que el archivo se pueda editar en Excel y volver a importar sin romper el
  árbol; hay una prueba que hace ese viaje de ida y vuelta completo. La
  importación entra en el historial y se deshace con Ctrl+Z.
- **Verificación de tokens en CSS (TEST-TOK-005..008).** Una prueba recorre
  todas las hojas de estilo y comprueba que cada variable `--it-*` que leen esté
  definida en `tokens.css`, reconociendo las que un componente fija desde
  TypeScript. El typecheck no puede ver el CSS, así que esta deriva era
  invisible hasta aparecer como un gris sobre gris en el portátil de un cliente.
- **Aplicación de escritorio completa.** Armazón con barra de comandos, raíl de
  módulos, panel contextual, lienzo e inspector. Siete módulos: escenas,
  catálogo de activos, notas, telemetría, recorridos, publicación y ajustes.
- **Abrir y guardar** sobre el contenedor de Windows, con escritura atómica,
  rotación de copias y recuperación de trabajo interrumpido.
- **Contenedor Tauri** con almacén de credenciales del sistema (sin `get`
  expuesto a la vista web), volcado a disco y proxy de telemetría en Rust.
- **Publicación de extremo a extremo:** sitio web estático, paquete sin
  conexión y curso SCORM 1.2, con informe de publicación y sumas de
  verificación.
- **Visor web publicado** que valida su manifiesto al cargarlo y distingue un
  paquete sin conexión de la telemetría en vivo.
- **Servidor** con permisos por rol, ámbito y caducidad; auditoría encadenada
  que redacta credenciales; y servicio de telemetría de sólo lectura.
- **Modelo de permisos generado** desde el dominio, con verificación que falla
  si las dos copias divergen (ADR 0003).
- **Herramientas de autoría:** colocación y arrastre de marcadores con
  aritmética esférica, edición de polígonos.
- **Conexión automática de escenas** (experimental): propone con GPS, plano u
  orden de captura, declara su señal y su confianza, y todo entra sin revisar.
- **Cosido de panorámicas** (experimental): mide lo que el cosido de alto nivel
  no expone y emite tres veredictos; lo rechazado no se entrega.
- **Documentación:** manual de uso, instalación, limitaciones conocidas y cuatro
  decisiones de arquitectura.
- **Verificación:** 1104 pruebas de TypeScript, 76 del servidor, 46 del cosido
  y 12 de extremo a extremo con navegador real.

### Corregido

Durante el desarrollo, estas correcciones salieron de escribir la prueba antes
de dar algo por bueno. Se anotan porque cada una era un fallo real:

- **El fondo del visor publicado leía una variable inexistente**
  (`--it-color-canvas-void`), por lo que el lienzo quedaba sin fondo declarado.
  Lo encontró la nueva prueba de tokens en su primera ejecución.
- **El número de serie se perdía al reimportar** un catálogo exportado por la
  propia aplicación: la cabecera «Número de serie» no coincidía con ninguna de
  las variantes que el importador reconocía.
- **Una hoja parcial desvinculaba los activos de su padre.** Al actualizar sólo
  nombres, la columna de jerarquía vacía se interpretaba como orden de
  desvincular y destruía el árbol de la planta.
- **La verificación de un respaldo nunca detectaba medios ausentes:** buscaba
  la ruta de cada archivo en un campo que el formato no tiene, de modo que la
  lista de esperados salía vacía y cualquier respaldo parecía completo.
- **Una ficha de respaldo con la fecha ilegible se colaba como «la más
  reciente»** —el texto de una fecha rota ordena por delante de cualquier
  dígito— y ocupaba una de las plazas protegidas de la limpieza, desplazando a
  una copia que sí era reciente.
- **El selector de estado de una nota ofrecía «resuelta» y «archivada»**, que
  siempre acababan en un aviso de error porque ambas exigen un dato que un
  selector no recoge. Ahora cada una tiene su botón y su diálogo, y el selector
  sólo ofrece los estados de trabajo.
- **`draftToAsset` podía escribir un TAG inválido.** Reutilizaba el TAG del
  activo anterior, o escribía el inválido si era nuevo, dejando un archivo que
  no volvía a validar al abrirlo y un equipo que la búsqueda por TAG no
  encontraba. Ahora devuelve `Result` y se niega.
- **`writeAtomic` borraba el temporal ante cualquier fallo**, destruyendo
  trabajo recuperable. Ahora conserva el temporal que se escribió completo y el
  mensaje de error dice que está ahí.
- **Un paquete manipulado informaba «formato inválido» en lugar de «suma
  incorrecta».** La verificación de integridad va ahora antes de interpretar el
  manifiesto.
- **`Escape` en un campo numérico revertía el valor y el desenfoque posterior
  volvía a aplicarlo.** El campo recuerda que se canceló.
- **El menú desplegable no respondía al teclado** porque el portal creaba su
  anfitrión en un efecto y los hijos se montaban un ciclo tarde.
- **Una transición de corte declaraba «llegando» en el instante cero**, lo que
  dejaba la escena destino sin dibujar durante un fotograma.
- **La inercia de la cámara dependía de la frecuencia de fotogramas**: el mismo
  gesto recorría más ángulo en un equipo rápido.
- **`formatValue` devolvía el valor crudo del historiador cuando venían el
  número y la cadena**, ignorando los decimales declarados.
- **Una variable sin reglas de condición se pintaba de verde**, afirmando una
  normalidad que nadie había comprobado.
- **La gráfica descartaba una lectura aislada entre huecos**, afirmando que no
  hubo lectura cuando sí la hubo.
- **El reparto horizontal de la gráfica era por índice y no por tiempo**, lo que
  mostraba una frecuencia de muestreo que no existió.
- **El cliente de telemetría no cancelaba su temporizador**, acumulando
  despertares del WebView en una jornada de sala de control.
- **Una marca propia vacía dejaba la pestaña del navegador sin título**, porque
  la cadena vacía no es «sin valor» para `??`.
- **El paquete publicado no declaraba icono**, dejando un 404 en el registro
  del servidor del cliente por cada visita.
- **El generador del modelo de permisos dejaba fuera la última entrada**, que
  resultaba ser el rol administrador.
- **El cosido aceptaba un resultado degenerado** cuando OpenCV devolvía «éxito»
  con una imagen más pequeña que las fotografías de entrada.
- **El recuento de coincidencias del cosido contaba falsos positivos**: entre
  dos imágenes sin nada en común daba casi dos mil. Ahora verifica con la razón
  de Lowe y RANSAC.
- **El radar del minimapa usaba una apertura fija**, de modo que con zoom
  sugería un campo de visión que el operador no tenía.
- **El atajo de módulo no funcionaba mientras se escribía en un campo**, aunque
  `Alt` y un dígito no producen texto.
- **Seis combinaciones de color no alcanzaban el contraste AA** en uno de los
  dos temas, y dos estados de calidad del dato eran indistinguibles para quien
  no percibe bien el color.

### Seguridad

- Telemetría de sólo lectura por construcción, con verificador que no se
  esquiva con espacios ni mayúsculas (ADR 0002).
- El token del historiador no pasa por la vista web ni aparece en registros,
  errores o exportaciones.
- El manifiesto publicado se audita antes de entregarse buscando claves
  prohibidas; la generación se detiene si aparece alguna.
- JavaScript del autor deshabilitado por defecto, con aprobación por huella,
  contexto aislado y retirada automática del paquete publicado si la política no
  lo permite ahí.
- Protección contra ZIP slip, recorrido de rutas, bombas ZIP y entradas
  excesivas al abrir un paquete.
- Política de seguridad de contenido restrictiva en la aplicación y en todo
  paquete publicado.

### Pendiente conocido

Ver `docs/LIMITACIONES.md`. Lo más importante: **la autenticación del servidor
no está hecha** —la identidad llega por cabeceras y no se valida—, así que el
servidor no debe exponerse fuera de una red de confianza.
