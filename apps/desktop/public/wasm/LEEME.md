# Binario WASM de SQLite

`sql-wasm.wasm` se copia aquí desde `node_modules/sql.js/dist/` y se sirve como
recurso estático de la aplicación, no desde una CDN.

El motivo es operativo: una red de planta suele estar aislada de Internet, y una
aplicación que necesita descargar su motor de base de datos para abrir un
archivo local no arranca en el sitio donde tiene que funcionar.

La copia se verifica en `npm run verify`: si la versión de `sql.js` cambia y el
binario no se actualiza, la comprobación falla antes de que el desajuste llegue
a un instalador.
