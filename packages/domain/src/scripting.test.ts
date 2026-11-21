import { describe, expect, it } from 'vitest';
import {
  auditScript,
  BLOCKED_GLOBALS,
  decideScriptExecution,
  DEFAULT_SCRIPTING_POLICY,
  SCRIPT_API_SURFACE,
  scriptDigest,
  scriptPreview,
  type ScriptApproval,
  type ScriptingPolicy,
} from './scripting';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const approval = (sha256: string): ScriptApproval => ({
  sha256,
  approvedBy: 'u-admin',
  approvedAt: '2026-11-12T19:00:00.000Z',
  justification: 'Revisado con el integrador',
  preview: 'ui.hide("panel");',
});

const policy = (overrides: Partial<ScriptingPolicy> = {}): ScriptingPolicy => ({
  ...DEFAULT_SCRIPTING_POLICY,
  ...overrides,
});

/**
 * TEST-SCR-001 .. TEST-SCR-016
 * Requisito: J09 (etapa 03). Límite de confianza de la arquitectura:
 * «JavaScript personalizado es riesgo alto: deshabilitado por defecto, solo
 * administradores y contexto aislado, sin acceso al sistema operativo».
 */
describe('política por defecto', () => {
  it('TEST-SCR-001: el producto llega con los scripts desactivados', () => {
    expect(DEFAULT_SCRIPTING_POLICY.mode).toBe('disabled');
    expect(DEFAULT_SCRIPTING_POLICY.allowInPublished).toBe(false);
    expect(DEFAULT_SCRIPTING_POLICY.approvals).toEqual([]);
  });

  it('TEST-SCR-002: desactivado, nada se ejecuta ni siquiera siendo administrador', () => {
    const decision = decideScriptExecution(policy(), SHA_A, {
      published: false,
      isAdministrator: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('scriptingDisabled');
  });

  it('TEST-SCR-003: el mensaje dice dónde se habilita', () => {
    // Un «no funciona» silencioso lleva a desactivar la seguridad a ciegas.
    const decision = decideScriptExecution(policy(), SHA_A, { published: false, isAdministrator: true });
    if (!decision.allowed) {
      expect(decision.message).toContain('Ajustes');
      expect(decision.message.length).toBeGreaterThan(40);
    }
  });
});

describe('aprobación por huella', () => {
  it('TEST-SCR-004: un script aprobado se ejecuta', () => {
    const decision = decideScriptExecution(
      policy({ mode: 'approvedOnly', approvals: [approval(SHA_A)] }),
      SHA_A,
      { published: false, isAdministrator: false },
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.reason).toBe('approved');
  });

  it('TEST-SCR-005: un script importado sin aprobar NO se ejecuta', () => {
    // Si abrir un proyecto ejecutara su código, el formato de proyecto sería
    // un vector de ejecución remota.
    const decision = decideScriptExecution(policy({ mode: 'approvedOnly' }), SHA_A, {
      published: false,
      isAdministrator: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('notApproved');
  });

  it('TEST-SCR-006: editar el script invalida la aprobación', () => {
    // Lo aprobado fue ese texto, no «los scripts de este proyecto».
    const decision = decideScriptExecution(
      policy({ mode: 'approvedOnly', approvals: [approval(SHA_A)] }),
      SHA_B,
      { published: false, isAdministrator: true },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('approvalStale');
      expect(decision.message).toContain('ha cambiado');
    }
  });

  it('TEST-SCR-007: la aprobación es por script y no por proyecto', () => {
    const p = policy({ mode: 'approvedOnly', approvals: [approval(SHA_A)] });
    expect(decideScriptExecution(p, SHA_A, { published: false, isAdministrator: false }).allowed).toBe(true);
    expect(decideScriptExecution(p, SHA_B, { published: false, isAdministrator: false }).allowed).toBe(false);
  });
});

describe('contexto publicado', () => {
  it('TEST-SCR-008: el recorrido publicado no ejecuta scripts por defecto', () => {
    const decision = decideScriptExecution(
      policy({ mode: 'approvedOnly', approvals: [approval(SHA_A)] }),
      SHA_A,
      { published: true, isAdministrator: true },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('publishedContext');
  });

  it('TEST-SCR-009: habilitarlo expresamente permite el script aprobado', () => {
    const decision = decideScriptExecution(
      policy({ mode: 'approvedOnly', approvals: [approval(SHA_A)], allowInPublished: true }),
      SHA_A,
      { published: true, isAdministrator: false },
    );
    expect(decision.allowed).toBe(true);
  });

  it('TEST-SCR-010: incluso habilitado, un script no aprobado sigue bloqueado', () => {
    const decision = decideScriptExecution(
      policy({ mode: 'approvedOnly', allowInPublished: true }),
      SHA_A,
      { published: true, isAdministrator: true },
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('modo de desarrollo', () => {
  it('TEST-SCR-011: requiere permisos de administrador', () => {
    const p = policy({ mode: 'allProjectScripts' });
    expect(decideScriptExecution(p, SHA_A, { published: false, isAdministrator: true }).allowed).toBe(true);
    const denied = decideScriptExecution(p, SHA_A, { published: false, isAdministrator: false });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe('notAdministrator');
  });

  it('TEST-SCR-012: el modo de desarrollo no se aplica en publicación', () => {
    const decision = decideScriptExecution(
      policy({ mode: 'allProjectScripts' }),
      SHA_A,
      { published: true, isAdministrator: true },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('publishedContext');
  });
});

describe('superficie expuesta', () => {
  it('TEST-SCR-013: la API del script es una lista blanca corta', () => {
    expect(SCRIPT_API_SURFACE.length).toBeLessThanOrEqual(8);
    expect(SCRIPT_API_SURFACE).toEqual(['tour', 'vars', 'ui', 'log', 'scene']);
  });

  it('TEST-SCR-014: los globales de red, almacenamiento y contenedor están bloqueados', () => {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'indexedDB', 'eval', 'Function', '__TAURI__', 'process', 'document']) {
      expect(BLOCKED_GLOBALS, name).toContain(name);
    }
  });

  it('TEST-SCR-015: la API expuesta y los globales bloqueados no se solapan', () => {
    const blocked = new Set<string>(BLOCKED_GLOBALS);
    for (const api of SCRIPT_API_SURFACE) {
      expect(blocked.has(api), `la API ${api} no debe estar en la lista de bloqueo`).toBe(false);
    }
  });
});

describe('revisión previa de scripts', () => {
  it('TEST-SCR-016: detecta los intentos evidentes de salir del recinto', () => {
    const cases: Array<[string, string]> = [
      ['fetch("https://x")', 'red'],
      ['const m = await import("fs")', 'módulos'],
      ['require("child_process")', 'Node'],
      ['new Function("return this")()', 'texto'],
      ['eval("1+1")', 'texto'],
      ['window.__TAURI__.invoke("x")', 'aplicación'],
      ['process.env.TOKEN', 'sistema'],
      ['localStorage.setItem("a","b")', 'navegador'],
      ['({})["constructor"]["constructor"]("return this")()', 'constructor'],
      ['document.querySelector("body")', 'DOM'],
    ];
    for (const [source, expectedWord] of cases) {
      const audit = auditScript(source);
      expect(audit.findings.length, source).toBeGreaterThan(0);
      expect(audit.findings.some((f) => f.reason.includes(expectedWord)), source).toBe(true);
    }
  });

  it('TEST-SCR-017: un script que usa sólo la API expuesta no genera avisos', () => {
    const source = `
      // Oculta el panel de ayuda y suma puntos de seguridad.
      ui.hide("panel-ayuda");
      vars.set("seguridad", vars.get("seguridad") + 1);
      log.info("Panel oculto");
      tour.goToScene(scene.id);
    `;
    expect(auditScript(source).findings).toEqual([]);
  });

  it('TEST-SCR-018: informa del tamaño para que el revisor sepa qué asume', () => {
    const audit = auditScript('ui.hide("a");\nui.show("b");\n');
    expect(audit.lineCount).toBe(3);
    expect(audit.byteSize).toBeGreaterThan(20);
  });

  it('TEST-SCR-019: la vista previa salta comentarios y líneas vacías', () => {
    expect(scriptPreview('\n\n// comentario\nui.hide("x");')).toBe('ui.hide("x");');
    expect(scriptPreview('')).toBe('');
    expect(scriptPreview(`${'a'.repeat(200)};`, 50)).toHaveLength(50);
  });
});

describe('scriptDigest', () => {
  it('calcula el SHA-256 del código tal cual', () => {
    // TEST-SCR-D01: sin normalizar ni recortar. Un espacio de más es otro
    // código, y «aprobé algo muy parecido» no es aprobar.
    return scriptDigest('it360.log("hola");', globalThis.crypto.subtle).then((digest) => {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      return scriptDigest('it360.log("hola"); ', globalThis.crypto.subtle).then((otro) => {
        expect(otro).not.toBe(digest);
      });
    });
  });

  it('devuelve null cuando no hay SHA-256, en lugar de una reserva', async () => {
    // TEST-SCR-D02: es la decisión de seguridad del módulo. Una reserva que
    // mirara los primeros bytes haría que dos guiones con el mismo comienzo
    // compartieran huella: bastaría copiar el principio de un guion aprobado y
    // añadirle detrás lo que se quisiera. Sin SHA-256, lo correcto es no
    // ejecutar, y de eso se encarga quien recibe este `null`.
    expect(await scriptDigest('x', undefined)).toBeNull();
  });

  it('el mismo código da la misma huella', async () => {
    // TEST-SCR-D03: si no, una aprobación valdría para una sola ejecución.
    const a = await scriptDigest('const x = 1;', globalThis.crypto.subtle);
    const b = await scriptDigest('const x = 1;', globalThis.crypto.subtle);

    expect(a).toBe(b);
  });
});
