/**
 * Guardar un archivo suelto que el editor acaba de producir (S07).
 *
 * No es el guardado del proyecto —de eso se ocupa `project-files.ts` con su
 * escritura atómica y su rotación de copias—, sino la salida de algo que el
 * autor va a usar fuera: hoy, el vídeo de un recorrido.
 *
 * Las dos vías son distintas de verdad y por eso están las dos:
 *
 *  - En el contenedor se pide carpeta y se escribe en disco, que es lo que el
 *    autor espera de una aplicación de escritorio.
 *  - En el navegador se descarga, porque no hay otra forma. Un botón que no
 *    hiciera nada en la versión web sería peor que la descarga.
 */

import { isTauri } from './tauri-storage';

/**
 * Escribe el archivo y dice si se guardó.
 *
 * `false` significa que el autor canceló, no que fallara: quien llama lo
 * distingue para no felicitarle por un archivo que no existe.
 */
export async function saveBinaryFile(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');

    const chosen = await save({ defaultPath: suggestedName });
    if (chosen === null) return false;

    await writeFile(chosen, bytes);
    return true;
  }

  /* Versión web: descarga. El objeto se libera después de pulsar el enlace
     —no antes— porque el navegador todavía lo está leyendo cuando la llamada
     vuelve, y liberarlo en el acto deja un archivo de cero bytes. */
  const blob = new Blob([bytes as unknown as BlobPart]);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
