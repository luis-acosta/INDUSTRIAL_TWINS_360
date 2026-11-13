/**
 * Matemática del radar del minimapa (G04, G05).
 *
 * Está en su propio módulo porque es la parte del minimapa que puede estar
 * mal sin que se note: un cono dibujado con el rumbo sin corregir apunta
 * siempre desviado el mismo ángulo, y sobre un plano de planta eso parece
 * plausible —el cono se mueve al girar la cámara— pero manda al técnico a la
 * pared de enfrente. Separarlo permite comprobarlo con casos concretos en
 * lugar de a ojo sobre una imagen.
 *
 * Convenios, que es donde está toda la dificultad:
 *
 *  - El azimut de la cámara (`yaw`) se mide en radianes desde el centro de la
 *    panorámica, creciendo hacia la derecha del observador.
 *  - `sceneNorthOffsetRad` dice cuánto hay que girar ese azimut para que
 *    apunte al norte geográfico: lo aporta la captura, no el plano.
 *  - `northRad` dice hacia dónde está el norte en la imagen del plano, medido
 *    desde «arriba» de la imagen. Un plano dibujado con el norte a la derecha
 *    tiene `northRad = π/2`.
 *
 * El rumbo que se dibuja es, por tanto, el azimut llevado a geográfico y
 * después a coordenadas de la imagen.
 */

export interface PlanOrientation {
  /** Dirección del norte en la imagen del plano, en radianes desde arriba. */
  readonly northRad: number;
  /** Corrección del azimut de la escena para apuntar al norte geográfico. */
  readonly sceneNorthOffsetRad: number;
}

const TWO_PI = Math.PI * 2;

/** Normaliza a [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Rumbo del cono del radar, en grados desde «arriba» de la imagen del plano.
 *
 * Se devuelve en grados y no en radianes porque es lo que consume el SVG, y
 * convertir en el componente invitaría a hacerlo dos veces.
 */
export function radarBearingDeg(yawRad: number, orientation: PlanOrientation): number {
  const geographic = yawRad + orientation.sceneNorthOffsetRad;
  const onPlan = geographic - orientation.northRad;
  return normalizeDeg((onPlan * 180) / Math.PI);
}

/**
 * Sector circular centrado en el rumbo, con el 0° hacia arriba.
 *
 * El radio se recibe en unidades del `viewBox`, no en píxeles: el cono debe
 * escalar con el minimapa sin recalcular nada.
 */
export function conePath(bearingDeg: number, apertureDeg: number, radius: number): string {
  // Una apertura de 360° no se puede dibujar con un solo arco: los dos
  // extremos coinciden y el arco queda indefinido. Se dibuja el círculo
  // completo con dos semicírculos.
  const aperture = Math.min(Math.max(apertureDeg, 1), 360);

  if (aperture >= 360) {
    return `M0,${-radius} A${radius},${radius} 0 1 1 0,${radius} A${radius},${radius} 0 1 1 0,${-radius} Z`;
  }

  const half = aperture / 2;
  const point = (deg: number): string => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(Math.cos(rad) * radius).toFixed(2)},${(Math.sin(rad) * radius).toFixed(2)}`;
  };

  const largeArc = aperture > 180 ? 1 : 0;
  return `M0,0 L${point(bearingDeg - half)} A${radius},${radius} 0 ${largeArc} 1 ${point(bearingDeg + half)} Z`;
}

/**
 * Apertura del cono a partir del campo de visión real de la cámara.
 *
 * Dibujar una apertura fija —los 60° típicos de los ejemplos— hace que el
 * radar mienta en cuanto el usuario hace zoom: con el campo de visión en 30°
 * el operador está mirando la mitad de lo que el cono sugiere. Se acota por
 * abajo para que un zoom extremo no deje una línea invisible.
 */
export function coneAperture(horizontalFovDeg: number, declaredApertureDeg: number): number {
  if (!Number.isFinite(horizontalFovDeg) || horizontalFovDeg <= 0) return declaredApertureDeg;
  return Math.min(Math.max(horizontalFovDeg, 8), 360);
}

/**
 * Campo de visión horizontal a partir del vertical y la relación de aspecto.
 *
 * La cámara declara el campo vertical, que es lo que usa la proyección en
 * perspectiva; el radar necesita el horizontal, que es más ancho en una
 * ventana apaisada. Usar el vertical dibujaría un cono más estrecho que lo
 * que el operador ve de verdad.
 */
export function horizontalFovDeg(verticalFovDeg: number, aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return verticalFovDeg;
  const halfV = (verticalFovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return (halfH * 360) / Math.PI;
}

/** Igualdad angular con tolerancia, para comparar rumbos. */
export function sameBearing(a: number, b: number, toleranceDeg = 0.001): boolean {
  const diff = Math.abs(normalizeDeg(a) - normalizeDeg(b)) % 360;
  return Math.min(diff, 360 - diff) <= toleranceDeg;
}

export { TWO_PI };
