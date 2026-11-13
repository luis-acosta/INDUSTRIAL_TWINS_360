/**
 * Pruebas de las ventanas del recorrido publicado
 * (E01, E02, E03, E05, E06, E08).
 *
 * Los dos fallos que persiguen estas pruebas son los que arruinan la confianza
 * en un recorrido de inspección: **no saber si se ha visto el álbum entero** y
 * **ver un hueco en blanco donde debía haber algo**. El primero se evita no
 * dando la vuelta al final del álbum; el segundo, omitiendo lo que falta en
 * lugar de dejar una tarjeta vacía, y no prometiendo embebido lo que el
 * navegador no sabe mostrar.
 */
import { describe, expect, it } from 'vitest';
import {
  albumPosition,
  canStepAlbum,
  documentUrlWithPage,
  documentWindow,
  isEmbeddableDocument,
  infoWindow,
  isFrameAllowed,
  mediaKindOf,
  mediaWindow,
  safeDownloadName,
  stepAlbum,
  type WindowContext,
} from './windows';
import { actionSchema, createInfoWindow, toManifest, type InfoWindow } from '@it360/domain';
import { makeDocument, makeMedia, makeProject, makeScene, testUuid } from '@it360/domain/testing';
import type { Manifest } from '@it360/domain';

const NOW = '2026-09-10T10:00:00.000Z';

/** Contexto con los medios y documentos indicados. */
function context(options: {
  readonly media?: readonly { id: string; name: string; mime: string }[];
  readonly documents?: readonly { id: string; mediaId: string; title: string }[];
  readonly missingUrls?: readonly string[];
}): WindowContext {
  const base = makeProject();

  const media = (options.media ?? []).map((entry, index) =>
    makeMedia(index + 1, {
      id: entry.id as never,
      originalName: entry.name,
      mime: entry.mime as never,
    }),
  );

  const documents = (options.documents ?? []).map((entry, index) =>
    makeDocument(index + 1, entry.mediaId, {
      id: entry.id as never,
      title: entry.title,
    }),
  );

  const manifest: Manifest = toManifest(
    { ...base, media, documents },
    { publishedAt: NOW, appVersion: '0.23.0', offlineCapable: true },
  );

  const urls = new Map<string, string>();
  for (const entry of media) {
    if ((options.missingUrls ?? []).includes(entry.id)) continue;
    urls.set(entry.id, `./medios/${entry.id}.bin`);
  }

  return { manifest, mediaUrls: urls };
}

const id = (n: number): string => testUuid(n);

/* ------------------------------------------------------------------ *
 * Álbum (E03)
 * ------------------------------------------------------------------ */

describe('stepAlbum', () => {
  it('TEST-WIN-001 avanza y retrocede de uno en uno', () => {
    expect(stepAlbum(0, 5, 1)).toBe(1);
    expect(stepAlbum(3, 5, -1)).toBe(2);
  });

  it('TEST-WIN-002 no da la vuelta al llegar al final', () => {
    // Un álbum que vuelve al principio sin avisar hace que el visitante no
    // sepa si ya lo ha visto entero, y en una inspección eso significa no
    // saber si vio todas las fotos del equipo.
    expect(stepAlbum(4, 5, 1)).toBe(4);
    expect(stepAlbum(0, 5, -1)).toBe(0);
  });

  it('TEST-WIN-003 el botón se desactiva en los extremos', () => {
    expect(canStepAlbum(0, 5, -1)).toBe(false);
    expect(canStepAlbum(0, 5, 1)).toBe(true);
    expect(canStepAlbum(4, 5, 1)).toBe(false);
    expect(canStepAlbum(4, 5, -1)).toBe(true);
  });

  it('TEST-WIN-004 con una sola foto no hay navegación', () => {
    expect(canStepAlbum(0, 1, 1)).toBe(false);
    expect(canStepAlbum(0, 1, -1)).toBe(false);
    expect(albumPosition(0, 1)).toBe('');
  });

  it('TEST-WIN-005 un álbum vacío no produce un índice inválido', () => {
    expect(stepAlbum(3, 0, 1)).toBe(0);
    expect(canStepAlbum(0, 0, 1)).toBe(false);
  });

  it('TEST-WIN-006 dice en qué foto se está', () => {
    expect(albumPosition(0, 12)).toBe('1 de 12');
    expect(albumPosition(11, 12)).toBe('12 de 12');
  });

  it('TEST-WIN-007 un salto mayor se queda dentro de los límites', () => {
    expect(stepAlbum(2, 5, 10)).toBe(4);
    expect(stepAlbum(2, 5, -10)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Qué se puede embeber (E05)
 * ------------------------------------------------------------------ */

describe('isEmbeddableDocument', () => {
  it('TEST-WIN-008 el PDF se muestra dentro del recorrido', () => {
    expect(isEmbeddableDocument('application/pdf')).toBe(true);
  });

  it('TEST-WIN-009 lo demás no se promete embebido', () => {
    // Un .docx o un .dwg en un marco produce una descarga o una página en
    // blanco según el navegador, y un recuadro en blanco dentro del recorrido
    // hace creer que algo ha fallado.
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/octet-stream',
      'text/plain',
    ]) {
      expect(isEmbeddableDocument(mime), mime).toBe(false);
    }
  });
});

describe('mediaKindOf', () => {
  it('TEST-WIN-010 clasifica por el tipo declarado, no por la extensión', () => {
    // El nombre del archivo lo pone quien lo exportó y puede mentir; el tipo
    // lo verificó la importación.
    expect(mediaKindOf('image/jpeg')).toBe('image');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('audio/mpeg')).toBe('audio');
    expect(mediaKindOf('application/pdf')).toBe('other');
  });
});

/* ------------------------------------------------------------------ *
 * Enmarcado (E08, D06)
 * ------------------------------------------------------------------ */

describe('isFrameAllowed', () => {
  it('TEST-WIN-011 admite una ruta relativa, que es contenido del paquete', () => {
    expect(isFrameAllowed('./documentos/p101.pdf', [])).toBe(true);
  });

  it('TEST-WIN-012 admite un origen que el autor declaró', () => {
    expect(isFrameAllowed('https://scada.planta.local/panel', ['https://scada.planta.local'])).toBe(
      true,
    );
  });

  it('TEST-WIN-013 rechaza un origen que no está en la política', () => {
    // El navegador lo bloquearía en silencio y el visitante vería un hueco;
    // comprobarlo aquí permite decir por qué.
    expect(isFrameAllowed('https://otro.sitio.com/x', ['https://scada.planta.local'])).toBe(false);
  });

  it('TEST-WIN-014 el puerto cuenta como parte del origen', () => {
    expect(isFrameAllowed('https://a.local:8443/x', ['https://a.local'])).toBe(false);
    expect(isFrameAllowed('https://a.local:8443/x', ['https://a.local:8443'])).toBe(true);
  });

  it('TEST-WIN-015 no admite un esquema que no es una página', () => {
    // `javascript:` dentro de un marco sería ejecución de código en la página
    // del recorrido; su origen no es ninguno de los declarados y se rechaza.
    expect(isFrameAllowed('javascript:alert(1)', ['https://a.local'])).toBe(false);
    expect(isFrameAllowed('data:text/html,<b>x</b>', ['https://a.local'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Ventanas de medios (E02, E03)
 * ------------------------------------------------------------------ */

describe('mediaWindow', () => {
  it('TEST-WIN-016 una sola foto abre una ventana de detalle', () => {
    const ctx = context({ media: [{ id: id(1), name: 'brida.jpg', mime: 'image/jpeg' }] });
    const win = mediaWindow(ctx, id(1), [], false);

    expect(win?.kind).toBe('media');
    if (win?.kind !== 'media') return;
    expect(win.items).toHaveLength(1);
    expect(win.items[0]?.kind).toBe('image');
    expect(win.index).toBe(0);
  });

  it('TEST-WIN-017 un álbum abre en la foto que se pulsó, no en la primera', () => {
    // Pulsar la tercera foto y que se abra la primera obliga a buscar otra vez
    // la que se quería ver.
    const ctx = context({
      media: [
        { id: id(1), name: 'a.jpg', mime: 'image/jpeg' },
        { id: id(2), name: 'b.jpg', mime: 'image/jpeg' },
        { id: id(3), name: 'c.jpg', mime: 'image/jpeg' },
      ],
    });

    const win = mediaWindow(ctx, id(3), [id(1), id(2), id(3)], false);
    expect(win?.kind).toBe('media');
    if (win?.kind !== 'media') return;

    expect(win.index).toBe(2);
    expect(win.items).toHaveLength(3);
    expect(win.title).toBe('c.jpg');
  });

  it('TEST-WIN-018 omite del álbum lo que no está en el paquete', () => {
    // Una tarjeta en blanco en medio del álbum parece un fallo del recorrido;
    // el visitante no tiene forma de saber que ahí debía haber algo.
    const ctx = context({
      media: [
        { id: id(1), name: 'a.jpg', mime: 'image/jpeg' },
        { id: id(2), name: 'b.jpg', mime: 'image/jpeg' },
      ],
      missingUrls: [id(2)],
    });

    const win = mediaWindow(ctx, id(1), [id(1), id(2)], false);
    expect(win?.kind).toBe('media');
    if (win?.kind !== 'media') return;
    expect(win.items).toHaveLength(1);
    expect(win.items[0]?.caption).toBe('a.jpg');
  });

  it('TEST-WIN-019 si no queda nada que mostrar no abre una ventana vacía', () => {
    const ctx = context({
      media: [{ id: id(1), name: 'a.jpg', mime: 'image/jpeg' }],
      missingUrls: [id(1)],
    });
    expect(mediaWindow(ctx, id(1), [], false)).toBeNull();
  });

  it('TEST-WIN-020 el índice no se sale cuando se omiten fotos anteriores', () => {
    // Pedir la tercera de un álbum del que faltan las dos primeras no puede
    // dejar el índice apuntando fuera de la lista.
    const ctx = context({
      media: [
        { id: id(1), name: 'a.jpg', mime: 'image/jpeg' },
        { id: id(2), name: 'b.jpg', mime: 'image/jpeg' },
        { id: id(3), name: 'c.jpg', mime: 'image/jpeg' },
      ],
      missingUrls: [id(1), id(2)],
    });

    const win = mediaWindow(ctx, id(3), [id(1), id(2), id(3)], false);
    expect(win?.kind).toBe('media');
    if (win?.kind !== 'media') return;

    expect(win.items).toHaveLength(1);
    expect(win.index).toBeLessThan(win.items.length);
    expect(win.index).toBe(0);
  });

  it('TEST-WIN-021 un medio que no existe en el manifiesto no abre nada', () => {
    const ctx = context({ media: [{ id: id(1), name: 'a.jpg', mime: 'image/jpeg' }] });
    expect(mediaWindow(ctx, id(99), [], false)).toBeNull();
  });

  it('TEST-WIN-022 conserva la petición de reproducción automática', () => {
    const ctx = context({ media: [{ id: id(1), name: 'v.mp4', mime: 'video/mp4' }] });
    const win = mediaWindow(ctx, id(1), [], true);

    expect(win?.kind).toBe('media');
    if (win?.kind !== 'media') return;
    expect(win.autoplay).toBe(true);
    expect(win.items[0]?.kind).toBe('video');
  });
});

/* ------------------------------------------------------------------ *
 * Ventanas de documento (E05)
 * ------------------------------------------------------------------ */

describe('documentWindow', () => {
  it('TEST-WIN-023 abre un PDF embebido con su título', () => {
    const ctx = context({
      media: [{ id: id(1), name: 'p101.pdf', mime: 'application/pdf' }],
      documents: [{ id: id(50), mediaId: id(1), title: 'Hoja de datos P-101' }],
    });

    const win = documentWindow(ctx, id(50), 1);
    expect(win?.kind).toBe('document');
    if (win?.kind !== 'document') return;

    expect(win.title).toBe('Hoja de datos P-101');
    expect(win.embeddable).toBe(true);
  });

  it('TEST-WIN-024 un documento que el navegador no muestra no se promete embebido', () => {
    const ctx = context({
      media: [{ id: id(1), name: 'plano.dwg', mime: 'application/octet-stream' }],
      documents: [{ id: id(50), mediaId: id(1), title: 'Plano mecánico' }],
    });

    const win = documentWindow(ctx, id(50), 1);
    expect(win?.kind).toBe('document');
    if (win?.kind !== 'document') return;
    expect(win.embeddable).toBe(false);
  });

  it('TEST-WIN-025 un documento sin archivo en el paquete no abre nada', () => {
    const ctx = context({
      media: [{ id: id(1), name: 'p101.pdf', mime: 'application/pdf' }],
      documents: [{ id: id(50), mediaId: id(1), title: 'Hoja' }],
      missingUrls: [id(1)],
    });
    expect(documentWindow(ctx, id(50), 1)).toBeNull();
  });

  it('TEST-WIN-026 una página menor que uno no se propaga', () => {
    const ctx = context({
      media: [{ id: id(1), name: 'p.pdf', mime: 'application/pdf' }],
      documents: [{ id: id(50), mediaId: id(1), title: 'Hoja' }],
    });

    const win = documentWindow(ctx, id(50), 0);
    expect(win?.kind).toBe('document');
    if (win?.kind !== 'document') return;
    expect(win.page).toBe(1);
  });
});

describe('documentUrlWithPage', () => {
  it('TEST-WIN-027 añade la página sólo cuando no es la primera', () => {
    expect(documentUrlWithPage('./doc.pdf', 1)).toBe('./doc.pdf');
    expect(documentUrlWithPage('./doc.pdf', 7)).toBe('./doc.pdf#page=7');
  });
});

/* ------------------------------------------------------------------ *
 * Descargas (E06)
 * ------------------------------------------------------------------ */

describe('safeDownloadName', () => {
  it('TEST-WIN-028 usa el nombre sugerido cuando es usable', () => {
    expect(safeDownloadName('Hoja de datos P-101.pdf', 'archivo.bin')).toBe(
      'Hoja de datos P-101.pdf',
    );
  });

  it('TEST-WIN-029 recurre al nombre de reserva si no hay sugerencia', () => {
    expect(safeDownloadName(undefined, 'archivo.bin')).toBe('archivo.bin');
    expect(safeDownloadName('   ', 'archivo.bin')).toBe('archivo.bin');
  });

  it('TEST-WIN-030 corta cualquier ruta del nombre sugerido', () => {
    // Un nombre con `../` escrito en el proyecto no debe poder decidir dónde
    // se guarda el archivo.
    expect(safeDownloadName('../../etc/passwd', 'archivo.bin')).toBe('passwd');
    expect(safeDownloadName('C:\\Windows\\System32\\drivers\\etc\\hosts', 'a.bin')).toBe('hosts');
    expect(safeDownloadName('carpeta/sub/doc.pdf', 'a.bin')).toBe('doc.pdf');
  });

  it('TEST-WIN-031 quita los caracteres que el sistema de archivos rechaza', () => {
    expect(safeDownloadName('informe: "final" <v2>?.pdf', 'a.bin')).toBe('informe final v2.pdf');
  });

  it('TEST-WIN-032 no deja un nombre que empiece por punto', () => {
    // `.htaccess` o `.bashrc` como nombre de descarga es, en el mejor caso,
    // un archivo que el usuario no ve en su carpeta.
    expect(safeDownloadName('.htaccess', 'archivo.bin')).toBe('htaccess');
    expect(safeDownloadName('...', 'archivo.bin')).toBe('archivo.bin');
  });

  it('TEST-WIN-033 recorta un nombre absurdamente largo', () => {
    const largo = `${'a'.repeat(500)}.pdf`;
    expect(safeDownloadName(largo, 'a.bin').length).toBeLessThanOrEqual(200);
  });

  it('TEST-WIN-034 quita los caracteres de control', () => {
    expect(safeDownloadName('doc\u0000\u001f.pdf', 'a.bin')).toBe('doc.pdf');
  });
});

/* ------------------------------------------------------------------ *
 * Ventanas compuestas por el autor (E01, F08, F09)
 * ------------------------------------------------------------------ */

describe('infoWindow', () => {
  const windowWith = (blocks: InfoWindow['tabs'][number]['blocks']): InfoWindow => ({
    ...createInfoWindow('Ficha de la bomba', id(201), id(200)),
    tabs: [{ id: id(201) as InfoWindow['tabs'][number]['id'], title: 'General', blocks }],
  });

  it('TEST-WIN-030 el título y el texto llegan con las variables sustituidas', () => {
    const built = infoWindow(
      context({}),
      {
        ...windowWith([{ type: 'text', text: 'Está en **{{scene.title}}**.' }]),
        title: 'Ficha de {{scene.title}}',
      },
      { 'scene.title': 'Sala de bombas' },
    );

    expect(built.kind).toBe('info');
    if (built.kind !== 'info') return;
    expect(built.title).toBe('Ficha de Sala de bombas');

    const block = built.tabs[0]?.blocks[0];
    expect(block?.kind).toBe('richText');
    if (block?.kind !== 'richText') return;
    const spans = block.nodes[0]?.kind === 'paragraph' ? block.nodes[0].spans : [];
    expect(spans.find((span) => span.kind === 'bold')?.text).toBe('Sala de bombas');
  });

  it('TEST-WIN-031 sin título propio se usa el nombre de la ventana', () => {
    const built = infoWindow(context({}), { ...windowWith([]), title: '' }, {});
    expect(built.kind === 'info' && built.title).toBe('Ficha de la bomba');
  });

  it('TEST-WIN-032 una imagen del paquete se resuelve a su URL', () => {
    const built = infoWindow(
      context({ media: [{ id: id(10), name: 'bomba.jpg', mime: 'image/jpeg' }] }),
      windowWith([{ type: 'image', mediaId: id(10) as never, caption: 'Vista {{scene.title}}' }]),
      { 'scene.title': 'lateral' },
    );

    const block = built.kind === 'info' ? built.tabs[0]?.blocks[0] : undefined;
    expect(block?.kind).toBe('media');
    if (block?.kind !== 'media') return;
    expect(block.media.url).toContain(id(10));
    expect(block.media.kind).toBe('image');
    expect(block.caption).toBe('Vista lateral');
  });

  it('TEST-WIN-033 una imagen que falta del paquete se convierte en aviso, no en hueco', () => {
    // El visitante tiene que poder distinguir «aquí falta algo» de «aquí no
    // había nada», y el autor que prueba su recorrido necesita verlo.
    const built = infoWindow(
      context({ media: [{ id: id(10), name: 'bomba.jpg', mime: 'image/jpeg' }], missingUrls: [id(10)] }),
      windowWith([{ type: 'image', mediaId: id(10) as never, caption: '' }]),
      {},
    );

    const block = built.kind === 'info' ? built.tabs[0]?.blocks[0] : undefined;
    expect(block?.kind).toBe('missing');
  });

  it('TEST-WIN-034 los demás bloques sobreviven a uno roto', () => {
    const built = infoWindow(
      context({ media: [{ id: id(10), name: 'x.jpg', mime: 'image/jpeg' }], missingUrls: [id(10)] }),
      windowWith([
        { type: 'image', mediaId: id(10) as never, caption: '' },
        { type: 'text', text: 'El procedimiento sigue aquí.' },
      ]),
      {},
    );

    const blocks = built.kind === 'info' ? (built.tabs[0]?.blocks ?? []) : [];
    expect(blocks.map((block) => block.kind)).toEqual(['missing', 'richText']);
  });

  it('TEST-WIN-035 un documento se resuelve con su página y si se puede enmarcar', () => {
    const built = infoWindow(
      context({
        media: [{ id: id(11), name: 'hoja.pdf', mime: 'application/pdf' }],
        documents: [{ id: id(20), mediaId: id(11), title: 'Hoja de datos' }],
      }),
      windowWith([{ type: 'document', documentId: id(20) as never, page: 3 }]),
      {},
    );

    const block = built.kind === 'info' ? built.tabs[0]?.blocks[0] : undefined;
    expect(block?.kind).toBe('document');
    if (block?.kind !== 'document') return;
    expect(block.page).toBe(3);
    expect(block.embeddable).toBe(true);
    expect(block.title).toBe('Hoja de datos');
  });

  it('TEST-WIN-036 las pestañas se conservan en orden', () => {
    const built = infoWindow(
      context({}),
      {
        ...createInfoWindow('Ficha', id(201), id(200)),
        tabs: [
          {
            id: id(201) as InfoWindow['tabs'][number]['id'],
            title: 'General',
            blocks: [{ type: 'text', text: 'a' }],
          },
          {
            id: id(202) as InfoWindow['tabs'][number]['id'],
            title: 'Documentos',
            blocks: [{ type: 'text', text: 'b' }],
          },
        ],
      },
      {},
    );

    expect(built.kind === 'info' && built.tabs.map((tab) => tab.title)).toEqual([
      'General',
      'Documentos',
    ]);
  });

  it('TEST-WIN-037 las acciones de cierre viajan con la ventana', () => {
    const closing = [
      actionSchema.parse({ id: id(210), event: 'click', config: { type: 'stopTour' } }),
    ];
    const built = infoWindow(context({}), { ...windowWith([]), onCloseActions: closing }, {});

    expect(built.kind === 'info' && built.onClose).toHaveLength(1);
  });

  it('TEST-WIN-038 el contenido web pasa su dirección tal cual, para que el visor decida', () => {
    // La decisión de enmarcar o no depende de la política del paquete, que
    // sólo se conoce en el visor; aquí sólo se traslada.
    const built = infoWindow(
      context({}),
      windowWith([
        { type: 'webframe', url: 'https://mapa.example.com/x', heightPx: 300, allowFullscreen: true },
      ]),
      {},
    );

    const block = built.kind === 'info' ? built.tabs[0]?.blocks[0] : undefined;
    expect(block?.kind === 'webframe' && block.url).toBe('https://mapa.example.com/x');
    expect(block?.kind === 'webframe' && block.heightPx).toBe(300);
  });

  it('TEST-WIN-039 un enlace a escena toma el título de la escena si no tiene rótulo', () => {
    const base = makeProject();
    const scene = makeScene(30, base.id, { title: 'Plataforma superior' });
    const manifest = toManifest(
      { ...base, scenes: [scene] },
      { publishedAt: NOW, appVersion: '0.23.0', offlineCapable: true },
    );

    const built = infoWindow(
      { manifest, mediaUrls: new Map() },
      windowWith([{ type: 'sceneLink', sceneId: scene.id, label: '' }]),
      {},
    );

    const block = built.kind === 'info' ? built.tabs[0]?.blocks[0] : undefined;
    expect(block?.kind === 'sceneLink' && block.label).toBe('Plataforma superior');
  });
});
