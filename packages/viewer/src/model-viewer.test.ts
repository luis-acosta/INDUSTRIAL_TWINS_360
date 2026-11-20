/**
 * Pruebas del visor de modelos 3D (etapa 08: L02–L04, L08–L12, V03).
 *
 * Todo lo que se comprueba aquí es aritmética y estado: posición de cámara,
 * límites, degradación de resolución, selección de malla, visibilidad y
 * animaciones. Nada necesita GPU, y por eso puede comprobarse de verdad en
 * lugar de darse por bueno.
 *
 * Lo que estas pruebas vigilan, más allá de que las fórmulas cuadren, es que
 * el observador **no se teletransporte**: cambiar de modo, tocar los límites o
 * cambiar de modelo compatible tiene que dejarlo donde estaba. Un salto en una
 * inspección hace perder la referencia de dónde se está mirando, y recuperarla
 * cuesta más que el movimiento que se ahorró.
 */
import { describe, expect, it } from 'vitest';
import {
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  Box3,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import {
  AdaptiveResolution,
  collectMeshNames,
  ModelCameraController,
  pickMesh,
  playAnimation,
  setNodeVisibility,
  type ModelCameraState,
} from './model-viewer';
import type { CameraBounds } from '@it360/domain';
import { orbitForView } from './transition';

const BOUNDS: CameraBounds = {
  minDistance: 1,
  maxDistance: 100,
  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI - 0.1,
  eyeHeight: 1.7,
  moveSpeed: 4,
  collide: false,
};

const START: ModelCameraState = {
  target: new Vector3(0, 0, 0),
  distance: 10,
  azimuth: 0,
  polar: Math.PI / 2,
  fov: 60,
};

const near = (a: number, b: number, tolerance = 1e-6): void => {
  expect(Math.abs(a - b)).toBeLessThan(tolerance);
};

/* ------------------------------------------------------------------ *
 * Resolución adaptativa (V03)
 * ------------------------------------------------------------------ */

describe('AdaptiveResolution', () => {
  it('TEST-M3D-001 arranca a la resolución máxima y sin degradar', () => {
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    const state = adaptive.sample(16, 1000);

    expect(state.pixelRatio).toBe(2);
    expect(state.degraded).toBe(false);
  });

  it('TEST-M3D-002 baja la resolución cuando no se sostiene la tasa', () => {
    // Un modelo que se mueve a 50 fps algo borroso es utilizable para
    // inspección; uno nítido a 6 fps no lo es.
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    let state = adaptive.sample(16, 0);

    // 10 fps durante más de medio segundo.
    for (let i = 1; i <= 20; i += 1) state = adaptive.sample(100, i * 100);

    expect(state.pixelRatio).toBeLessThan(2);
    expect(state.degraded).toBe(true);
    expect(state.measuredFps).toBeLessThan(20);
  });

  it('TEST-M3D-003 nunca baja del mínimo declarado', () => {
    const adaptive = new AdaptiveResolution(60, 0.75, 2);
    let state = adaptive.sample(16, 0);
    for (let i = 1; i <= 400; i += 1) state = adaptive.sample(250, i * 600);

    expect(state.pixelRatio).toBeGreaterThanOrEqual(0.75);
  });

  it('TEST-M3D-004 no sube hasta que la holgura se sostiene', () => {
    // Subir en cuanto hay un fotograma rápido produce oscilación: sube, se
    // atraganta, baja, y el usuario ve el modelo parpadear de nitidez.
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    adaptive.sample(16, 0);
    for (let i = 1; i <= 20; i += 1) adaptive.sample(100, i * 100);

    const degradado = adaptive.sample(100, 2100).pixelRatio;

    // Un segundo de holgura no basta.
    let state = adaptive.sample(5, 2200);
    for (let i = 1; i <= 10; i += 1) state = adaptive.sample(5, 2200 + i * 50);
    expect(state.pixelRatio).toBe(degradado);

    // Con más de tres segundos, sí sube.
    for (let i = 1; i <= 10; i += 1) state = adaptive.sample(5, 6000 + i * 50);
    expect(state.pixelRatio).toBeGreaterThan(degradado);
  });

  it('TEST-M3D-005 no sube por encima del máximo', () => {
    const adaptive = new AdaptiveResolution(30, 0.5, 1.5);
    let state = adaptive.sample(16, 0);
    for (let i = 1; i <= 200; i += 1) state = adaptive.sample(4, i * 4000);

    expect(state.pixelRatio).toBeLessThanOrEqual(1.5);
  });

  it('TEST-M3D-006 reset vuelve al máximo', () => {
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    adaptive.sample(16, 0);
    for (let i = 1; i <= 20; i += 1) adaptive.sample(100, i * 100);
    expect(adaptive.sample(100, 3000).pixelRatio).toBeLessThan(2);

    adaptive.reset();
    expect(adaptive.sample(16, 4000).pixelRatio).toBe(2);
  });

  it('TEST-M3D-007 un fotograma de duración cero no desvirtúa la medida', () => {
    // `deltaMs` puede llegar a cero en el primer fotograma o si el reloj no
    // avanza; dividir por él daría una tasa infinita y la resolución subiría
    // justo cuando no hay datos para decidirlo.
    const adaptive = new AdaptiveResolution(60, 0.5, 2);
    const state = adaptive.sample(0, 100);
    expect(Number.isFinite(state.measuredFps)).toBe(true);
    expect(state.measuredFps).toBe(60);
  });
});

/* ------------------------------------------------------------------ *
 * Cámara: límites (L08)
 * ------------------------------------------------------------------ */

describe('ModelCameraController — límites', () => {
  it('TEST-M3D-008 respeta la distancia mínima y máxima', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);

    camera.setState({ distance: 0.01 });
    expect(camera.getState().distance).toBe(BOUNDS.minDistance);

    camera.setState({ distance: 5000 });
    expect(camera.getState().distance).toBe(BOUNDS.maxDistance);
  });

  it('TEST-M3D-009 impide que la cámara cruce los polos', () => {
    // Pasarse del cenit invierte la imagen y el usuario pierde la referencia
    // de dónde está el suelo.
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);

    camera.rotate(0, 10_000, 600);
    expect(camera.getState().polar).toBeGreaterThanOrEqual(BOUNDS.minPolarAngle);

    camera.rotate(0, -10_000, 600);
    expect(camera.getState().polar).toBeLessThanOrEqual(BOUNDS.maxPolarAngle);
  });

  it('TEST-M3D-010 el azimut gira sin tope', () => {
    // Dar la vuelta completa alrededor de un equipo es lo normal; un tope ahí
    // obligaría a desandar el giro.
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    camera.rotate(-10_000, 0, 600);
    expect(Math.abs(camera.getState().azimuth)).toBeGreaterThan(Math.PI * 2);
  });

  it('TEST-M3D-011 cambiar los límites recoloca lo que queda fuera', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    camera.setState({ distance: 50 });

    camera.setBounds({ ...BOUNDS, maxDistance: 20 });
    expect(camera.getState().distance).toBe(20);
  });

  it('TEST-M3D-012 el campo de visión se mantiene en un rango usable', () => {
    const camera = new ModelCameraController(START, 'firstPerson', BOUNDS);

    camera.setState({ fov: 1 });
    expect(camera.getState().fov).toBeGreaterThanOrEqual(10);

    camera.setState({ fov: 300 });
    expect(camera.getState().fov).toBeLessThanOrEqual(120);
  });

  it('TEST-M3D-013 un estado inicial fuera de límites se corrige al construir', () => {
    const camera = new ModelCameraController(
      { ...START, distance: 1000, polar: -5, fov: 500 },
      'orbit',
      BOUNDS,
    );
    const state = camera.getState();

    expect(state.distance).toBe(BOUNDS.maxDistance);
    expect(state.polar).toBe(BOUNDS.minPolarAngle);
    expect(state.fov).toBe(120);
  });
});

/* ------------------------------------------------------------------ *
 * Cámara: geometría (L02)
 * ------------------------------------------------------------------ */

describe('ModelCameraController — geometría orbital', () => {
  it('TEST-M3D-014 la cámara está a la distancia declarada del objetivo', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const position = camera.computePosition();
    near(position.distanceTo(camera.getState().target), 10, 1e-5);
  });

  it('TEST-M3D-015 en orbital siempre mira al objetivo', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    camera.rotate(120, -40, 800);
    expect(camera.computeLookAt().equals(camera.getState().target)).toBe(true);
  });

  it('TEST-M3D-016 el azimut gira alrededor del eje vertical', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const inicio = camera.computePosition();

    camera.setState({ azimuth: Math.PI });
    const opuesto = camera.computePosition();

    // Media vuelta: misma altura, posición horizontal opuesta.
    near(inicio.y, opuesto.y, 1e-6);
    near(inicio.x, -opuesto.x, 1e-6);
    near(inicio.z, -opuesto.z, 1e-6);
  });

  it('TEST-M3D-017 acercar en orbital reduce la distancia, no el campo de visión', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const fovAntes = camera.getState().fov;

    camera.zoom(0.5);
    expect(camera.getState().distance).toBe(5);
    expect(camera.getState().fov).toBe(fovAntes);
  });

  it('TEST-M3D-018 acercar en primera persona cambia el campo de visión', () => {
    // En primera persona, acercarse moviendo la cámara atravesaría la pared.
    const camera = new ModelCameraController(START, 'firstPerson', BOUNDS);
    const distanciaAntes = camera.getState().distance;

    camera.zoom(0.5);
    expect(camera.getState().fov).toBe(30);
    expect(camera.getState().distance).toBe(distanciaAntes);
  });

  it('TEST-M3D-019 el desplazamiento lateral mueve el objetivo, no gira la cámara', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const azimutAntes = camera.getState().azimuth;

    camera.pan(100, 0, 800);
    expect(camera.getState().target.equals(new Vector3(0, 0, 0))).toBe(false);
    expect(camera.getState().azimuth).toBe(azimutAntes);
  });

  it('TEST-M3D-020 el desplazamiento lateral escala con la distancia', () => {
    // Arrastrar lo mismo de cerca y de lejos debe recorrer la misma fracción
    // de pantalla, no la misma distancia del modelo.
    const cerca = new ModelCameraController({ ...START, distance: 2 }, 'orbit', BOUNDS);
    const lejos = new ModelCameraController({ ...START, distance: 50 }, 'orbit', BOUNDS);

    cerca.pan(100, 0, 800);
    lejos.pan(100, 0, 800);

    const recorridoCerca = cerca.getState().target.length();
    const recorridoLejos = lejos.getState().target.length();
    expect(recorridoLejos).toBeGreaterThan(recorridoCerca * 10);
  });
});

/* ------------------------------------------------------------------ *
 * Cámara: modos (L03, L04, L11)
 * ------------------------------------------------------------------ */

describe('ModelCameraController — modos', () => {
  it('TEST-M3D-021 cambiar de modo no teletransporta al observador', () => {
    // Es el requisito L11 llevado a los modos: un salto en una inspección hace
    // perder la referencia de dónde se está mirando.
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    camera.rotate(80, -30, 800);
    const antes = camera.getState();

    camera.setMode('firstPerson');
    const despues = camera.getState();

    expect(despues.target.equals(antes.target)).toBe(true);
    expect(despues.azimuth).toBe(antes.azimuth);
    expect(despues.polar).toBe(antes.polar);
    expect(despues.distance).toBe(antes.distance);
  });

  it('TEST-M3D-022 en primera persona la cámara está en el objetivo', () => {
    const camera = new ModelCameraController(START, 'firstPerson', BOUNDS);
    expect(camera.computePosition().equals(camera.getState().target)).toBe(true);
  });

  it('TEST-M3D-023 en primera persona mira hacia delante, no hacia el objetivo', () => {
    const camera = new ModelCameraController(START, 'firstPerson', BOUNDS);
    const lookAt = camera.computeLookAt();

    expect(lookAt.equals(camera.getState().target)).toBe(false);
    near(lookAt.distanceTo(camera.getState().target), 1, 1e-6);
  });

  it('TEST-M3D-024 caminar en primera persona mantiene la altura de los ojos', () => {
    // Un observador que puede volar no transmite la escala del espacio, que es
    // la razón de usar este modo en una inspección.
    const camera = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: 0.6 },
      'firstPerson',
      BOUNDS,
    );

    camera.move(1, 0, 1);
    expect(camera.getState().target.y).toBe(BOUNDS.eyeHeight);

    camera.move(-3, 2, 1);
    expect(camera.getState().target.y).toBe(BOUNDS.eyeHeight);
  });

  it('TEST-M3D-025 en Fly Over sí se gana o se pierde altura', () => {
    const camera = new ModelCameraController(
      { ...START, target: new Vector3(0, 5, 0), polar: 0.5 },
      'flyOver',
      BOUNDS,
    );

    camera.move(1, 0, 1);
    expect(camera.getState().target.y).toBeGreaterThan(5);
  });

  it('TEST-M3D-026 avanzar recorre la velocidad declarada por segundo', () => {
    const camera = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: Math.PI / 2 },
      'firstPerson',
      BOUNDS,
    );

    camera.move(1, 0, 1);
    near(camera.getState().target.length() - BOUNDS.eyeHeight, 0, 10);
    // El recorrido horizontal es la velocidad por el tiempo.
    const horizontal = Math.hypot(camera.getState().target.x, camera.getState().target.z);
    near(horizontal, BOUNDS.moveSpeed, 1e-5);
  });

  it('TEST-M3D-027 medio segundo recorre la mitad', () => {
    const camera = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: Math.PI / 2 },
      'firstPerson',
      BOUNDS,
    );
    camera.move(1, 0, 0.5);
    const horizontal = Math.hypot(camera.getState().target.x, camera.getState().target.z);
    near(horizontal, BOUNDS.moveSpeed / 2, 1e-5);
  });

  it('TEST-M3D-028 caminar mirando al suelo sigue avanzando', () => {
    // Mirar un rodamiento a los pies y pulsar adelante tiene que avanzar. Si
    // la dirección horizontal se anulara al mirar a plomo, el observador se
    // quedaría clavado sin entender por qué.
    const camera = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: BOUNDS.maxPolarAngle },
      'firstPerson',
      BOUNDS,
    );

    camera.move(1, 0, 1);
    const horizontal = Math.hypot(camera.getState().target.x, camera.getState().target.z);
    expect(horizontal).toBeGreaterThan(0.1);
  });

  it('TEST-M3D-029 el desplazamiento lateral es perpendicular al avance', () => {
    const adelante = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: Math.PI / 2 },
      'firstPerson',
      BOUNDS,
    );
    const lado = new ModelCameraController(
      { ...START, target: new Vector3(0, BOUNDS.eyeHeight, 0), polar: Math.PI / 2 },
      'firstPerson',
      BOUNDS,
    );

    adelante.move(1, 0, 1);
    lado.move(0, 1, 1);

    const a = adelante.getState().target.clone().setY(0);
    const b = lado.getState().target.clone().setY(0);
    near(a.dot(b), 0, 1e-5);
  });
});

/* ------------------------------------------------------------------ *
 * Encuadre (L08)
 * ------------------------------------------------------------------ */

describe('frameObject', () => {
  it('TEST-M3D-030 centra la cámara en el objeto', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const box = new Box3(new Vector3(10, 0, 10), new Vector3(14, 4, 14));

    camera.frameObject(box, 60);
    expect(camera.getState().target.equals(new Vector3(12, 2, 12))).toBe(true);
  });

  it('TEST-M3D-031 deja margen: el objeto no toca los bordes', () => {
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    const box = new Box3(new Vector3(-5, -5, -5), new Vector3(5, 5, 5));

    camera.frameObject(box, 60);
    // Distancia justa para un radio de 5 con 60° de FOV: 5/tan(30°) ≈ 8,66.
    // Con el 20 % de margen, algo más de 10.
    expect(camera.getState().distance).toBeGreaterThan(8.66);
    near(camera.getState().distance, 10.39, 0.05);
  });

  it('TEST-M3D-032 un objeto mayor se encuadra desde más lejos', () => {
    const pequeno = new ModelCameraController(START, 'orbit', BOUNDS);
    const grande = new ModelCameraController(START, 'orbit', BOUNDS);

    pequeno.frameObject(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), 60);
    grande.frameObject(new Box3(new Vector3(-10, -10, -10), new Vector3(10, 10, 10)), 60);

    expect(grande.getState().distance).toBeGreaterThan(pequeno.getState().distance * 5);
  });

  it('TEST-M3D-033 el encuadre respeta la distancia máxima', () => {
    // Un modelo de planta entera pide una distancia enorme; si los límites de
    // la escena la acotan, el encuadre no puede saltárselos.
    const camera = new ModelCameraController(START, 'orbit', BOUNDS);
    camera.frameObject(new Box3(new Vector3(-500, -500, -500), new Vector3(500, 500, 500)), 60);
    expect(camera.getState().distance).toBe(BOUNDS.maxDistance);
  });
});

/* ------------------------------------------------------------------ *
 * Selección de malla (L06, L07)
 * ------------------------------------------------------------------ */

/** Escena con un cubo de 2×2×2 centrado en el origen. */
function sceneWithCube(name = 'BOMBA-P101'): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  mesh.name = name;
  scene.add(mesh);

  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  return { scene, camera };
}

describe('pickMesh', () => {
  it('TEST-M3D-034 encuentra la malla bajo el puntero y la nombra', () => {
    const { scene, camera } = sceneWithCube();
    const pick = pickMesh(scene, camera, 0, 0);

    expect(pick).not.toBeNull();
    expect(pick?.nodeName).toBe('BOMBA-P101');
  });

  it('TEST-M3D-035 devuelve el punto de impacto en coordenadas del modelo', () => {
    const { scene, camera } = sceneWithCube();
    const pick = pickMesh(scene, camera, 0, 0);

    // La cara frontal del cubo está en z = 1.
    near(pick?.point.z ?? 0, 1, 1e-5);
  });

  it('TEST-M3D-036 devuelve la normal de la superficie, en espacio de mundo', () => {
    // Es lo que necesita un marcador adherido para orientarse contra la pieza
    // en vez de quedar flotando atravesado.
    const { scene, camera } = sceneWithCube();
    const pick = pickMesh(scene, camera, 0, 0);

    near(pick?.normal.z ?? 0, 1, 1e-5);
    near(pick?.normal.length() ?? 0, 1, 1e-5);
  });

  it('TEST-M3D-037 la normal sigue a la malla cuando está girada', () => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    mesh.name = 'GIRADA';
    mesh.rotation.y = Math.PI / 2;
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const pick = pickMesh(scene, camera, 0, 0);
    // Girar el cubo 90° no cambia que la cara que mira a la cámara apunta a +Z.
    near(pick?.normal.z ?? 0, 1, 1e-5);
  });

  it('TEST-M3D-038 no devuelve nada si el puntero no da a ninguna malla', () => {
    const { scene, camera } = sceneWithCube();
    expect(pickMesh(scene, camera, 0.99, 0.99)).toBeNull();
  });

  it('TEST-M3D-039 ignora las mallas ocultas', () => {
    // Ocultar una tapa para ver el interior y que el marcador se siguiera
    // clavando en la tapa invisible sería desconcertante.
    const { scene, camera } = sceneWithCube();
    const mesh = scene.children[0];
    if (mesh !== undefined) mesh.visible = false;

    expect(pickMesh(scene, camera, 0, 0)).toBeNull();
  });

  it('TEST-M3D-040 elige la malla más cercana cuando hay varias alineadas', () => {
    const scene = new Scene();
    const atras = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    atras.name = 'ATRAS';
    atras.position.z = -5;
    const delante = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    delante.name = 'DELANTE';
    scene.add(atras, delante);
    scene.updateMatrixWorld(true);

    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    expect(pickMesh(scene, camera, 0, 0)?.nodeName).toBe('DELANTE');
  });
});

/* ------------------------------------------------------------------ *
 * Visibilidad por nodo (L12)
 * ------------------------------------------------------------------ */

function plant(): Object3D {
  const root = new Object3D();
  root.name = 'PLANTA';

  for (const name of ['BOMBA-P101', 'BOMBA-P102', 'TUBERIA-10', 'CARCASA']) {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}

describe('setNodeVisibility', () => {
  it('TEST-M3D-041 oculta los nodos nombrados y dice cuántos tocó', () => {
    const root = plant();
    expect(setNodeVisibility(root, ['BOMBA-P101', 'CARCASA'], false)).toBe(2);

    expect(root.getObjectByName('BOMBA-P101')?.visible).toBe(false);
    expect(root.getObjectByName('CARCASA')?.visible).toBe(false);
    expect(root.getObjectByName('BOMBA-P102')?.visible).toBe(true);
  });

  it('TEST-M3D-042 volver a mostrarlos los restaura', () => {
    const root = plant();
    setNodeVisibility(root, ['CARCASA'], false);
    expect(setNodeVisibility(root, ['CARCASA'], true)).toBe(1);
    expect(root.getObjectByName('CARCASA')?.visible).toBe(true);
  });

  it('TEST-M3D-043 un nombre que no existe no afecta a nada', () => {
    // Un proyecto puede nombrar una pieza que el modelo perdió al
    // reexportarse; eso no debe impedir ver el resto.
    const root = plant();
    expect(setNodeVisibility(root, ['NO-EXISTE'], false)).toBe(0);
    expect(root.children.every((child) => child.visible)).toBe(true);
  });

  it('TEST-M3D-044 una lista vacía no cambia nada', () => {
    const root = plant();
    expect(setNodeVisibility(root, [], false)).toBe(0);
  });
});

describe('collectMeshNames', () => {
  it('TEST-M3D-045 lista las mallas en orden estable y natural', () => {
    const root = new Object3D();
    for (const name of ['TUBERIA-10', 'TUBERIA-2', 'BOMBA-P101']) {
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
      mesh.name = name;
      root.add(mesh);
    }

    // Orden natural: TUBERIA-2 antes que TUBERIA-10, no al revés.
    expect(collectMeshNames(root)).toEqual(['BOMBA-P101', 'TUBERIA-2', 'TUBERIA-10']);
  });

  it('TEST-M3D-046 no repite nombres ni incluye lo que no es malla', () => {
    const root = new Object3D();
    const grupo = new Object3D();
    grupo.name = 'GRUPO';
    root.add(grupo);

    for (let i = 0; i < 2; i += 1) {
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
      mesh.name = 'REPETIDA';
      grupo.add(mesh);
    }

    expect(collectMeshNames(root)).toEqual(['REPETIDA']);
  });

  it('TEST-M3D-047 ignora las mallas sin nombre', () => {
    // Un GLB exportado sin nombres no debe llenar la lista de componentes de
    // entradas en blanco imposibles de distinguir.
    const root = new Object3D();
    root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    expect(collectMeshNames(root)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Animaciones (L10)
 * ------------------------------------------------------------------ */

function mixerWithClip(name: string): { mixer: AnimationMixer; clips: AnimationClip[] } {
  const root = new Object3D();
  root.name = 'RAIZ';

  const track = new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 0, 1, 0]);
  const clip = new AnimationClip(name, 1, [track]);

  return { mixer: new AnimationMixer(root), clips: [clip] };
}

describe('playAnimation', () => {
  it('TEST-M3D-048 reproduce la animación por su nombre', () => {
    const { mixer, clips } = mixerWithClip('APERTURA-VALVULA');
    const action = playAnimation(mixer, clips, 'APERTURA-VALVULA', false);

    expect(action).not.toBeNull();
    expect(action?.isRunning()).toBe(true);
  });

  it('TEST-M3D-049 devuelve null si la animación no existe, en lugar de lanzar', () => {
    // Un proyecto puede referirse a una animación que el modelo perdió al
    // reexportarse, y eso no debe impedir ver el modelo.
    const { mixer, clips } = mixerWithClip('APERTURA-VALVULA');
    expect(playAnimation(mixer, clips, 'NO-EXISTE', false)).toBeNull();
  });

  it('TEST-M3D-050 en bucle repite y sin bucle se detiene al final', () => {
    const { mixer, clips } = mixerWithClip('GIRO');

    const bucle = playAnimation(mixer, clips, 'GIRO', true);
    expect(bucle?.repetitions).toBe(Infinity);
    expect(bucle?.clampWhenFinished).toBe(false);

    const unaVez = playAnimation(mixer, clips, 'GIRO', false);
    expect(unaVez?.repetitions).toBe(1);
    // Se queda en el último fotograma: una válvula que termina de abrirse debe
    // quedarse abierta, no volver de golpe a cerrada.
    expect(unaVez?.clampWhenFinished).toBe(true);
  });

  it('TEST-M3D-051 relanzar la misma animación la reinicia', () => {
    const { mixer, clips } = mixerWithClip('GIRO');
    const primera = playAnimation(mixer, clips, 'GIRO', false);
    mixer.update(0.5);
    expect(primera?.time).toBeGreaterThan(0);

    playAnimation(mixer, clips, 'GIRO', false);
    expect(primera?.time).toBe(0);
  });
});

describe('cámara de la geometría durante una transición (C10)', () => {
  it('la vista traducida deja la cámara donde la transición apunta', () => {
    // TEST-MVC-C10-001: comprueba la composición completa sin WebGL, que es lo
    // que de verdad ocurre en el visor: la transición calcula una vista de
    // panorámica, se traduce a órbita y se aplica al mando del modelo.
    const controller = new ModelCameraController(
      { target: new Vector3(0, 1, 0), distance: 4, azimuth: 0, polar: Math.PI / 2, fov: 60 },
      'orbit',
      BOUNDS,
    );

    controller.setState(
      orbitForView({ yaw: 1.2, pitch: 0.3, fov: 70 }, controller.getState()),
    );
    const state = controller.getState();

    expect(state.azimuth).toBeCloseTo(1.2, 5);
    expect(state.polar).toBeCloseTo(Math.PI / 2 - 0.3, 5);
    // El objetivo y la distancia son de la escena de destino y no se tocan:
    // moverlos acercaría o alejaría el modelo sin que nadie lo pidiera.
    expect(state.distance).toBeCloseTo(4, 5);
    expect(state.target.y).toBeCloseTo(1, 5);
  });
});
