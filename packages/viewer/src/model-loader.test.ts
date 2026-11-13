/**
 * Pruebas de la carga de modelos GLB/glTF (L01).
 *
 * El fallo que estas pruebas persiguen es el silencioso: un archivo truncado o
 * que no es un modelo hace que el cargador de three lance desde dentro de una
 * promesa, y el visor se queda con un lienzo en negro sin decir por qué. Lo que
 * se comprueba es que cada forma de archivo malo produzca un motivo concreto y
 * un remedio que el usuario pueda aplicar.
 */
import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import {
  describeModelProblem,
  inspectModelFile,
  LARGE_MODEL_BYTES,
  modelSizeWarning,
  normalizeModel,
  type ModelFileProblem,
} from './model-loader';

/** Construye una cabecera GLB con los campos que se le indiquen. */
function glbHeader(options: {
  readonly magic?: number;
  readonly version?: number;
  readonly declaredLength?: number;
  readonly actualLength?: number;
}): ArrayBuffer {
  const actual = options.actualLength ?? 64;
  const buffer = new ArrayBuffer(actual);
  if (actual >= 12) {
    const view = new DataView(buffer);
    view.setUint32(0, options.magic ?? 0x46546c67, true);
    view.setUint32(4, options.version ?? 2, true);
    view.setUint32(8, options.declaredLength ?? actual, true);
  }
  return buffer;
}

/** Un .gltf es JSON: empieza por `{`. */
function gltfJson(): ArrayBuffer {
  const text = '{"asset":{"version":"2.0"},"scenes":[]}';
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/* ------------------------------------------------------------------ *
 * Inspección
 * ------------------------------------------------------------------ */

describe('inspectModelFile', () => {
  it('TEST-MLD-001 acepta un GLB bien formado', () => {
    const check = inspectModelFile(glbHeader({}));
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    expect(check.info.format).toBe('glb');
    expect(check.info.version).toBe(2);
    expect(check.info.byteLength).toBe(64);
  });

  it('TEST-MLD-002 acepta un glTF en JSON', () => {
    const check = inspectModelFile(gltfJson());
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.info.format).toBe('gltf');
  });

  it('TEST-MLD-003 rechaza un archivo vacío', () => {
    const check = inspectModelFile(new ArrayBuffer(0));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem.kind).toBe('empty');
  });

  it('TEST-MLD-004 rechaza un archivo que no es un modelo', () => {
    // Un PDF arrastrado por error al cuadro del modelo.
    const pdf = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\nmás cosas').buffer as ArrayBuffer;
    const check = inspectModelFile(pdf);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem.kind).toBe('notAModel');
  });

  it('TEST-MLD-005 rechaza un archivo demasiado corto para tener cabecera', () => {
    const check = inspectModelFile(new ArrayBuffer(4));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem.kind).toBe('notAModel');
  });

  it('TEST-MLD-006 detecta un GLB truncado y dice cuánto falta', () => {
    // Es el caso real: el archivo se copió de un recurso de red que se cortó.
    // Sin esta comprobación, el cargador lanza desde dentro de una promesa y
    // el lienzo se queda en negro.
    const check = inspectModelFile(glbHeader({ declaredLength: 5_000_000, actualLength: 1024 }));

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem.kind).toBe('truncated');
    if (check.problem.kind !== 'truncated') return;
    expect(check.problem.declared).toBe(5_000_000);
    expect(check.problem.actual).toBe(1024);
  });

  it('TEST-MLD-007 un archivo mayor que lo declarado se acepta', () => {
    // Algunos exportadores rellenan al final; el modelo está completo.
    expect(inspectModelFile(glbHeader({ declaredLength: 32, actualLength: 64 })).ok).toBe(true);
  });

  it('TEST-MLD-008 rechaza una versión de glTF que no se admite', () => {
    const check = inspectModelFile(glbHeader({ version: 1 }));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem.kind).toBe('unsupportedVersion');
  });
});

/* ------------------------------------------------------------------ *
 * Mensajes
 * ------------------------------------------------------------------ */

describe('describeModelProblem', () => {
  it('TEST-MLD-009 cada motivo lleva un remedio que el usuario puede aplicar', () => {
    const problems: readonly ModelFileProblem[] = [
      { kind: 'empty' },
      { kind: 'notAModel' },
      { kind: 'truncated', declared: 5_000_000, actual: 1024 },
      { kind: 'unsupportedVersion', version: 1 },
    ];

    for (const problem of problems) {
      const message = describeModelProblem(problem);
      expect(message.length, problem.kind).toBeGreaterThan(10);
      expect(message.endsWith('.'), problem.kind).toBe(true);
    }
  });

  it('TEST-MLD-010 el archivo truncado dice los dos tamaños en unidades legibles', () => {
    const message = describeModelProblem({ kind: 'truncated', declared: 5_000_000, actual: 1024 });
    expect(message).toContain('4.8 MB');
    expect(message).toContain('1 kB');
    expect(message).toContain('Vuelva a copiarlo');
  });

  it('TEST-MLD-011 el que no es un modelo dice qué exportar', () => {
    expect(describeModelProblem({ kind: 'notAModel' })).toContain('.glb');
  });

  it('TEST-MLD-012 la versión no admitida dice cuál se admite', () => {
    const message = describeModelProblem({ kind: 'unsupportedVersion', version: 1 });
    expect(message).toContain('glTF 2.0');
  });
});

/* ------------------------------------------------------------------ *
 * Aviso de tamaño
 * ------------------------------------------------------------------ */

describe('modelSizeWarning', () => {
  it('TEST-MLD-013 no avisa de un modelo pequeño', () => {
    expect(modelSizeWarning(5 * 1024 * 1024)).toBeNull();
  });

  it('TEST-MLD-014 avisa de un modelo grande sin impedirlo', () => {
    // No es un límite: un modelo de planta grande es legítimo y el autor puede
    // saber perfectamente lo que hace.
    const warning = modelSizeWarning(LARGE_MODEL_BYTES + 1);
    expect(warning).not.toBeNull();
    expect(warning).toContain('gráficos integrados');
    expect(warning).toContain('resolución antes que los fotogramas');
  });

  it('TEST-MLD-015 el aviso dice el tamaño real', () => {
    expect(modelSizeWarning(300 * 1024 * 1024)).toContain('300.0 MB');
  });
});

/* ------------------------------------------------------------------ *
 * Normalización
 * ------------------------------------------------------------------ */

/** Modelo con una caja de las dimensiones dadas, centrada donde se indique. */
function modelWithBox(size: Vector3, center: Vector3): Object3D {
  const root = new Object3D();
  const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z), new MeshBasicMaterial());
  mesh.position.copy(center);
  root.add(mesh);
  root.updateMatrixWorld(true);
  return root;
}

describe('normalizeModel', () => {
  it('TEST-MLD-016 lleva un modelo en milímetros a un tamaño manejable', () => {
    // Un CAD exportado en milímetros llega con 40.000 unidades de lado; tal
    // cual, la cámara queda dentro de una pared.
    const root = modelWithBox(new Vector3(40_000, 10_000, 20_000), new Vector3(0, 0, 0));
    const { scale } = normalizeModel(root, 10);

    root.updateMatrixWorld(true);
    const size = new Box3().setFromObject(root).getSize(new Vector3());

    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(10, 4);
    expect(scale).toBeCloseTo(10 / 40_000, 10);
  });

  it('TEST-MLD-017 centra un modelo cuyo origen está lejos', () => {
    // Las coordenadas de planta sitúan el origen a kilómetros; sin centrar, el
    // modelo aparece fuera de cámara y parece que no cargó.
    const root = modelWithBox(new Vector3(2, 2, 2), new Vector3(5000, 0, -3000));
    normalizeModel(root, 10);

    root.updateMatrixWorld(true);
    const center = new Box3().setFromObject(root).getCenter(new Vector3());

    expect(center.length()).toBeLessThan(0.001);
  });

  it('TEST-MLD-018 un modelo ya del tamaño adecuado apenas se toca', () => {
    const root = modelWithBox(new Vector3(10, 4, 6), new Vector3(0, 0, 0));
    const { scale } = normalizeModel(root, 10);
    expect(scale).toBeCloseTo(1, 6);
  });

  it('TEST-MLD-019 un modelo degenerado no se multiplica por infinito', () => {
    // Un GLB con toda la geometría en un punto daría escala infinita y el
    // modelo desaparecería sin que el autor supiera por qué.
    const root = new Object3D();
    const { scale } = normalizeModel(root, 10);

    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBe(1);
  });

  it('TEST-MLD-020 la transformación va en el nodo raíz y se puede deshacer', () => {
    // No se toca el archivo original: la normalización es una vista, no una
    // modificación del modelo del cliente.
    const root = modelWithBox(new Vector3(100, 100, 100), new Vector3(50, 0, 0));
    const hijoAntes = (root.children[0] as Mesh).position.clone();

    normalizeModel(root, 10);

    expect((root.children[0] as Mesh).position.equals(hijoAntes)).toBe(true);
    expect(root.scale.x).not.toBe(1);

    root.position.set(0, 0, 0);
    root.scale.setScalar(1);
    root.updateMatrixWorld(true);
    const size = new Box3().setFromObject(root).getSize(new Vector3());
    expect(size.x).toBeCloseTo(100, 4);
  });
});
