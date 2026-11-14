/**
 * Pruebas de las direcciones de los medios al abrir un proyecto (Y01).
 *
 * Existen por un defecto que rompía el ciclo básico del producto: al abrir un
 * proyecto guardado se cargaban el modelo y los bytes de los archivos, pero
 * nadie construía las direcciones con las que mostrarlos, así que el proyecto
 * se abría con todas sus escenas en blanco. Crear, guardar y seguir mañana no
 * se cerraba.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { makeMedia } from '@it360/domain/testing';
import { buildMediaUrls, objectUrlFor, releaseMediaUrls } from './media-urls';

afterEach(() => {
  vi.restoreAllMocks();
});

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

describe('buildMediaUrls', () => {
  it('TEST-MUR-001 cada medio con archivo recibe su dirección', () => {
    const pano = makeMedia(80, { relativePath: 'media/pano.jpg', mime: 'image/jpeg' });
    const plan = makeMedia(81, { relativePath: 'media/planos/planta.png', mime: 'image/png' });

    const urls = buildMediaUrls(
      [pano, plan],
      new Map([
        ['media/pano.jpg', bytes(16)],
        ['media/planos/planta.png', bytes(8)],
      ]),
    );

    expect(urls.size).toBe(2);
    expect(urls.get(pano.id)).toBeTruthy();
    expect(urls.get(plan.id)).toBeTruthy();
  });

  it('TEST-MUR-002 se indexa por identificador de medio, no por ruta', () => {
    // El resto de la aplicación pide la dirección de un medio por su `id`.
    const pano = makeMedia(80, { relativePath: 'media/pano.jpg' });
    const urls = buildMediaUrls([pano], new Map([['media/pano.jpg', bytes(4)]]));

    expect([...urls.keys()]).toEqual([pano.id]);
  });

  it('TEST-MUR-003 un medio cuyo archivo falta se omite', () => {
    // La interfaz ya sabe decir «falta este archivo» cuando no hay dirección;
    // una cadena vacía produciría una petición a la propia página.
    const pano = makeMedia(80, { relativePath: 'media/pano.jpg' });
    const urls = buildMediaUrls([pano], new Map());

    expect(urls.size).toBe(0);
    expect(urls.has(pano.id)).toBe(false);
  });

  it('TEST-MUR-004 el tipo del medio viaja en la dirección de datos', () => {
    // Sin tipo, el navegador no sabe decodificar una panorámica.
    const url = objectUrlFor(bytes(3), 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('TEST-MUR-005 un medio sin tipo declarado no produce una dirección inválida', () => {
    expect(objectUrlFor(bytes(3), '')).toContain('application/octet-stream');
  });

  it('TEST-MUR-006 con URL de objeto disponible se prefiere a la de datos', () => {
    // Una panorámica de 40 MB en base64 son 53 MB de cadena en memoria.
    const created: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:fake/1';
      },
      revokeObjectURL: () => undefined,
    });

    expect(objectUrlFor(bytes(5), 'image/jpeg')).toBe('blob:fake/1');
    expect(created).toHaveLength(1);
  });
});

describe('releaseMediaUrls', () => {
  it('TEST-MUR-007 libera las direcciones que ya no se usan', () => {
    // Sin esto, abrir diez proyectos grandes en una sesión deja retenidos sus
    // bytes y la aplicación se va volviendo lenta sin motivo aparente.
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    releaseMediaUrls(
      new Map([
        ['a', 'blob:vieja-1'],
        ['b', 'blob:vieja-2'],
      ]),
      new Map([['c', 'blob:nueva']]),
    );

    expect(revoked).toEqual(['blob:vieja-1', 'blob:vieja-2']);
  });

  it('TEST-MUR-008 no libera una dirección que se sigue usando', () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    releaseMediaUrls(new Map([['a', 'blob:compartida']]), new Map([['b', 'blob:compartida']]));

    expect(revoked).toEqual([]);
  });

  it('TEST-MUR-009 una dirección de datos no se intenta liberar', () => {
    // No retiene nada y revocarla no significa nada.
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    releaseMediaUrls(new Map([['a', 'data:image/png;base64,AAA']]), new Map());

    expect(revoked).toEqual([]);
  });
});
