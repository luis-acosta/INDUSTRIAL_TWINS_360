/**
 * Pruebas de las ventanas de información (E01, F08, F09).
 *
 * Dos cosas se vigilan por encima del resto: que el texto del autor no pueda
 * convertirse en código ejecutable, y que una dirección de red interna no se
 * pueda enmarcar. Las dos son puertas que, abiertas, convierten un paquete de
 * recorrido en una herramienta para alcanzar la red del cliente.
 */
import { describe, expect, it } from 'vitest';
import {
  canPublishInfoWindows,
  createInfoBlock,
  createInfoWindow,
  INFO_VARIABLES,
  isPrivateHost,
  moveBlock,
  parseRichText,
  referencedWindowIds,
  resolveVariables,
  richTextSummary,
  unknownVariables,
  validateInfoWindows,
  variablesIn,
  webframeProblem,
  type InfoWindow,
  type InfoWindowRefs,
} from './info-window';
import { actionSchema } from './action';
import { testUuid } from './testing';

const emptyRefs: InfoWindowRefs = {
  mediaIds: new Set<string>(),
  documentIds: new Set<string>(),
  assetIds: new Set<string>(),
  mappingIds: new Set<string>(),
  sceneIds: new Set<string>(),
};

const refsWith = (partial: Partial<InfoWindowRefs>): InfoWindowRefs => ({
  ...emptyRefs,
  ...partial,
});

const windowWith = (blocks: InfoWindow['tabs'][number]['blocks']): InfoWindow => ({
  ...createInfoWindow('Ficha de la bomba', testUuid(51), testUuid(50)),
  tabs: [{ id: testUuid(51), title: 'General', blocks }],
});

/* ------------------------------------------------------------------ *
 * Creación
 * ------------------------------------------------------------------ */

describe('createInfoWindow', () => {
  it('TEST-INF-001 nace con una pestaña, nunca con ninguna', () => {
    // Una ventana sin pestañas y una con una sola son lo mismo; tener los dos
    // casos obligaría a cada consumidor a distinguirlos.
    const window = createInfoWindow('Procedimiento', testUuid(51), testUuid(50));

    expect(window.tabs).toHaveLength(1);
    expect(window.tabs[0]?.blocks).toEqual([]);
    expect(window.title).toBe('Procedimiento');
    expect(window.modal).toBe(false);
  });

  it('TEST-INF-002 los tamaños por omisión vienen del esquema', () => {
    const window = createInfoWindow('X', testUuid(51), testUuid(50));
    expect(window.widthPx).toBe(720);
    expect(window.heightPx).toBe(520);
  });
});

describe('createInfoBlock', () => {
  it('TEST-INF-003 un bloque que necesita referencia no se crea sin ella', () => {
    // Crear un bloque de imagen sin imagen daría una ventana con un hueco que
    // el autor descubriría delante del visitante.
    expect(createInfoBlock('image')).toBeNull();
    expect(createInfoBlock('document')).toBeNull();
    expect(createInfoBlock('asset')).toBeNull();
    expect(createInfoBlock('telemetry')).toBeNull();
    expect(createInfoBlock('sceneLink')).toBeNull();
  });

  it('TEST-INF-004 con la referencia, el bloque trae sus valores por omisión', () => {
    const block = createInfoBlock('document', { documentId: testUuid(60) });
    expect(block).toEqual({ type: 'document', documentId: testUuid(60), page: 1 });
  });

  it('TEST-INF-005 el contenido web nace sin configurar, a propósito', () => {
    // Nunca apuntando a un sitio real que el autor no eligió.
    const block = createInfoBlock('webframe');
    expect(block?.type).toBe('webframe');
    if (block?.type !== 'webframe') return;
    expect(block.url).toContain('example.invalid');
    expect(webframeProblem(block.url)?.severity).toBe('warning');
  });
});

describe('moveBlock', () => {
  const tab = {
    id: testUuid(51),
    title: 'General',
    blocks: [
      { type: 'text' as const, text: 'uno' },
      { type: 'text' as const, text: 'dos' },
      { type: 'text' as const, text: 'tres' },
    ],
  };

  it('TEST-INF-006 mueve el bloque a la posición pedida', () => {
    const moved = moveBlock(tab, 0, 2);
    expect(moved.blocks.map((b) => (b.type === 'text' ? b.text : ''))).toEqual([
      'dos',
      'tres',
      'uno',
    ]);
  });

  it('TEST-INF-007 una posición fuera de rango se acota y no pierde bloques', () => {
    expect(moveBlock(tab, 0, 99).blocks).toHaveLength(3);
    expect(moveBlock(tab, 99, 0)).toBe(tab);
    expect(moveBlock(tab, 1, 1)).toBe(tab);
  });
});

/* ------------------------------------------------------------------ *
 * Variables (F09)
 * ------------------------------------------------------------------ */

describe('variables', () => {
  it('TEST-INF-008 encuentra las variables sin repetir', () => {
    expect(variablesIn('{{scene.title}} y {{scene.title}} con {{score.total}}')).toEqual([
      'scene.title',
      'score.total',
    ]);
  });

  it('TEST-INF-009 admite espacios dentro de las llaves', () => {
    expect(variablesIn('{{ scene.title }}')).toEqual(['scene.title']);
  });

  it('TEST-INF-010 sustituye con los valores dados', () => {
    expect(
      resolveVariables('Está en {{scene.title}} ({{score.total}} puntos)', {
        'scene.title': 'Sala de bombas',
        'score.total': 40,
      }),
    ).toBe('Está en Sala de bombas (40 puntos)');
  });

  it('TEST-INF-011 una variable sin valor se queda vacía, no con las llaves', () => {
    // El visitante no tiene por qué leer la plantilla del autor.
    expect(resolveVariables('Hola {{nadie}}.', {})).toBe('Hola .');
  });

  it('TEST-INF-012 denuncia las variables que el visor no sabe rellenar', () => {
    expect(unknownVariables('{{scene.title}} {{inventada}}')).toEqual(['inventada']);
  });

  it('TEST-INF-013 no denuncia las variables del propio recorrido', () => {
    // `var:` son las que el recorrido define con `setVariable`, y aquí no se
    // puede saber si existirán.
    expect(unknownVariables('{{var:quiz.aciertos}}')).toEqual([]);
    // Y la puntuación con clave libre del autor.
    expect(unknownVariables('{{score.seguridad}}')).toEqual([]);
    // Pero el espacio a secas, sin clave, no vale.
    expect(unknownVariables('{{score.}}')).toEqual(['score.']);
  });

  it('TEST-INF-014 todas las variables documentadas se consideran conocidas', () => {
    for (const name of Object.keys(INFO_VARIABLES)) {
      expect(unknownVariables(`{{${name}}}`)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Texto con formato
 * ------------------------------------------------------------------ */

describe('parseRichText', () => {
  it('TEST-INF-015 separa párrafos por línea en blanco', () => {
    const nodes = parseRichText('Primero.\n\nSegundo.');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({ kind: 'paragraph', spans: [{ kind: 'plain', text: 'Primero.' }] });
  });

  it('TEST-INF-016 une las líneas seguidas en un párrafo', () => {
    const nodes = parseRichText('Una línea\ny su continuación.');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind === 'paragraph' && nodes[0].spans[0]?.text).toBe(
      'Una línea y su continuación.',
    );
  });

  it('TEST-INF-017 reconoce negrita, cursiva y código', () => {
    const nodes = parseRichText('Pulse **arranque**, luego *espere* y revise `P-101`.');
    const spans = nodes[0]?.kind === 'paragraph' ? nodes[0].spans : [];

    expect(spans.find((s) => s.kind === 'bold')?.text).toBe('arranque');
    expect(spans.find((s) => s.kind === 'italic')?.text).toBe('espere');
    expect(spans.find((s) => s.kind === 'code')?.text).toBe('P-101');
  });

  it('TEST-INF-018 reconoce listas con guión, asterisco o viñeta', () => {
    const nodes = parseRichText('- uno\n* dos\n• tres');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind === 'list' && nodes[0].items).toHaveLength(3);
  });

  it('TEST-INF-019 admite enlaces https', () => {
    const nodes = parseRichText('Vea [la ficha](https://ejemplo.com/ficha).');
    const link = nodes[0]?.kind === 'paragraph' ? nodes[0].spans.find((s) => s.kind === 'link') : undefined;

    expect(link?.kind === 'link' && link.href).toBe('https://ejemplo.com/ficha');
    expect(link?.text).toBe('la ficha');
  });

  it('TEST-INF-020 un enlace «javascript:» se degrada a texto', () => {
    // Es el caso que importa: el texto del autor no puede ejecutar nada.
    const nodes = parseRichText('[pulse aquí](javascript:alert(1))');
    const spans = nodes[0]?.kind === 'paragraph' ? nodes[0].spans : [];

    expect(spans.every((span) => span.kind !== 'link')).toBe(true);
    expect(spans[0]?.text).toBe('pulse aquí');
    // El análisis corta en el primer paréntesis que cierra, así que queda uno
    // suelto en el texto. Es cosmético y sólo ocurre con una entrada hostil:
    // lo que no puede ocurrir es que salga un enlace.
    expect(spans.map((span) => span.text).join('')).toBe('pulse aquí)');
  });

  it('TEST-INF-021 tampoco admite «data:» ni «http»', () => {
    for (const href of ['data:text/html,<script>x</script>', 'http://ejemplo.com']) {
      const nodes = parseRichText(`[x](${href})`);
      const spans = nodes[0]?.kind === 'paragraph' ? nodes[0].spans : [];
      expect(spans.every((span) => span.kind !== 'link')).toBe(true);
    }
  });

  it('TEST-INF-022 el marcado HTML sale como texto, no como elementos', () => {
    // No se sanea nada porque no se produce HTML: el consumidor recibe datos.
    const nodes = parseRichText('<script>alert(1)</script> y <b>negrita</b>');
    const text = nodes[0]?.kind === 'paragraph' ? nodes[0].spans.map((s) => s.text).join('') : '';

    expect(text).toBe('<script>alert(1)</script> y <b>negrita</b>');
    expect(nodes[0]?.kind === 'paragraph' && nodes[0].spans.every((s) => s.kind === 'plain')).toBe(
      true,
    );
  });

  it('TEST-INF-023 un texto vacío no produce nodos', () => {
    expect(parseRichText('')).toEqual([]);
    expect(parseRichText('\n\n  \n')).toEqual([]);
  });

  it('TEST-INF-024 el resumen quita el formato y recorta', () => {
    expect(richTextSummary('**Arranque** de la bomba')).toBe('Arranque de la bomba');
    expect(richTextSummary('a'.repeat(200), 20)).toHaveLength(20);
    expect(richTextSummary('- uno\n- dos')).toBe('uno · dos');
  });
});

/* ------------------------------------------------------------------ *
 * Contenido web (E09)
 * ------------------------------------------------------------------ */

describe('webframeProblem', () => {
  it('TEST-INF-025 una dirección https pública se admite', () => {
    expect(webframeProblem('https://www.openstreetmap.org/export/embed.html')).toBeNull();
  });

  it('TEST-INF-026 sólo https', () => {
    expect(webframeProblem('http://ejemplo.com')?.severity).toBe('blocking');
    expect(webframeProblem('ftp://ejemplo.com')?.severity).toBe('blocking');
  });

  it('TEST-INF-027 una dirección mal escrita se denuncia', () => {
    expect(webframeProblem('no es una url')?.severity).toBe('blocking');
  });

  it('TEST-INF-028 no se puede enmarcar la red interna', () => {
    // El recorrido se abre dentro de la red del cliente: un marco a un equipo
    // interno convierte el paquete en una vía para alcanzarlo.
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.5',
      '169.254.169.254',
      'servidor',
      'nas.local',
      '[::1]',
    ]) {
      expect(webframeProblem(`https://${host}/x`)?.severity, host).toBe('blocking');
    }
  });

  it('TEST-INF-029 un dominio público normal no se confunde con red interna', () => {
    for (const host of ['ejemplo.com', 'www.youtube.com', 'maps.google.com', '8.8.8.8']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('TEST-INF-030 el metadato de nube se considera interno', () => {
    // 169.254.169.254 es el servicio de metadatos de las nubes: enmarcarlo es
    // la forma clásica de sacar credenciales de una máquina.
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------ */

describe('validateInfoWindows', () => {
  it('TEST-INF-031 una referencia muerta impide publicar', () => {
    const problems = validateInfoWindows(
      [windowWith([{ type: 'image', mediaId: testUuid(70), caption: '' }])],
      emptyRefs,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('blocking');
    expect(problems[0]?.blockIndex).toBe(0);
    expect(canPublishInfoWindows(problems)).toBe(false);
  });

  it('TEST-INF-032 con la referencia viva no hay problema', () => {
    const problems = validateInfoWindows(
      [windowWith([{ type: 'image', mediaId: testUuid(70), caption: '' }])],
      refsWith({ mediaIds: new Set([testUuid(70)]) }),
    );

    expect(problems).toEqual([]);
  });

  it('TEST-INF-033 una ventana sin contenido avisa pero no bloquea', () => {
    const problems = validateInfoWindows(
      [createInfoWindow('Vacía', testUuid(51), testUuid(50))],
      emptyRefs,
    );

    expect(problems[0]?.severity).toBe('warning');
    expect(canPublishInfoWindows(problems)).toBe(true);
  });

  it('TEST-INF-034 un texto vacío y una variable desconocida avisan', () => {
    const problems = validateInfoWindows(
      [
        windowWith([
          { type: 'text', text: '  ' },
          { type: 'text', text: '{{inventada}}' },
        ]),
      ],
      emptyRefs,
    );

    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.severity === 'warning')).toBe(true);
    expect(problems[1]?.message).toContain('{{inventada}}');
  });

  it('TEST-INF-035 dos pestañas con el mismo nombre avisan', () => {
    const window: InfoWindow = {
      ...createInfoWindow('Ficha', testUuid(51), testUuid(50)),
      tabs: [
        { id: testUuid(51), title: 'General', blocks: [{ type: 'text', text: 'a' }] },
        { id: testUuid(52), title: 'General', blocks: [{ type: 'text', text: 'b' }] },
      ],
    };

    const problems = validateInfoWindows([window], emptyRefs);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('dos pestañas');
  });

  it('TEST-INF-036 el contenido web interno impide publicar', () => {
    const problems = validateInfoWindows(
      [windowWith([{ type: 'webframe', url: 'https://192.168.1.10/', heightPx: 420, allowFullscreen: false }])],
      emptyRefs,
    );

    expect(problems[0]?.severity).toBe('blocking');
    expect(canPublishInfoWindows(problems)).toBe(false);
  });

  it('TEST-INF-037 el contenido web sin configurar avisa y deja publicar', () => {
    const problems = validateInfoWindows(
      [windowWith([{ type: 'webframe', url: 'https://example.invalid/', heightPx: 420, allowFullscreen: false }])],
      emptyRefs,
    );

    expect(problems[0]?.severity).toBe('warning');
    expect(canPublishInfoWindows(problems)).toBe(true);
  });

  it('TEST-INF-038 cada tipo de referencia se comprueba contra su colección', () => {
    const problems = validateInfoWindows(
      [
        windowWith([
          { type: 'document', documentId: testUuid(60), page: 1 },
          { type: 'asset', assetId: testUuid(61) },
          { type: 'telemetry', mappingId: testUuid(62) },
          { type: 'sceneLink', sceneId: testUuid(63), label: '' },
        ]),
      ],
      refsWith({
        documentIds: new Set([testUuid(60)]),
        assetIds: new Set([testUuid(61)]),
        mappingIds: new Set([testUuid(62)]),
        // La escena falta a propósito.
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('escena');
  });
});

describe('referencedWindowIds', () => {
  it('TEST-INF-039 reúne las ventanas a las que apunta alguna acción', () => {
    const action = actionSchema.parse({
      id: testUuid(90),
      event: 'click',
      config: { type: 'openInfoWindow', windowId: testUuid(50), modal: false },
    });

    expect([...referencedWindowIds([action])]).toEqual([testUuid(50)]);
  });

  it('TEST-INF-040 una lista sin ventanas da un conjunto vacío', () => {
    const action = actionSchema.parse({
      id: testUuid(91),
      event: 'click',
      config: { type: 'stopTour' },
    });

    expect(referencedWindowIds([action]).size).toBe(0);
  });
});
