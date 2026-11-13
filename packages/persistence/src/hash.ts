/**
 * Huellas SHA-256.
 *
 * Se usan en tres sitios y por tres razones distintas:
 *  - identidad de los medios: el mismo panorama importado dos veces no se
 *    duplica en el paquete;
 *  - integridad del paquete `.ivp`: `checksums.sha256` permite detectar al
 *    abrir que un archivo se ha corrompido o alterado;
 *  - auditoría: los eventos guardan el hash del antes y del después, de modo
 *    que se puede demostrar que algo cambió sin guardar una segunda copia de
 *    los datos industriales.
 *
 * Se usa Web Crypto, disponible tanto en Node 20+ como en el WebView de
 * Tauri, para no arrastrar una dependencia de criptografía al paquete.
 */

export async function sha256(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('Web Crypto no está disponible en este entorno');
  }
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const digest = await subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text));
}

/**
 * Huella de un objeto, estable frente al orden de las claves.
 *
 * Es lo que hace comparables los hashes de auditoría: sin ordenar las claves,
 * dos serializaciones del mismo estado darían huellas distintas y el registro
 * mostraría cambios donde no los hay.
 */
export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

/** JSON con claves ordenadas y sin espacios superfluos. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  const stringify = (node: unknown): string => {
    if (node === null) return 'null';
    if (typeof node === 'number') return Number.isFinite(node) ? JSON.stringify(node) : 'null';
    if (typeof node === 'boolean' || typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'undefined') return 'null';
    if (typeof node !== 'object') return 'null';

    if (seen.has(node)) throw new Error('Referencia circular al calcular la huella');
    seen.add(node);

    try {
      if (Array.isArray(node)) {
        return `[${node.map(stringify).join(',')}]`;
      }
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`).join(',')}}`;
    } finally {
      seen.delete(node);
    }
  };

  return stringify(value);
}

/* ------------------------------------------------------------------ *
 * Archivo de checksums
 * ------------------------------------------------------------------ */

/**
 * Formato de `checksums.sha256`: una línea por archivo, `hash␠␠ruta`, igual
 * que la salida de `sha256sum`. Se eligió un formato estándar para que el
 * cliente pueda verificar el paquete con las herramientas que ya tiene, sin
 * depender de esta aplicación.
 */
export function formatChecksums(entries: ReadonlyMap<string, string>): string {
  return (
    [...entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, hash]) => `${hash}  ${path}`)
      .join('\n') + '\n'
  );
}

export function parseChecksums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^([0-9a-f]{64})\s{1,2}(.+)$/.exec(trimmed);
    if (match === null) continue;
    const hash = match[1];
    const path = match[2];
    if (hash === undefined || path === undefined) continue;
    map.set(path, hash);
  }
  return map;
}

export interface ChecksumVerification {
  readonly ok: boolean;
  /** Archivos cuyo contenido no coincide con el hash registrado. */
  readonly mismatched: readonly string[];
  /** Archivos registrados que faltan en el paquete. */
  readonly missing: readonly string[];
  /** Archivos presentes que no estaban registrados. */
  readonly unexpected: readonly string[];
}

/**
 * Compara los hashes registrados con el contenido real.
 *
 * Distingue tres fallos porque significan cosas distintas: un hash que no
 * coincide indica corrupción o manipulación, un archivo que falta indica un
 * paquete truncado, y uno inesperado indica que alguien añadió contenido al
 * ZIP después de generarlo. El tercero no impide abrir, pero sí merece un
 * aviso.
 */
export async function verifyChecksums(
  registered: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<ChecksumVerification> {
  const mismatched: string[] = [];
  const missing: string[] = [];
  const unexpected: string[] = [];

  for (const [path, expected] of registered) {
    const data = files.get(path);
    if (data === undefined) {
      missing.push(path);
      continue;
    }
    const actual = await sha256(data);
    if (actual !== expected) mismatched.push(path);
  }

  for (const path of files.keys()) {
    if (!registered.has(path) && path !== 'checksums.sha256') unexpected.push(path);
  }

  return {
    ok: mismatched.length === 0 && missing.length === 0,
    mismatched: mismatched.sort(),
    missing: missing.sort(),
    unexpected: unexpected.sort(),
  };
}
