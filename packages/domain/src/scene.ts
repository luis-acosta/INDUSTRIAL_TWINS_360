/**
 * Escenas del recorrido (etapas 01, 02, 04 y 08).
 *
 * Una escena es un punto de vista: una panorámica, una imagen plana o un
 * modelo 3D. El mismo tipo cubre los tres casos porque el resto del sistema
 * —hotspots, acciones, notas, telemetría, autopilot— no necesita saber en
 * cuál está: necesita saber que hay una escena, con sus marcadores y su
 * cámara. Esa uniformidad es lo que permite que la etapa 08 añada modelos 3D
 * sin reescribir las etapas 02 a 07.
 */
import { z } from 'zod';
import { uuidSchema } from './identity';
import {
  cameraViewSchema,
  planOrientationSchema,
  planPointSchema,
  zoomLimitsSchema,
} from './coordinates';
import { hotspotSchema } from './hotspot';
import { actionSchema } from './action';

export const sceneKindSchema = z.enum(['panorama', 'image', 'model']);
export type SceneKind = z.infer<typeof sceneKindSchema>;

/* ------------------------------------------------------------------ *
 * Control de cámara (C02, C03)
 * ------------------------------------------------------------------ */

export const cameraControlSchema = z.object({
  /** Vista con la que arranca la escena. */
  initialView: cameraViewSchema,
  zoom: zoomLimitsSchema.default({ minFovDeg: 30, maxFovDeg: 100 }),
  /** Sensibilidad del arrastre. 1 = un píxel de ratón por píxel de textura. */
  dragSpeed: z.number().gt(0).max(10).default(1),
  /**
   * Inercia del movimiento, 0-1 (C02).
   *
   * Es el factor de amortiguación por fotograma: 0 detiene la cámara en seco
   * al soltar y 0.95 la deja deslizar mucho. El valor por defecto, 0.82, es
   * el que hace que un arrastre corto se sienta directo y uno largo
   * conserve el impulso, que es como se comporta el gesto real.
   */
  inertia: z.number().min(0).max(0.98).default(0.82),
  /** Giro automático lento cuando no hay interacción. */
  autoRotate: z.boolean().default(false),
  /** Velocidad del giro automático, en radianes por segundo. */
  autoRotateSpeed: z.number().min(-1).max(1).default(0.05),
  /** Segundos de inactividad antes de reanudar el giro automático. */
  autoRotateIdleS: z.number().min(0).max(600).default(8),
  /** Invertir el eje vertical del arrastre. */
  invertPitch: z.boolean().default(false),
});

export type CameraControl = z.infer<typeof cameraControlSchema>;

export const DEFAULT_CAMERA_CONTROL: CameraControl = {
  initialView: { yaw: 0, pitch: 0, fov: 75 },
  zoom: { minFovDeg: 30, maxFovDeg: 100 },
  dragSpeed: 1,
  inertia: 0.82,
  autoRotate: false,
  autoRotateSpeed: 0.05,
  autoRotateIdleS: 8,
  invertPitch: false,
};

/* ------------------------------------------------------------------ *
 * Escena de modelo 3D (etapa 08)
 * ------------------------------------------------------------------ */

export const cameraModeSchema = z.enum(['orbit', 'flyOver', 'firstPerson']);
export type CameraMode = z.infer<typeof cameraModeSchema>;

export const modelLightingSchema = z.object({
  /** Intensidad de la luz ambiental. */
  ambientIntensity: z.number().min(0).max(5).default(0.6),
  /** Intensidad de la luz direccional principal. */
  directionalIntensity: z.number().min(0).max(10).default(1.2),
  /** Dirección de la luz principal, en radianes. */
  directionalYaw: z.number().finite().default(0.8),
  directionalPitch: z.number().finite().default(0.9),
  shadows: z.boolean().default(true),
  /** Tono del fondo: token del sistema o color propio. */
  background: z
    .discriminatedUnion('kind', [
      // `surfaceToken` y no `token`: el manifiesto publicado rechaza las
      // claves llamadas `token` para que no viaje una credencial, y un fondo
      // del sistema hacía saltar esa guarda.
      z.object({
        kind: z.literal('token'),
        surfaceToken: z.enum(['canvas', 'sunken', 'base']),
      }),
      z.object({ kind: z.literal('color'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
      z.object({ kind: z.literal('panorama'), mediaId: uuidSchema }),
    ])
    .default({ kind: 'token', surfaceToken: 'sunken' }),
  /** Exposición del renderizador en paradas. */
  exposure: z.number().min(0.1).max(4).default(1),
});

export type ModelLighting = z.infer<typeof modelLightingSchema>;

export const cameraBoundsSchema = z.object({
  /** Distancia mínima y máxima de la cámara orbital al objetivo. */
  minDistance: z.number().gt(0).default(0.5),
  maxDistance: z.number().gt(0).default(500),
  /** Límites de elevación de la cámara orbital, en radianes. */
  minPolarAngle: z.number().min(0).max(Math.PI).default(0.05),
  maxPolarAngle: z.number().min(0).max(Math.PI).default(Math.PI - 0.05),
  /** Altura del observador en primera persona, en unidades del modelo. */
  eyeHeight: z.number().gt(0).default(1.7),
  /** Velocidad de desplazamiento en primera persona y Fly Over. */
  moveSpeed: z.number().gt(0).default(3),
  /** Impedir que la cámara atraviese la geometría en primera persona. */
  collide: z.boolean().default(true),
});

export type CameraBounds = z.infer<typeof cameraBoundsSchema>;

/** Vista con nombre, guardada para volver a ella (L08). */
export const savedViewSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  mode: cameraModeSchema,
  /** Posición de la cámara en coordenadas del modelo. */
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  /** Punto al que mira. */
  target: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  fov: z.number().min(10).max(120).default(60),
});

export type SavedView = z.infer<typeof savedViewSchema>;

export const modelSettingsSchema = z.object({
  defaultMode: cameraModeSchema.default('orbit'),
  allowedModes: z.array(cameraModeSchema).min(1).default(['orbit', 'flyOver', 'firstPerson']),
  bounds: cameraBoundsSchema.default({
    minDistance: 0.5,
    maxDistance: 500,
    minPolarAngle: 0.05,
    maxPolarAngle: Math.PI - 0.05,
    eyeHeight: 1.7,
    moveSpeed: 3,
    collide: true,
  }),
  lighting: modelLightingSchema.default({
    ambientIntensity: 0.6,
    directionalIntensity: 1.2,
    directionalYaw: 0.8,
    directionalPitch: 0.9,
    shadows: true,
    background: { kind: 'token', surfaceToken: 'sunken' },
    exposure: 1,
  }),
  savedViews: z.array(savedViewSchema).default([]),
  /**
   * Resolución adaptativa (V03): el renderizador baja la escala de píxel si
   * no sostiene la tasa objetivo. Es la diferencia entre un modelo pesado que
   * se mueve a 20 fps borroso y uno que se mueve a 4 fps nítido; en
   * inspección, lo primero es utilizable y lo segundo no.
   */
  adaptiveResolution: z.boolean().default(true),
  targetFps: z.number().int().min(15).max(120).default(50),
  minPixelRatio: z.number().min(0.3).max(1).default(0.6),
  /** Nombres de animación a reproducir al entrar (L10). */
  autoplayAnimations: z.array(z.string().min(1)).default([]),
  /**
   * Preserva la vista al cambiar entre modelos compatibles (L11). Dos modelos
   * son compatibles cuando declaran el mismo `coordinateSpaceId`.
   */
  coordinateSpaceId: z.string().max(120).nullable().default(null),
});

export type ModelSettings = z.infer<typeof modelSettingsSchema>;

/* ------------------------------------------------------------------ *
 * Planos y radar (G01-G05)
 * ------------------------------------------------------------------ */

export const planSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  /** Imagen del plano: PNG, SVG o fotografía del plano impreso. */
  mediaId: uuidSchema,
  /** Agrupación por zona o piso (G03). */
  floor: z.string().max(80).default(''),
  floorOrder: z.number().int().default(0),
  orientation: planOrientationSchema.default({ northRad: 0, sceneNorthOffsetRad: 0 }),
  /** Mostrar el radar de dirección de mirada sobre este plano (G04). */
  showRadar: z.boolean().default(true),
  /** Apertura del cono del radar, en grados. */
  radarApertureDeg: z.number().min(5).max(180).default(60),
});

export type Plan = z.infer<typeof planSchema>;

/** Punto navegable del plano que lleva a una escena (G02). */
export const planMarkerSchema = z.object({
  id: uuidSchema,
  planId: uuidSchema,
  sceneId: uuidSchema,
  position: planPointSchema,
  label: z.string().max(120).default(''),
  /** Orientación de la escena respecto al plano, para el radar (G05). */
  headingRad: z.number().finite().default(0),
});

export type PlanMarker = z.infer<typeof planMarkerSchema>;

/* ------------------------------------------------------------------ *
 * Escena
 * ------------------------------------------------------------------ */

export const sceneSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  kind: sceneKindSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  /** Medio principal: panorámica, imagen o modelo GLB. */
  mediaId: uuidSchema.nullable().default(null),
  camera: cameraControlSchema.default(DEFAULT_CAMERA_CONTROL),
  /** Presente sólo en escenas de tipo `model`. */
  model: modelSettingsSchema.nullable().default(null),
  hotspots: z.array(hotspotSchema).default([]),
  /** Acciones de entrada y salida de escena (J07). */
  actions: z.array(actionSchema).default([]),
  /** Posición en el árbol del editor y en los selectores. */
  order: z.number().int().nonnegative().default(0),
  /** Agrupación libre del autor: unidad, piso, recorrido. */
  group: z.string().max(120).default(''),
  tags: z.array(z.string().max(48)).default([]),
  /** Escena excluida de la publicación sin borrarla del proyecto. */
  excludedFromPublish: z.boolean().default(false),
  /** Efecto visual ambiental de la escena (V06, V08). */
  ambientEffect: z
    .object({
      effect: z.enum(['none', 'rain', 'dust', 'snow', 'lensFlare']),
      intensity: z.number().min(0).max(1),
    })
    .default({ effect: 'none', intensity: 0.5 }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Scene = z.infer<typeof sceneSchema>;

/**
 * Comprueba la coherencia entre el tipo de escena y su configuración.
 *
 * Zod valida la forma de cada campo, no la relación entre ellos: una escena
 * `model` sin `model` pasa el esquema y revienta en el visor. Estas reglas
 * cruzadas se comprueban aquí y se ejecutan al guardar y al abrir.
 */
export function validateSceneConsistency(scene: Scene): string[] {
  const problems: string[] = [];

  if (scene.kind === 'model') {
    if (scene.model === null) {
      problems.push('Una escena de modelo 3D necesita su configuración de modelo');
    }
    if (scene.mediaId === null) {
      problems.push('Una escena de modelo 3D necesita un archivo GLB o glTF asociado');
    }
  } else if (scene.model !== null) {
    problems.push(`Una escena de tipo «${scene.kind}» no debe llevar configuración de modelo 3D`);
  }

  if (scene.kind === 'panorama' && scene.mediaId === null) {
    problems.push('Una escena panorámica necesita una imagen asociada');
  }

  if (scene.camera.zoom.minFovDeg > scene.camera.zoom.maxFovDeg) {
    problems.push('El FOV mínimo de la escena supera el máximo');
  }

  const { initialView, zoom } = scene.camera;
  if (initialView.fov < zoom.minFovDeg || initialView.fov > zoom.maxFovDeg) {
    problems.push(
      `La vista inicial (${initialView.fov}°) queda fuera de los límites de zoom de la escena (${zoom.minFovDeg}°–${zoom.maxFovDeg}°)`,
    );
  }

  if (scene.model !== null) {
    if (!scene.model.allowedModes.includes(scene.model.defaultMode)) {
      problems.push('El modo de cámara por defecto no está entre los modos permitidos');
    }
    if (scene.model.bounds.minDistance > scene.model.bounds.maxDistance) {
      problems.push('La distancia mínima de cámara supera la máxima');
    }
  }

  const ids = new Set<string>();
  for (const hotspot of scene.hotspots) {
    if (ids.has(hotspot.id)) problems.push(`Marcador duplicado: ${hotspot.id}`);
    ids.add(hotspot.id);
    if (hotspot.sceneId !== scene.id) {
      problems.push(`El marcador «${hotspot.name}» apunta a otra escena`);
    }
  }

  return problems;
}

/** Marcadores visibles en el editor, ordenados de forma estable. */
export function orderedHotspots(scene: Scene): Scene['hotspots'] {
  return [...scene.hotspots].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name, 'es');
  });
}
