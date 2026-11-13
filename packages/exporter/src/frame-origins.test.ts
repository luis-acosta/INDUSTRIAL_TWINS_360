/**
 * Pruebas de los orígenes enmarcables del recorrido publicado (E05, E08, D06).
 *
 * Lo que se vigila aquí es que abrir la puerta a los Webframes **no la deje
 * abierta**. El recorrido se sirve desde la intranet del cliente; un
 * `frame-src *` convertiría cada marco en una ventana a la que ni el autor ni
 * el cliente han dado el visto bueno, y además lo haría para siempre, también
 * en los recorridos que no usan ningún Webframe.
 */
import { describe, expect, it } from 'vitest';
import { collectFrameOrigins, frameSrcDirective } from './frame-origins';
import { makeHotspot, makeProject, makeScene, testUuid } from '@it360/domain/testing';
import { skinSchema, type Action, type Project, type Scene } from '@it360/domain';

const NOW = '2026-09-01T10:00:00.000Z';

/** Acción de Webframe con la URL dada. */
function webframeAction(url: string): Action {
  return {
    id: testUuid(90),
    event: 'click',
    config: { type: 'openWebframe', url, width: 960, height: 600, allowFullscreen: false },
    order: 0,
    delayMs: 0,
    focusDwellMs: 1200,
    once: false,
    requiresScore: null,
    enabled: true,
  } as Action;
}

/** Proyecto con las acciones de Webframe indicadas en un marcador. */
function projectWith(urls: readonly string[], over: Partial<Scene> = {}): Project {
  const base = makeProject();
  const scene = makeScene(1, base.id, {
    hotspots: [
      {
        ...makeHotspot(1, base.id),
        actions: urls.map(webframeAction),
      },
    ],
    ...over,
  });

  return { ...base, scenes: [scene] };
}

/* ------------------------------------------------------------------ *
 * Recolección
 * ------------------------------------------------------------------ */

describe('collectFrameOrigins', () => {
  it('TEST-FRM-001 un recorrido sin Webframes no admite ningún origen', () => {
    // Es el caso normal, y la política debe quedarse en `self`: nada de abrir
    // la puerta por si algún día hace falta.
    const report = collectFrameOrigins(makeProject());
    expect(report.origins).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(frameSrcDirective(report.origins)).toBe("'self'");
  });

  it('TEST-FRM-002 reúne el origen de una acción de Webframe', () => {
    const report = collectFrameOrigins(
      projectWith(['https://scada.planta.local/panel?tag=P-101']),
    );

    expect(report.origins).toEqual(['https://scada.planta.local']);
    expect(frameSrcDirective(report.origins)).toBe("'self' https://scada.planta.local");
  });

  it('TEST-FRM-003 guarda el origen, no la ruta ni la consulta', () => {
    // Admitir la URL completa no sirve de nada: la política trabaja con
    // orígenes. Guardar la ruta daría una falsa sensación de precisión.
    const report = collectFrameOrigins(
      projectWith(['https://scada.planta.local/a/b/c?x=1#frag']),
    );
    expect(report.origins).toEqual(['https://scada.planta.local']);
  });

  it('TEST-FRM-004 no repite el mismo origen', () => {
    const report = collectFrameOrigins(
      projectWith([
        'https://scada.planta.local/uno',
        'https://scada.planta.local/dos',
        'https://otro.planta.local/tres',
      ]),
    );
    expect(report.origins).toEqual([
      'https://otro.planta.local',
      'https://scada.planta.local',
    ]);
  });

  it('TEST-FRM-005 conserva el puerto, que es parte del origen', () => {
    const report = collectFrameOrigins(projectWith(['https://scada.planta.local:8443/panel']));
    expect(report.origins).toEqual(['https://scada.planta.local:8443']);
  });

  it('TEST-FRM-006 rechaza http y explica por qué', () => {
    // El navegador lo bloquearía igual al servirse el recorrido por https;
    // admitirlo sólo serviría para que el fallo apareciera más tarde y con
    // peor mensaje.
    const report = collectFrameOrigins(projectWith(['http://scada.planta.local/panel']));

    expect(report.origins).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.reason).toContain('https');
  });

  it('TEST-FRM-007 ignora la dirección de ejemplo de un componente sin configurar', () => {
    const report = collectFrameOrigins(projectWith(['https://example.invalid/']));
    expect(report.origins).toEqual([]);
    expect(report.rejected[0]?.reason).toContain('sin configurar');
  });

  it('TEST-FRM-008 recoge también los Webframes de las interfaces', () => {
    const base = makeProject();
    const skin = skinSchema.parse({
      id: testUuid(70),
      name: 'Interfaz',
      root: [
        {
          id: 'n1',
          name: 'Panel SCADA',
          config: { kind: 'webframe', url: 'https://scada.planta.local/panel' },
          box: {},
          style: {},
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const report = collectFrameOrigins({ ...base, skins: [skin] });
    expect(report.origins).toEqual(['https://scada.planta.local']);
  });

  it('TEST-FRM-009 recoge los de un marcador de tipo Webframe', () => {
    const base = makeProject();
    const hotspot = makeHotspot(1, base.id);
    const scene = makeScene(1, base.id, {
      hotspots: [
        {
          ...hotspot,
          geometry: {
            shape: 'webframe',
            url: 'https://manual.planta.local/p101',
            widthPx: 640,
            heightPx: 400,
          } as (typeof hotspot)['geometry'],
        },
      ],
    });

    const report = collectFrameOrigins({ ...base, scenes: [scene] });
    expect(report.origins).toEqual(['https://manual.planta.local']);
  });

  it('TEST-FRM-010 no mira las escenas excluidas de la publicación', () => {
    // Lo que no se publica no puede necesitar permiso en la política del
    // paquete publicado.
    const report = collectFrameOrigins(
      projectWith(['https://scada.planta.local/panel'], { excludedFromPublish: true }),
    );
    expect(report.origins).toEqual([]);
  });

  it('TEST-FRM-011 una URL ilegible se rechaza sin lanzar', () => {
    const report = collectFrameOrigins(projectWith(['no soy una url']));
    expect(report.origins).toEqual([]);
    expect(report.rejected[0]?.reason).toContain('no es una dirección válida');
  });

  it('TEST-FRM-012 el resultado es estable entre publicaciones', () => {
    // Si el orden variara, cada publicación cambiaría la política aunque el
    // proyecto fuera el mismo, y un cambio real pasaría desapercibido.
    const project = projectWith([
      'https://zeta.planta.local/a',
      'https://alfa.planta.local/b',
      'https://media.planta.local/c',
    ]);

    const una = collectFrameOrigins(project);
    const otra = collectFrameOrigins(project);
    expect(una.origins).toEqual(otra.origins);
    expect([...una.origins]).toEqual([...una.origins].sort());
  });
});

/* ------------------------------------------------------------------ *
 * Directiva
 * ------------------------------------------------------------------ */

describe('frameSrcDirective', () => {
  it('TEST-FRM-013 siempre incluye el propio paquete', () => {
    // Es lo que permite mostrar un PDF del recorrido dentro del recorrido.
    expect(frameSrcDirective([])).toContain("'self'");
    expect(frameSrcDirective(['https://a.local'])).toContain("'self'");
  });

  it('TEST-FRM-014 nunca produce un comodín', () => {
    // Un comodín de subdominios admitiría cualquier host que alguien levante
    // bajo ese dominio, y eso ya no es una decisión del autor.
    const directive = frameSrcDirective(['https://a.local', 'https://b.local:8443']);
    expect(directive).not.toContain('*');
    expect(directive).toBe("'self' https://a.local https://b.local:8443");
  });

  it('TEST-FRM-015 no deja entrar «unsafe» ni esquemas sueltos', () => {
    const directive = frameSrcDirective(collectFrameOrigins(makeProject()).origins);
    expect(directive).not.toContain('unsafe');
    expect(directive).not.toContain('data:');
    expect(directive).not.toContain('http:');
  });
});
