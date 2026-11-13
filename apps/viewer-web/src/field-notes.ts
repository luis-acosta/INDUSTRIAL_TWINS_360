/**
 * Almacén de notas de campo en el visor publicado (P01).
 *
 * El visor puede estar funcionando en una tableta, dentro de una planta, sin
 * cobertura. Eso decide dónde van las notas: al navegador de quien las escribe,
 * inmediatamente, y de ahí a un archivo que el autor del proyecto importa.
 *
 * Tres cosas que esta capa promete y que importan:
 *
 * - **Guardar nunca lanza.** `localStorage` falla en modo privado de Safari, con
 *   la cuota llena y en algunos navegadores embebidos en quioscos. Si la nota
 *   que acaba de escribir un operador desapareciera con una excepción, habría
 *   perdido una observación que se tomó delante del equipo y que no se puede
 *   volver a tomar. Se informa del fallo y se conserva lo que haya en memoria.
 * - **Las notas se guardan por proyecto.** Una tableta puede recorrer dos
 *   plantas; mezclar sus observaciones sería peor que no guardarlas.
 * - **Nada se borra sin que el usuario lo pida.** Exportar no vacía el almacén:
 *   quien descarga el archivo puede perderlo antes de entregarlo.
 */
import { fieldNoteSchema, type FieldNote } from '@it360/domain';

const KEY_PREFIX = 'it360.fieldNotes.';

export interface FieldNoteStoreResult {
  readonly ok: boolean;
  /** Mensaje para el usuario cuando el almacenamiento falla. */
  readonly message?: string;
}

/** Clave de almacenamiento del proyecto. */
const keyFor = (projectId: string): string => `${KEY_PREFIX}${projectId}`;

/**
 * Lee las notas guardadas de un proyecto.
 *
 * Valida cada nota por separado y descarta las que no cumplen el esquema, en
 * lugar de rechazar el conjunto: una entrada corrupta —por una versión
 * anterior, o por otra pestaña escribiendo a la vez— no debe hacer desaparecer
 * las demás.
 */
export function loadFieldNotes(projectId: string): readonly FieldNote[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(projectId));
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const notes: FieldNote[] = [];
  for (const candidate of parsed) {
    const result = fieldNoteSchema.safeParse(candidate);
    if (result.success) notes.push(result.data);
  }
  return notes;
}

/** Guarda las notas de un proyecto. Nunca lanza. */
export function saveFieldNotes(
  projectId: string,
  notes: readonly FieldNote[],
): FieldNoteStoreResult {
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(notes));
    return { ok: true };
  } catch (error) {
    const full =
      error instanceof Error && /quota|exceeded/i.test(error.name + error.message);
    return {
      ok: false,
      message: full
        ? 'No queda espacio en el navegador para guardar la nota. Descargue las notas pendientes y vuelva a intentarlo.'
        : 'Este navegador no permite guardar notas (puede estar en modo privado). La nota sigue en pantalla: descárguela antes de cerrar.',
    };
  }
}

/** Borra las notas guardadas de un proyecto. Sólo a petición del usuario. */
export function clearFieldNotes(projectId: string): FieldNoteStoreResult {
  try {
    window.localStorage.removeItem(keyFor(projectId));
    return { ok: true };
  } catch {
    return { ok: false, message: 'No se pudieron borrar las notas guardadas.' };
  }
}

/**
 * Descarga el paquete como archivo.
 *
 * Se devuelve el nombre para poder decírselo al usuario: en una tableta la
 * carpeta de descargas no está a la vista, y «se descargó» sin nombre no le
 * sirve para encontrarlo.
 */
export function downloadBundle(bundle: unknown, projectTitle: string): string {
  const safeTitle = projectTitle
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `notas-de-campo-${safeTitle.length > 0 ? safeTitle : 'recorrido'}-${stamp}.json`;

  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);

  return fileName;
}
