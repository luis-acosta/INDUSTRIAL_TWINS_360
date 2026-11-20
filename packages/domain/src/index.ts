/**
 * @it360/domain — modelo de dominio de INDUSTRIAL TWINS 360.
 *
 * Capa sin dependencias de interfaz, de base de datos ni de red: tipos,
 * esquemas Zod, matemática de coordenadas y reglas de negocio puras. Todo lo
 * que aquí se decide es comprobable con una prueba unitaria, y eso es
 * deliberado: las reglas que importan —qué dato es fiable, quién puede hacer
 * qué, qué se publica y qué no— no deben vivir en un componente de React.
 */
export * from './result';
export * from './identity';
export * from './coordinates';
export * from './media';
export * from './media-import';
export * from './info-window';
export * from './model-hotspot';
export * from './publish-plan';
export * from './action';
export * from './hotspot';
export * from './hotspot-geometry';
export * from './plan';
export * from './scene';
export * from './tags';
export * from './asset';
export * from './asset-draft';
export * from './catalog-csv';
export * from './class-draft';
export * from './note';
export * from './note-authoring';
export * from './field-note';
export * from './telemetry';
export * from './skin';
export * from './skin-editing';
export * from './skin-templates';
export * from './tour';
export * from './tour-authoring';
export * from './history';
export * from './scripting';
export * from './access';
export * from './project';
export * from './revision';
