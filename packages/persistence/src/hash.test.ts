/**
 * Pruebas de las huellas SHA-256.
 *
 * No existían, y la integración continua encontró por qué hacían falta: la
 * implementación entregaba a `digest` el `ArrayBuffer` del origen en lugar de
 * una vista propia, lo que funcionaba en Node 22 y fallaba en Node 20.11.
 * El cálculo era correcto —recortaba bien el tramo de la vista—, pero nada lo
 * comprobaba, así que al cambiar la llamada no había forma de saber si seguía
 * firmando los mismos bytes.
 *
 * Los valores esperados son los SHA-256 reales de las cadenas, no los que
 * devuelva la implementación: una prueba que compara el código consigo mismo
 * no detecta que el algoritmo esté mal.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256, sha256Canonical, sha256Text } from './hash';

/** SHA-256 de la cadena vacía, valor publicado del estándar. */
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** SHA-256 de «abc», el vector de prueba de FIPS 180-4. */
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256', () => {
  it('TEST-HSH-001 la cadena vacía da la huella publicada del estándar', async () => {
    expect(await sha256(new Uint8Array(0))).toBe(EMPTY);
  });

  it('TEST-HSH-002 «abc» da el vector de prueba de FIPS 180-4', async () => {
    expect(await sha256Text('abc')).toBe(ABC);
  });

  it('TEST-HSH-003 la huella tiene 64 dígitos hexadecimales en minúscula', async () => {
    const hash = await sha256Text('cualquier cosa');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TEST-HSH-004 el mismo contenido da siempre la misma huella', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await sha256(bytes)).toBe(await sha256(new Uint8Array([1, 2, 3, 4, 5])));
  });

  it('TEST-HSH-005 un byte distinto cambia la huella', async () => {
    const a = await sha256(new Uint8Array([1, 2, 3]));
    const b = await sha256(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });

  it('TEST-HSH-006 una vista que no empieza en el byte cero firma sólo sus bytes', async () => {
    // El tramo, no el buffer entero. Firmar el buffer completo haría que dos
    // vistas distintas del mismo origen dieran la misma huella, y en el
    // paquete un medio sobrescribiría al otro. La implementación ya lo hacía
    // bien; esta prueba lo fija para que un cambio en la llamada no lo rompa.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);

    expect(view.byteOffset).toBe(2);
    expect(await sha256(view)).toBe(await sha256(new Uint8Array([1, 2, 3])));
  });

  it('TEST-HSH-007 dos vistas del mismo buffer con contenido distinto difieren', async () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const first = backing.subarray(0, 3);
    const second = backing.subarray(3, 6);

    expect(await sha256(first)).not.toBe(await sha256(second));
  });

  it('TEST-HSH-008 el texto se codifica en UTF-8', async () => {
    // «ñ» ocupa dos bytes: si se codificara byte a byte, la huella sería otra.
    const direct = await sha256(new TextEncoder().encode('añil'));
    expect(await sha256Text('añil')).toBe(direct);
  });
});

/* ------------------------------------------------------------------ *
 * JSON canónico
 * ------------------------------------------------------------------ */

describe('canonicalJson', () => {
  it('TEST-HSH-009 el orden de las claves no cambia el resultado', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('TEST-HSH-010 el orden de un array sí cuenta', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('TEST-HSH-011 ordena también las claves anidadas', () => {
    const one = canonicalJson({ x: { d: 1, c: 2 }, a: 3 });
    const other = canonicalJson({ a: 3, x: { c: 2, d: 1 } });
    expect(one).toBe(other);
  });

  it('TEST-HSH-012 los números no finitos se escriben como nulos', () => {
    // `JSON.stringify` también lo hace, pero aquí es deliberado: una huella
    // no puede depender de que `NaN` se serialice de una u otra forma.
    expect(canonicalJson({ v: Number.NaN })).toBe(canonicalJson({ v: null }));
    expect(canonicalJson({ v: Number.POSITIVE_INFINITY })).toBe(canonicalJson({ v: null }));
  });

  it('TEST-HSH-013 una referencia circular se rechaza con el motivo', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/i);
  });

  it('TEST-HSH-014 la huella canónica es estable frente al orden de las claves', async () => {
    const one = await sha256Canonical({ tag: 'B-101', estado: 'activo' });
    const other = await sha256Canonical({ estado: 'activo', tag: 'B-101' });
    expect(one).toBe(other);
  });

  it('TEST-HSH-015 un cambio real sí cambia la huella canónica', async () => {
    const before = await sha256Canonical({ tag: 'B-101', estado: 'activo' });
    const after = await sha256Canonical({ tag: 'B-101', estado: 'fuera de servicio' });
    expect(before).not.toBe(after);
  });
});
