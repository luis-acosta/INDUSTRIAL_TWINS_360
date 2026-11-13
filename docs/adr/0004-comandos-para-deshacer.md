# ADR 0004 — El proyecto sólo cambia aplicando comandos invertibles

**Fecha:** 2026-11-12 · **Estado:** aceptada

## Contexto

El requisito Y04 pide que deshacer y rehacer cubran **todas** las ediciones del
proyecto. Las opciones habituales son guardar instantáneas del estado o
registrar comandos invertibles.

## Decisión

El proyecto es inmutable y sólo cambia aplicando un `Command<Project>` con
`apply` e `invert`. No hay ninguna otra vía para modificarlo: la tienda del
editor no expone un «asignar estado».

Los comandos con la misma clave de fusión y dentro de una ventana de tiempo se
combinan en una sola entrada del historial.

## Motivos

**Contra las instantáneas:** una tienda con actualizaciones libres permite
escribir código que edita el proyecto por un lado y no aparece en el historial.
Ese fallo sólo se descubre cuando un usuario pulsa deshacer y no pasa nada —y
entonces ya hay diez sitios que lo hacen mal—. Con comandos, la única forma de
cambiar el proyecto es registrar el cambio.

**A favor de la fusión:** arrastrar un marcador produce un evento de puntero por
fotograma. Sin fusión, deshacer retrocede un píxel y el usuario tiene que
pulsar cuarenta veces. La entrada fusionada conserva la inversión del **primer**
comando del grupo, que es lo que el usuario considera un paso.

## Consecuencias

- El historial es barato aunque cada comando «reemplace» el proyecto completo:
  como es inmutable, la inversión guarda un puntero al objeto anterior, no una
  copia.
- Rehacer es volver a aplicar, sin recalcular nada.
- El estado de interfaz —selección, paneles abiertos, filtros— vive aparte y no
  pasa por el historial: deshacer un cambio de pestaña no es lo que nadie
  espera.
- Hay un índice del último comando guardado, de modo que deshacer hasta el
  punto de guardado deja el proyecto marcado como limpio en lugar de sucio para
  siempre.
