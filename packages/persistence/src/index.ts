/**
 * @it360/persistence — persistencia local del proyecto.
 *
 * Reúne el almacenamiento de bytes con guardado atómico y respaldos, el
 * acceso a SQLite, las migraciones versionadas, la traducción entre el
 * agregado de dominio y las tablas, y el formato de paquete `.ivp`.
 *
 * Ninguna de estas piezas conoce React ni Tauri: la aplicación de escritorio
 * aporta la implementación de `Storage` y el resto es el mismo código que
 * ejecutan las pruebas.
 */
export * from './storage';
export * from './backup';
export * from './hash';
export * from './sql';
export * from './migrations';
export * from './repository';
export * from './ivp';
export * from './workspace';
