/**
 * Espacios de coordenadas compartidos entre modelos (L11).
 *
 * El caso que esto resuelve es concreto y frecuente en una planta: el mismo
 * equipo modelado en dos niveles de detalle —la carcasa cerrada y el despiece
 * interior—, o la misma nave en dos fases de obra. El autor quiere que el
 * visitante pueda pasar de uno a otro **sin perder de vista lo que estaba
 * mirando**: si la cámara vuelve a la vista inicial, hay que volver a buscar
 * la pieza, y en un modelo grande eso son varios segundos cada vez.
 *
 * Que dos modelos compartan el espacio no es algo que se pueda deducir del
 * archivo: dos exportaciones de la misma pieza pueden tener orígenes y escalas
 * distintos sin que nada en el `.glb` lo diga. Lo declara el autor, con el
 * campo `coordinateSpaceId` de la escena, y este módulo es la regla de cuándo
 * se aplica.
 *
 * El campo existía desde la etapa 08 y no lo leía nadie: se podía declarar y
 * la vista se reiniciaba igual.
 */
import type { Scene } from './scene';

/**
 * `true` si pasar de una escena a otra puede conservar la vista.
 *
 * Las dos condiciones son necesarias y ninguna es obvia:
 *
 * - **Las dos son escenas de modelo.** Una vista de modelo —posición, objetivo
 *   y campo— no significa nada en una panorámica, donde la cámara está en el
 *   centro de una esfera.
 * - **Declaran el mismo espacio, y no nulo.** Nulo significa «no lo sé», y
 *   tratar dos «no lo sé» como iguales conservaría la vista entre dos modelos
 *   sin relación: la cámara acabaría dentro de una pared o a cien metros del
 *   equipo, que es peor que reiniciar la vista.
 */
export function sharesCoordinateSpace(from: Scene, to: Scene): boolean {
  if (from.kind !== 'model' || to.kind !== 'model') return false;

  const fromSpace = from.model?.coordinateSpaceId ?? null;
  const toSpace = to.model?.coordinateSpaceId ?? null;
  if (fromSpace === null || toSpace === null) return false;

  return fromSpace === toSpace;
}

/**
 * Escenas que comparten espacio con una dada, sin contarla a ella.
 *
 * El editor la usa para decir «esta vista se conservará al pasar a…», que es
 * la única forma de que el autor compruebe que declaró bien el espacio: un
 * identificador mal escrito no da ningún error, simplemente no agrupa.
 */
export function scenesInSameSpace(scene: Scene, scenes: readonly Scene[]): readonly Scene[] {
  return scenes.filter((candidate) => candidate.id !== scene.id && sharesCoordinateSpace(scene, candidate));
}

/**
 * Vista que debe usarse al entrar en una escena de modelo.
 *
 * `carried` es la última vista del espacio al que pertenece la escena, si la
 * hay. Cuando existe, manda sobre la vista guardada de la escena: el visitante
 * acaba de colocar la cámara donde le interesa, y devolverle a la vista que el
 * autor guardó hace meses deshace su trabajo.
 *
 * Devuelve `undefined` —y no la vista inicial de la escena— cuando no hay nada
 * que conservar: así quien llama distingue «usa la tuya» de «usa ésta», y la
 * escena sigue decidiendo si encuadra el modelo entero por no tener vista
 * guardada.
 */
export function viewForEntering<V>(
  scene: Scene,
  carried: { readonly spaceId: string; readonly view: V } | null,
): V | undefined {
  if (scene.kind !== 'model') return undefined;
  const space = scene.model?.coordinateSpaceId ?? null;
  if (space === null || carried === null) return undefined;
  return carried.spaceId === space ? carried.view : undefined;
}
