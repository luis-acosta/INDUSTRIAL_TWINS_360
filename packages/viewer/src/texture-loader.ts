/**
 * Carga de texturas panorámicas.
 *
 * Tres problemas que este módulo resuelve y que, sin resolver, se manifiestan
 * tarde y mal:
 *
 *  1. **Límite de textura de la GPU.** Una equirectangular 16K no cabe en el
 *     límite de muchas GPU integradas. Subirla produce una esfera negra sin
 *     error visible; aquí se reescala antes y se avisa.
 *  2. **Carga cancelada.** El usuario navega entre escenas más rápido de lo
 *     que cargan: sin cancelación, la textura de la escena abandonada llega
 *     después y sustituye a la correcta.
 *  3. **Memoria de GPU.** Las texturas se cuentan y se liberan; una caché sin
 *     tope termina cerrando la pestaña en un recorrido grande.
 */
import { domainError, err, ok, type Result } from '@it360/domain';
import { LinearFilter, Texture } from 'three';

export interface LoadedTexture {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
  /** `true` si hubo que reducir la imagen para caber en la GPU. */
  readonly downscaled: boolean;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export interface TextureLoadOptions {
  /** Límite de la GPU; se consulta con `detectCapabilities`. */
  readonly maxTextureSize: number;
  readonly signal?: AbortSignal;
  /** Progreso 0-1 cuando la fuente permite medirlo. */
  readonly onProgress?: (progress: number) => void;
}

/**
 * Carga una imagen y la convierte en textura.
 *
 * Se usa `createImageBitmap` cuando está disponible porque decodifica fuera
 * del hilo principal: con una 8K, la decodificación síncrona congela la
 * interfaz casi un segundo, y la etapa 00 pide expresamente no congelarla.
 */
export async function loadPanoramaTexture(
  source: string | Blob,
  options: TextureLoadOptions,
): Promise<Result<LoadedTexture>> {
  try {
    const bitmap = await decode(source, options);
    if (options.signal?.aborted === true) {
      bitmap.close?.();
      return err(domainError('CANCELLED', 'Carga cancelada'));
    }

    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const limit = Math.max(options.maxTextureSize, 2048);

    let image: ImageBitmap | HTMLCanvasElement = bitmap;
    let downscaled = false;

    if (originalWidth > limit || originalHeight > limit) {
      const scale = limit / Math.max(originalWidth, originalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(Math.floor(originalWidth * scale), 1);
      canvas.height = Math.max(Math.floor(originalHeight * scale), 1);
      const context = canvas.getContext('2d');
      if (context === null) {
        bitmap.close?.();
        return err(
          domainError('INTERNAL', 'No se pudo preparar la imagen para la tarjeta gráfica'),
        );
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      image = canvas;
      downscaled = true;
    }

    const texture = new Texture(image as unknown as HTMLImageElement);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    return ok({
      texture,
      width: image instanceof HTMLCanvasElement ? image.width : image.width,
      height: image instanceof HTMLCanvasElement ? image.height : image.height,
      downscaled,
      originalWidth,
      originalHeight,
    });
  } catch (cause) {
    if (options.signal?.aborted === true) {
      return err(domainError('CANCELLED', 'Carga cancelada'));
    }
    return err(
      domainError('IO_FAILED', 'No se pudo cargar la imagen panorámica', {
        detail: { cause: String(cause) },
        recovery:
          'Compruebe que el archivo existe en la biblioteca de medios y que su formato está admitido.',
      }),
    );
  }
}

async function decode(source: string | Blob, options: TextureLoadOptions): Promise<ImageBitmap> {
  if (typeof source !== 'string') {
    return createImageBitmap(source);
  }

  const init: RequestInit = options.signal !== undefined ? { signal: options.signal } : {};
  const response = await fetch(source, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al cargar ${source}`);
  }

  // Progreso cuando el servidor declara el tamaño: una panorámica de 60 MB
  // sin barra de progreso parece una aplicación colgada.
  const total = Number(response.headers.get('content-length') ?? 0);
  if (options.onProgress !== undefined && total > 0 && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        received += value.length;
        options.onProgress(Math.min(received / total, 1));
      }
    }
    return createImageBitmap(new Blob(chunks as BlobPart[]));
  }

  return createImageBitmap(await response.blob());
}

/* ------------------------------------------------------------------ *
 * Caché
 * ------------------------------------------------------------------ */

export interface TextureCacheOptions {
  /** Número máximo de texturas retenidas. */
  readonly maxEntries?: number;
  /** Memoria aproximada máxima, en bytes. */
  readonly maxBytes?: number;
}

/**
 * Caché de texturas con desalojo por uso menos reciente.
 *
 * El tope es doble, por número y por memoria, porque ninguno basta solo:
 * veinte panorámicas 2K caben de sobra y tres 16K no. El coste se estima en
 * cuatro bytes por píxel, que es lo que ocupa una textura RGBA sin comprimir
 * en la GPU.
 */
export class TextureCache {
  private readonly entries = new Map<string, LoadedTexture>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: TextureCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 8;
    this.maxBytes = options.maxBytes ?? 768 * 1024 * 1024;
  }

  get(key: string): LoadedTexture | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Reinsertar lo marca como el más reciente: Map conserva el orden de
    // inserción, así que la primera clave es siempre la más antigua.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: LoadedTexture): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    this.evict();
  }

  /** Protege una clave del desalojo: la escena que se está mostrando. */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
  }

  private estimatedBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.width * entry.height * 4;
    return bytes;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.estimatedBytes() > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true || this.entries.size <= 1) break;
      const entry = this.entries.get(oldest.value);
      entry?.texture.dispose();
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
  }

  get stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.estimatedBytes() };
  }
}
