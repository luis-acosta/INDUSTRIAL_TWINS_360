# API del servicio (X19)

Superficie que otros pueden programar: un panel de mantenimiento, un cuadro de
mando, un servicio que vuelque las notas al gestor de incidencias del cliente.

El esquema OpenAPI completo lo sirve el propio servicio en `/docs` y
`/openapi.json`. Este documento dice lo que un esquema no puede decir: qué se
puede dar por estable, qué no, y qué no va a existir nunca.

---

## ⚠ Antes de integrar nada

**La identidad no se valida.** Llega en las cabeceras `x-usuario`, `x-rol`,
`x-planta` y `x-categorias-nota`, y el servicio las cree. La integración con el
directorio del cliente está pendiente (`docs/LIMITACIONES.md`), así que esta API
va detrás de la VPN o de la red de planta, nunca con el puerto publicado en
Internet. No es una recomendación de endurecimiento: hasta que esté hecha, el
control de acceso de la API es tan fuerte como la red que la rodea.

Lo que el modelo de acceso **sí** hace, y hace de verdad, es decidir qué
devuelve cada operación a la identidad que se declare: un cliente que se
presente con una concesión limitada a unas categorías de nota recibe esas notas y
no las demás, y el recorte ocurre en el servidor.

---

## Qué es estable

| Garantía | Alcance |
|---|---|
| La versión va en la ruta | `/api/v1/...`. Una integración escrita contra `v1` seguirá hablando con `v1` mientras `v1` exista |
| Las rutas y métodos no desaparecen | Un cambio que rompa pide `/api/v2`, no una edición de `v1` |
| Los parámetros no se vuelven obligatorios | Ni los campos del cuerpo |
| Los campos de respuesta no se renombran | Se pueden **añadir**: un cliente debe ignorar los que no conozca |

Esto no es una promesa escrita en un documento: `contract/openapi-surface.json`
guarda la forma de cada operación y una prueba la compara con la que el servicio
genera. Un cambio incompatible rompe la construcción, de modo que aparece en la
revisión en lugar de descubrirse en producción.

**Lo que no es estable:** los textos de los mensajes de error. El `code` de un
error sí lo es; el `message` está escrito para una persona y se mejora. Una
integración que compare el texto se romperá, y con razón.

---

## Operaciones

### Salud

| | |
|---|---|
| `GET /api/v1/health` | Estado, entorno, huella del modelo de permisos y si la telemetría está configurada. Sin identidad: lo consulta el orquestador |

La huella del modelo de permisos sirve para detectar un servidor desalineado:
si no coincide con la del editor, uno de los dos es de otra versión.

### Telemetría (sólo lectura)

| | |
|---|---|
| `GET /api/v1/telemetry/ping` | Si el historiador responde |
| `POST /api/v1/telemetry/latest` | Último valor de varias variables. Es una consulta con cuerpo porque la lista no cabe en una cadena de consulta |
| `GET /api/v1/telemetry/{mapping_id}/history` | Serie temporal, con ventana acotada |

Anónimas a propósito: las consulta el recorrido publicado, que no tiene
identidad. Lo que pueden devolver está limitado por la lista blanca de variables
del servidor (`IT360_MAPPINGS_FILE`): sin archivo, contestan 503.

**No hay escritura de variables de proceso y no la habrá.** Las
especificaciones son explícitas y el producto no lleva esa capacidad en ninguna
capa; hay una prueba que impide que aparezca por descuido.

### Notas

| | |
|---|---|
| `GET /api/v1/notes` | Notas del proyecto, ya recortadas por la concesión |
| `PUT /api/v1/notes` | Carga las notas de un proyecto. Exige `project.update` |
| `POST /api/v1/notes/{id}/comments` | Comentar. Exige `note.update` |
| `POST /api/v1/notes/{id}/status` | Mover el estado de trabajo. Exige `note.update` |

Dos cosas que conviene saber antes de programar contra esto:

- **«No existe» y «no puede verla» comparten el 404.** Distinguirlos diría a un
  contratista que el proyecto tiene notas de categorías que no puede ver, y
  cuántas. Una integración no debe tratar el 404 como «se borró».
- `POST /notes/{id}/status` sólo acepta los estados de trabajo que devuelve
  `GET /notes` en `fieldStatuses`. Resolver y archivar no están: resolver exige
  escribir cómo se resolvió. Lea esa lista en lugar de escribirla en el cliente.

### Revisión y publicación

| | |
|---|---|
| `POST /api/v1/revisions` | Crear una revisión |
| `GET /api/v1/revisions` | Listar |
| `POST /api/v1/revisions/{id}/actions` | Enviar, aprobar, pedir cambios, publicar |

Las transiciones están tabuladas en el servidor y una acción fuera de la tabla
responde 409. Quien aprueba no puede ser quien envió.

### Avisos

| | |
|---|---|
| `POST /api/v1/notifications` | Encolar y entregar un aviso. Exige `note.assign` |
| `GET /api/v1/notifications` | Estado de la cola, sin direcciones. Exige `audit.read` |

**La respuesta dice si se entregó, no si se aceptó.** `delivered: 0` con
`pending: 1` significa que nadie ha sido avisado —normalmente porque el
despliegue no tiene servidor de correo—. Una integración que trate el 200 como
«avisado» mentirá a su usuario.

### Acceso y auditoría

| | |
|---|---|
| `GET /api/v1/me/operations` | Qué puede hacer la identidad declarada, con su ámbito |
| `POST /api/v1/access/check` | Si una operación concreta está permitida sobre un recurso |
| `GET /api/v1/audit` | Registro encadenado. Exige una concesión global |

`GET /me/operations` es la forma correcta de decidir qué mostrar en una
interfaz: replicar el modelo de permisos en el cliente lo deja desfasado el día
que cambie en el servidor, y entonces la interfaz ofrece algo que el servicio
rechaza.

---

## Lo que esta API no es

- **No es multiproyecto con aislamiento fuerte.** El servicio sirve varios
  proyectos, pero la separación la da la concesión declarada, y la identidad no
  se valida: ver la advertencia de arriba.
- **No tiene persistencia completa.** El registro de auditoría, las revisiones y
  la cola de avisos viven en memoria y se pierden al reiniciar. Tienen la
  semántica que tendrá la tabla; la persistencia en PostgreSQL es la parte
  pendiente, y está declarada.
- **No sirve los recorridos.** Son archivos estáticos y los sirve el servidor
  web (ver `deploy/nginx.conf`).
