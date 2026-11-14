/**
 * Aplica el plan de publicación a las imágenes (V01, V02).
 *
 * Cierra una promesa que estaba sin cumplir: el editor dejaba elegir formato,
 * calidad y lado máximo, y la publicación copiaba los originales tal cual. Un
 * recorrido de cuarenta panorámicas a 100 MP salía como cuatro gigabytes
 * aunque el autor hubiera pedido la mitad de resolución.
 *
 * El reparto: el plan lo decide `@it360/domain` (puro, probado sin navegador),
 * la codificación la hace el contenedor en Rust (probada con `cargo test`), y
 * este módulo es el pegamento —leer, pedir, sustituir— más la parte que no
 * puede hacer ninguno de los dos: mantener el registro del medio de acuerdo
 * con el archivo que de verdad se escribe.
 *
 * Eso último importa más de lo que parece. El manifiesto publicado lleva la
 * ruta, el tipo, el tamaño y la suma de cada medio. Si se recodifica el archivo
 * y no se actualiza el registro, el paquete afirma una suma que no es la del
 * archivo que lleva, y la comprobación de integridad del propio paquete
 * fallaría en casa del cliente.
 *
 * **Las teselas se planifican y no se escriben todavía.** El visor carga la
 * imagen completa y no consume la pirámide, así que escribir cuatro mil
 * archivos que nadie lee abultaría el paquete y parecería una función
 * terminada. El plan ya las calcula; se escribirán cuando el visor las pida.
 */

import {
  planImage,
  type ImagePlan,
  type Media,
  type Project,
  type PublishImageFormat,
} from '@it360/domain';
import { sha256 } from '@it360/persistence/hash';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-storage';

/** Formatos que el contenedor sabe codificar. */
type EncodableFormat = 'jpeg' | 'png' | 'webp';

interface EncodeRequest {
  readonly format: EncodableFormat;
  readonly quality: number;
  readonly maxEdgePx: number;
}

interface EncodedImage {
  readonly bytes: number[];
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

export interface PreparedMedia {
  /** Proyecto con los registros de medio al día. */
  readonly project: Project;
  /** Archivos a escribir, con las rutas nuevas. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Lo que conviene contarle al autor: sustituciones, imágenes copiadas. */
  readonly notes: readonly string[];
  readonly originalBytes: number;
  readonly publishedBytes: number;
}

const isEncodable = (format: PublishImageFormat): format is EncodableFormat =>
  format === 'jpeg' || format === 'png' || format === 'webp';

/**
 * Recodifica las imágenes del proyecto según sus ajustes de publicación.
 *
 * Una imagen que no se puede recodificar se copia tal cual y se dice. Es el
 * caso de un archivo que el decodificador no acepta: dejar fuera la escena
 * sería peor que publicarla con su imagen original, y callarlo sería peor que
 * las dos cosas.
 */
export async function prepareMediaForPublish(
  project: Project,
  mediaFiles: ReadonlyMap<string, Uint8Array>,
  onProgress?: (done: number, total: number) => void,
): Promise<PreparedMedia> {
  const quality = project.settings.publishQuality;
  const files = new Map<string, Uint8Array>();
  const media: Media[] = [];
  const notes: string[] = [];

  let originalBytes = 0;
  let publishedBytes = 0;
  let done = 0;

  /* Sin contenedor no hay codificador: la versión web ejecuta las
     comprobaciones y copia, que es lo único que puede hacer con honestidad. */
  const canEncode = isTauri();
  if (!canEncode && project.media.some((entry) => entry.kind === 'image')) {
    notes.push(
      'Las imágenes se copian sin recodificar: la versión web no puede cambiar de formato ni reescalar.',
    );
  }

  for (const entry of project.media) {
    const bytes = mediaFiles.get(entry.relativePath);
    onProgress?.(done, project.media.length);
    done += 1;

    if (bytes === undefined) {
      // El archivo falta del proyecto; el exportador ya lo denuncia por su
      // cuenta. Aquí se conserva el registro para no cambiar ese diagnóstico.
      media.push(entry);
      continue;
    }

    originalBytes += bytes.byteLength;
    const plan = planImage(entry, quality);

    if (plan.note !== null) notes.push(`${entry.originalName}: ${plan.note}`);

    if (plan.action === 'copy' || !canEncode || !isEncodable(plan.format)) {
      files.set(entry.relativePath, bytes);
      publishedBytes += bytes.byteLength;
      media.push(entry);
      continue;
    }

    const encoded = await encodeOne(bytes, {
      format: plan.format,
      quality: plan.quality,
      maxEdgePx: quality.maxEdgePx,
    });

    if (encoded === null) {
      notes.push(
        `${entry.originalName}: no se pudo recodificar, se publica el archivo original.`,
      );
      files.set(entry.relativePath, bytes);
      publishedBytes += bytes.byteLength;
      media.push(entry);
      continue;
    }

    files.set(plan.relativePath, encoded.bytes);
    publishedBytes += encoded.bytes.byteLength;

    /* El registro se pone al día con el archivo que de verdad se escribe: si
       no, el manifiesto afirmaría una suma que no es la de su archivo y la
       comprobación de integridad fallaría en casa del cliente. */
    media.push({
      ...entry,
      relativePath: plan.relativePath,
      mime: plan.mime,
      byteSize: encoded.bytes.byteLength,
      width: encoded.width,
      height: encoded.height,
      sha256: await sha256(encoded.bytes),
      // Se planifican y no se escriben: el visor no las consume todavía.
      tiles: [],
    });
  }

  onProgress?.(project.media.length, project.media.length);

  if (quality.tiled && project.media.some((entry) => entry.kind === 'image')) {
    notes.push(
      'El teselado todavía no se aplica: el visor carga la imagen completa, así que escribir la pirámide abultaría el paquete sin que nadie la lea.',
    );
  }

  return {
    project: { ...project, media },
    files,
    notes,
    originalBytes,
    publishedBytes,
  };
}

/** Pide al contenedor que recodifique, o `null` si no pudo. */
async function encodeOne(
  bytes: Uint8Array,
  request: EncodeRequest,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    const encoded = await invoke<EncodedImage>('image_encode', {
      bytes: [...bytes],
      request,
    });

    return {
      bytes: new Uint8Array(encoded.bytes),
      width: encoded.width,
      height: encoded.height,
    };
  } catch {
    // El motivo exacto lo registra el contenedor; aquí basta saber que no se
    // pudo, para copiar el original y decirlo.
    return null;
  }
}

/** Resumen para la interfaz, con el ahorro real ya medido. */
export function publishSummary(prepared: PreparedMedia): string {
  if (prepared.originalBytes === 0) return 'Sin imágenes que preparar.';

  const saved = prepared.originalBytes - prepared.publishedBytes;
  const percent = Math.round((Math.abs(saved) / prepared.originalBytes) * 100);
  const mb = (value: number): string => `${(value / 1_000_000).toFixed(1)} MB`;

  if (saved > 0) {
    return `Imágenes: ${mb(prepared.originalBytes)} → ${mb(prepared.publishedBytes)} (${percent} % menos).`;
  }
  if (saved < 0) {
    return `Imágenes: ${mb(prepared.originalBytes)} → ${mb(prepared.publishedBytes)} (${percent} % más, por el formato elegido).`;
  }
  return `Imágenes: ${mb(prepared.publishedBytes)}, sin cambios.`;
}

export type { ImagePlan };
