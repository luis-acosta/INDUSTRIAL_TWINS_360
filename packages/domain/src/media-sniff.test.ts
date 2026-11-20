/**
 * Pruebas del reconocimiento de formatos y de la importación de audio y vídeo.
 *
 * Lo que se protege son las dos caras del mismo problema: que un archivo
 * correcto no se rechace por su extensión, y que un archivo que no es lo que
 * dice no se acepte. La segunda es una regla de seguridad del proyecto
 * —«validar todos los archivos y entradas»— y la primera es la diferencia
 * entre un importador que la gente usa y uno que rodea convirtiendo archivos.
 *
 * Las cabeceras se construyen byte a byte. Son las de verdad: las firmas de
 * PNG, JPEG, RIFF, ISO-BMFF, Matroska, Ogg e ID3 están en sus respectivas
 * especificaciones y son lo que mira cualquier reproductor.
 */
import { describe, expect, it } from 'vitest';

import { importAudioVideo } from './media-import';
import { kindOfMime, resolveAmbiguous, sniffMedia } from './media-sniff';
import { ISO_NOW, testUuid } from './testing';
import type { Media } from './media';

/** Construye una cabecera a partir de bytes y textos. */
function header(...parts: (number | string)[]): Uint8Array {
  const bytes: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') bytes.push(part);
    else for (const char of part) bytes.push(char.charCodeAt(0));
  }
  // Se rellena hasta 64 bytes: es lo que lee el reconocedor y lo que leería
  // quien importa de verdad.
  while (bytes.length < 64) bytes.push(0);
  return new Uint8Array(bytes);
}

const PNG = header(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = header(0xff, 0xd8, 0xff, 0xe0);
const WEBP = header('RIFF', 0, 0, 0, 0, 'WEBP');
const WAV = header('RIFF', 0, 0, 0, 0, 'WAVE');
const AVIF = header(0, 0, 0, 0x20, 'ftyp', 'avif');
const MP4 = header(0, 0, 0, 0x20, 'ftyp', 'isom');
const M4A = header(0, 0, 0, 0x20, 'ftyp', 'M4A ');
const MATROSKA = header(0x1a, 0x45, 0xdf, 0xa3);
const OGG = header('OggS');
const MP3_ID3 = header('ID3', 0x03, 0x00);
const MP3_FRAME = header(0xff, 0xfb, 0x90, 0x00);
const PDF = header('%PDF-1.7');
const SVG = header('<svg xmlns="http://www.w3.org/2000/svg">');
const GARBAGE = header(0x12, 0x34, 0x56, 0x78);

describe('sniffMedia', () => {
  it('reconoce las imágenes por su firma', () => {
    // TEST-SNF-001: el tipo que declara el sistema llega vacío para
    // extensiones que no conoce; la firma está siempre.
    expect(sniffMedia(PNG).mime).toBe('image/png');
    expect(sniffMedia(JPEG).mime).toBe('image/jpeg');
    expect(sniffMedia(WEBP).mime).toBe('image/webp');
    expect(sniffMedia(AVIF).mime).toBe('image/avif');
  });

  it('distingue AVIF de MP4 aunque compartan contenedor', () => {
    // TEST-SNF-002: los dos empiezan por un recuadro «ftyp». Mirar sólo eso
    // confundiría una foto con un vídeo, y el recorrido intentaría
    // reproducir una imagen.
    expect(sniffMedia(AVIF).mime).toBe('image/avif');
    expect(sniffMedia(MP4).mime).toBe('video/mp4');
  });

  it('distingue WebP de WAV aunque compartan contenedor RIFF', () => {
    // TEST-SNF-003: la firma RIFF es la misma; lo que decide es la forma que
    // viene detrás.
    expect(sniffMedia(WEBP).mime).toBe('image/webp');
    expect(sniffMedia(WAV).mime).toBe('audio/wav');
  });

  it('reconoce el audio en sus dos formas de MP3', () => {
    // TEST-SNF-004: con etiqueta ID3 delante, o empezando por una trama. La
    // segunda es la que traen muchas grabadoras de campo, y rechazarla
    // obligaría a convertir cada nota de voz.
    expect(sniffMedia(MP3_ID3).mime).toBe('audio/mpeg');
    expect(sniffMedia(MP3_FRAME).mime).toBe('audio/mpeg');
  });

  it('reconoce Ogg y M4A', () => {
    // TEST-SNF-005: M4A declara audio en la propia marca del contenedor, de
    // modo que no hay nada que preguntar.
    expect(sniffMedia(OGG).mime).toBe('audio/ogg');
    expect(sniffMedia(M4A).mime).toBe('audio/mp4');
    expect(sniffMedia(M4A).ambiguousContainer).toBeNull();
  });

  it('marca como ambiguos los contenedores que llevan vídeo o audio', () => {
    // TEST-SNF-006: MP4 y Matroska no dicen en la cabecera qué pistas traen.
    // Fingir certeza aquí haría que un M4V y un M4A se importaran igual.
    expect(sniffMedia(MP4).ambiguousContainer).toBe('mp4');
    expect(sniffMedia(MATROSKA).ambiguousContainer).toBe('matroska');
  });

  it('reconoce PDF y SVG', () => {
    // TEST-SNF-007: los dos llegan al importador por error con frecuencia, y
    // decir qué son orienta mejor que «formato no admitido».
    expect(sniffMedia(PDF).mime).toBe('application/pdf');
    expect(sniffMedia(SVG).mime).toBe('image/svg+xml');
  });

  it('no reconoce un contenido arbitrario', () => {
    // TEST-SNF-008: es la mitad de seguridad de la función. Si adivinara por
    // la extensión, un archivo renombrado entraría en el paquete.
    expect(sniffMedia(GARBAGE, 'video/mp4', 'planta.mp4').mime).toBeNull();
  });

  it('no deja que el tipo declarado invente un formato', () => {
    // TEST-SNF-009: el declarado sólo desempata dentro de un contenedor
    // reconocido; nunca convierte lo no reconocido en reconocido.
    expect(sniffMedia(GARBAGE, 'audio/mpeg', 'nota.mp3').mime).toBeNull();
    expect(sniffMedia(new Uint8Array([1, 2]), 'image/png', 'x.png').mime).toBeNull();
  });

  it('reconoce un archivo correcto con extensión inhabitual', () => {
    // TEST-SNF-010: es la otra mitad. Un WAV sin extensión o un JPEG escrito
    // «.jpe» son archivos correctos, y rechazarlos enseña a la gente a
    // convertir archivos antes de importar.
    expect(sniffMedia(WAV, '', 'grabacion').mime).toBe('audio/wav');
    expect(sniffMedia(JPEG, '', 'foto.jpe').mime).toBe('image/jpeg');
  });
});

describe('resolveAmbiguous', () => {
  it('decide Matroska con el tipo declarado', () => {
    // TEST-SNF-011: es el único dato disponible sin recorrer las pistas, y
    // aquí sí es admisible porque las dos opciones caben en el contenedor.
    const matroska = sniffMedia(MATROSKA);
    expect(resolveAmbiguous(matroska, 'audio/webm')).toBe('audio/webm');
    expect(resolveAmbiguous(matroska, 'video/webm')).toBe('video/webm');
  });

  it('decide MP4 con el tipo declarado', () => {
    // TEST-SNF-012
    const mp4 = sniffMedia(MP4);
    expect(resolveAmbiguous(mp4, 'audio/mp4')).toBe('audio/mp4');
    expect(resolveAmbiguous(mp4, 'video/mp4')).toBe('video/mp4');
  });

  it('con un declarado que no encaja, elige vídeo', () => {
    // TEST-SNF-013: un declarado absurdo —«application/octet-stream»— no debe
    // decidir nada. Vídeo es la lectura segura: si resultara ser sólo audio,
    // el reproductor lo reproduce igual; al contrario, no.
    const mp4 = sniffMedia(MP4);
    expect(resolveAmbiguous(mp4, 'application/octet-stream')).toBe('video/mp4');
  });

  it('deja intacto lo que no era ambiguo', () => {
    // TEST-SNF-014: un declarado equivocado no puede cambiar un formato que
    // la firma determinó sin dudas.
    expect(resolveAmbiguous(sniffMedia(WAV), 'video/mp4')).toBe('audio/wav');
  });
});

describe('kindOfMime', () => {
  it('clasifica por familia', () => {
    // TEST-SNF-015: la clase decide el límite de tamaño y la carpeta del
    // paquete, de modo que una clasificación equivocada mete un vídeo en la
    // carpeta de audio y lo mide con el límite que no le toca.
    expect(kindOfMime('image/png')).toBe('image');
    expect(kindOfMime('audio/wav')).toBe('audio');
    expect(kindOfMime('video/mp4')).toBe('video');
    expect(kindOfMime('application/pdf')).toBe('document');
  });
});

describe('importAudioVideo', () => {
  const base = {
    id: testUuid(70),
    sha256: 'a'.repeat(64),
    originalName: 'narracion.mp3',
    byteSize: 1024 * 64,
    head: MP3_ID3,
    declaredMime: 'audio/mpeg',
    durationS: 42.5,
    width: null,
    height: null,
    createdAt: ISO_NOW,
  };

  it('registra un audio con su duración', () => {
    // TEST-SNF-016: la duración es lo que permite a una parada de recorrido
    // esperar a que acabe la narración.
    const result = importAudioVideo(base, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.media.kind).toBe('audio');
      expect(result.value.media.mime).toBe('audio/mpeg');
      expect(result.value.media.durationS).toBe(42.5);
      expect(result.value.media.relativePath).toContain('media/audio/');
    }
  });

  it('registra un vídeo con sus dimensiones', () => {
    // TEST-SNF-017: un vídeo sin dimensiones no se puede encuadrar en el
    // visor, y se vería estirado.
    const result = importAudioVideo(
      { ...base, originalName: 'linea.mp4', head: MP4, declaredMime: 'video/mp4', width: 1920, height: 1080 },
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.media.kind).toBe('video');
      expect(result.value.media.width).toBe(1920);
      expect(result.value.media.relativePath).toContain('media/video/');
    }
  });

  it('no guarda dimensiones en un audio', () => {
    // TEST-SNF-018: un reproductor puede informar de 0×0 o de valores
    // residuales; guardarlos haría que algo intentara encuadrar un audio.
    const result = importAudioVideo({ ...base, width: 300, height: 150 }, []);
    expect(result.ok && result.value.media.width).toBeNull();
  });

  it('deja la duración nula cuando no se pudo medir', () => {
    // TEST-SNF-019: inventar cero tendría una consecuencia concreta: una
    // parada configurada para «esperar al audio» avanzaría de inmediato y el
    // autor vería un recorrido que se salta su propia narración.
    const result = importAudioVideo({ ...base, durationS: null }, []);
    expect(result.ok && result.value.media.durationS).toBeNull();

    const zero = importAudioVideo({ ...base, durationS: 0 }, []);
    expect(zero.ok && zero.value.media.durationS).toBeNull();
  });

  it('rechaza un contenido que no es audio ni vídeo', () => {
    // TEST-SNF-020: y dice qué es, porque «formato no admitido» no orienta a
    // quien acaba de arrastrar una foto.
    const result = importAudioVideo({ ...base, originalName: 'foto.png', head: PNG }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('image/png');
      expect(result.error.recovery).toContain('imágenes');
    }
  });

  it('rechaza un archivo renombrado', () => {
    // TEST-SNF-021: es el caso que justifica mirar el contenido. La extensión
    // dice mp4 y dentro no hay un mp4.
    const result = importAudioVideo(
      { ...base, originalName: 'linea.mp4', head: GARBAGE, declaredMime: 'video/mp4' },
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('rechaza un archivo vacío', () => {
    // TEST-SNF-022: un archivo de cero bytes suele ser una copia a medias, y
    // aceptarlo metería en el paquete un medio que no se puede reproducir.
    const result = importAudioVideo({ ...base, byteSize: 0 }, []);
    expect(result.ok).toBe(false);
  });

  it('aplica el límite de tamaño de cada clase', () => {
    // TEST-SNF-023: el de vídeo es ocho veces el de audio, y medir un vídeo
    // con el límite del audio rechazaría vídeos perfectamente normales.
    const bigAudio = importAudioVideo({ ...base, byteSize: 600 * 1024 * 1024 }, []);
    expect(bigAudio.ok).toBe(false);
    if (!bigAudio.ok) expect(bigAudio.error.code).toBe('FILE_TOO_LARGE');

    const sameSizeVideo = importAudioVideo(
      {
        ...base,
        originalName: 'linea.mp4',
        head: MP4,
        declaredMime: 'video/mp4',
        byteSize: 600 * 1024 * 1024,
        width: 1920,
        height: 1080,
      },
      [],
    );
    expect(sameSizeVideo.ok).toBe(true);
  });

  it('reutiliza un medio con el mismo contenido', () => {
    // TEST-SNF-024: una narración que se importa dos veces durante la edición
    // añadiría dos copias al paquete.
    const first = importAudioVideo(base, []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = importAudioVideo({ ...base, id: testUuid(71) }, [first.value.media]);
    expect(second.ok && second.value.reused).toBe(true);
    expect(second.ok && second.value.media.id).toBe(first.value.media.id);
  });

  it('no reutiliza un medio de otra clase con el mismo contenido', () => {
    // TEST-SNF-025: no puede pasar con contenidos distintos, pero sí si
    // alguien importa el mismo contenedor como audio y como vídeo. Son dos
    // medios con reproductores y metadatos distintos.
    const existing: Media = {
      ...(importAudioVideo(base, []) as { value: { media: Media } }).value.media,
      kind: 'video',
    };
    const result = importAudioVideo(base, [existing]);
    expect(result.ok && result.value.reused).toBe(false);
  });

  it('no pisa la ruta de un medio que ya está', () => {
    // TEST-SNF-026: dos narraciones con el mismo nombre de archivo y
    // contenido distinto acabarían siendo la misma dentro del paquete.
    const first = importAudioVideo(base, []);
    if (!first.ok) return;

    const second = importAudioVideo({ ...base, id: testUuid(72), sha256: 'b'.repeat(64) }, [
      first.value.media,
    ]);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.media.relativePath).not.toBe(first.value.media.relativePath);
    }
  });
});
