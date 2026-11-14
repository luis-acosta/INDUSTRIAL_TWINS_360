/**
 * Pruebas de la colocación de marcadores sobre el modelo (L05–L07).
 *
 * Lo que se vigila es la conversión de coordenadas: el visor devuelve el punto
 * en el espacio del mundo y el marcador se guarda en el espacio local de la
 * pieza. Equivocar esa conversión deja el marcador a metros de donde el autor
 * pulsó, y el síntoma —un marcador que «no aparece»— no apunta a la causa.
 *
 * El módulo completo no se monta: `ModelScene` necesita WebGL y en jsdom no
 * hay. Se prueba la conversión con las mismas funciones que usa el módulo, con
 * un modelo de three.js de verdad.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { createHotspot, createModelSurfaceAnchor } from '@it360/domain';
import { anchorWorldPosition, worldToLocal } from '@it360/viewer';
import { testUuid } from '@it360/domain/testing';

/** Modelo con una pieza desplazada y girada, como la trae un CAD de verdad. */
function model(): { root: Object3D; valve: Object3D } {
  const root = new Object3D();
  const valve = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  valve.name = 'valvula_01';
  valve.position.set(4, 2, -1);
  valve.rotateY(Math.PI / 3);
  root.add(valve);
  root.updateMatrixWorld(true);
  return { root, valve };
}

describe('colocación de un marcador sobre el modelo', () => {
  it('TEST-MPL-001 el punto donde se pulsó se recupera igual', () => {
    // Es la prueba del ciclo completo: mundo -> local al guardar, local ->
    // mundo al dibujar. Si no cierra, el marcador aparece desplazado.
    const { root, valve } = model();
    const clicked = new Vector3(4.3, 2.5, -0.8);

    const local = worldToLocal(valve, clicked);
    const anchor = createModelSurfaceAnchor(
      'valvula_01',
      { x: local.x, y: local.y, z: local.z },
      { x: 0, y: 1, z: 0 },
    );

    const placed = anchorWorldPosition(root, anchor);
    expect(placed?.point.x).toBeCloseTo(clicked.x, 6);
    expect(placed?.point.y).toBeCloseTo(clicked.y, 6);
    expect(placed?.point.z).toBeCloseTo(clicked.z, 6);
  });

  it('TEST-MPL-002 guardar en coordenadas del mundo habría sido un error', () => {
    // Se demuestra el motivo de la decisión: con la posición del mundo, mover
    // la pieza deja el marcador donde la pieza estaba.
    const { root, valve } = model();
    const clicked = new Vector3(4.3, 2.5, -0.8);

    const local = worldToLocal(valve, clicked);
    const anchor = createModelSurfaceAnchor(
      'valvula_01',
      { x: local.x, y: local.y, z: local.z },
      { x: 0, y: 1, z: 0 },
    );

    // La pieza se mueve, como haría una animación.
    valve.position.set(4, 5, -1);
    root.updateMatrixWorld(true);

    const placed = anchorWorldPosition(root, anchor);
    expect(placed?.point.y).toBeCloseTo(clicked.y + 3, 6);
  });

  it('TEST-MPL-003 el marcador creado queda listo para publicar', () => {
    const { root, valve } = model();
    const local = worldToLocal(valve, new Vector3(4, 2, -1));

    const hotspot = createHotspot({
      sceneId: testUuid(10),
      name: 'Válvula de descarga',
      anchor: createModelSurfaceAnchor(
        'valvula_01',
        { x: local.x, y: local.y, z: local.z },
        { x: 0, y: 1, z: 0 },
      ),
      order: 0,
      now: '2026-11-13T10:00:00.000Z',
    });

    expect(hotspot.anchor.space).toBe('modelSurface');
    expect(hotspot.name).toBe('Válvula de descarga');
    // Creado a mano: cuenta como revisado, o no se publicaría.
    expect(hotspot.reviewed).toBe(true);
    expect(hotspot.actions).toEqual([]);
    expect(anchorWorldPosition(root, hotspot.anchor as never)).not.toBeNull();
  });

  it('TEST-MPL-004 el marcador nace con la geometría por omisión del esquema', () => {
    // Antes cada sitio que creaba un marcador escribía veintitantos campos y
    // los afirmaba con un `as`: dos copias que se separan al crecer el esquema.
    const hotspot = createHotspot({
      sceneId: testUuid(10),
      anchor: { space: 'spherical', yaw: 0, pitch: 0 },
      now: '2026-11-13T10:00:00.000Z',
    });

    expect(hotspot.geometry.shape).toBe('icon');
    expect(hotspot.style.projection).toBe('billboard');
    expect(hotspot.visibility).toEqual({ desktop: true, tablet: true, mobile: true, vr: true });
  });
});
