/**
 * Pruebas del almacén de notas de campo del visor publicado.
 *
 * Lo que se comprueba aquí no es que guarde, sino que **no pierda nada cuando
 * el navegador no colabora**: una observación tomada delante del equipo no se
 * puede volver a tomar, y `localStorage` falla de verdad en modo privado de
 * Safari, con la cuota llena y en navegadores embebidos de quiosco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleFieldNotes, createFieldNote, newUuid, type FieldNote } from '@it360/domain';
import {
  clearFieldNotes,
  downloadBundle,
  loadFieldNotes,
  saveFieldNotes,
} from './field-notes';

const PROJECT = newUuid();
const OTHER = newUuid();
const SCENE = newUuid();

const note = (title = 'Goteo en la brida'): FieldNote =>
  createFieldNote({
    sceneId: SCENE,
    yaw: 1,
    pitch: 0,
    title,
    body: '',
    categoryId: 'leak',
    priority: 'high',
    authorName: 'Operador',
    now: '2026-06-01T08:00:00.000Z',
  });

/** Almacén en memoria que imita a `localStorage`. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  } as Storage;
}

function install(storage: Storage | (() => never)): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: typeof storage === 'function' ? storage : () => storage,
  });
}

beforeEach(() => {
  install(memoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Guardar y leer
 * ------------------------------------------------------------------ */

describe('saveFieldNotes y loadFieldNotes', () => {
  it('TEST-VFN-001 guarda y recupera las notas de un proyecto', () => {
    const notes = [note('Fuga'), note('Corrosión')];
    expect(saveFieldNotes(PROJECT, notes).ok).toBe(true);

    const leidas = loadFieldNotes(PROJECT);
    expect(leidas.map((n) => n.title)).toEqual(['Fuga', 'Corrosión']);
  });

  it('TEST-VFN-002 separa las notas por proyecto', () => {
    // Una tableta puede recorrer dos plantas; mezclar sus observaciones sería
    // peor que no guardarlas.
    saveFieldNotes(PROJECT, [note('De la planta norte')]);
    saveFieldNotes(OTHER, [note('De la planta sur')]);

    expect(loadFieldNotes(PROJECT).map((n) => n.title)).toEqual(['De la planta norte']);
    expect(loadFieldNotes(OTHER).map((n) => n.title)).toEqual(['De la planta sur']);
  });

  it('TEST-VFN-003 un proyecto sin notas devuelve una lista vacía', () => {
    expect(loadFieldNotes(PROJECT)).toEqual([]);
  });

  it('TEST-VFN-004 el ancla y la escena sobreviven al viaje por JSON', () => {
    const original = note();
    saveFieldNotes(PROJECT, [original]);

    const recuperada = loadFieldNotes(PROJECT)[0];
    expect(recuperada?.anchor).toEqual(original.anchor);
    expect(recuperada?.sceneId).toBe(SCENE);
    expect(recuperada?.createdAt).toBe(original.createdAt);
  });
});

/* ------------------------------------------------------------------ *
 * Cuando el navegador no colabora
 * ------------------------------------------------------------------ */

describe('resistencia del almacén', () => {
  it('TEST-VFN-005 informa, sin lanzar, cuando no queda espacio', () => {
    // Si la nota que acaba de escribir un operador desapareciera con una
    // excepción, habría perdido una observación irrepetible.
    const storage = memoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      const error = new Error('exceeded the quota');
      error.name = 'QuotaExceededError';
      throw error;
    });
    install(storage);

    const result = saveFieldNotes(PROJECT, [note()]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('espacio');
    expect(result.message).toContain('Descargue');
  });

  it('TEST-VFN-006 informa, sin lanzar, cuando el navegador prohíbe guardar', () => {
    const storage = memoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    install(storage);

    const result = saveFieldNotes(PROJECT, [note()]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('modo privado');
    // Y dice qué hacer con la nota que ya está en pantalla.
    expect(result.message).toContain('descárguela');
  });

  it('TEST-VFN-007 leer no lanza cuando el acceso al almacén falla', () => {
    install(() => {
      throw new DOMException('Access denied.', 'SecurityError');
    });
    expect(loadFieldNotes(PROJECT)).toEqual([]);
  });

  it('TEST-VFN-008 un contenido corrupto devuelve una lista vacía en lugar de romper', () => {
    const storage = memoryStorage();
    storage.setItem(`it360.fieldNotes.${PROJECT}`, 'esto no es json {');
    install(storage);

    expect(loadFieldNotes(PROJECT)).toEqual([]);
  });

  it('TEST-VFN-009 un contenido que no es una lista devuelve una lista vacía', () => {
    const storage = memoryStorage();
    storage.setItem(`it360.fieldNotes.${PROJECT}`, '{"notas":[]}');
    install(storage);

    expect(loadFieldNotes(PROJECT)).toEqual([]);
  });

  it('TEST-VFN-010 una nota corrupta no se lleva a las demás', () => {
    // Una entrada mal formada —por una versión anterior, o por otra pestaña
    // escribiendo a la vez— no debe hacer desaparecer las buenas.
    const buena = note('Buena');
    const storage = memoryStorage();
    storage.setItem(
      `it360.fieldNotes.${PROJECT}`,
      JSON.stringify([{ id: 'no-es-uuid', title: '' }, buena, { nada: true }]),
    );
    install(storage);

    const leidas = loadFieldNotes(PROJECT);
    expect(leidas).toHaveLength(1);
    expect(leidas[0]?.title).toBe('Buena');
  });
});

/* ------------------------------------------------------------------ *
 * Borrado
 * ------------------------------------------------------------------ */

describe('clearFieldNotes', () => {
  it('TEST-VFN-011 borra sólo el proyecto indicado', () => {
    saveFieldNotes(PROJECT, [note()]);
    saveFieldNotes(OTHER, [note()]);

    expect(clearFieldNotes(PROJECT).ok).toBe(true);
    expect(loadFieldNotes(PROJECT)).toEqual([]);
    expect(loadFieldNotes(OTHER)).toHaveLength(1);
  });

  it('TEST-VFN-012 informa sin lanzar si el borrado falla', () => {
    const storage = memoryStorage();
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('denegado');
    });
    install(storage);

    expect(clearFieldNotes(PROJECT).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Descarga
 * ------------------------------------------------------------------ */

describe('downloadBundle', () => {
  it('TEST-VFN-013 nombra el archivo con el proyecto y la fecha', () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    // jsdom no implementa las URL de objeto.
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();

    const bundle = bundleFieldNotes([note()], PROJECT, 'Planta Norte', '2026-06-02T10:00:00.000Z');
    const fileName = downloadBundle(bundle, 'Planta Norte · Revisión Anual');

    expect(fileName).toMatch(/^notas-de-campo-planta-norte-revision-anual-\d{4}-\d{2}-\d{2}\.json$/);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe(fileName);
  });

  it('TEST-VFN-014 un título sin caracteres usables no deja el nombre colgando', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();

    const bundle = bundleFieldNotes([], PROJECT, '', '2026-06-02T10:00:00.000Z');
    expect(downloadBundle(bundle, '··· ')).toMatch(/^notas-de-campo-recorrido-/);
  });
});
