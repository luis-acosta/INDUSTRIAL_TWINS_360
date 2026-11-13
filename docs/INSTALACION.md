# Instalación y compilación

## 1. Qué se instala en el equipo del cliente

**Un solo instalador de Windows** (`.msi` o `.exe`) que contiene la aplicación,
el visor que se empaqueta en las publicaciones y el motor de base de datos. No
descarga nada al instalar ni al usarse: una red de planta sin salida a Internet
es el caso normal.

| Componente | Obligatorio | Nota |
|---|---|---|
| Aplicación de escritorio | sí | Windows 10 21H2 o posterior, 64 bits |
| WebView2 | sí | El instalador lo instala si falta |
| Servidor de telemetría | no | Sólo si el recorrido muestra datos de proceso |
| Servicio de cosido | no | Sólo si se van a coser panorámicas |

**Requisitos del equipo:** 8 GB de memoria y GPU con WebGL 2 para trabajar con
panorámicas de 8192 px. Con menos, la aplicación funciona y reduce la resolución,
avisándolo en pantalla. La resolución mínima de pantalla admitida es 1366 × 768.

---

## 2. Compilar el instalador

### Requisitos de la máquina de compilación

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | 20.11 o posterior | Interfaz y herramientas |
| Rust | 1.77 o posterior | Contenedor de escritorio |
| Visual Studio Build Tools | 2022, con «Desarrollo para escritorio con C++» | Enlazador de Windows |
| WebView2 SDK | lo trae Tauri | — |

### Pasos

```bash
npm ci                 # dependencias, con versiones exactas del lockfile
npm run verify         # tipos, modelo de permisos y las 650 pruebas
npm run tauri:build    # instaladores en apps/desktop/src-tauri/target/release/bundle
```

`npm run tauri:build` compila primero el visor web y lo incluye como recurso: es
lo que el publicador lee para generar los paquetes. Si falta, el publicador se
niega a generar en lugar de producir un sitio sin JavaScript — una página en
blanco que el cliente descubriría después de subirla a su servidor.

### Verificar un instalador antes de entregarlo

1. **Instalar en una máquina limpia**, sin herramientas de desarrollo. Es la
   única forma de detectar una dependencia que la máquina de compilación tenía y
   el cliente no.
2. **Abrir la aplicación sin red.** Desconecte la red y compruebe que arranca,
   abre un proyecto y muestra una panorámica. Si algo intenta descargarse, aquí
   se ve.
3. **Guardar y reabrir un proyecto.** Comprueba la escritura atómica y las
   copias de respaldo.
4. **Generar un paquete web y abrirlo con un navegador** desde una subcarpeta,
   no desde la raíz del servidor: es como se publica en la intranet de un
   cliente y es donde fallan las rutas absolutas.
5. **Comprobar las sumas.** El paquete lleva `SUMAS.txt`; verifique un par de
   archivos.

### Firma del instalador

`tauri.conf.json` deja `certificateThumbprint` en `null`: el instalador **no
viene firmado**. Sin firma, Windows muestra un aviso de SmartScreen la primera
vez y algunas políticas corporativas bloquean la instalación.

Para firmar, ponga la huella del certificado en ese campo. El sello de tiempo ya
está configurado, que es lo que mantiene válida la firma después de que el
certificado caduque.

---

## 3. Servidor de telemetría (opcional)

Sólo hace falta si el recorrido muestra datos de proceso en vivo.

```bash
cd apps/server
pip install -e .

IT360_DATABASE_URL=postgresql://it360:...@db.planta.local/it360 \
IT360_INFLUX_URL=https://influx.planta.local:8086 \
IT360_INFLUX_ORG=planta-norte \
IT360_INFLUX_BUCKET=proceso \
IT360_INFLUX_TOKEN=<token de SOLO LECTURA> \
uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8787
```

**El token debe ser de sólo lectura en InfluxDB.** El servidor rechaza toda
consulta que no sea de lectura, pero eso es la segunda barrera; la primera es
que la credencial no pueda escribir ni aunque alguien se equivoque.

**No exponga este puerto fuera de una red de confianza.** La autenticación de
usuarios está pendiente: la identidad llega por cabeceras HTTP y no se valida
(ver `docs/LIMITACIONES.md`).

Si el historiador usa un certificado interno, puede desactivar la verificación
TLS con `IT360_INFLUX_VERIFY_TLS=false`, pero el servidor exige que declare el
motivo en `IT360_INFLUX_TLS_EXEMPTION_REASON` y no arranca sin él. Una
desactivación silenciosa de TLS es una puerta abierta que nadie recuerda.

---

## 4. Servicio de cosido (opcional)

```bash
cd services/stitcher
pip install -e ".[cv]"     # [cv] instala OpenCV
```

OpenCV es opcional a propósito: un despliegue que sólo usa panorámicas ya
cosidas no tiene por qué cargar con 60 MB de binarios. Si falta, el servicio
avisa al llamarlo en lugar de impedir el arranque.

---

## 5. Desarrollo

```bash
npm run dev            # aplicación en el navegador, puerto 5173
npm run dev:viewer     # visor publicado, puerto 5174
npm run tauri:dev      # aplicación en el contenedor de Windows
npm run test:watch     # pruebas en vigilancia
npm run verify         # todo lo que la integración continua comprueba
npm run test:e2e       # extremo a extremo con un navegador real
```

En el navegador la aplicación **trabaja en memoria**: no abre ni guarda
archivos. Para eso hace falta `tauri:dev`.

### Qué comprueba `npm run verify`

| Paso | Qué protege |
|---|---|
| `typecheck` | Un solo programa de TypeScript sobre todo el monorepo |
| `verify:wasm` | Que el binario de SQLite servido corresponda a la versión instalada |
| `verify:access` | Que el modelo de permisos del servidor corresponda al dominio |
| `test` | 528 pruebas de TypeScript |
| `test:server` | 76 pruebas del servidor |
| `test:stitcher` | 46 pruebas del cosido, 34 con OpenCV real |

Las pruebas de extremo a extremo van aparte porque necesitan un navegador
instalado. Lo que comprueban no lo puede comprobar ninguna prueba unitaria: que
el paquete que produce el exportador sea el que el visor sabe abrir.
