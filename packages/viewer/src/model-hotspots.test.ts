/**
 * Pruebas de la proyección de marcadores sobre modelo (L06, L07).
 *
 * Se montan escenas de three.js de verdad —mallas, cámara, matrices— porque lo
 * que se comprueba es precisamente la aritmética de proyección y de oclusión,
 * y con dobles no se comprobaría nada. No hace falta WebGL: ninguna de estas
 * funciones dibuja.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { createModelSurfaceAnchor } from '@it360/domain';
import {
  anchorWorldPosition,
  hotspotAtPointer,
  isOccluded,
  normalizedPointer,
  projectHotspot,
  worldToLocal,
} from './model-hotspots';

const SIZE = { width: 800, height: 600 };

/** Modelo con una pieza cúbica en el origen y otra desplazada. */
function model(): Object3D {
  const root = new Object3D();

  const valve = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  valve.name = 'valvula_01';
  root.add(valve);

  const tank = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  tank.name = 'deposito';
  tank.position.set(0, 0, 4);
  root.add(tank);

  root.updateMatrixWorld(true);
  return root;
}

function sceneWith(root: Object3D): Scene {
  const scene = new Scene();
  scene.add(root);
  scene.updateMatrixWorld(true);
  return scene;
}

/** Cámara mirando al origen desde el eje Z positivo. */
function camera(z = 10): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, SIZE.width / SIZE.height, 0.1, 1000);
  cam.position.set(0, 0, z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

const anchor = (nodeName = 'valvula_01') =>
  createModelSurfaceAnchor(nodeName, { x: 0, y: 0, z: 0.5 }, { x: 0, y: 0, z: 1 });

describe('anchorWorldPosition', () => {
  it('TEST-MHP-001 sitúa el ancla en el mundo siguiendo a su pieza', () => {
    const root = model();
    const placed = anchorWorldPosition(root, anchor());

    expect(placed).not.toBeNull();
    expect(placed?.point.z).toBeCloseTo(0.5, 6);
    expect(placed?.normal.z).toBeCloseTo(1, 6);
  });

  it('TEST-MHP-002 si la pieza se mueve, el marcador se mueve con ella', () => {
    // Es la razón de guardar la posición en local: una válvula animada se
    // lleva su marcador consigo.
    const root = model();
    const valve = root.getObjectByName('valvula_01');
    valve?.position.set(3, 0, 0);
    root.updateMatrixWorld(true);

    const placed = anchorWorldPosition(root, anchor());
    expect(placed?.point.x).toBeCloseTo(3, 6);
  });

  it('TEST-MHP-003 si la pieza gira, la normal gira con ella', () => {
    const root = model();
    const valve = root.getObjectByName('valvula_01');
    valve?.rotateY(Math.PI / 2);
    root.updateMatrixWorld(true);

    const placed = anchorWorldPosition(root, anchor());
    // La normal apuntaba a +Z; tras girar 90° sobre Y apunta a +X.
    expect(placed?.normal.x).toBeCloseTo(1, 5);
    expect(placed?.normal.z).toBeCloseTo(0, 5);
  });

  it('TEST-MHP-004 una pieza que ya no está da null, no una posición cualquiera', () => {
    // Un marcador en el sitio equivocado es peor que un marcador ausente.
    expect(anchorWorldPosition(model(), anchor('pieza_borrada'))).toBeNull();
  });
});

describe('worldToLocal', () => {
  it('TEST-MHP-005 es la inversa de situar en el mundo', () => {
    const root = model();
    const valve = root.getObjectByName('valvula_01');
    if (valve === undefined) throw new Error('falta la pieza de prueba');

    valve.position.set(2, 1, 0);
    valve.rotateY(0.7);
    root.updateMatrixWorld(true);

    const world = new Vector3(2.4, 1, 0.3);
    const local = worldToLocal(valve, world);
    const back = local.clone().applyMatrix4(valve.matrixWorld);

    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
    expect(back.z).toBeCloseTo(world.z, 6);
  });
});

describe('projectHotspot', () => {
  it('TEST-MHP-006 un marcador en el centro de la vista cae en el centro', () => {
    const root = model();
    const projected = projectHotspot(root, sceneWith(root), camera(), anchor(), SIZE);

    expect(projected).not.toBeNull();
    expect(projected?.x).toBeCloseTo(SIZE.width / 2, 0);
    expect(projected?.y).toBeCloseTo(SIZE.height / 2, 0);
  });

  it('TEST-MHP-007 el marcador crece al acercarse', () => {
    const root = model();
    const scene = sceneWith(root);

    const near = projectHotspot(root, scene, camera(3), anchor(), SIZE);
    const far = projectHotspot(root, scene, camera(40), anchor(), SIZE);

    expect(near?.scale ?? 0).toBeGreaterThan(far?.scale ?? 0);
    expect(near?.distance ?? 0).toBeLessThan(far?.distance ?? 0);
  });

  it('TEST-MHP-008 lo que queda detrás de la cámara no se proyecta', () => {
    // Proyectarlo daría una posición especular: aparecería al otro lado de la
    // pantalla señalando algo que está a la espalda del visitante.
    const root = model();
    const cam = camera(-10);
    cam.lookAt(0, 0, -20);
    cam.updateMatrixWorld(true);

    expect(projectHotspot(root, sceneWith(root), cam, anchor(), SIZE)).toBeNull();
  });

  it('TEST-MHP-009 mirando desde atrás, el marcador se marca como cara oculta', () => {
    const root = model();
    const cam = camera(-10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);

    const projected = projectHotspot(root, sceneWith(root), cam, anchor(), SIZE);
    expect(projected?.facing).toBe(false);
  });

  it('TEST-MHP-010 sin pedirlo, no se comprueba la oclusión', () => {
    // Cuesta un rayo por marcador: en un modelo con cien marcadores eso es
    // cien rayos por fotograma, y no siempre hace falta.
    const root = model();
    const projected = projectHotspot(root, sceneWith(root), camera(), anchor(), SIZE);
    expect(projected?.occluded).toBe(false);
  });
});

describe('isOccluded', () => {
  it('TEST-MHP-011 una pieza por delante tapa el marcador', () => {
    // Sin esto, el marcador de una válvula se ve a través del depósito que la
    // tapa y el visitante cree que está mirando la válvula.
    const root = model();
    const scene = sceneWith(root);

    // Cámara al otro lado del depósito, que está en z = 4.
    const cam = camera(12);
    const point = new Vector3(0, 0, 0.5);

    expect(isOccluded(scene, cam, point, cam.position.distanceTo(point))).toBe(true);
  });

  it('TEST-MHP-012 sin nada por delante, no está tapado', () => {
    const root = model();
    const tank = root.getObjectByName('deposito');
    tank?.position.set(0, 0, -10);
    root.updateMatrixWorld(true);

    const scene = sceneWith(root);
    const cam = camera(10);
    const point = new Vector3(0, 0, 0.5);

    expect(isOccluded(scene, cam, point, cam.position.distanceTo(point))).toBe(false);
  });

  it('TEST-MHP-013 la propia superficie no se declara tapada a sí misma', () => {
    // Sin margen, la chapa en la que está pegado el marcador lo taparía
    // siempre y no se vería ninguno.
    const root = model();
    const tank = root.getObjectByName('deposito');
    tank?.removeFromParent();
    root.updateMatrixWorld(true);

    const scene = sceneWith(root);
    const cam = camera(10);
    const point = new Vector3(0, 0, 0.5);

    expect(isOccluded(scene, cam, point, cam.position.distanceTo(point))).toBe(false);
  });

  it('TEST-MHP-014 una pieza oculta no tapa', () => {
    const root = model();
    const tank = root.getObjectByName('deposito');
    if (tank !== undefined) tank.visible = false;
    root.updateMatrixWorld(true);

    const scene = sceneWith(root);
    const cam = camera(12);
    const point = new Vector3(0, 0, 0.5);

    expect(isOccluded(scene, cam, point, cam.position.distanceTo(point))).toBe(false);
  });
});

describe('hotspotAtPointer', () => {
  const screen = (x: number, y: number, distance: number, over: Partial<{ facing: boolean; occluded: boolean }> = {}) => ({
    x,
    y,
    distance,
    scale: 1,
    facing: over.facing ?? true,
    occluded: over.occluded ?? false,
  });

  it('TEST-MHP-015 con dos superpuestos, se pulsa el de delante', () => {
    const id = hotspotAtPointer(
      [
        { id: 'atras', screen: screen(100, 100, 20) },
        { id: 'delante', screen: screen(103, 98, 5) },
      ],
      { x: 100, y: 100 },
      24,
    );

    expect(id).toBe('delante');
  });

  it('TEST-MHP-016 fuera del radio no se pulsa nada', () => {
    expect(hotspotAtPointer([{ id: 'a', screen: screen(100, 100, 5) }], { x: 300, y: 300 }, 24)).toBeNull();
  });

  it('TEST-MHP-017 no se pulsa lo que está tapado ni lo que está de espaldas', () => {
    expect(
      hotspotAtPointer(
        [
          { id: 'tapado', screen: screen(100, 100, 5, { occluded: true }) },
          { id: 'de espaldas', screen: screen(100, 100, 4, { facing: false }) },
        ],
        { x: 100, y: 100 },
        24,
      ),
    ).toBeNull();
  });

  it('TEST-MHP-018 un marcador sin proyección se ignora', () => {
    expect(hotspotAtPointer([{ id: 'a', screen: null }], { x: 0, y: 0 }, 24)).toBeNull();
  });
});

describe('normalizedPointer', () => {
  it('TEST-MHP-019 el centro del lienzo es el origen', () => {
    const p = normalizedPointer({ x: 400, y: 300 }, SIZE);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('TEST-MHP-020 la esquina superior izquierda es (-1, 1)', () => {
    const p = normalizedPointer({ x: 0, y: 0 }, SIZE);
    expect(p.x).toBe(-1);
    expect(p.y).toBe(1);
  });

  it('TEST-MHP-021 un lienzo sin tamaño no produce NaN', () => {
    const p = normalizedPointer({ x: 10, y: 10 }, { width: 0, height: 0 });
    expect(Number.isFinite(p.x)).toBe(true);
  });
});
