# ADR 0002 — La telemetría es de sólo lectura por construcción

**Fecha:** 2026-11-12 · **Estado:** aceptada

## Contexto

El producto muestra variables de proceso de una planta industrial: presiones,
caudales, temperaturas, estados de equipo. Los datos vienen de un historiador
InfluxDB.

En una planta, la primera pregunta de seguridad informática es: ¿esto puede
tocar el proceso? Y la segunda: ¿dónde está el token?

## Decisión

1. **No existe ninguna función que escriba.** La superficie completa de la API
   de telemetría son cuatro operaciones: `latest`, `history`, `ping`,
   `listMeasurements`. No es una lista de configuración; es todo lo que hay.
2. **Toda consulta pasa por un verificador** que la rechaza si contiene
   palabras de escritura (`to(`, `delete(`, `drop(`), de esquema (`create`,
   `alter`) o de salida de red desde el motor (`http.post`, `sql.to`).
3. **La interfaz nunca ve el token.** El visor y el editor piden lecturas por
   identificador de variable a un servicio local; el servicio resuelve la
   credencial en su propio proceso. En el contenedor de escritorio esa
   resolución está en Rust y el almacén es el Administrador de credenciales de
   Windows.

## Motivos

El usuario del token debe ser de sólo lectura en el servidor del cliente, y eso
es la primera defensa. Pero depende de cómo esté configurado un servidor que no
controlamos. El verificador es la segunda defensa, la que no depende de nadie
más.

El verificador normaliza a minúsculas y elimina el espacio antes del paréntesis.
Sin eso, `to (` lo esquiva, y un verificador que se esquiva con un espacio no
verifica nada.

`http.post` no escribe en la base, pero saca los datos del perímetro. Está en la
lista por eso.

## Consecuencias

- El producto **no controla procesos** y no puede llegar a hacerlo sin reescribir
  esta capa a propósito, que es exactamente la barrera que se quería.
- El visor publicado no puede construir consultas propias: pide por
  identificador de mapeo, y el servidor sólo conoce los mapeos del recorrido.
  Un identificador desconocido se responde como «sin dato» con el motivo, no se
  ignora en silencio: un visor que pide algo que el servidor no tiene está
  desincronizado y hay que poder verlo.
- La calidad del dato se reevalúa en el cliente con su propio reloj. El servicio
  no sabe cuánto tardó la respuesta en llegar al navegador, y «actual» es una
  afirmación sobre el momento en que alguien mira la pantalla.
