/**
 * Pruebas de los enlaces a una escena y una vista (S09).
 *
 * Un enlace es algo que una persona copia, pega en un correo y abre semanas
 * después. Las pruebas persiguen lo que lo estropea en ese recorrido: un
 * parámetro perdido, un orden distinto, un `#` de más, y sobre todo que el
 * enlace apunte a una escena que ya no está en el paquete.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDeepLink,
  buildShareUrl,
  parseDeepLink,
  resolveDeepLink,
  type DeepLink,
} from './deep-link';
import type { CameraView } from '@it360/domain';

const SCENE = 'a3f1c2d4-0000-4000-8000-000000000001';

const view = (yaw: number, pitch: number, fov: number): CameraView => ({ yaw, pitch, fov });

/* ------------------------------------------------------------------ *
 * Construir
 * ------------------------------------------------------------------ */

describe('buildDeepLink', () => {
  it('TEST-LNK-001 un enlace sin vista lleva sólo la escena', () => {
    expect(buildDeepLink(SCENE)).toBe(`#escena=${SCENE}`);
  });

  it('TEST-LNK-002 los ángulos van en grados, que es lo que una persona puede leer', () => {
    const link = buildDeepLink(SCENE, view(Math.PI / 2, 0, 75));
    expect(link).toContain('yaw=90');
    expect(link).toContain('fov=75');
  });

  it('TEST-LNK-003 los ángulos se redondean a una décima', () => {
    // Más precisión no se percibe y sólo alarga el enlace.
    const link = buildDeepLink(SCENE, view(0.123456, 0, 75));
    expect(link).toContain('yaw=7.1');
  });

  it('TEST-LNK-004 el identificador se codifica', () => {
    expect(buildDeepLink('con espacio')).toContain('con%20espacio');
  });

  it('TEST-LNK-005 el enlace absoluto sustituye el fragmento que hubiera', () => {
    const url = buildShareUrl('https://planta.invalid/recorrido/#escena=otra', SCENE);
    expect(url).toBe(`https://planta.invalid/recorrido/#escena=${SCENE}`);
  });

  it('TEST-LNK-006 el enlace absoluto conserva la consulta de la dirección', () => {
    // El fragmento es lo único que el visor toca; el resto es del cliente.
    const url = buildShareUrl('https://planta.invalid/r/?v=2', SCENE);
    expect(url).toBe(`https://planta.invalid/r/?v=2#escena=${SCENE}`);
  });

  it('TEST-LNK-007 va en el fragmento, nunca en la consulta', () => {
    // El fragmento no viaja al servidor: la escena que alguien mira no tiene
    // por qué quedar anotada en el registro de accesos del cliente.
    const url = buildShareUrl('https://planta.invalid/r/', SCENE, view(1, 0, 75));
    expect(url.split('#')[0]).not.toContain('escena=');
    expect(url.split('#')[1]).toContain('escena=');
  });
});

/* ------------------------------------------------------------------ *
 * Leer
 * ------------------------------------------------------------------ */

describe('parseDeepLink', () => {
  it('TEST-LNK-008 lo que se construye se vuelve a leer igual', () => {
    const original = view(1.2, -0.4, 60);
    const parsed = parseDeepLink(buildDeepLink(SCENE, original));

    expect(parsed.sceneId).toBe(SCENE);
    expect(parsed.view?.yaw).toBeCloseTo(original.yaw, 2);
    expect(parsed.view?.pitch).toBeCloseTo(original.pitch, 2);
    expect(parsed.view?.fov).toBeCloseTo(original.fov, 2);
  });

  it('TEST-LNK-009 un fragmento vacío no pide nada', () => {
    expect(parseDeepLink('')).toEqual({ sceneId: null, view: null });
    expect(parseDeepLink('#')).toEqual({ sceneId: null, view: null });
  });

  it('TEST-LNK-010 tolera almohadillas de más', () => {
    // Es lo que pasa al pegar un enlace detrás de otro.
    expect(parseDeepLink(`##escena=${SCENE}`).sceneId).toBe(SCENE);
  });

  it('TEST-LNK-011 el orden de los parámetros da igual', () => {
    const parsed = parseDeepLink(`#fov=60&pitch=0&escena=${SCENE}&yaw=90`);
    expect(parsed.sceneId).toBe(SCENE);
    expect(parsed.view?.fov).toBe(60);
  });

  it('TEST-LNK-012 sin los tres ángulos no se inventa la vista', () => {
    // Con dos, el tercero sería inventado y el visitante vería algo que quien
    // mandó el enlace no estaba mirando.
    const parsed = parseDeepLink(`#escena=${SCENE}&yaw=90&pitch=0`);
    expect(parsed.sceneId).toBe(SCENE);
    expect(parsed.view).toBeNull();
  });

  it('TEST-LNK-013 un ángulo que no es número se ignora sin invalidar el enlace', () => {
    // Abrir la escena correcta sin orientación es mejor que no abrir nada.
    const parsed = parseDeepLink(`#escena=${SCENE}&yaw=norte&pitch=0&fov=75`);
    expect(parsed.sceneId).toBe(SCENE);
    expect(parsed.view).toBeNull();
  });

  it('TEST-LNK-014 la elevación se acota a lo que la cámara admite', () => {
    const parsed = parseDeepLink(`#escena=${SCENE}&yaw=0&pitch=200&fov=75`);
    expect(parsed.view?.pitch).toBeCloseTo(Math.PI / 2, 4);
  });

  it('TEST-LNK-015 el campo de visión se acota a un intervalo utilizable', () => {
    expect(parseDeepLink(`#escena=${SCENE}&yaw=0&pitch=0&fov=500`).view?.fov).toBe(120);
    expect(parseDeepLink(`#escena=${SCENE}&yaw=0&pitch=0&fov=1`).view?.fov).toBe(20);
  });

  it('TEST-LNK-016 una escena vacía cuenta como ausente', () => {
    expect(parseDeepLink('#escena=&yaw=0&pitch=0&fov=75').sceneId).toBeNull();
  });

  it('TEST-LNK-017 un fragmento que no es de este visor no estorba', () => {
    // Un ancla cualquiera, como la que deja un lector de pantalla.
    expect(parseDeepLink('#contenido-principal').sceneId).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Resolver contra el paquete
 * ------------------------------------------------------------------ */

describe('resolveDeepLink', () => {
  const available = new Set([SCENE, 'otra-escena']);

  it('TEST-LNK-018 sin escena no hay nada que resolver', () => {
    expect(resolveDeepLink({ sceneId: null, view: null }, available)).toEqual({ kind: 'none' });
  });

  it('TEST-LNK-019 una escena presente se resuelve con su vista', () => {
    const link: DeepLink = { sceneId: SCENE, view: view(1, 0, 60) };
    const result = resolveDeepLink(link, available);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.sceneId).toBe(SCENE);
      expect(result.view?.fov).toBe(60);
    }
  });

  it('TEST-LNK-020 una escena que ya no está se informa, no se ignora', () => {
    // Quien recibió el enlace merece saber que apuntaba a algo que ya no está,
    // y no creer que le mandaron mal la dirección.
    const result = resolveDeepLink({ sceneId: 'borrada', view: null }, available);

    expect(result.kind).toBe('missing');
    if (result.kind === 'missing') expect(result.sceneId).toBe('borrada');
  });

  it('TEST-LNK-021 un paquete sin escenas no resuelve nada', () => {
    const result = resolveDeepLink({ sceneId: SCENE, view: null }, new Set());
    expect(result.kind).toBe('missing');
  });
});
