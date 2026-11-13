# INDUSTRIAL TWINS 360

Plataforma de recorridos virtuales industriales: un editor de escritorio para Windows que
compone panorámicas, activos, telemetría y formación, y un visor publicado que funciona sin
conexión desde una carpeta, un servidor web o una memoria USB.

Desarrollado por **PDI Advanced**.

## Estado

Avance global **69 %** sobre los 156 requisitos seleccionados: 78 completos, 37 parciales,
10 experimentales, 11 modelados y 20 pendientes. El recuento vive en
[`tools/progress.json`](tools/progress.json) y se pondera así: completo 1, experimental 0,85,
parcial 0,5, modelado 0,2, pendiente 0.

Las etiquetas significan algo concreto y no se usan para redondear hacia arriba:

| Estado | Qué quiere decir |
| --- | --- |
| **completo** | Interfaz integrada y prueba automatizada en verde |
| **experimental** | Funciona, pero su calidad no alcanza para confiar en el resultado sin revisarlo |
| **parcial** | Lógica implementada y probada, sin interfaz o sin integrar |
| **modelado** | El esquema y los tipos existen; el comportamiento no |
| **pendiente** | Sin empezar |

**1 544 pruebas en verde**: 1 410 de TypeScript, 76 del servidor de telemetría, 46 del cosido
de panorámicas y 12 de extremo a extremo.

Lo que falta por etapas está en `tools/progress.json`; lo más grande son las transiciones
visuales entre escenas, el autoconectado automático de panorámicas (hoy experimental), la
sesión inmersiva de realidad virtual —que no se puede verificar sin un visor— y partes de la
publicación como el visor en archivo único.

## Cómo se ejecuta

Requiere Node 20.11 y Python 3.11.

```bash
npm ci
npm run verify        # tipos, pruebas de TypeScript, servidor y cosido
npm run dev           # editor de escritorio
npm run dev:viewer    # visor publicado
```

Otros comandos útiles:

```bash
npm run typecheck     # un solo programa de TypeScript, modo estricto
npm run test:e2e      # Playwright sobre un paquete publicado real
npm run build         # compila los nueve paquetes
npm run report        # informe de requisitos y pruebas
```

## Cómo está organizado

Monorepo con espacios de trabajo de npm.

```
apps/
  desktop/        Editor (React + Vite + Tauri)
  viewer-web/     Visor publicado
  server/         Servicio de telemetría (Python)
packages/
  domain/         Esquemas Zod, reglas y motores. Sin interfaz ni entrada/salida
  ui/             Sistema de diseño: primitivas, iconos, superposiciones
  tokens/         Color, tipografía y retícula como única fuente de verdad
  viewer/         Motor del visor: cámara, marcadores, acciones, modelos, WebXR
  editor/         Operaciones de edición independientes de la pantalla
  persistence/    Proyecto en SQLite (WASM), migraciones versionadas, respaldos
  exporter/       Generación del paquete publicado
services/
  stitcher/       Cosido de panorámicas (Python)
docs/adr/         Decisiones de arquitectura
tools/            Verificaciones, avance y generación del panel
```

El dominio es el centro: las reglas que deciden si algo se puede publicar, si un recorrido
apunta a una escena que ya no existe o si un contorno se puede pulsar viven en
`packages/domain` como funciones puras, y las pantallas las llaman. Es lo que permite probar
el ciclo completo sin renderizar nada y sin esperar en tiempo real.

## Decisiones que conviene conocer antes de tocar el código

- **Los valores por defecto se derivan del esquema, nunca se copian a mano.** Una lista de
  campos escrita en una pantalla se queda atrás en cuanto el esquema cambia, y el resultado es
  un proyecto que no valida sin que nadie sepa por qué.
- **Las funciones del dominio devuelven `Result`, no lanzan.** Un error lleva código, mensaje
  y, cuando existe, el camino para resolverlo.
- **Nada se da por terminado sin interfaz y prueba.** Si un algoritmo no alcanza la calidad
  necesaria se queda marcado como experimental, no como completo.
- **Los límites se declaran en el código.** Donde algo es una aproximación —la profundidad de
  un marcador se dibuja como escala y no como paralaje— está escrito en el comentario, no
  disimulado.

## Seguridad

Restricciones que el código respeta y que conviene no relajar:

- **La telemetría es exclusivamente de lectura.** No hay control de PLC ni escritura de
  variables de proceso en ninguna parte del sistema.
- **El visor publicado nunca conoce credenciales.** No habla con InfluxDB: pide lecturas por
  identificador de mapeo a un servicio local que guarda la conexión.
- **Nunca hay credenciales en el repositorio, en los registros ni en las exportaciones.**
- **El JavaScript propio del autor está desactivado por defecto**, y cuando se habilita corre
  en contexto aislado, sin acceso al sistema operativo.
- **Los scripts de un proyecto importado no se ejecutan sin aprobación explícita.**
- **Los permisos se comprueban en el servidor, nunca sólo en la interfaz.**
- Las importaciones se validan contra ZIP slip, salto de rutas, XSS y SSRF.
- Los datos sin conexión se etiquetan como caché, nunca como telemetría actual.

## Licencia

Propiedad de PDI Advanced. Todos los derechos reservados.
