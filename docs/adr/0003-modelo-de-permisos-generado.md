# ADR 0003 — El modelo de permisos se genera, no se copia

**Fecha:** 2026-11-13 · **Estado:** aceptada

## Contexto

Los permisos tienen que verificarse en el servidor y no sólo en la interfaz.
Eso obliga a que la misma tabla de roles y operaciones exista en TypeScript
—donde vive el dominio y lo usa la aplicación— y en Python, donde está el
servidor.

Dos tablas escritas a mano divergen. El escenario concreto: alguien añade la
operación `document.approve` al rol revisor en el editor, se olvida del
servidor, y queda un permiso que la interfaz oculta y la API concede. **Ese
fallo no se descubre probando la aplicación**, porque la aplicación no ofrece el
botón.

## Decisión

`apps/server/app/access_model.py` es un archivo **generado** por
`tools/emit-access-model.mjs` a partir de `packages/domain/src/access.ts`.
Lleva una huella SHA-256 del modelo, y `npm run verify` falla si el archivo no
corresponde al dominio actual.

La API publica esa huella en `/api/v1/health`, de modo que se puede detectar un
servidor desplegado con un modelo distinto del de la aplicación que lo usa.

## Alternativas descartadas

- **Un paquete compartido en un formato neutro (JSON).** Añade un paso de
  construcción a las dos partes y un archivo que hay que mantener en sincronía
  con el dominio, que es el problema original movido de sitio.
- **Que el servidor consulte los permisos a la aplicación.** Invierte la
  dependencia: el servidor es quien debe decidir, y pedirle la decisión al
  cliente anula el propósito de verificar en el servidor.
- **Generar TypeScript desde Python.** El dominio es TypeScript y es donde
  viven las reglas; el servidor es el consumidor.

## Consecuencias

- Cambiar un permiso es un cambio en un solo sitio, y olvidarse de regenerar
  rompe la verificación en lugar de pasar inadvertido.
- El archivo generado lleva un encabezado que dice que no se edite y por qué.
- El generador extrae las constantes del texto fuente con expresiones
  regulares en lugar de importar el módulo, para no necesitar un transpilador
  en un script de herramientas. Si el formato del fuente cambia, el generador
  falla con un error claro en lugar de emitir una tabla incompleta — y eso ya
  ocurrió una vez durante el desarrollo: el patrón inicial dejaba fuera la
  última entrada del diccionario, que resultaba ser `administrator`.
