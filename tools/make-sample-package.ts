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

    first.hotspots = [
      albumHotspot,
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

  const planMarkers = scenes.map((scene, index) => ({
    id: newUuid(),
    planId,
    sceneId: scene.id,
    position: index === 0 ? { x: 0.3, y: 0.7 } : { x: 0.72, y: 0.28 },
    label: '',
    headingRad: index === 0 ? 0 : Math.PI / 2,
  }));

  const project: Project = {
    ...base,
    media,
    scenes,
    plans,
    planMarkers,
    settings: { ...base.settings, entrySceneId: (first?.id ?? null) as Uuid | null },
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
