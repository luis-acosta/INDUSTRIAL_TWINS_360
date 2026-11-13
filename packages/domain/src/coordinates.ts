/**
 * Sistema de coordenadas del recorrido.
 *
 * El contrato de datos fija las unidades y aquí se implementan sin excepción:
 *
 *  - **yaw** y **pitch** en RADIANES. yaw crece hacia la derecha del
 *    observador y está envuelto en (-π, π]; pitch es la elevación en
 *    [-π/2, π/2], con +π/2 mirando al cenit.
 *  - **FOV** en GRADOS, porque es la unidad en la que piensa quien configura
 *    una escena y la que aparece en la interfaz. La conversión a radianes
 *    ocurre en el límite con Three.js y en ningún otro sitio.
 *  - **UV** normalizados en [0,1], con v = 0 en el borde superior de la
 *    imagen equirectangular, que es la convención de la propia textura.
 *  - **Planos**: puntos normalizados en [0,1] relativos a la imagen del
 *    plano, nunca en píxeles, para que cambiar la resolución del plano no
 *    desplace los puntos colocados sobre él.
 *
 * Mezclar grados y radianes es el error clásico en este dominio, y no produce
 * una excepción: produce una escena que mira a otro lado. Por eso cada
 * función declara su unidad en el nombre o en el tipo, y las conversiones
 * están centralizadas en este módulo.
 */
import { z } from 'zod';

export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Acota un valor al intervalo [min, max]. */
export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Envuelve un ángulo en radianes al intervalo (-π, π].
 *
 * Girar 370° y girar 10° deben producir exactamente la misma orientación
 * guardada; de lo contrario, dos escenas idénticas se comparan como distintas
 * y el histórico de deshacer acumula pasos que no cambian nada.
 */
export function wrapYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  let v = ((yaw + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  // El intervalo es abierto por abajo y cerrado por arriba: -π se normaliza a π.
  if (v === -Math.PI) v = Math.PI;
  return v;
}

/** Acota la elevación. No se envuelve: pasarse del cenit invertiría la escena. */
export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return clamp(pitch, -HALF_PI, HALF_PI);
}

/**
 * Diferencia angular más corta entre dos yaw, en radianes y con signo.
 * Positiva si hay que girar a la derecha para ir de `from` a `to`.
 *
 * Es la base de la transición entre escenas: sin esto, pasar de 170° a -170°
 * recorrería 340° en lugar de los 20° que separan las dos vistas.
 */
export function shortestYawDelta(from: number, to: number): number {
  return wrapYaw(to - from);
}

/* ------------------------------------------------------------------ *
 * Orientación de cámara
 * ------------------------------------------------------------------ */

export const sphericalSchema = z.object({
  /** Azimut en radianes, (-π, π]. */
  yaw: z.number().finite(),
  /** Elevación en radianes, [-π/2, π/2]. */
  pitch: z.number().finite(),
});

export type Spherical = z.infer<typeof sphericalSchema>;

/** FOV vertical en grados. El rango admisible se justifica en `fovLimits`. */
export const FOV_MIN_DEG = 10;
export const FOV_MAX_DEG = 120;
export const FOV_DEFAULT_DEG = 75;

export const cameraViewSchema = z.object({
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  /** FOV vertical en GRADOS. */
  fov: z.number().min(FOV_MIN_DEG).max(FOV_MAX_DEG),
});

export type CameraView = z.infer<typeof cameraViewSchema>;

export const DEFAULT_CAMERA_VIEW: CameraView = {
  yaw: 0,
  pitch: 0,
  fov: FOV_DEFAULT_DEG,
};

/** Normaliza una vista: envuelve yaw, acota pitch y acota el FOV. */
export function normalizeCameraView(view: Partial<CameraView>): CameraView {
  return {
    yaw: wrapYaw(view.yaw ?? 0),
    pitch: clampPitch(view.pitch ?? 0),
    fov: clamp(view.fov ?? FOV_DEFAULT_DEG, FOV_MIN_DEG, FOV_MAX_DEG),
  };
}

/* ------------------------------------------------------------------ *
 * Conversión esfera <-> cartesiano
 * ------------------------------------------------------------------ */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Dirección unitaria para una orientación dada.
 *
 * Convención (la misma que usa el visor y que debe respetar cualquier
 * consumidor del formato): Y es el eje vertical, yaw = 0 mira hacia -Z.
 * Es la convención de Three.js, de modo que el visor no necesita una matriz
 * de cambio de base y no hay dos sistemas de coordenadas que mantener
 * sincronizados.
 */
export function sphericalToVector({ yaw, pitch }: Spherical): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: cosPitch * Math.sin(yaw),
    y: Math.sin(pitch),
    z: -cosPitch * Math.cos(yaw),
  };
}

/** Inversa de `sphericalToVector`. Tolera vectores no unitarios. */
export function vectorToSpherical(v: Vec3): Spherical {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length === 0 || !Number.isFinite(length)) return { yaw: 0, pitch: 0 };
  const y = clamp(v.y / length, -1, 1);
  return {
    yaw: wrapYaw(Math.atan2(v.x / length, -v.z / length)),
    pitch: Math.asin(y),
  };
}

/** Ángulo entre dos orientaciones, en radianes. */
export function angularDistance(a: Spherical, b: Spherical): number {
  const va = sphericalToVector(a);
  const vb = sphericalToVector(b);
  const dot = clamp(va.x * vb.x + va.y * vb.y + va.z * vb.z, -1, 1);
  return Math.acos(dot);
}

/**
 * Interpolación esférica entre dos orientaciones.
 *
 * Interpolar yaw y pitch por separado produce un recorrido que se curva y
 * acelera cerca de los polos; interpolar la dirección resuelve ambos
 * problemas y es lo que hace que una transición entre escenas se perciba
 * como un giro de cabeza y no como un barrido.
 */
export function slerpSpherical(from: Spherical, to: Spherical, t: number): Spherical {
  const k = clamp(t, 0, 1);
  const a = sphericalToVector(from);
  const b = sphericalToVector(to);
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const omega = Math.acos(dot);

  // Orientaciones casi coincidentes: la interpolación lineal es estable y
  // evita dividir por un seno que tiende a cero.
  if (omega < 1e-6) {
    return {
      yaw: wrapYaw(from.yaw + shortestYawDelta(from.yaw, to.yaw) * k),
      pitch: clampPitch(from.pitch + (to.pitch - from.pitch) * k),
    };
  }

  const sinOmega = Math.sin(omega);
  const wa = Math.sin((1 - k) * omega) / sinOmega;
  const wb = Math.sin(k * omega) / sinOmega;
  return vectorToSpherical({
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
  });
}

/* ------------------------------------------------------------------ *
 * Equirectangular <-> esfera
 * ------------------------------------------------------------------ */

export const uvSchema = z.object({
  u: z.number().min(0).max(1),
  v: z.number().min(0).max(1),
});

export type Uv = z.infer<typeof uvSchema>;

/**
 * Orientación -> coordenada de textura equirectangular.
 *
 * u = 0 corresponde a yaw = -π (borde izquierdo de la imagen) y v = 0 al
 * borde superior (cenit). Es la convención de las panorámicas 2:1 producidas
 * por cualquier cosedora, incluida la de la etapa 12.
 */
export function sphericalToUv({ yaw, pitch }: Spherical): Uv {
  const u = (wrapYaw(yaw) + Math.PI) / TWO_PI;
  const v = 0.5 - clampPitch(pitch) / Math.PI;
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
}

/** Inversa de `sphericalToUv`. */
export function uvToSpherical({ u, v }: Uv): Spherical {
  return {
    yaw: wrapYaw(clamp(u, 0, 1) * TWO_PI - Math.PI),
    pitch: clampPitch((0.5 - clamp(v, 0, 1)) * Math.PI),
  };
}

/* ------------------------------------------------------------------ *
 * Panorámicas parciales
 * ------------------------------------------------------------------ */

/**
 * Cobertura angular de una panorámica.
 *
 * Una panorámica completa cubre 360° en horizontal y 180° en vertical. La
 * etapa 01 exige admitir panorámicas parciales, que cubren menos: fuera de
 * su cobertura no hay información, y el visor tiene que limitar la cámara
 * en vez de mostrar textura estirada o negra.
 */
export const panoramaCoverageSchema = z.object({
  /** Cobertura horizontal en grados, (0, 360]. */
  horizontalDeg: z.number().gt(0).max(360),
  /** Cobertura vertical en grados, (0, 180]. */
  verticalDeg: z.number().gt(0).max(180),
  /** Centro horizontal de la cobertura, en radianes. */
  centerYaw: z.number().finite().default(0),
  /** Centro vertical de la cobertura, en radianes. */
  centerPitch: z.number().finite().default(0),
});

export type PanoramaCoverage = z.infer<typeof panoramaCoverageSchema>;

export const FULL_COVERAGE: PanoramaCoverage = {
  horizontalDeg: 360,
  verticalDeg: 180,
  centerYaw: 0,
  centerPitch: 0,
};

export const isFullCoverage = (c: PanoramaCoverage): boolean =>
  c.horizontalDeg >= 360 && c.verticalDeg >= 180;

/**
 * Deduce la cobertura a partir de las dimensiones en píxeles.
 *
 * Una imagen 2:1 se asume esférica completa. Cualquier otra relación se
 * interpreta como parcial conservando la densidad de píxeles por grado del
 * caso 2:1, que es como se comporta el recorte de una equirectangular
 * completa. La deducción es una ayuda al importar: el usuario siempre puede
 * corregir la cobertura, y el valor corregido es el que se guarda.
 */
export function inferCoverage(width: number, height: number): PanoramaCoverage {
  if (width <= 0 || height <= 0) return FULL_COVERAGE;
  const ratio = width / height;

  if (Math.abs(ratio - 2) < 0.02) return FULL_COVERAGE;

  // Densidad de referencia: 360° repartidos en el ancho de una 2:1 de la
  // misma altura. Si la imagen es más estrecha, cubre menos grados.
  const degPerPixel = 180 / height;
  return {
    horizontalDeg: clamp(width * degPerPixel, 0.1, 360),
    verticalDeg: clamp(height * degPerPixel, 0.1, 180),
    centerYaw: 0,
    centerPitch: 0,
  };
}

/** Límites de cámara derivados de la cobertura y del FOV actual. */
export interface ViewLimits {
  readonly yawMin: number;
  readonly yawMax: number;
  readonly pitchMin: number;
  readonly pitchMax: number;
  /** `true` cuando el yaw puede girar sin tope (cobertura de 360°). */
  readonly yawUnbounded: boolean;
}

/**
 * Calcula hasta dónde puede mirar la cámara.
 *
 * El margen depende del FOV: con un campo de visión amplio, el borde de la
 * imagen entra en cuadro antes, así que el tope de la cámara debe retroceder
 * medio FOV. Sin esta corrección, acercar el zoom al borde de una panorámica
 * parcial muestra el vacío que hay más allá de la textura.
 */
export function viewLimits(coverage: PanoramaCoverage, fovDeg: number): ViewLimits {
  const fov = clamp(fovDeg, FOV_MIN_DEG, FOV_MAX_DEG);
  const halfVertical = degToRad(coverage.verticalDeg) / 2;
  const halfFovV = degToRad(fov) / 2;

  const pitchSpan = Math.max(halfVertical - halfFovV, 0);
  const pitchMin = clampPitch(coverage.centerPitch - pitchSpan);
  const pitchMax = clampPitch(coverage.centerPitch + pitchSpan);

  if (coverage.horizontalDeg >= 360) {
    return { yawMin: -Math.PI, yawMax: Math.PI, pitchMin, pitchMax, yawUnbounded: true };
  }

  // El FOV horizontal se deduce del vertical asumiendo el aspecto del
  // viewport en el visor; aquí se usa el propio FOV como cota conservadora.
  const halfHorizontal = degToRad(coverage.horizontalDeg) / 2;
  const yawSpan = Math.max(halfHorizontal - halfFovV, 0);
  return {
    yawMin: coverage.centerYaw - yawSpan,
    yawMax: coverage.centerYaw + yawSpan,
    pitchMin,
    pitchMax,
    yawUnbounded: false,
  };
}

/** Aplica los límites a una vista. */
export function constrainView(view: CameraView, coverage: PanoramaCoverage): CameraView {
  const limits = viewLimits(coverage, view.fov);
  return {
    yaw: limits.yawUnbounded ? wrapYaw(view.yaw) : clamp(view.yaw, limits.yawMin, limits.yawMax),
    pitch: clamp(clampPitch(view.pitch), limits.pitchMin, limits.pitchMax),
    fov: clamp(view.fov, FOV_MIN_DEG, FOV_MAX_DEG),
  };
}

/* ------------------------------------------------------------------ *
 * Límites de zoom configurables (C03)
 * ------------------------------------------------------------------ */

export const zoomLimitsSchema = z
  .object({
    /** FOV mínimo en grados: el zoom más cercano permitido. */
    minFovDeg: z.number().min(FOV_MIN_DEG).max(FOV_MAX_DEG).default(30),
    /** FOV máximo en grados: el zoom más alejado permitido. */
    maxFovDeg: z.number().min(FOV_MIN_DEG).max(FOV_MAX_DEG).default(100),
  })
  .refine((v) => v.minFovDeg <= v.maxFovDeg, {
    message: 'El FOV mínimo no puede superar el máximo',
    path: ['minFovDeg'],
  });

export type ZoomLimits = z.infer<typeof zoomLimitsSchema>;

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { minFovDeg: 30, maxFovDeg: 100 };

/**
 * Aplica un paso de zoom.
 *
 * El paso es multiplicativo sobre el FOV y no aditivo: así un «clic» de rueda
 * se percibe igual de intenso con el zoom cercano que con el lejano, que es
 * como se comporta cualquier visor que no resulte brusco.
 */
export function applyZoom(fovDeg: number, factor: number, limits: ZoomLimits): number {
  const next = fovDeg * (factor > 0 ? factor : 1);
  return clamp(next, limits.minFovDeg, limits.maxFovDeg);
}

/* ------------------------------------------------------------------ *
 * Coordenadas de plano (G01-G05)
 * ------------------------------------------------------------------ */

export const planPointSchema = z.object({
  /** Posición horizontal normalizada respecto a la imagen del plano. */
  x: z.number().min(0).max(1),
  /** Posición vertical normalizada respecto a la imagen del plano. */
  y: z.number().min(0).max(1),
});

export type PlanPoint = z.infer<typeof planPointSchema>;

/**
 * Orientación del norte del plano, en radianes.
 *
 * El contrato obliga a declararla porque sin ella el radar no puede ser
 * correcto: la dirección de la mirada se conoce en el sistema de la
 * panorámica, y proyectarla sobre el plano exige saber cómo están alineados
 * uno y otro. Un radar que apunta sistemáticamente 40° desviado es peor que
 * no tener radar, porque induce a error sobre el terreno.
 */
export const planOrientationSchema = z.object({
  /** Rumbo del norte del plano medido en la imagen, en radianes. */
  northRad: z.number().finite().default(0),
  /** Rumbo que corresponde a yaw = 0 de la panorámica, en radianes. */
  sceneNorthOffsetRad: z.number().finite().default(0),
});

export type PlanOrientation = z.infer<typeof planOrientationSchema>;

/**
 * Convierte el yaw de la cámara en el ángulo que debe dibujar el radar sobre
 * el plano, medido en sentido horario desde el eje vertical de la imagen.
 */
export function yawToPlanBearing(yaw: number, orientation: PlanOrientation): number {
  return wrapYaw(yaw + orientation.sceneNorthOffsetRad - orientation.northRad);
}

/* ------------------------------------------------------------------ *
 * Geometría de polígonos sobre la esfera (D03, D11)
 * ------------------------------------------------------------------ */

/**
 * Área firmada de un polígono en coordenadas UV.
 *
 * El signo indica el sentido de recorrido, y es lo que permite implementar
 * «invertir polígono» (D11) sin reordenar la lista de vértices: basta negar
 * el sentido para que la zona interactiva pase a ser el exterior.
 */
export function signedAreaUv(points: readonly Uv[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.u * b.v - b.u * a.v;
  }
  return area / 2;
}

export const isClockwiseUv = (points: readonly Uv[]): boolean => signedAreaUv(points) < 0;

/**
 * Prueba de punto en polígono por cruce de rayos.
 *
 * Se usa para el picking de polígonos interactivos en el visor. Trabaja en UV
 * y no en pantalla para que el resultado no dependa del tamaño de la ventana
 * ni de la orientación actual de la cámara.
 */
export function pointInPolygonUv(point: Uv, polygon: readonly Uv[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.v > point.v !== pj.v > point.v &&
      point.u < ((pj.u - pi.u) * (point.v - pi.v)) / (pj.v - pi.v) + pi.u;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Rectángulo envolvente en UV, útil para descartar picking rápidamente. */
export function boundingBoxUv(points: readonly Uv[]): { min: Uv; max: Uv } | null {
  if (points.length === 0) return null;
  let minU = 1;
  let minV = 1;
  let maxU = 0;
  let maxV = 0;
  for (const p of points) {
    minU = Math.min(minU, p.u);
    minV = Math.min(minV, p.v);
    maxU = Math.max(maxU, p.u);
    maxV = Math.max(maxV, p.v);
  }
  return { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
}

/* ------------------------------------------------------------------ *
 * Transformación de marcadores en tres ejes (D08, D09)
 * ------------------------------------------------------------------ */

export const transform3dSchema = z.object({
  /** Escala uniforme. 1 = tamaño nominal del marcador. */
  scale: z.number().gt(0).max(50).default(1),
  /** Rotación alrededor del eje de la mirada, en radianes. */
  roll: z.number().finite().default(0),
  /** Inclinación vertical del marcador, en radianes. */
  tilt: z.number().finite().default(0),
  /** Giro del marcador sobre su eje vertical, en radianes. */
  spin: z.number().finite().default(0),
  /** Desplazamiento radial: acerca o aleja el marcador del observador. */
  depth: z.number().min(0.1).max(10).default(1),
});

export type Transform3d = z.infer<typeof transform3dSchema>;

export const IDENTITY_TRANSFORM: Transform3d = {
  scale: 1,
  roll: 0,
  tilt: 0,
  spin: 0,
  depth: 1,
};
