import { beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk } from '@it360/domain';
import {
  findBackups,
  findInterruptedWrites,
  MemoryStorage,
  writeAtomic,
} from './storage';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const read = async (storage: MemoryStorage, path: string): Promise<string> =>
  new TextDecoder().decode(await storage.readFile(path));

/**
 * TEST-STO-001 .. TEST-STO-014
 * Requisito: etapa 00, «guardado atómico con respaldo y recuperación ante
 * cierre abrupto»; contrato de datos, «escritura en archivo temporal + fsync
 * + rename; backups automáticos».
 */
describe('guardado atómico', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('TEST-STO-001: escribe el archivo cuando no existía', async () => {
    const result = await writeAtomic(storage, '/proyectos/planta.ivp', bytes('v1'));
    expect(isOk(result)).toBe(true);
    expect(await read(storage, '/proyectos/planta.ivp')).toBe('v1');
  });

  it('TEST-STO-002: no deja archivos temporales tras un guardado correcto', async () => {
    await writeAtomic(storage, '/proyectos/planta.ivp', bytes('v1'));
    expect(storage.listAll().filter((p) => p.includes('.tmp-'))).toEqual([]);
  });

  it('TEST-STO-003: conserva el contenido anterior como respaldo', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('v1'));
    await writeAtomic(storage, '/p/x.ivp', bytes('v2'));
    expect(await read(storage, '/p/x.ivp')).toBe('v2');
    expect(await read(storage, '/p/x.ivp.bak1')).toBe('v1');
  });

  it('TEST-STO-004: rota los respaldos del más reciente al más antiguo', async () => {
    for (const version of ['v1', 'v2', 'v3', 'v4']) {
      await writeAtomic(storage, '/p/x.ivp', bytes(version), { backupCount: 3 });
    }
    expect(await read(storage, '/p/x.ivp')).toBe('v4');
    expect(await read(storage, '/p/x.ivp.bak1')).toBe('v3');
    expect(await read(storage, '/p/x.ivp.bak2')).toBe('v2');
    expect(await read(storage, '/p/x.ivp.bak3')).toBe('v1');
  });

  it('TEST-STO-005: no conserva más respaldos de los configurados', async () => {
    for (let i = 1; i <= 8; i += 1) {
      await writeAtomic(storage, '/p/x.ivp', bytes(`v${i}`), { backupCount: 2 });
    }
    expect(await storage.exists('/p/x.ivp.bak2')).toBe(true);
    expect(await storage.exists('/p/x.ivp.bak3')).toBe(false);
  });

  it('TEST-STO-006: con backupCount 0 no genera respaldos', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('v1'), { backupCount: 0 });
    await writeAtomic(storage, '/p/x.ivp', bytes('v2'), { backupCount: 0 });
    expect(await storage.exists('/p/x.ivp.bak1')).toBe(false);
  });

  it('TEST-STO-007a: un temporal truncado se limpia; no sirve para recuperar nada', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('bueno'));
    storage.failOn = { op: 'writeFile', path: '.tmp-' };
    await writeAtomic(storage, '/p/x.ivp', bytes('nuevo'));
    expect(storage.listAll().filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('TEST-STO-007: un fallo al escribir el temporal deja intacto el archivo anterior', async () => {
    // Es la garantía que importa: un corte a mitad de guardado no puede
    // dejar al usuario sin el proyecto que ya tenía.
    await writeAtomic(storage, '/p/x.ivp', bytes('bueno'));
    storage.failOn = { op: 'writeFile', path: '.tmp-' };

    const result = await writeAtomic(storage, '/p/x.ivp', bytes('nuevo'));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('STORAGE_FAILED');
      expect(result.error.recovery).toContain('respaldos');
    }
    expect(await read(storage, '/p/x.ivp')).toBe('bueno');
  });

  it('TEST-STO-008: un fallo al renombrar conserva el original en el respaldo', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('bueno'));
    // Falla el renombrado final del temporal sobre el destino.
    storage.failOn = { op: 'rename', path: '.tmp-' };

    const result = await writeAtomic(storage, '/p/x.ivp', bytes('nuevo'));
    expect(isErr(result)).toBe(true);
    // En este punto el original ya rotó a .bak1, que es exactamente el motivo
    // de rotar ANTES de renombrar: siempre queda una copia completa.
    expect(await read(storage, '/p/x.ivp.bak1')).toBe('bueno');
  });

  it('TEST-STO-008a: un temporal completo NO se borra: contiene el trabajo más reciente', async () => {
    // Borrarlo «para limpiar» destruiría los únicos datos nuevos que
    // sobrevivieron al fallo.
    await writeAtomic(storage, '/p/x.ivp', bytes('viejo'));
    storage.failOn = { op: 'rename', path: '.tmp-' };

    const result = await writeAtomic(storage, '/p/x.ivp', bytes('trabajo reciente'));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail?.['recoverableTemp']).not.toBeNull();
      expect(result.error.recovery).toContain('temporal');
    }
    const temps = storage.listAll().filter((f) => f.includes('/p/x.ivp.tmp-'));
    expect(temps).toHaveLength(1);
    expect(await read(storage, temps[0] as string)).toBe('trabajo reciente');
  });

  it('TEST-STO-009: el archivo nunca se observa a medio escribir', async () => {
    // El destino sólo cambia por un renombrado, que es indivisible: entre el
    // contenido viejo y el nuevo no hay ningún estado intermedio legible.
    await writeAtomic(storage, '/p/x.ivp', bytes('AAAA'));
    const observed: string[] = [];
    const original = storage.rename.bind(storage);
    storage.rename = async (from: string, to: string) => {
      if (await storage.exists('/p/x.ivp')) observed.push(await read(storage, '/p/x.ivp'));
      await original(from, to);
    };
    await writeAtomic(storage, '/p/x.ivp', bytes('BBBB'));
    expect(observed.every((c) => c === 'AAAA' || c === 'BBBB')).toBe(true);
  });

  it('TEST-STO-010: informa de cuántos respaldos quedaron', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('v1'));
    const second = await writeAtomic(storage, '/p/x.ivp', bytes('v2'));
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.backupsKept).toBe(1);
  });
});

describe('recuperación', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('TEST-STO-011: localiza los respaldos existentes, del más reciente al más antiguo', async () => {
    for (const v of ['v1', 'v2', 'v3']) await writeAtomic(storage, '/p/x.ivp', bytes(v));
    const backups = await findBackups(storage, '/p/x.ivp');
    expect(backups.map((b) => b.path)).toEqual(['/p/x.ivp.bak1', '/p/x.ivp.bak2']);
  });

  it('TEST-STO-012: detecta el temporal de un guardado interrumpido', async () => {
    // Su existencia es la señal de que la aplicación murió guardando, y ese
    // temporal puede contener el único trabajo de la última hora.
    await writeAtomic(storage, '/p/x.ivp', bytes('viejo'));
    storage.failOn = { op: 'rename', path: '.tmp-' };
    await writeAtomic(storage, '/p/x.ivp', bytes('trabajo reciente'));

    const interrupted = await findInterruptedWrites(storage, '/p/x.ivp');
    expect(interrupted).toHaveLength(1);
    const first = interrupted[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(await read(storage, first.path)).toBe('trabajo reciente');
    }
  });

  it('TEST-STO-013: no confunde el temporal de otro archivo', async () => {
    await writeAtomic(storage, '/p/a.ivp', bytes('a'));
    await writeAtomic(storage, '/p/b.ivp', bytes('b'));
    storage.failOn = { op: 'rename', path: '/p/a.ivp.tmp-' };
    await writeAtomic(storage, '/p/a.ivp', bytes('a2'));

    expect(await findInterruptedWrites(storage, '/p/b.ivp')).toHaveLength(0);
    expect(await findInterruptedWrites(storage, '/p/a.ivp')).toHaveLength(1);
  });

  it('TEST-STO-014: sin respaldos ni temporales la lista queda vacía', async () => {
    await writeAtomic(storage, '/p/x.ivp', bytes('v1'), { backupCount: 0 });
    expect(await findBackups(storage, '/p/x.ivp')).toEqual([]);
    expect(await findInterruptedWrites(storage, '/p/x.ivp')).toEqual([]);
  });
});
