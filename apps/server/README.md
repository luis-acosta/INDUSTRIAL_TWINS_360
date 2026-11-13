# Servidor de INDUSTRIAL TWINS 360

Dos superficies y dos públicos distintos:

| Superficie | Quién la usa | Autenticación |
|---|---|---|
| `POST /api/v1/telemetry/latest`, `GET /api/v1/telemetry/ping` | el recorrido publicado | ninguna |
| el resto | la aplicación de escritorio y los administradores | identidad y permisos |

## Lo que este servidor no puede hacer

- **No escribe en el historiador ni en el PLC.** No existe la función. Toda
  consulta pasa por un verificador que la rechaza si contiene palabras de
  escritura o de salida de red, y ese verificador no se esquiva con un espacio
  ni con mayúsculas (`tests/test_telemetry.py`).
- **No entrega credenciales.** El token de InfluxDB se lee del entorno al
  arrancar y no aparece en ninguna respuesta, registro ni mensaje de error. Una
  prueba recorre la respuesta del visor buscando las palabras prohibidas.
- **No sirve el recorrido.** Eso lo hace un servidor web estático o el propio
  paquete. Separar los oficios permite publicar sin desplegar nada.

## Permisos

La tabla de roles **no se escribe aquí**. Se genera desde
`packages/domain/src/access.ts`, que es la única fuente de verdad, con:

```
node tools/emit-access-model.mjs
```

`npm run verify` comprueba que la copia del servidor corresponde al dominio. El
motivo: una operación añadida en el editor y olvidada en el servidor deja un
permiso que la interfaz oculta y la API concede, y eso no se descubre probando
la aplicación porque la aplicación no ofrece el botón.

## Lo que falta (etapa 11)

- **Autenticación real.** La identidad llega por cabeceras (`x-usuario`,
  `x-rol`), que sirve para desarrollar y probar contra el servidor sin un
  proveedor de identidad montado, y **no valida nada**. La integración con el
  directorio del cliente —LDAP o SSO— sustituye `current_grants`. Está escrito
  también en el código, junto a la función, para que nadie despliegue esto
  creyendo que autentica.
- Persistencia en PostgreSQL: hoy el registro de auditoría es en memoria, con
  la misma semántica que tendrá la tabla (sólo añadir, cadena de huellas).
- Copia de respaldo y restauración.

## Arranque

```
IT360_DATABASE_URL=postgresql://... \
IT360_INFLUX_URL=https://influx.planta.local:8086 \
IT360_INFLUX_ORG=planta \
IT360_INFLUX_BUCKET=proceso \
IT360_INFLUX_TOKEN=... \
uvicorn app.main:create_app --factory --port 8787
```

El arranque falla si falta algo imprescindible. Un servidor a medias —sin token
de telemetría, por ejemplo— responde a todo menos a lo que le pidan de verdad,
y el fallo aparecería en la primera consulta del cliente.
