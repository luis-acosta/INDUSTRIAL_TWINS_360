/**
 * El recorrido publicado, como paquete.
 *
 * Esto vivía dentro de `apps/viewer-web` y se ha movido aquí por una razón
 * concreta: el editor necesita previsualizar el recorrido **con el mismo
 * componente** que ejecuta el visitante (Y07). Una previsualización escrita
 * aparte sería una segunda implementación del visor, y lo que el autor
 * aprobaría mirándola no sería lo que se publica.
 *
 * El paquete no sabe de dónde vienen los datos: recibe un `LoadedTour` ya
 * resuelto. El visor publicado lo obtiene descargando el manifiesto del
 * paquete; el editor lo construye en memoria con el proyecto que se está
 * editando. Ninguno de los dos necesita saber del otro.
 */
export * from './TourViewer';
export * from './manifest';
export * from './deep-link';
export * from './playback';
export * from './windows';
export * from './field-notes';
export * from './telemetry';
export * from './device';
export * from './PlanView';
export * from './WindowHost';
export * from './InfoWindowBody';
export * from './SkinRenderer';
export * from './notes-client';
