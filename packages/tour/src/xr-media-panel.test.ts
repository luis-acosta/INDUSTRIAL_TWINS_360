/**
 * Pruebas del panel de multimedia de la sesión inmersiva (N10).
 *
 * Lo que se fija aquí es que el panel se compone con nodos de piel **de
 * verdad** —pasados por el esquema del contrato— y no con una estructura
 * paralela. Importa porque de eso depende que el panel se maquete, se pinte, se
 * apunte con el mando y se active con el mismo código que cualquier otro panel
 * del recorrido: si fuera una vía aparte, cada mejora del panel habría que
 * hacerla dos veces, y la segunda se olvidaría.
 */
import { describe, expect, it } from 'vitest';

import { skinNodeSchema } from '@it360/domain';

import {
  XR_MEDIA_CLOSE_ID,
  XR_MEDIA_PANEL_ID,
  xrMediaFromWindow,
  xrMediaPanelNodes,
} from './xr-media-panel';
import type { TourWindow } from './windows';

const VIDEO_WINDOW: TourWindow = {
  kind: 'media',
  title: 'Arranque de la bomba',
  items: [{ url: 'media/arranque.mp4', caption: 'Secuencia de arranque', kind: 'video' }],
  index: 0,
  autoplay: true,
  id: 'w1',
  widthPx: 720,
  heightPx: 480,
  modal: false,
  onClose: [],
} as unknown as TourWindow;

describe('xrMediaFromWindow', () => {
  it('describe la multimedia abierta', () => {
    // TEST-XMP-001
    expect(xrMediaFromWindow(VIDEO_WINDOW)).toEqual({
      title: 'Secuencia de arranque',
      kind: 'video',
      fraction: null,
    });
  });

  it('usa el título del álbum cuando la foto no tiene pie', () => {
    // TEST-XMP-002: en un panel de un renglón vale más el pie, que describe la
    // foto, y el título cuando no hay pie. Dejarlo vacío sería un panel sin
    // nada escrito.
    const win = {
      ...VIDEO_WINDOW,
      items: [{ url: 'media/a.jpg', caption: '', kind: 'image' }],
    } as unknown as TourWindow;

    expect(xrMediaFromWindow(win)?.title).toBe('Arranque de la bomba');
  });

  it('no compone panel para una ventana que ya tiene el suyo', () => {
    // TEST-XMP-003: una ventana de información o un cuestionario se pintan con
    // la piel del proyecto. Añadirles otro panel los mostraría dos veces.
    const info = { ...VIDEO_WINDOW, kind: 'info', tabs: [] } as unknown as TourWindow;

    expect(xrMediaFromWindow(info)).toBeNull();
    expect(xrMediaFromWindow(null)).toBeNull();
  });

  it('un documento sí compone panel, para poder decir que no se muestra', () => {
    // TEST-XMP-004: es lo contrario de dejar la acción muda.
    const doc = {
      ...VIDEO_WINDOW,
      kind: 'document',
      title: 'Manual de la bomba',
      url: 'docs/manual.pdf',
      page: 1,
      embeddable: true,
    } as unknown as TourWindow;

    expect(xrMediaFromWindow(doc)).toEqual({
      title: 'Manual de la bomba',
      kind: 'document',
      fraction: null,
    });
  });
});

describe('xrMediaPanelNodes', () => {
  it('devuelve nodos válidos según el contrato de piel', () => {
    // TEST-XMP-005: es la comprobación que sostiene todo lo demás. Si los nodos
    // no fueran válidos, la maquetación los descartaría y el panel saldría
    // vacío dentro del visor, donde nadie puede inspeccionarlo.
    const nodes = xrMediaPanelNodes({ title: 'Secuencia', kind: 'video', fraction: null });

    expect(nodes).toHaveLength(1);
    expect(() => skinNodeSchema.parse(nodes[0])).not.toThrow();
    expect(nodes[0]!.id).toBe(XR_MEDIA_PANEL_ID);
  });

  it('siempre incluye el botón de cerrar', () => {
    // TEST-XMP-006: dentro del visor no hay una tecla de escape que pulsar. Un
    // panel sin cierre deja al visitante con la ventana puesta hasta que se
    // quita las gafas.
    for (const kind of ['video', 'audio', 'image', 'document']) {
      const nodes = xrMediaPanelNodes({ title: 'x', kind, fraction: null });
      const ids = nodes[0]!.children.map((child) => child.id);
      expect(ids).toContain(XR_MEDIA_CLOSE_ID);
    }
  });

  it('la barra de progreso sólo aparece donde significa algo', () => {
    // TEST-XMP-007: una imagen y un documento no se reproducen; una barra a
    // cero junto a una foto se lee como «está cargando» y no carga nunca.
    const withBar = (kind: string): boolean =>
      xrMediaPanelNodes({ title: 'x', kind, fraction: null })[0]!.children.some(
        (child) => child.config.kind === 'progressBar',
      );

    expect(withBar('video')).toBe(true);
    expect(withBar('audio')).toBe(true);
    expect(withBar('image')).toBe(false);
    expect(withBar('document')).toBe(false);
  });

  it('un documento lleva escrito por qué no se muestra', () => {
    // TEST-XMP-008
    const nodes = xrMediaPanelNodes({ title: 'Manual', kind: 'document', fraction: null });
    const texts = nodes[0]!.children
      .map((child) => (child.config.kind === 'text' ? child.config.template : ''))
      .join(' ');

    expect(texts).toMatch(/quítese las gafas/i);
  });

  it('la barra lee la fuente «media» y no la del recorrido', () => {
    // TEST-XMP-009: el progreso lo pone el reproductor. Con la fuente «tour»,
    // la barra mostraría el avance del recorrido automático junto a un vídeo,
    // que es un número que no tiene nada que ver con lo que se está mirando.
    const bar = xrMediaPanelNodes({ title: 'x', kind: 'audio', fraction: null })[0]!.children.find(
      (child) => child.config.kind === 'progressBar',
    );

    expect(bar?.config.kind === 'progressBar' && bar.config.source).toBe('media');
  });
});
