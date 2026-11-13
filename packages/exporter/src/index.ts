export * from './frame-origins';
/**
 * @it360/exporter — publicación del recorrido.
 *
 * Compone paquetes a partir del proyecto: sitio web estático, paquete sin
 * conexión y curso SCORM. No construye el visor ni habla con el sistema de
 * archivos: recibe el tiempo de ejecución y los medios como datos y devuelve
 * archivos. Eso lo hace comprobable sin empaquetador y sin disco, que es la
 * única forma de tener pruebas de la publicación que corran en cada cambio.
 */
export * from './plan';
export * from './site';
export * from './package';
