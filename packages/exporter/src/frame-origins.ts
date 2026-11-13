/**
 * Orígenes que el recorrido publicado puede enmarcar (E08, D06).
 *
 * El paquete publicado sale con `frame-src 'none'`, y eso impedía dos cosas
 * legítimas: mostrar un PDF del propio paquete dentro del recorrido (E05) y
 * usar los Webframes que el autor declaró (E08, D06).
 *
 * La salida fácil habría sido `frame-src *`. Pero una política que permite
 * enmarcar cualquier sitio «por si acaso» no es una política: el recorrido se
 * sirve desde la intranet del cliente, y un marco a un sitio arbitrario es una
 * ventana a la que ni el autor ni el cliente han dado el visto bueno.
 *
 * Lo que se hace en su lugar: se recorre el proyecto, se reúnen **los orígenes
 * que el autor declaró de verdad** y sólo esos entran en la política. Si el
 * recorrido no usa Webframes, la política sigue siendo `frame-src 'self'`, que
 * es lo que hace falta para el PDF y nada más.
 */
import { walkSkin, type Project, type Scene } from '@it360/domain';

export interface FrameOriginReport {
  /** Orígenes admitidos, en forma `https://host[:puerto]`, ordenados. */
  readonly origins: readonly string[];
  /** URL que el autor declaró y que no se puede admitir, con el motivo. */
  readonly rejected: readonly { readonly url: string; readonly reason: string }[];
}

/**
 * Origen de una URL, si se puede enmarcar.
 *
 * Sólo `https`. Un marco `http` en una página servida por `https` lo bloquea
 * el navegador de todas formas, así que admitirlo en la política sólo serviría
 * para que el fallo apareciera más tarde y con peor mensaje.
 */
function frameableOrigin(raw: string): { origin: string } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'no es una dirección válida' };
  }

  if (url.protocol === 'http:') {
    return {
      reason:
        'es http y el recorrido se sirve por https, así que el navegador bloquearía el marco',
    };
  }
  if (url.protocol !== 'https:') {
    return { reason: `el esquema «${url.protocol}» no se puede enmarcar` };
  }

  // `example.invalid` es el valor con el que nace un componente de contenido
  // web sin configurar: no se mete en la política ni se cuenta como error del
  // autor, porque el aviso de «sin configurar» ya lo da el editor.
  if (url.hostname === 'example.invalid') {
    return { reason: 'sigue con la dirección de ejemplo, sin configurar' };
  }

  return { origin: url.origin };
}

/** URLs de Webframe declaradas en las acciones de una escena y sus marcadores. */
function sceneFrameUrls(scene: Scene): readonly string[] {
  const urls: string[] = [];

  const fromActions = (actions: Scene['actions']): void => {
    for (const action of actions) {
      if (action.config.type === 'openWebframe') urls.push(action.config.url);
    }
  };

  fromActions(scene.actions);
  for (const hotspot of scene.hotspots) {
    fromActions(hotspot.actions);
    if (hotspot.geometry.shape === 'webframe') urls.push(hotspot.geometry.url);
  }

  return urls;
}

/**
 * Reúne los orígenes que el recorrido necesita enmarcar.
 *
 * Recorre las escenas publicables, sus marcadores y los componentes de las
 * interfaces. Devuelve también lo rechazado, para poder decírselo al autor en
 * la comprobación previa en lugar de que descubra el marco en blanco al abrir
 * el recorrido publicado.
 */
export function collectFrameOrigins(project: Project): FrameOriginReport {
  const origins = new Set<string>();
  const rejected: { url: string; reason: string }[] = [];
  const seen = new Set<string>();

  const consider = (raw: string): void => {
    if (seen.has(raw)) return;
    seen.add(raw);

    const result = frameableOrigin(raw);
    if ('origin' in result) origins.add(result.origin);
    else rejected.push({ url: raw, reason: result.reason });
  };

  for (const scene of project.scenes) {
    if (scene.excludedFromPublish) continue;
    for (const url of sceneFrameUrls(scene)) consider(url);
  }

  for (const skin of project.skins) {
    for (const { node } of walkSkin(skin.root)) {
      if (node.config.kind === 'webframe') consider(node.config.url);
      for (const action of node.actions) {
        if (action.config.type === 'openWebframe') consider(action.config.url);
      }
    }
  }

  /* Los bloques de contenido web de las ventanas de información (E01, E09).
   *
   * Es tan declarativo como una acción de Webframe y se olvidaba con
   * facilidad: sin esto, el origen no entra en la política y el visor bloquea
   * el marco con toda la razón, de modo que el bloque nunca funcionaría y el
   * autor no tendría forma de saber por qué. */
  for (const window of project.infoWindows) {
    for (const tab of window.tabs) {
      for (const block of tab.blocks) {
        if (block.type === 'webframe') consider(block.url);
      }
    }
    for (const action of window.onCloseActions) {
      if (action.config.type === 'openWebframe') consider(action.config.url);
    }
  }

  return {
    origins: [...origins].sort(),
    // Se ordenan para que el informe sea estable entre publicaciones y un
    // cambio en la lista se note como un cambio real.
    rejected: rejected.sort((a, b) => a.url.localeCompare(b.url)),
  };
}

/**
 * Valor de `frame-src` para la política.
 *
 * `'self'` siempre, porque es lo que permite mostrar un PDF del propio paquete
 * dentro del recorrido. Los orígenes de terceros se añaden uno a uno, sin
 * comodines: un comodín de subdominios admitiría cualquier host que alguien
 * levante bajo ese dominio, y eso ya no es una decisión del autor.
 */
export function frameSrcDirective(origins: readonly string[]): string {
  return ["'self'", ...origins].join(' ');
}
