import { describe, expect, it } from 'vitest';
import {
  assertSafeRelativePath,
  isSafeRelativePath,
  isUuid,
  newUuid,
  normalizeTag,
  parseTag,
  sanitizeFileName,
  TAG_MAX_LENGTH,
  tagScopeKey,
} from './identity';
import { isErr, isOk } from './result';

/**
 * TEST-ID-001 .. TEST-ID-022
 * Requisitos: X01 (UUID y TAG industrial), contrato de datos (nombres
 * sanitizados, prevención de ZIP slip y path traversal).
 */
describe('UUID', () => {
  it('TEST-ID-001: genera UUID v4 válidos y en minúsculas', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newUuid();
      expect(isUuid(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
      expect(id[14]).toBe('4');
    }
  });

  it('TEST-ID-002: no repite identificadores en una tirada larga', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newUuid()));
    expect(ids.size).toBe(2000);
  });

  it('TEST-ID-003: rechaza lo que no es UUID v4', () => {
    expect(isUuid('no-es-uuid')).toBe(false);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-00000000000')).toBe(false);
    expect(isUuid('00000000-0000-4000-C000-000000000000')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe('normalización de TAG', () => {
  it('TEST-ID-004: recorta, pasa a mayúsculas y colapsa separadores', () => {
    expect(normalizeTag('  p-101a  ')).toBe('P-101A');
    expect(normalizeTag('TI--2301')).toBe('TI-2301');
    expect(normalizeTag('-P-101-')).toBe('P-101');
    expect(normalizeTag('A//B')).toBe('A/B');
  });

  it('TEST-ID-005: no inventa correcciones', () => {
    // Un TAG inventado por el importador es peor que uno rechazado: el
    // primero entra en el catálogo y nadie lo revisa.
    expect(normalizeTag('P 101 A')).toBe('P 101 A');
    expect(isErr(parseTag('P 101 A'))).toBe(true);
    expect(normalizeTag('BOMBA Ñ')).toBe('BOMBA Ñ');
    expect(isErr(parseTag('BOMBA Ñ'))).toBe(true);
  });

  it('TEST-ID-006: acepta las convenciones ISA habituales', () => {
    for (const raw of ['P-101A', 'TI-2301', 'FIC_100', 'U200/AREA3/P-101', 'V.101', 'X1']) {
      const result = parseTag(raw);
      expect(isOk(result), `debería aceptar ${raw}`).toBe(true);
    }
  });

  it('TEST-ID-007: rechaza vacío, demasiado largo y con caracteres no admitidos', () => {
    expect(isErr(parseTag(''))).toBe(true);
    expect(isErr(parseTag('   '))).toBe(true);
    expect(isErr(parseTag('A'.repeat(TAG_MAX_LENGTH + 1)))).toBe(true);
    expect(isOk(parseTag('A'.repeat(TAG_MAX_LENGTH)))).toBe(true);
    expect(isErr(parseTag('P#101'))).toBe(true);
    expect(isErr(parseTag('P@101'))).toBe(true);
  });

  it('TEST-ID-008: el error explica qué hacer', () => {
    const result = parseTag('tag con espacios');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.recovery).toBeDefined();
      expect(result.error.detail).toMatchObject({ raw: 'tag con espacios' });
    }
  });
});

describe('alcance de unicidad del TAG', () => {
  const hierarchy = { plantId: 'pl1', unitId: 'u2', areaId: 'a3' };

  it('TEST-ID-009: cada alcance produce una clave distinta', () => {
    expect(tagScopeKey('P-101', 'none', hierarchy)).toBeNull();
    expect(tagScopeKey('P-101', 'project', hierarchy)).toBe('P-101');
    expect(tagScopeKey('P-101', 'plant', hierarchy)).toBe('pl1::P-101');
    expect(tagScopeKey('P-101', 'unit', hierarchy)).toBe('pl1/u2::P-101');
    expect(tagScopeKey('P-101', 'area', hierarchy)).toBe('pl1/u2/a3::P-101');
  });

  it('TEST-ID-010: con alcance de unidad, el mismo TAG en dos unidades no choca', () => {
    // En planta real conviven las tres convenciones; imponer una política que
    // el cliente no sigue termina en TAG falseados con sufijos.
    const a = tagScopeKey('TI-101', 'unit', { plantId: 'pl1', unitId: 'u1' });
    const b = tagScopeKey('TI-101', 'unit', { plantId: 'pl1', unitId: 'u2' });
    expect(a).not.toBe(b);
  });
});

describe('saneado de nombres de archivo', () => {
  it('TEST-ID-011: sustituye los caracteres prohibidos por Windows', () => {
    expect(sanitizeFileName('plano:final?.pdf')).toBe('plano_final_.pdf');
    expect(sanitizeFileName('a/b\\c.png')).toBe('a_b_c.png');
    expect(sanitizeFileName('dato|1<2>3.txt')).toBe('dato_1_2_3.txt');
  });

  it('TEST-ID-012: evita los nombres de dispositivo reservados', () => {
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('aux')).toBe('_aux');
    expect(sanitizeFileName('COM1.pdf')).toBe('_COM1.pdf');
    expect(sanitizeFileName('console.txt')).toBe('console.txt');
  });

  it('TEST-ID-013: elimina el punto final que Windows descartaría', () => {
    // Si se conservara, el hash del manifiesto no coincidiría con el archivo
    // realmente escrito en disco.
    expect(sanitizeFileName('informe.')).toBe('informe');
    expect(sanitizeFileName('informe...')).toBe('informe');
  });

  it('TEST-ID-014: nunca devuelve cadena vacía', () => {
    expect(sanitizeFileName('')).toBe('archivo');
    expect(sanitizeFileName('   ')).toBe('archivo');
    expect(sanitizeFileName('...')).toBe('archivo');
    expect(sanitizeFileName('', 'medio')).toBe('medio');
  });

  it('TEST-ID-015: conserva los acentos del nombre original', () => {
    // El TAG está restringido; el nombre descriptivo no tiene por qué estarlo.
    expect(sanitizeFileName('Inspección válvula.pdf')).toBe('Inspección válvula.pdf');
  });

  it('TEST-ID-016: recorta nombres excesivamente largos conservando la extensión', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const result = sanitizeFileName(long);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('rutas relativas seguras', () => {
  it('TEST-ID-017: acepta rutas relativas normales', () => {
    expect(isSafeRelativePath('media/panorama-01.jpg')).toBe(true);
    expect(isSafeRelativePath('documents/P-101/hoja.pdf')).toBe(true);
    expect(isSafeRelativePath('manifest.json')).toBe(true);
  });

  it('TEST-ID-018: rechaza el escape por segmentos relativos (ZIP slip)', () => {
    // Un .ivp recibido de un tercero puede traer esta entrada; extraerla
    // escribiría fuera de la carpeta del proyecto.
    expect(isSafeRelativePath('../../AppData/Roaming/x.exe')).toBe(false);
    expect(isSafeRelativePath('media/../../secreto.txt')).toBe(false);
    expect(isSafeRelativePath('./media/a.jpg')).toBe(false);
    expect(isSafeRelativePath('media/./a.jpg')).toBe(false);
  });

  it('TEST-ID-019: rechaza rutas absolutas y unidades de Windows', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('\\\\servidor\\compartido\\a.txt')).toBe(false);
    expect(isSafeRelativePath('C:/Windows/System32/x.dll')).toBe(false);
    expect(isSafeRelativePath('c:a.txt')).toBe(false);
  });

  it('TEST-ID-020: rechaza bytes nulos y segmentos vacíos', () => {
    expect(isSafeRelativePath('media/a\0.jpg')).toBe(false);
    expect(isSafeRelativePath('media//a.jpg')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });

  it('TEST-ID-021: rechaza rutas desmedidas', () => {
    expect(isSafeRelativePath(`${'a/'.repeat(600)}b.txt`)).toBe(false);
  });

  it('TEST-ID-022: assertSafeRelativePath devuelve un error con código propio', () => {
    const result = assertSafeRelativePath('../x');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('UNSAFE_PATH');
      expect(result.error.recovery).toContain('No se extraerá');
    }
    expect(isOk(assertSafeRelativePath('media/ok.jpg'))).toBe(true);
  });
});
