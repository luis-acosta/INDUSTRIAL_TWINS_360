/**
 * Genera un paquete publicado de verdad, para las pruebas de extremo a extremo.
 *
 * Las pruebas unitarias comprueban el exportador y el visor por separado. Lo
 * que ninguna de las dos puede comprobar es que el paquete que produce el
 * exportador sea el que el visor sabe abrir: el contrato entre los dos son
 * nombres de archivo, el identificador del elemento raíz del HTML y la forma
 * del manifiesto, y los tres se pueden romper sin que falle una sola prueba
 * unitaria.
 *
 * Este script cose las dos mitades: construye un proyecto de muestra, lo
 * publica con el exportador real y el visor real compilado, y escribe el
 * resultado en una carpeta que Playwright sirve y abre con un navegador.
 *
 * Uso:
 *   npx vite-node tools/make-sample-package.ts -- /ruta/de/salida
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, newUuid, type Project, type Uuid } from '../packages/domain/src/index';
import { exportWebSite } from '../packages/exporter/src/index';

const root = fileURLToPath(new URL('..', import.meta.url));
const VIEWER_DIST = join(root, 'apps/viewer-web/dist');

const outDir = process.argv[2] ?? join(root, 'dist/sample-package');

/**
 * Imagen equirectangular mínima pero reconocible.
 *
 * Es un PNG generado byte a byte: cuatro franjas de color que permiten
 * comprobar a ojo —y con una captura de pantalla— que el visor orienta y
 * proyecta. Generarlo evita meter una fotografía en el repositorio y evita
 * depender de un canvas, que en Node no existe.
 */
function stripedPng(width: number, height: number): Uint8Array {
  const bands: ReadonlyArray<readonly [number, number, number]> = [
    [34, 62, 86],
    [38, 96, 112],
    [122, 92, 54],
    [58, 44, 40],
  ];

  // Cada fila va precedida por un byte de filtro (0 = sin filtro).
  const raw = new Uint8Array((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    const band = bands[Math.floor((y / height) * bands.length)] ?? bands[0];
    for (let x = 0; x < width; x += 1) {
      // Una rejilla cada 64 px para que se vea la deformación esférica.
      const grid = x % 64 === 0 || y % 64 === 0;
      raw[offset] = grid ? 220 : (band?.[0] ?? 0);
      raw[offset + 1] = grid ? 220 : (band?.[1] ?? 0);
      raw[offset + 2] = grid ? 220 : (band?.[2] ?? 0);
      offset += 3;
    }
  }

  return encodePng(width, height, raw);
}

/** PNG sin comprimir (deflate almacenado), suficiente y sin dependencias. */
function encodePng(width: number, height: number, raw: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // profundidad de bits
  ihdr[9] = 2; // color verdadero
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlibStored(raw)));
  chunks.push(chunk('IEND', new Uint8Array(0)));

  const total = signature.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  out.set(signature, 0);
  let at = signature.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(new Uint8Array([...typeBytes, ...data])));
  return out;
}

/** Flujo zlib con bloques almacenados: válido y sin comprimir. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01];
  const MAX = 65535;

  for (let i = 0; i < data.length; i += MAX) {
    const slice = data.subarray(i, Math.min(i + MAX, data.length));
    const last = i + MAX >= data.length ? 1 : 0;
    blocks.push(last, slice.length & 0xff, slice.length >>> 8, ~slice.length & 0xff, (~slice.length >>> 8) & 0xff);
    for (const byte of slice) blocks.push(byte);
  }

  // Adler-32 del contenido original.
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff);

  return new Uint8Array(blocks);
}

/**
 * Un .glb mínimo y válido: un cuadrilátero con nombre de pieza.
 *
 * Se genera en lugar de meter un archivo binario en el repositorio porque el
 * paquete de muestra tiene que poder reconstruirse entero desde el código, y
 * porque lo único que hace falta para comprobar el camino del modelo es una
 * malla con nombre: el visor la carga, la normaliza y le ancla un marcador
 * igual que a un CAD de cuarenta mil piezas.
 */
function minimalGlb(nodeName: string): Uint8Array {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  // El buffer binario: posiciones y luego índices, alineados a cuatro bytes.
  const positionBytes = new Uint8Array(positions.buffer);
  const indexBytes = new Uint8Array(indices.buffer);
  const indexOffset = positionBytes.byteLength;
  const binLength = indexOffset + indexBytes.byteLength;
  const binPadded = Math.ceil(binLength / 4) * 4;

  const bin = new Uint8Array(binPadded);
  bin.set(positionBytes, 0);
  bin.set(indexBytes, indexOffset);

  const gltf = {
    asset: { version: '2.0', generator: 'INDUSTRIAL TWINS 360 — paquete de prueba' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: nodeName }],
    meshes: [{ name: nodeName, primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength, target: 34_962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.byteLength, target: 34_963 },
    ],
    buffers: [{ byteLength: binPadded }],
  };

  // El trozo JSON se rellena con espacios y el binario con ceros: lo pide el
  // formato, y un relleno equivocado hace que el cargador rechace el archivo.
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const json = new Uint8Array(jsonPadded).fill(0x20);
  json.set(jsonBytes, 0);

  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, 0x46546c67, true); // «glTF»
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, 0x4e4f534a, true); // «JSON»
  out.set(json, 20);

  const binHeader = 20 + jsonPadded;
  view.setUint32(binHeader, binPadded, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // «BIN»
  out.set(bin, binHeader + 8);

  return out;
}

async function buildProject(): Promise<{ project: Project; files: Map<string, Uint8Array> }> {
  const now = new Date('2026-03-01T10:00:00.000Z').toISOString();
  const base = createProject({
    id: newUuid(),
    title: 'Unidad U-200 — paquete de prueba',
    client: 'PDI Advanced',
    site: 'Planta Norte',
    now,
    appVersion: '0.14.0',
  });

  const files = new Map<string, Uint8Array>();
  const { sha256 } = await import('../packages/persistence/src/hash');

  /* Se reserva antes para que el marcador pueda apuntar a la ventana. */
  const infoWindowId = newUuid();
  const infoTabId = newUuid();
  const infoDocsTabId = newUuid();

  const scenes = [];
  const media = [];

  for (const [index, title] of ['Sala de bombas', 'Plataforma superior'].entries()) {
    const bytes = stripedPng(1024, 512);
    const relativePath = `media/escena-${index + 1}.png`;
    files.set(relativePath, bytes);

    const mediaId = newUuid();
    media.push({
      id: mediaId,
      sha256: await sha256(bytes),
      mime: 'image/png' as const,
      kind: 'image' as const,
      relativePath,
      originalName: `${title}.png`,
      byteSize: bytes.byteLength,
      width: 1024,
      height: 512,
      durationS: null,
      thumbnailPath: null,
      panorama: {
        coverage: { horizontalDeg: 360, verticalDeg: 180, centerYaw: 0, centerPitch: 0 },
        equirectangular: true,
        capturedHeadingRad: null,
        captureHeightM: 1.6,
        gps: null,
      },
      tiles: [],
      quarantined: false,
      quarantineReason: null,
      createdAt: now,
    });

    scenes.push({
      id: newUuid(),
      projectId: base.id,
      kind: 'panorama' as const,
      title,
      description: '',
      mediaId,
      camera: {
        initialView: { yaw: 0, pitch: 0, fov: 75 },
        zoom: { minFovDeg: 30, maxFovDeg: 100 },
        dragSpeed: 1,
        inertia: 0.82,
        autoRotate: false,
        autoRotateSpeed: 0.05,
        autoRotateIdleS: 8,
        invertPitch: false,
      },
      model: null,
      hotspots: [],
      actions: [],
      order: index,
      group: 'Unidad U-200',
      tags: [],
      excludedFromPublish: false,
      ambientEffect: { effect: 'none' as const, intensity: 0.5 },
      createdAt: now,
      updatedAt: now,
    });
  }

  // Marcador de navegación de la primera a la segunda escena: es lo que la
  // prueba pulsa para comprobar que el recorrido navega de verdad.
  const first = scenes[0];
  const second = scenes[1];
  if (first !== undefined && second !== undefined) {
    /*
     * Marcador de álbum, para que la prueba de extremo a extremo pueda
     * comprobar la ventana de fotografías contra un paquete de verdad: el
     * recorrido de la ventana y el del álbum sólo se ejercitan con más de una
     * imagen dentro.
     */
    const albumHotspot = {
      id: newUuid(),
      sceneId: first.id,
      name: 'Fotos de detalle',
      anchor: { space: 'spherical', yaw: -0.45, pitch: -0.05 },
      geometry: { shape: 'icon', mediaId: null, builtinIcon: 'info', sizePx: 44 },
      style: {
        colorToken: 'accent',
        colorOverride: null,
        opacity: 1,
        pulse: false,
        showLabel: true,
        labelTemplate: 'Fotos de detalle',
        hoverScale: 1.15,
        transform: { scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 },
        projection: 'billboard',
      },
      actions: [
        {
          id: newUuid(),
          event: 'click',
          config: {
            type: 'openMedia',
            mediaId: media[0]?.id,
            albumMediaIds: media.map((entry) => entry.id),
            autoplay: false,
          },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
      assetId: null,
      visibility: { desktop: true, tablet: true, mobile: true, vr: true },
      preload: 'lazy',
      locked: false,
      hiddenInEditor: false,
      tags: [],
      autoGenerated: false,
      autoConfidence: null,
      reviewed: true,
      order: 1,
      createdAt: now,
      updatedAt: now,
    };

    /* Un marcador que abre una ventana compuesta por el autor.
     *
     * Va en el paquete porque la ventana sólo se puede comprobar de verdad
     * aquí: el texto con formato, el pie de la imagen, el enlace a otra escena
     * y el aviso del contenido web no declarado dependen todos de cómo el
     * navegador pinta y de la política del propio paquete.
     */
    const infoHotspot = {
      ...albumHotspot,
      id: newUuid(),
      name: 'Ficha del equipo',
      anchor: { space: 'spherical' as const, yaw: 0.6, pitch: -0.1 },
      style: { ...albumHotspot.style, labelTemplate: 'Ficha del equipo' },
      actions: [
        {
          id: newUuid(),
          event: 'click' as const,
          config: { type: 'openInfoWindow' as const, windowId: infoWindowId, modal: false },
          order: 0,
          delayMs: 0,
          focusDwellMs: 1200,
          once: false,
          requiresScore: null,
          enabled: true,
        },
      ],
      order: 2,
    };

    first.hotspots = [
      albumHotspot,
      infoHotspot as (typeof first.hotspots)[number],
      {
        id: newUuid(),
        sceneId: first.id,
        name: 'A la plataforma',
        anchor: { space: 'spherical', yaw: 0, pitch: 0 },
        geometry: { shape: 'icon', mediaId: null, builtinIcon: 'arrow', sizePx: 48 },
        style: {
          colorToken: 'accent',
          colorOverride: null,
          opacity: 1,
          pulse: false,
          showLabel: true,
          labelTemplate: 'A la plataforma',
          hoverScale: 1.15,
          transform: { scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 },
          projection: 'billboard',
        },
        actions: [
          {
            id: newUuid(),
            event: 'click',
            config: {
              type: 'goToScene',
              sceneId: second.id,
              entryMode: 'smart',
              transition: { kind: 'zoomThrough', durationMs: 600, useGeometry: false },
            },
            order: 0,
            delayMs: 0,
            focusDwellMs: 1200,
            once: false,
            requiresScore: null,
            enabled: true,
          },
        ],
        assetId: null,
        visibility: { desktop: true, tablet: true, mobile: true, vr: true },
        preload: 'lazy',
        locked: false,
        hiddenInEditor: false,
        tags: [],
        autoGenerated: false,
        autoConfidence: null,
        reviewed: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      } as (typeof first.hotspots)[number],
    ];
  }

  /* Una escena de modelo 3D con un marcador anclado a su pieza, que lleva a
     la panorámica (L05). Va en el paquete porque el camino del modelo —bajar
     el archivo, cargarlo, normalizarlo, proyectar el marcador y comprobar la
     oclusión— sólo se puede comprobar con WebGL de verdad. */
  const glb = minimalGlb('valvula_01');
  const glbPath = 'media/modelos/unidad.glb';
  files.set(glbPath, glb);

  const glbMediaId = newUuid();
  media.push({
    id: glbMediaId,
    sha256: await sha256(glb),
    mime: 'model/gltf-binary' as const,
    kind: 'model' as const,
    relativePath: glbPath,
    originalName: 'Unidad U-200.glb',
    byteSize: glb.byteLength,
    width: null,
    height: null,
    durationS: null,
    thumbnailPath: null,
    panorama: null,
    tiles: [],
    quarantined: false,
    quarantineReason: null,
    createdAt: now,
  });

  const modelSceneId = newUuid();
  scenes.push({
    ...(scenes[0] as (typeof scenes)[number]),
    id: modelSceneId,
    kind: 'model' as const,
    title: 'Modelo de la unidad',
    mediaId: glbMediaId,
    model: {
      defaultMode: 'orbit' as const,
      allowedModes: ['orbit' as const, 'flyOver' as const, 'firstPerson' as const],
      bounds: {
        minDistance: 0.5,
        maxDistance: 500,
        minPolarAngle: 0.05,
        maxPolarAngle: Math.PI - 0.05,
        eyeHeight: 1.7,
        moveSpeed: 3,
        collide: true,
      },
      lighting: {
        ambientIntensity: 0.6,
        directionalIntensity: 1.2,
        directionalYaw: 0.8,
        directionalPitch: 0.9,
        shadows: true,
        background: { kind: 'token' as const, surfaceToken: 'sunken' as const },
        exposure: 1,
      },
      savedViews: [],
      adaptiveResolution: true,
      targetFps: 50,
      minPixelRatio: 0.6,
      autoplayAnimations: [],
      coordinateSpaceId: null,
    },
    hotspots: [
      {
        ...(first?.hotspots[0] as NonNullable<typeof first>['hotspots'][number]),
        id: newUuid(),
        sceneId: modelSceneId,
        name: 'A la sala de bombas',
        anchor: {
          space: 'modelSurface' as const,
          nodeName: 'valvula_01',
          localPosition: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        style: {
          ...(first?.hotspots[0]?.style as NonNullable<typeof first>['hotspots'][0]['style']),
          labelTemplate: 'A la sala de bombas',
        },
        actions: [
          {
            id: newUuid(),
            event: 'click' as const,
            config: {
              type: 'goToScene' as const,
              sceneId: (first?.id ?? modelSceneId) as Uuid,
              entryMode: 'smart' as const,
              transition: { kind: 'fade' as const, durationMs: 600, useGeometry: true },
            },
            order: 0,
            delayMs: 0,
            focusDwellMs: 1200,
            once: false,
            requiresScore: null,
            enabled: true,
          },
        ],
        order: 0,
      },
    ],
    order: scenes.length,
  } as (typeof scenes)[number]);

  /* Un plano con las dos escenas situadas.
   *
   * El paquete lo lleva porque el plano y el radar sólo se pueden comprobar en
   * un navegador de verdad: en jsdom la imagen no tiene tamaño y el visor no
   * puede dibujar el cono. Las dos escenas van en zonas distintas para que el
   * selector de zonas exista y se pueda probar.
   */
  const planBytes = stripedPng(512, 512);
  const planPath = 'media/planos/planta.png';
  files.set(planPath, planBytes);

  const planMediaId = newUuid();
  media.push({
    id: planMediaId,
    sha256: await sha256(planBytes),
    mime: 'image/png' as const,
    kind: 'image' as const,
    relativePath: planPath,
    originalName: 'Planta.png',
    byteSize: planBytes.byteLength,
    width: 512,
    height: 512,
    durationS: null,
    thumbnailPath: null,
    panorama: null,
    tiles: [],
    quarantined: false,
    quarantineReason: null,
    createdAt: now,
  });

  const planId = newUuid();
  const plans = [
    {
      id: planId,
      name: 'Planta general',
      mediaId: planMediaId,
      floor: 'Cota 0',
      floorOrder: 1,
      orientation: { northRad: 0, sceneNorthOffsetRad: 0 },
      showRadar: true,
      radarApertureDeg: 60,
    },
  ];

  /* Una posición distinta por escena. Dos puntos en el mismo sitio se tapan y
     el de abajo deja de poderse pulsar, que es un fallo del paquete de prueba
     difícil de reconocer: parece un fallo del plano. */
  const markerSpots = [
    { x: 0.3, y: 0.7 },
    { x: 0.72, y: 0.28 },
    { x: 0.52, y: 0.5 },
  ] as const;

  const planMarkers = scenes.map((scene, index) => ({
    id: newUuid(),
    planId,
    sceneId: scene.id,
    position: markerSpots[index % markerSpots.length] ?? { x: 0.5, y: 0.5 },
    label: '',
    headingRad: (index * Math.PI) / 2,
  }));

  /* Una ventana con dos pestañas: texto con variables y formato, una imagen
     con pie, un enlace a la otra escena, y un contenido web cuyo origen no se
     declara en ninguna acción de Webframe, de modo que la política del paquete
     no lo admite y el visor tiene que explicarlo en lugar de dejar un hueco. */
  const infoWindows = [
    {
      id: infoWindowId,
      name: 'Ficha del equipo',
      title: 'Ficha de {{scene.title}}',
      tabs: [
        {
          id: infoTabId,
          title: 'General',
          blocks: [
            {
              type: 'text' as const,
              text:
                'Bomba **P-101A** de la {{scene.title}}.\n\n' +
                '- Cerrar la válvula de descarga\n' +
                '- Purgar la línea\n\n' +
                'Consulte la [norma de arranque](https://ejemplo.com/norma).',
            },
            {
              type: 'image' as const,
              mediaId: planMediaId,
              caption: 'Ubicación en el plano',
            },
            {
              type: 'sceneLink' as const,
              sceneId: scenes[1]?.id ?? scenes[0]?.id ?? '',
              label: '',
            },
          ],
        },
        {
          id: infoDocsTabId,
          title: 'Enlaces',
          blocks: [
            /* Declarado: su origen entra en la política del paquete, así que
               el visor lo enmarca. La página no existe —el contenedor no sale
               a internet—, pero lo que se comprueba aquí es que el marco se
               crea con los permisos mínimos. */
            {
              type: 'webframe' as const,
              url: 'https://mapa.ejemplo.com/embed',
              heightPx: 260,
              allowFullscreen: false,
            },
            {
              type: 'text' as const,
              text: 'Y un bloque que el autor dejó sin configurar:',
            },
            /* Sin configurar: la publicación no mete esta dirección en la
               política —a propósito—, así que el visor tiene que explicar por
               qué no lo muestra en lugar de dejar un recuadro en blanco. Es el
               caso real de un autor que añade el bloque y olvida la dirección. */
            {
              type: 'webframe' as const,
              url: 'https://example.invalid/mapa',
              heightPx: 200,
              allowFullscreen: false,
            },
          ],
        },
      ],
      widthPx: 760,
      heightPx: 520,
      modal: false,
      onCloseActions: [],
    },
  ];

  /* Una interfaz diseñada, con lo que de verdad hay que ver dibujado en un
     navegador: texto con variables, un botón que ejecuta una acción, una lista
     de miniaturas que navega, pestañas, y un componente excluido del móvil.
     Sin esto, la interfaz del autor sólo se probaría en jsdom, donde no hay
     disposición de verdad. */
  const panelId = newUuid();
  const thumbsId = newUuid();
  const skinNodes = [
    {
      id: panelId,
      name: 'Barra inferior',
      config: {
        kind: 'container' as const,
        direction: 'row' as const,
        justify: 'spaceBetween' as const,
        align: 'center' as const,
        scrollable: false,
      },
      box: {
        anchor: 'bottom' as const,
        offsetX: 0,
        offsetY: 16,
        width: null,
        height: 92,
        widthPercent: 0.92,
        heightPercent: null,
        minWidth: 0,
        minHeight: 0,
        padding: 12,
        gap: 12,
      },
      style: {
        background: { kind: 'token' as const, surfaceToken: 'overlay' as const },
        backdropBlur: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: null,
        shadow: 'md' as const,
        opacity: 1,
        fontMediaId: null,
        fontSize: null,
        fontWeight: null,
        textColor: null,
        textAlign: 'left' as const,
      },
      visibility: { desktop: true, tablet: true, mobile: true, vr: true },
      initiallyVisible: true,
      actions: [],
      tabId: null,
      sceneIds: [],
      locked: false,
      children: [
        {
          id: newUuid(),
          name: 'Dónde estoy',
          config: {
            kind: 'text' as const,
            template: 'Está en **{{scene.title}}** · {{time.elapsed}}',
            markdown: true,
          },
          box: {
            anchor: 'left' as const,
            offsetX: 4,
            offsetY: 0,
            width: 340,
            height: 48,
            widthPercent: null,
            heightPercent: null,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            gap: 0,
          },
          style: {
            background: { kind: 'none' as const },
            backdropBlur: 0,
            borderRadius: 0,
            borderWidth: 0,
            borderColor: null,
            shadow: 'none' as const,
            opacity: 1,
            fontMediaId: null,
            fontSize: 13,
            fontWeight: null,
            textColor: null,
            textAlign: 'left' as const,
          },
          visibility: { desktop: true, tablet: true, mobile: true, vr: true },
          initiallyVisible: true,
          actions: [],
          tabId: null,
          sceneIds: [],
          children: [],
          locked: false,
        },
        {
          id: newUuid(),
          name: 'Ocultar escenas',
          config: {
            kind: 'button' as const,
            label: 'Ocultar escenas',
            icon: '',
            variant: 'ghost' as const,
            imageMediaId: null,
            imageHoverMediaId: null,
            tooltip: '',
          },
          box: {
            anchor: 'center' as const,
            offsetX: 0,
            offsetY: 0,
            width: 160,
            height: 40,
            widthPercent: null,
            heightPercent: null,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            gap: 0,
          },
          style: {
            background: { kind: 'none' as const },
            backdropBlur: 0,
            borderRadius: 6,
            borderWidth: 0,
            borderColor: null,
            shadow: 'none' as const,
            opacity: 1,
            fontMediaId: null,
            fontSize: null,
            fontWeight: null,
            textColor: null,
            textAlign: 'center' as const,
          },
          visibility: { desktop: true, tablet: true, mobile: true, vr: true },
          initiallyVisible: true,
          actions: [
            {
              id: newUuid(),
              event: 'click' as const,
              config: { type: 'toggleElement' as const, elementIds: [thumbsId] },
              order: 0,
              delayMs: 0,
              focusDwellMs: 1200,
              once: false,
              requiresScore: null,
              enabled: true,
            },
          ],
          tabId: null,
          sceneIds: [],
          children: [],
          locked: false,
        },
        {
          id: newUuid(),
          name: 'Plano de planta',
          config: {
            kind: 'button' as const,
            label: 'Plano de planta',
            icon: '',
            variant: 'primary' as const,
            imageMediaId: null,
            imageHoverMediaId: null,
            tooltip: 'Abre el plano de la planta',
          },
          box: {
            anchor: 'right' as const,
            offsetX: 4,
            offsetY: 0,
            width: 150,
            height: 40,
            widthPercent: null,
            heightPercent: null,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            gap: 0,
          },
          style: {
            background: { kind: 'none' as const },
            backdropBlur: 0,
            borderRadius: 6,
            borderWidth: 0,
            borderColor: null,
            shadow: 'none' as const,
            opacity: 1,
            fontMediaId: null,
            fontSize: null,
            fontWeight: null,
            textColor: null,
            textAlign: 'center' as const,
          },
          visibility: { desktop: true, tablet: true, mobile: false, vr: true },
          initiallyVisible: true,
          actions: [
            {
              id: newUuid(),
              event: 'click' as const,
              config: { type: 'showPlan' as const, planId },
              order: 0,
              delayMs: 0,
              focusDwellMs: 1200,
              once: false,
              requiresScore: null,
              enabled: true,
            },
          ],
          tabId: null,
          sceneIds: [],
          children: [],
          locked: false,
        },
      ],
    },
    {
      id: thumbsId,
      name: 'Escenas',
      config: {
        kind: 'thumbnailList' as const,
        sceneIds: [],
        orientation: 'vertical' as const,
        thumbnailSize: 104,
        showTitles: true,
      },
      box: {
        anchor: 'topRight' as const,
        offsetX: 16,
        offsetY: 16,
        width: 124,
        height: 280,
        widthPercent: null,
        heightPercent: null,
        minWidth: 0,
        minHeight: 0,
        padding: 8,
        gap: 8,
      },
      style: {
        background: { kind: 'token' as const, surfaceToken: 'overlay' as const },
        backdropBlur: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: null,
        shadow: 'sm' as const,
        opacity: 1,
        fontMediaId: null,
        fontSize: null,
        fontWeight: null,
        textColor: null,
        textAlign: 'left' as const,
      },
      visibility: { desktop: true, tablet: true, mobile: false, vr: false },
      initiallyVisible: true,
      actions: [],
      tabId: null,
      sceneIds: [],
      children: [],
      locked: false,
    },
  ];

  const skinId = newUuid();
  const skins = [
    {
      id: skinId,
      name: 'Interfaz de la planta',
      description: 'Barra inferior con contexto y navegación lateral.',
      layoutMode: 'fluid' as const,
      designWidth: 1920,
      designHeight: 1080,
      root: skinNodes,
      templateId: null,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const project: Project = {
    ...base,
    media,
    scenes,
    plans,
    planMarkers,
    infoWindows,
    skins,
    settings: {
      ...base.settings,
      entrySceneId: (first?.id ?? null) as Uuid | null,
      defaultSkinId: skinId as Uuid,
    },
  };

  return { project, files };
}

async function readViewerRuntime(): Promise<Map<string, Uint8Array>> {
  const runtime = new Map<string, Uint8Array>();

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // La ruta servida es relativa a dist/, igual que en el paquete.
      runtime.set(relative(VIEWER_DIST, full).split('\\').join('/'), await readFile(full));
    }
  };

  await walk(join(VIEWER_DIST, 'viewer'));
  return runtime;
}

async function main(): Promise<void> {
  const runtime = await readViewerRuntime();
  if (runtime.size === 0) {
    throw new Error(
      'El visor no está compilado. Ejecute antes: npm run build:viewer',
    );
  }

  const { project, files } = await buildProject();

  const result = await exportWebSite(project, {
    publishedAt: new Date().toISOString(),
    appVersion: '0.14.0',
    runtime,
    mediaFiles: files,
  });

  for (const file of result.files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }

  console.log(
    `Paquete de prueba escrito en ${outDir}: ${result.files.length} archivos, ` +
      `${(result.totalBytes / 1024).toFixed(0)} KB` +
      (result.warnings.length > 0 ? `, ${result.warnings.length} advertencia(s)` : ''),
  );
  for (const warning of result.warnings) console.log(`  aviso: ${warning}`);
}

await main();
