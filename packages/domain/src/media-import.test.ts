/**
 * Pruebas del alta de imágenes.
 *
 * Lo que de verdad se comprueba aquí: que no se cuele un SVG ejecutable y que
 * importar dos veces el mismo plano no duplique megabytes en el paquete.
 */
import { describe, expect, it } from 'vitest';
import {
  freeRelativePath,
  imageMimeOf,
  importImage,
  safeMediaFileName,
  svgThreat,
  type ImageImportInput,
} from './media-import';
import { MEDIA_SIZE_LIMITS, type Media } from './media';
import { ISO_NOW, makeMedia, testUuid } from './testing';

const base: ImageImportInput = {
  id: testUuid(200),
  sha256: 'a'.repeat(64),
  declaredMime: 'image/png',
  originalName: 'Plano Planta 1.png',
  byteSize: 2048,
  width: 1200,
  height: 800,
  createdAt: ISO_NOW,
};

describe('imageMimeOf', () => {
  it('TEST-IMP-001 acepta el tipo declarado por el navegador', () => {
    expect(imageMimeOf('image/png', 'cualquiera.bin')).toBe('image/png');
  });

  it('TEST-IMP-002 cae en la extensión cuando el navegador no declara tipo', () => {
    // Al arrastrar desde algunos gestores de archivos `File.type` viene vacío.
    expect(imageMimeOf('', 'plano.PNG')).toBe('image/png');
    expect(imageMimeOf('', 'plano.jpeg')).toBe('image/jpeg');
  });

  it('TEST-IMP-003 rechaza lo que no es imagen', () => {
    expect(imageMimeOf('application/pdf', 'plano.pdf')).toBeNull();
    expect(imageMimeOf('', 'plano')).toBeNull();
  });
});

describe('svgThreat', () => {
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="8" height="8"/></svg>';

  it('TEST-IMP-004 un SVG de dibujo pasa', () => {
    expect(svgThreat(clean)).toBeNull();
  });

  it('TEST-IMP-005 detecta script, manejadores y contenido incrustado', () => {
    expect(svgThreat('<svg><script>alert(1)</script></svg>')).toContain('JavaScript');
    expect(svgThreat('<svg><rect onload="alert(1)"/></svg>')).toContain('manejadores');
    expect(svgThreat('<svg><foreignObject><b>x</b></foreignObject></svg>')).toContain('HTML');
    expect(svgThreat('<svg><a href="javascript:alert(1)">x</a></svg>')).toContain('javascript');
    expect(svgThreat('<svg><iframe src="x"/></svg>')).toContain('externo');
  });

  it('TEST-IMP-006 detecta recursos de internet', () => {
    // Un plano que carga una imagen de un servidor deja de verse sin conexión,
    // que es justo cuando se usa el visor en planta.
    expect(svgThreat('<svg><image xlink:href="https://ejemplo/x.png"/></svg>')).toContain(
      'internet',
    );
  });

  it('TEST-IMP-007 no confunde atributos normales con manejadores', () => {
    expect(svgThreat('<svg><rect fill="none" stroke-dasharray="2 2"/></svg>')).toBeNull();
  });
});

describe('safeMediaFileName', () => {
  it('TEST-IMP-008 limpia acentos, espacios y mayúsculas', () => {
    expect(safeMediaFileName('Plano Planta Baja ñ.png', '.png')).toBe('plano-planta-baja-n.png');
  });

  it('TEST-IMP-009 no deja que el nombre escape de la carpeta', () => {
    // Un nombre con barras o puntos dobles no debe producir una ruta de salida.
    const name = safeMediaFileName('../../etc/passwd', '.png');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('TEST-IMP-010 un nombre sin caracteres útiles sigue dando un archivo', () => {
    expect(safeMediaFileName('***', '.png')).toBe('imagen.png');
  });
});

describe('freeRelativePath', () => {
  it('TEST-IMP-011 evita pisar una ruta ya ocupada', () => {
    const taken = ['media/plano.png', 'media/plano-2.png'];
    expect(freeRelativePath(taken, 'media', 'plano.png')).toBe('media/plano-3.png');
  });

  it('TEST-IMP-012 respeta la carpeta pedida', () => {
    expect(freeRelativePath([], 'media/planos', 'p.png')).toBe('media/planos/p.png');
  });
});

describe('importImage', () => {
  it('TEST-IMP-013 registra la imagen con su suma y sus dimensiones', () => {
    const result = importImage(base, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.reused).toBe(false);
    expect(result.value.media.sha256).toBe(base.sha256);
    expect(result.value.media.kind).toBe('image');
    expect(result.value.media.width).toBe(1200);
    expect(result.value.media.relativePath).toBe('media/plano-planta-1.png');
    expect(result.value.media.originalName).toBe('Plano Planta 1.png');
  });

  it('TEST-IMP-014 reutiliza el medio cuando el contenido ya está', () => {
    // Importar el mismo plano dos veces no debe duplicar su peso en el paquete.
    const already: Media = makeMedia(80, { sha256: base.sha256, kind: 'image' });
    const result = importImage(base, [already]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(true);
    expect(result.value.media.id).toBe(already.id);
  });

  it('TEST-IMP-015 un nombre repetido no pisa el archivo anterior', () => {
    const already = makeMedia(80, {
      sha256: 'b'.repeat(64),
      relativePath: 'media/plano-planta-1.png',
    });
    const result = importImage(base, [already]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.media.relativePath).toBe('media/plano-planta-1-2.png');
  });

  it('TEST-IMP-016 rechaza lo que no es imagen, diciendo qué hacer', () => {
    const result = importImage({ ...base, declaredMime: 'application/pdf', originalName: 'p.pdf' }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(result.error.recovery).toContain('PDF');
  });

  it('TEST-IMP-017 rechaza un archivo vacío', () => {
    const result = importImage({ ...base, byteSize: 0 }, []);
    expect(result.ok).toBe(false);
  });

  it('TEST-IMP-018 rechaza por tamaño antes de guardar', () => {
    const result = importImage({ ...base, byteSize: MEDIA_SIZE_LIMITS.image + 1 }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FILE_TOO_LARGE');
  });

  it('TEST-IMP-019 un SVG ejecutable no entra en el proyecto', () => {
    const result = importImage(
      {
        ...base,
        declaredMime: 'image/svg+xml',
        originalName: 'plano.svg',
        svgText: '<svg><script>fetch("//x")</script></svg>',
      },
      [],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('JavaScript');
    expect(result.error.recovery).toContain('PNG');
  });

  it('TEST-IMP-020 un SVG limpio sí entra', () => {
    const result = importImage(
      {
        ...base,
        declaredMime: 'image/svg+xml',
        originalName: 'plano.svg',
        svgText: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L8 8"/></svg>',
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.media.relativePath).toBe('media/plano.svg');
  });

  it('TEST-IMP-021 un SVG que no se pudo leer no se acepta a ciegas', () => {
    const result = importImage(
      { ...base, declaredMime: 'image/svg+xml', originalName: 'plano.svg' },
      [],
    );
    expect(result.ok).toBe(false);
  });

  it('TEST-IMP-022 una imagen sin dimensiones medibles se acepta', () => {
    // Medir requiere decodificar, y hay entornos donde no se puede; el plano
    // se muestra igual con la relación de aspecto natural del `<img>`.
    const result = importImage({ ...base, width: null, height: null }, []);
    expect(result.ok).toBe(true);
  });
});
