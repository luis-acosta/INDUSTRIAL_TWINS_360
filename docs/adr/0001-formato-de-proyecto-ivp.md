# ADR 0001 — El proyecto se guarda como paquete `.ivp` con SQLite dentro

**Fecha:** 2026-11-12 · **Estado:** aceptada

## Contexto

Un proyecto tiene dos clases de contenido: datos estructurados —escenas,
marcadores, activos, notas, mapeos de telemetría— y archivos grandes
—panorámicas de 8192 px, modelos 3D, PDF—. Hace falta guardar los dos de forma
que el proyecto se pueda copiar, enviar por correo y abrir en otro equipo.

Las opciones consideradas:

1. **Carpeta con un JSON y los medios al lado.** Simple, inspeccionable.
2. **Base de datos SQLite con los medios como BLOB.** Un solo archivo.
3. **Paquete ZIP con una base SQLite y los medios como entradas.**

## Decisión

La tercera: un ZIP con extensión `.ivp` que contiene `proyecto.db` (SQLite),
los medios en `media/`, los documentos en `documents/`, un manifiesto y un
archivo de sumas SHA-256.

## Motivos

**Contra la carpeta (1):** un proyecto que son cuatrocientos archivos se
desordena en el primer envío. Alguien copia la carpeta sin el JSON, o mueve una
imagen, y el proyecto queda roto sin que nada lo detecte. El ZIP es un objeto
que se mueve entero o no se mueve.

**Contra el SQLite monolítico (2):** meter 8 GB de panorámicas como BLOB obliga
a leer y escribir la base completa para cualquier operación, y hace imposible
que el exportador copie una imagen sin pasarla por la base. Además, un archivo
corrupto se pierde todo; en el ZIP, un medio corrupto se detecta por su suma y
el resto del proyecto sigue abriéndose.

**A favor del ZIP con SQLite (3):** los datos estructurados tienen consultas
—«qué notas están abiertas en esta unidad»— y para eso SQLite es la herramienta.
Los medios son archivos y se tratan como archivos. Las sumas permiten decir
exactamente qué se corrompió.

## Consecuencias

- Abrir un proyecto es: leer el ZIP, verificar integridad, abrir la base,
  migrar en memoria, cargar y validar. El orden importa: la verificación va
  **antes** de interpretar el manifiesto, porque un paquete manipulado debe
  dar «suma incorrecta» y no «formato inválido».
- La migración ocurre en memoria y no se escribe hasta que el usuario guarda.
  Así, abrir un proyecto con una versión nueva de la aplicación no impide
  volver a la anterior si algo no funciona.
- Se usa SQLite compilado a WebAssembly (`sql.js`) en lugar de un módulo
  nativo. El mismo código corre en el contenedor de Windows, en el navegador y
  en las pruebas de Node, y no hay un binario por plataforma que mantener.
- El binario WASM viaja en el instalador, no se descarga: una red de planta sin
  salida a Internet es el caso normal. `npm run verify` comprueba que la copia
  corresponde a la versión instalada de `sql.js`.
