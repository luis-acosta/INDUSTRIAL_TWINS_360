/**
 * Carga de modelos GLB/glTF (L01).
 *
 * Un modelo de planta no es un archivo cualquiera: puede traer cientos de
 * megas, geometría comprimida con Draco, texturas en KTX2 y nombres de nodo
 * que son los TAG del cliente. Lo que esta capa garantiza:
 *
 * - **El archivo se valida antes de cargarlo.** Un GLB truncado hace que el
 *   cargador lance desde dentro de una promesa que el visor no espera, y la
 *   aplicación se queda con un lienzo en negro sin decir por qué. Aquí se
 *   comprueba la cabecera primero y se devuelve un `Result` con el motivo.
 * - **Los decodificadores se sirven desde el propio paquete**, no desde una
 *   CDN. El recorrido publicado tiene que funcionar en una intranet sin
 *   salida a internet, y un modelo comprimido que sólo carga con red sería un
 *   modelo que no carga en la planta.
 * - **El tamaño se declara antes de empezar.** Cargar 300 MB sin avisar en un
 *   portátil con gráficos integrados agota la memoria y cierra la pestaña.
 */
import { Box3, Vector3, type AnimationClip, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/* ------------------------------------------------------------------ *
 * Validación del archivo
 * ------------------------------------------------------------------ */

/** Cabecera de un GLB binario: «glTF» en ASCII. */
const GLB_MAGIC = 0x46546c67;

export interface ModelFileInfo {
  readonly format: 'glb' | 'gltf';
  readonly version: number;
  readonly byteLength: number;
}

export type ModelFileProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'notAModel' }
  | { readonly kind: 'truncated'; readonly declared: number; readonly actual: number }
  | { readonly kind: 'unsupportedVersion'; readonly version: number };

export type ModelFileCheck =
  | { readonly ok: true; readonly info: ModelFileInfo }
  | { readonly ok: false; readonly problem: ModelFileProblem };

/**
 * Comprueba que el archivo sea un modelo antes de dárselo al cargador.
 *
 * El cargador de three lanza desde dentro de una promesa cuando el archivo
 * está truncado, y en el visor publicado eso deja el lienzo en negro sin
 * explicación. Mirar doce bytes de cabecera evita ese final.
 */
export function inspectModelFile(buffer: ArrayBuffer): ModelFileCheck {
  if (buffer.byteLength === 0) {
    return { ok: false, problem: { kind: 'empty' } };
  }

  // Un .gltf es JSON; un .glb empieza por la cabecera binaria.
  if (buffer.byteLength < 12) {
    return { ok: false, problem: { kind: 'notAModel' } };
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);

  if (magic !== GLB_MAGIC) {
    // Puede ser un glTF en JSON: se acepta si empieza por `{`, dejando que el
    // cargador haga el resto de la validación.
    const first = new Uint8Array(buffer, 0, 1)[0];
    if (first === 0x7b) {
      return { ok: true, info: { format: 'gltf', version: 2, byteLength: buffer.byteLength } };
    }
    return { ok: false, problem: { kind: 'notAModel' } };
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    return { ok: false, problem: { kind: 'unsupportedVersion', version } };
  }

  const declared = view.getUint32(8, true);
  if (declared > buffer.byteLength) {
    return {
      ok: false,
      problem: { kind: 'truncated', declared, actual: buffer.byteLength },
    };
  }

  return { ok: true, info: { format: 'glb', version, byteLength: buffer.byteLength } };
}

/** Mensaje para el usuario, con lo que puede hacer al respecto. */
export function describeModelProblem(problem: ModelFileProblem): string {
  switch (problem.kind) {
    case 'empty':
      return 'El archivo está vacío.';
    case 'notAModel':
      return 'El archivo no es un modelo glTF ni GLB. Exporte el modelo en formato .glb desde su herramienta de CAD.';
    case 'truncated':
      return `El archivo está incompleto: declara ${formatBytes(problem.declared)} y sólo tiene ${formatBytes(problem.actual)}. Vuelva a copiarlo desde el origen.`;
    case 'unsupportedVersion':
      return `El modelo usa la versión ${problem.version} de glTF y esta aplicación admite la 2. Reexpórtelo como glTF 2.0.`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * Advertencia de tamaño
 * ------------------------------------------------------------------ */

/**
 * Umbral a partir del cual conviene avisar antes de cargar.
 *
 * No es un límite: un modelo de planta grande es legítimo y el autor puede
 * saber perfectamente lo que hace. Es el punto en que un portátil con
 * gráficos integrados empieza a sufrir, y eso se dice antes y no después de
 * que se quede sin memoria.
 */
export const LARGE_MODEL_BYTES = 80 * 1024 * 1024;

export function modelSizeWarning(byteLength: number): string | null {
  if (byteLength < LARGE_MODEL_BYTES) return null;
  return (
    `El modelo ocupa ${formatBytes(byteLength)}. En un equipo con gráficos integrados puede ` +
    `tardar en abrirse y moverse con dificultad; el visor bajará la resolución antes que los ` +
    `fotogramas. Considere simplificar la geometría si va a publicarse.`
  );
}

/* ------------------------------------------------------------------ *
 * Carga
 * ------------------------------------------------------------------ */

export interface LoadedModel {
  readonly root: Object3D;
  readonly animations: readonly AnimationClip[];
  readonly bounds: Box3;
  readonly meshCount: number;
  readonly info: ModelFileInfo;
}

export interface LoadModelOptions {
  /**
   * Carpeta de la que se sirven los decodificadores de Draco.
   *
   * Se sirve desde el propio paquete publicado, no desde una CDN: el recorrido
   * tiene que funcionar en una intranet sin salida a internet.
   */
  readonly decoderPath?: string;
  readonly onProgress?: (fraction: number) => void;
}

/** Construye el cargador con los decodificadores en local. */
export function createLoader(decoderPath = './decoders/draco/'): GLTFLoader {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(decoderPath);
  loader.setDRACOLoader(draco);
  return loader;
}

export type LoadModelResult =
  | { readonly ok: true; readonly model: LoadedModel }
  | { readonly ok: false; readonly problem: ModelFileProblem | { readonly kind: 'parse'; readonly message: string } };

/**
 * Carga un modelo desde memoria.
 *
 * Devuelve un resultado en lugar de lanzar porque los dos fallos probables
 * —archivo corrupto y geometría comprimida sin decodificador— tienen remedios
 * distintos que el usuario puede aplicar, y una excepción sin mensaje no le
 * dice cuál.
 */
export async function loadModel(
  buffer: ArrayBuffer,
  options: LoadModelOptions = {},
): Promise<LoadModelResult> {
  const check = inspectModelFile(buffer);
  if (!check.ok) return { ok: false, problem: check.problem };

  const loader = createLoader(options.decoderPath);

  return new Promise<LoadModelResult>((resolve) => {
    loader.parse(
      buffer,
      '',
      (gltf) => {
        const root = gltf.scene;
        let meshCount = 0;
        root.traverse((child) => {
          if ((child as { isMesh?: boolean }).isMesh === true) meshCount += 1;
        });

        resolve({
          ok: true,
          model: {
            root,
            animations: gltf.animations,
            bounds: new Box3().setFromObject(root),
            meshCount,
            info: check.info,
          },
        });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          ok: false,
          problem: {
            kind: 'parse',
            message: /draco/i.test(message)
              ? 'El modelo usa geometría comprimida con Draco y no se encontró el decodificador. Vuelva a publicar el recorrido con esta versión de la aplicación.'
              : `El modelo no se pudo interpretar: ${message}`,
          },
        });
      },
    );
  });
}

/**
 * Centra y escala el modelo a un tamaño manejable.
 *
 * Los modelos de CAD llegan en las unidades más dispares —milímetros, pulgadas,
 * coordenadas de planta con el origen a kilómetros— y uno colocado tal cual
 * aparece fuera de cámara o microscópico. Se normaliza para que la primera
 * vista sea siempre utilizable, **sin tocar el archivo original**: la
 * transformación va en el nodo raíz y se puede deshacer.
 */
export function normalizeModel(root: Object3D, targetSize = 10): { scale: number; offset: Vector3 } {
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  const largest = Math.max(size.x, size.y, size.z);
  // Un modelo degenerado (todo en un punto) no se escala: multiplicar por
  // infinito lo haría desaparecer y el autor no sabría por qué.
  const scale = largest > 1e-6 ? targetSize / largest : 1;

  root.position.sub(center.multiplyScalar(scale));
  root.scale.setScalar(scale);

  return { scale, offset: root.position.clone() };
}
