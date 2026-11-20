/**
 * Proyecto de demostración.
 *
 * Existe por una razón práctica: una aplicación que al abrirse muestra una
 * pantalla vacía no se puede evaluar, ni por el cliente ni por quien la
 * prueba. Este proyecto llena cada panel con datos coherentes —una unidad de
 * bombeo con su jerarquía, instrumentos, documentos, observaciones y
 * variables de proceso— de modo que al arrancar se ve el producto funcionando
 * y no un formulario en blanco.
 *
 * Las panorámicas se generan por código como rejillas de calibración: no hay
 * fotografías de planta reales en el repositorio, y una imagen descargada de
 * Internet traería una licencia que nadie ha revisado. La rejilla tiene
 * además una ventaja: permite comprobar a ojo que la proyección esférica,
 * la orientación y los límites de cámara son correctos, cosa que una
 * fotografía no deja ver.
 */
// Se importa el submódulo de huellas y no el índice del paquete: el índice
// arrastra sql.js, y el proyecto de demostración sólo necesita calcular sumas.
import { sha256 } from '@it360/persistence/hash';
import {
  createProject,
  newUuid,
  type Asset,
  type AssetClass,
  type Hotspot,
  type Project,
  type Scene,
  type Uuid,
} from '@it360/domain';

const ISO = (offsetDays = 0): string =>
  new Date(Date.now() - offsetDays * 86_400_000).toISOString();

/* ------------------------------------------------------------------ *
 * Panorámicas sintéticas
 * ------------------------------------------------------------------ */

/**
 * Dibuja una equirectangular de calibración.
 *
 * Incluye el horizonte, meridianos cada 30°, paralelos cada 30° y rótulos de
 * rumbo. Si el visor orienta mal, se ve de inmediato: el rótulo «N» tiene que
 * caer en el centro cuando yaw vale cero.
 */
/**
 * PNG de 1×1 transparente, válido byte a byte.
 *
 * Se usa cuando el entorno no ofrece contexto 2D —jsdom en las pruebas—. La
 * alternativa, devolver una cadena vacía, dejaría un medio con cero bytes
 * cuya suma de verificación no corresponde a ninguna imagen; aquí el
 * contenido existe de verdad y su suma lo describe.
 */
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function makeCalibrationPanorama(options: {
  readonly width: number;
  readonly label: string;
  readonly hue: number;
}): string {
  const { width, label, hue } = options;
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return BLANK_PNG;

  // Degradado vertical: cenit claro, nadir oscuro. Da sensación de espacio y
  // deja ver si la imagen está invertida.
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, `hsl(${hue} 28% 26%)`);
  sky.addColorStop(0.48, `hsl(${hue} 22% 17%)`);
  sky.addColorStop(0.52, `hsl(${hue} 18% 12%)`);
  sky.addColorStop(1, `hsl(${hue} 14% 7%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = Math.max(width / 2048, 1);
  ctx.strokeStyle = `hsl(${hue} 40% 42% / 0.45)`;

  for (let deg = 0; deg < 360; deg += 30) {
    const x = (deg / 360) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let deg = -60; deg <= 60; deg += 30) {
    const y = height / 2 - (deg / 180) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Horizonte marcado: es la referencia que delata un pitch desviado.
  ctx.strokeStyle = `hsl(${hue} 60% 55% / 0.8)`;
  ctx.lineWidth = Math.max(width / 1024, 2);
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const fontSize = Math.round(width / 42);
  ctx.font = `600 ${fontSize}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Rumbos: yaw 0 debe quedar en el centro de la imagen.
  const bearings: Array<[number, string]> = [
    [0, 'O'],
    [90, 'N'],
    [180, 'E'],
    [270, 'S'],
  ];
  for (const [deg, name] of bearings) {
    const x = (deg / 360) * width;
    ctx.fillStyle = `hsl(${hue} 60% 72%)`;
    ctx.fillText(name, x, height / 2 - fontSize * 1.6);
  }

  for (let deg = 0; deg < 360; deg += 30) {
    ctx.fillStyle = `hsl(${hue} 30% 60% / 0.7)`;
    ctx.font = `400 ${Math.round(fontSize * 0.62)}px "IBM Plex Mono", monospace`;
    ctx.fillText(`${deg}°`, (deg / 360) * width, height / 2 + fontSize);
  }

  ctx.fillStyle = `hsl(${hue} 20% 88%)`;
  ctx.font = `600 ${Math.round(fontSize * 1.3)}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.fillText(label, width / 2, height / 2 + fontSize * 4);

  return canvas.toDataURL('image/jpeg', 0.86);
}

/** Imagen de plano sintética con la planta de la unidad. */
export function makeDemoPlan(width = 1400): string {
  const height = Math.round(width * 0.68);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return BLANK_PNG;

  ctx.fillStyle = '#0f131a';
  ctx.fillRect(0, 0, width, height);

  // Retícula de replanteo.
  ctx.strokeStyle = '#1d2531';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += width / 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#4b5768';
  ctx.lineWidth = 3;
  ctx.strokeRect(width * 0.08, height * 0.1, width * 0.84, height * 0.78);

  // Sala de bombas y plataforma.
  ctx.fillStyle = '#161c25';
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  const rooms: Array<[number, number, number, number, string]> = [
    [0.12, 0.16, 0.36, 0.42, 'SALA DE BOMBAS'],
    [0.54, 0.16, 0.32, 0.26, 'PLATAFORMA'],
    [0.54, 0.5, 0.32, 0.3, 'SUBESTACIÓN'],
    [0.12, 0.64, 0.36, 0.2, 'ALMACÉN'],
  ];
  ctx.font = `500 ${Math.round(width / 62)}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (const [rx, ry, rw, rh, name] of rooms) {
    const x = width * rx;
    const y = height * ry;
    const w = width * rw;
    const h = height * rh;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#8a94a6';
    ctx.fillText(name, x + w / 2, y + h / 2);
    ctx.fillStyle = '#161c25';
  }

  // Norte declarado: sin él el radar no puede ser correcto.
  const nx = width * 0.94;
  const ny = height * 0.12;
  ctx.strokeStyle = '#12a5b8';
  ctx.fillStyle = '#12a5b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nx, ny + 34);
  ctx.lineTo(nx, ny - 20);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(nx, ny - 26);
  ctx.lineTo(nx - 7, ny - 10);
  ctx.lineTo(nx + 7, ny - 10);
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 ${Math.round(width / 70)}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.fillText('N', nx, ny + 52);

  return canvas.toDataURL('image/png');
}

/* ------------------------------------------------------------------ *
 * Documento de muestra
 * ------------------------------------------------------------------ */

/**
 * PDF mínimo pero válido, generado por código.
 *
 * Se emite un PDF de verdad en lugar de registrar un documento inexistente
 * porque el medio lleva su suma SHA-256 y su tamaño: inventarlos produciría un
 * proyecto que falla la verificación de integridad en cuanto alguien lo
 * guarda y lo vuelve a abrir, y el fallo aparecería lejos de aquí.
 */
export function makeDemoDatasheet(title: string): string {
  const lines = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
  ];
  const text = `BT /F1 14 Tf 60 760 Td (${title.replace(/[()\\]/g, ' ')}) Tj ET`;
  lines.push(`4 0 obj << /Length ${text.length} >> stream\n${text}\nendstream endobj`);
  lines.push('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj');
  lines.push('trailer << /Root 1 0 R /Size 6 >>', '%%EOF', '');
  const body = lines.join('\n');
  return `data:application/pdf;base64,${btoa(body)}`;
}

/** Bytes de una URL de datos en base64. */
function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const base64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Suma y tamaño reales del contenido generado. */
async function fingerprint(dataUrl: string): Promise<{ sha256: string; byteSize: number }> {
  const bytes = dataUrlBytes(dataUrl);
  return { sha256: await sha256(bytes), byteSize: bytes.byteLength };
}

/* ------------------------------------------------------------------ *
 * Proyecto
 * ------------------------------------------------------------------ */

export interface DemoAssets {
  readonly project: Project;
  /** URLs de las imágenes generadas, por identificador de medio. */
  readonly mediaUrls: ReadonlyMap<string, string>;
}

const uuid = (): Uuid => newUuid();

/**
 * Construye el proyecto de demostración con sus imágenes.
 *
 * Las imágenes se generan en memoria y se referencian por URL de datos. En un
 * proyecto real vienen del paquete `.ivp`; aquí la sustitución es deliberada
 * y queda confinada a este módulo.
 */
export async function buildDemoProject(): Promise<DemoAssets> {
  const base = createProject({
    id: uuid(),
    title: 'Unidad de bombeo U-200 — demostración',
    client: 'PDI Advanced',
    site: 'Planta Norte',
    now: ISO(),
    appVersion: '0.14.0',
  });

  const mediaUrls = new Map<string, string>();

  const panoramas = [
    { label: 'Sala de bombas', hue: 205 },
    { label: 'Plataforma superior', hue: 188 },
    { label: 'Subestación', hue: 42 },
  ];

  const mediaRecords = await Promise.all(
    panoramas.map(async (p, index) => {
    const id = uuid();
    const url = makeCalibrationPanorama({ width: 3072, label: p.label, hue: p.hue });
    mediaUrls.set(id, url);
    const print = await fingerprint(url);
    return {
      id,
      sha256: print.sha256,
      mime: 'image/jpeg' as const,
      kind: 'image' as const,
      relativePath: `media/pano-${index + 1}.jpg`,
      originalName: `${p.label}.jpg`,
      byteSize: print.byteSize,
      width: 3072,
      height: 1536,
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
      renditions: [],
      quarantined: false,
      quarantineReason: null,
      createdAt: ISO(12),
    };
    }),
  );

  const planMediaId = uuid();
  const planUrl = makeDemoPlan();
  mediaUrls.set(planMediaId, planUrl);
  const planPrint = await fingerprint(planUrl);
  const planMedia = {
    id: planMediaId,
    sha256: planPrint.sha256,
    mime: 'image/png' as const,
    kind: 'image' as const,
    relativePath: 'media/plano-n0.png',
    originalName: 'Plano nivel 0.png',
    byteSize: planPrint.byteSize,
    width: 1400,
    height: 952,
    durationS: null,
    thumbnailPath: null,
    panorama: null,
    tiles: [],
    renditions: [],
    quarantined: false,
    quarantineReason: null,
    createdAt: ISO(12),
  };

  const datasheetId = uuid();
  const datasheetUrl = makeDemoDatasheet('P-101A hoja de datos Rev.2');
  mediaUrls.set(datasheetId, datasheetUrl);
  const datasheetPrint = await fingerprint(datasheetUrl);
  const datasheet = {
    id: datasheetId,
    sha256: datasheetPrint.sha256,
    mime: 'application/pdf' as const,
    kind: 'document' as const,
    relativePath: 'documents/p-101a-hoja-datos.pdf',
    originalName: 'P-101A hoja de datos Rev.2.pdf',
    byteSize: datasheetPrint.byteSize,
    width: null,
    height: null,
    durationS: null,
    thumbnailPath: null,
    panorama: null,
    tiles: [],
    renditions: [],
    quarantined: false,
    quarantineReason: null,
    createdAt: ISO(40),
  };

  /* --- Clases de activo --- */
  const plantClass: AssetClass = {
    id: uuid(),
    code: 'PLANT',
    name: 'Planta',
    description: 'Instalación completa',
    level: 'plant',
    attributes: [],
    icon: 'plant',
    parentClassId: null,
  };
  const unitClass: AssetClass = {
    id: uuid(),
    code: 'UNIT',
    name: 'Unidad de proceso',
    description: '',
    level: 'unit',
    attributes: [],
    icon: 'layers',
    parentClassId: null,
  };
  const pumpClass: AssetClass = {
    id: uuid(),
    code: 'PUMP_CENTRIFUGAL',
    name: 'Bomba centrífuga',
    description: 'Bomba centrífuga horizontal de proceso',
    level: 'equipment',
    attributes: [
      { key: 'flow_rate', label: 'Caudal nominal', type: 'quantity', unit: 'm³/h', required: true, options: [], group: 'Proceso', order: 0, helpText: '' },
      { key: 'head', label: 'Altura manométrica', type: 'quantity', unit: 'm', required: false, options: [], group: 'Proceso', order: 1, helpText: '' },
      { key: 'design_pressure', label: 'Presión de diseño', type: 'quantity', unit: 'bar', required: true, options: [], group: 'Proceso', order: 2, helpText: '' },
      { key: 'driver', label: 'Accionamiento', type: 'enum', unit: null, required: false, options: ['Motor eléctrico', 'Turbina de vapor'], group: 'Mecánico', order: 0, helpText: '' },
      { key: 'seal_plan', label: 'Plan de sello', type: 'text', unit: null, required: false, options: [], group: 'Mecánico', order: 1, helpText: 'Plan API 682' },
    ],
    icon: 'equipment',
    parentClassId: null,
  };
  const transmitterClass: AssetClass = {
    id: uuid(),
    code: 'XMTR_PRESSURE',
    name: 'Transmisor de presión',
    description: '',
    level: 'component',
    attributes: [
      { key: 'range_min', label: 'Rango mínimo', type: 'quantity', unit: 'bar', required: true, options: [], group: 'Instrumentación', order: 0, helpText: '' },
      { key: 'range_max', label: 'Rango máximo', type: 'quantity', unit: 'bar', required: true, options: [], group: 'Instrumentación', order: 1, helpText: '' },
      { key: 'protocol', label: 'Protocolo', type: 'enum', unit: null, required: false, options: ['HART', 'Foundation Fieldbus', '4-20 mA'], group: 'Instrumentación', order: 2, helpText: '' },
    ],
    icon: 'instrument',
    parentClassId: null,
  };

  /* --- Activos --- */
  const plant: Asset = {
    id: uuid(),
    projectId: base.id,
    tag: 'PL-NORTE' as Asset['tag'],
    name: 'Planta Norte',
    description: '',
    classId: plantClass.id,
    level: 'plant',
    parentId: null,
    attributes: {},
    revision: 1,
    status: 'published',
    criticality: null,
    manufacturer: '',
    model: '',
    serialNumber: '',
    createdAt: ISO(200),
    updatedAt: ISO(30),
  };

  const unit: Asset = {
    ...plant,
    id: uuid(),
    tag: 'U-200' as Asset['tag'],
    name: 'Unidad de bombeo 200',
    classId: unitClass.id,
    level: 'unit',
    parentId: plant.id,
  };

  const pumpA: Asset = {
    ...plant,
    id: uuid(),
    tag: 'P-101A' as Asset['tag'],
    name: 'Bomba de alimentación A',
    description: 'Bomba centrífuga de alimentación a torre T-201.',
    classId: pumpClass.id,
    level: 'equipment',
    parentId: unit.id,
    attributes: {
      flow_rate: 145,
      head: 92,
      design_pressure: 16,
      driver: 'Motor eléctrico',
      seal_plan: 'API 682 Plan 11/52',
    },
    criticality: 'high',
    manufacturer: 'Sulzer',
    model: 'OHH 80-250',
    serialNumber: 'SZ-2019-44812',
    revision: 3,
  };

  const pumpB: Asset = {
    ...pumpA,
    id: uuid(),
    tag: 'P-101B' as Asset['tag'],
    name: 'Bomba de alimentación B (reserva)',
    serialNumber: 'SZ-2019-44813',
    criticality: 'medium',
    revision: 2,
  };

  const transmitter: Asset = {
    ...plant,
    id: uuid(),
    tag: 'PIT-2301' as Asset['tag'],
    name: 'Transmisor de presión de descarga',
    classId: transmitterClass.id,
    level: 'component',
    parentId: pumpA.id,
    attributes: { range_min: 0, range_max: 25, protocol: 'HART' },
    manufacturer: 'Emerson',
    model: 'Rosemount 3051S',
    serialNumber: 'EM-3051-77210',
    criticality: 'high',
  };

  /* --- Escenas --- */
  const sceneIds = [uuid(), uuid(), uuid()];
  const now = ISO();

  const makeScene = (index: number, title: string, yaw: number): Scene => ({
    id: sceneIds[index] as Uuid,
    projectId: base.id,
    kind: 'panorama',
    title,
    description: '',
    mediaId: mediaRecords[index]?.id ?? null,
    camera: {
      initialView: { yaw, pitch: 0, fov: 75 },
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
    group: 'Unidad 200',
    tags: [],
    excludedFromPublish: false,
    ambientEffect: { effect: 'none', intensity: 0.5, lightYaw: null, lightPitch: null },
    createdAt: ISO(12),
    updatedAt: now,
  });

  const baseHotspot = (
    id: Uuid,
    sceneId: Uuid,
    name: string,
    yaw: number,
    pitch: number,
  ): Hotspot =>
    ({
      id,
      sceneId,
      name,
      anchor: { space: 'spherical', yaw, pitch },
      geometry: { shape: 'icon', mediaId: null, builtinIcon: 'marker', sizePx: 40 },
      style: {
        colorToken: 'accent',
        colorOverride: null,
        opacity: 1,
        pulse: false,
        showLabel: false,
        labelTemplate: '',
        hoverScale: 1.15,
        transform: { scale: 1, roll: 0, tilt: 0, spin: 0, depth: 1 },
        projection: 'billboard',
      },
      actions: [],
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
      createdAt: ISO(12),
      updatedAt: now,
    }) as Hotspot;

  const navAction = (sceneId: Uuid) =>
    ({
      id: uuid(),
      event: 'click',
      config: {
        type: 'goToScene',
        sceneId,
        entryMode: 'smart',
        transition: { kind: 'zoomThrough', durationMs: 700, useGeometry: false },
      },
      order: 0,
      delayMs: 0,
      focusDwellMs: 1200,
      once: false,
      requiresScore: null,
      enabled: true,
    }) as never;

  const assetAction = (assetId: Uuid) =>
    ({
      id: uuid(),
      event: 'click',
      config: { type: 'showAsset', assetId, tab: 'telemetry' },
      order: 0,
      delayMs: 0,
      focusDwellMs: 1200,
      once: false,
      requiresScore: null,
      enabled: true,
    }) as never;

  const scene0 = makeScene(0, 'Sala de bombas', 0);
  const scene1 = makeScene(1, 'Plataforma superior', 0.6);
  const scene2 = makeScene(2, 'Subestación', -1.1);

  const hotspots0: Hotspot[] = [
    {
      ...baseHotspot(uuid(), scene0.id, 'A plataforma superior', 1.05, -0.08),
      actions: [navAction(scene1.id)],
      style: {
        ...baseHotspot(uuid(), scene0.id, '', 0, 0).style,
        showLabel: true,
        labelTemplate: 'Plataforma superior',
      },
    },
    {
      ...baseHotspot(uuid(), scene0.id, 'P-101A', -0.55, -0.12),
      assetId: pumpA.id,
      actions: [assetAction(pumpA.id)],
      style: {
        ...baseHotspot(uuid(), scene0.id, '', 0, 0).style,
        colorToken: 'nominal',
        showLabel: true,
        labelTemplate: 'P-101A',
      },
    },
    {
      ...baseHotspot(uuid(), scene0.id, 'P-101B', -0.95, -0.14),
      assetId: pumpB.id,
      actions: [assetAction(pumpB.id)],
      style: {
        ...baseHotspot(uuid(), scene0.id, '', 0, 0).style,
        colorToken: 'warning',
        showLabel: true,
        labelTemplate: 'P-101B',
      },
    },
  ];

  const hotspots1: Hotspot[] = [
    {
      ...baseHotspot(uuid(), scene1.id, 'A sala de bombas', -2.1, -0.18),
      actions: [navAction(scene0.id)],
      style: {
        ...baseHotspot(uuid(), scene1.id, '', 0, 0).style,
        showLabel: true,
        labelTemplate: 'Sala de bombas',
      },
    },
    {
      ...baseHotspot(uuid(), scene1.id, 'A subestación', 1.6, -0.1),
      actions: [navAction(scene2.id)],
      style: {
        ...baseHotspot(uuid(), scene1.id, '', 0, 0).style,
        showLabel: true,
        labelTemplate: 'Subestación',
      },
    },
    {
      ...baseHotspot(uuid(), scene1.id, 'PIT-2301', 0.25, -0.25),
      assetId: transmitter.id,
      actions: [assetAction(transmitter.id)],
      style: {
        ...baseHotspot(uuid(), scene1.id, '', 0, 0).style,
        colorToken: 'info',
        showLabel: true,
        labelTemplate: 'PIT-2301',
      },
    },
  ];

  const hotspots2: Hotspot[] = [
    {
      ...baseHotspot(uuid(), scene2.id, 'A plataforma superior', -1.4, -0.12),
      actions: [navAction(scene1.id)],
      style: {
        ...baseHotspot(uuid(), scene2.id, '', 0, 0).style,
        showLabel: true,
        labelTemplate: 'Plataforma superior',
      },
    },
  ];

  /* --- Telemetría --- */
  const connectionId = uuid();
  const mappingPressure = uuid();
  const mappingTemp = uuid();
  const mappingFlow = uuid();
  const mappingVib = uuid();

  const planId = uuid();

  return {
    mediaUrls,
    project: {
      ...base,
      media: [...mediaRecords, planMedia, datasheet] as Project['media'],
      assetClasses: [plantClass, unitClass, pumpClass, transmitterClass],
      assets: [plant, unit, pumpA, pumpB, transmitter],
      assetLocations: [
        {
          id: uuid(),
          assetId: pumpA.id,
          sceneId: scene0.id,
          hotspotId: hotspots0[1]?.id ?? null,
          anchor: { space: 'spherical', yaw: -0.55, pitch: -0.12 },
          primary: true,
          note: 'Vista desde el pasillo central',
        },
        {
          id: uuid(),
          assetId: pumpA.id,
          sceneId: scene1.id,
          hotspotId: null,
          anchor: { space: 'spherical', yaw: -1.9, pitch: -0.5 },
          primary: false,
          note: 'Vista cenital desde la plataforma',
        },
        {
          id: uuid(),
          assetId: transmitter.id,
          sceneId: scene1.id,
          hotspotId: hotspots1[2]?.id ?? null,
          anchor: { space: 'spherical', yaw: 0.25, pitch: -0.25 },
          primary: true,
          note: '',
        },
      ] as Project['assetLocations'],
      documents: [
        {
          id: uuid(),
          assetId: pumpA.id,
          title: 'Hoja de datos de proceso',
          documentCode: 'U200-P-101A-DS-001',
          revision: '2',
          status: 'approved',
          mediaId: datasheet.id,
          discipline: 'process',
          issuedAt: ISO(40),
          supersededById: null,
          createdAt: ISO(40),
        },
        {
          id: uuid(),
          assetId: pumpA.id,
          title: 'Plano de montaje mecánico',
          documentCode: 'U200-P-101A-MD-004',
          revision: 'A',
          status: 'forReview',
          mediaId: datasheet.id,
          discipline: 'mechanical',
          issuedAt: ISO(6),
          supersededById: null,
          createdAt: ISO(6),
        },
      ] as Project['documents'],
      scenes: [
        { ...scene0, hotspots: hotspots0 },
        { ...scene1, hotspots: hotspots1 },
        { ...scene2, hotspots: hotspots2 },
      ],
      plans: [
        {
          id: planId,
          name: 'Nivel 0 — Unidad 200',
          mediaId: planMedia.id,
          floor: 'Nivel 0',
          floorOrder: 0,
          orientation: { northRad: 0, sceneNorthOffsetRad: Math.PI / 2 },
          showRadar: true,
          radarApertureDeg: 62,
        },
      ] as Project['plans'],
      planMarkers: [
        { id: uuid(), planId, sceneId: scene0.id, position: { x: 0.3, y: 0.37 }, label: 'Sala de bombas', headingRad: 0 },
        { id: uuid(), planId, sceneId: scene1.id, position: { x: 0.7, y: 0.29 }, label: 'Plataforma', headingRad: 0.6 },
        { id: uuid(), planId, sceneId: scene2.id, position: { x: 0.7, y: 0.65 }, label: 'Subestación', headingRad: -1.1 },
      ] as Project['planMarkers'],
      noteCategories: [
        { id: 'safety', label: 'Seguridad', colorToken: 'alarm', description: '' },
        { id: 'maintenance', label: 'Mantenimiento', colorToken: 'warning', description: '' },
        { id: 'corrosion', label: 'Corrosión', colorToken: 'warning', description: '' },
        { id: 'instrumentation', label: 'Instrumentación', colorToken: 'info', description: '' },
        { id: 'improvement', label: 'Mejora', colorToken: 'nominal', description: '' },
        { id: 'other', label: 'Otro', colorToken: 'neutral', description: '' },
      ],
      notes: [
        {
          id: uuid(),
          projectId: base.id,
          title: 'Fuga en brida de descarga de P-101A',
          body: 'Goteo intermitente en la brida de descarga. Se observa mancha en el cárter.',
          anchor: { space: 'spherical', yaw: -0.52, pitch: -0.2 },
          sceneId: scene0.id,
          assetId: pumpA.id,
          categoryId: 'maintenance',
          priority: 'urgent',
          status: 'open',
          assigneeId: 'u-simon',
          assigneeName: 'Simón Panzza',
          dueDate: ISO(-3),
          attachments: [],
          comments: [
            {
              id: uuid(),
              noteId: uuid(),
              authorId: 'u-juan',
              authorName: 'Juan Jairo Mercado',
              body: 'Confirmado en ronda del turno de noche. Se solicita repuesto de junta.',
              attachments: [],
              createdAt: ISO(1),
              editedAt: null,
            },
          ],
          authorId: 'u-luis',
          authorName: 'Luis',
          createdAt: ISO(2),
          updatedAt: ISO(1),
          resolvedAt: null,
          resolvedById: null,
          resolution: '',
        },
        {
          id: uuid(),
          projectId: base.id,
          title: 'Barandilla de plataforma sin pintura de protección',
          body: 'Tramo este de la barandilla con óxido superficial.',
          anchor: { space: 'spherical', yaw: 1.2, pitch: -0.4 },
          sceneId: scene1.id,
          assetId: null,
          categoryId: 'corrosion',
          priority: 'normal',
          status: 'inProgress',
          assigneeId: 'u-simon',
          assigneeName: 'Simón Panzza',
          dueDate: ISO(-14),
          attachments: [],
          comments: [],
          authorId: 'u-luis',
          authorName: 'Luis',
          createdAt: ISO(9),
          updatedAt: ISO(4),
          resolvedAt: null,
          resolvedById: null,
          resolution: '',
        },
        {
          id: uuid(),
          projectId: base.id,
          title: 'Señalización de EPP ilegible en el acceso',
          body: '',
          anchor: null,
          sceneId: scene0.id,
          assetId: null,
          categoryId: 'safety',
          priority: 'high',
          status: 'resolved',
          assigneeId: null,
          assigneeName: null,
          dueDate: null,
          attachments: [],
          comments: [],
          authorId: 'u-juan',
          authorName: 'Juan Jairo Mercado',
          createdAt: ISO(25),
          updatedAt: ISO(18),
          resolvedAt: ISO(18),
          resolvedById: 'u-simon',
          resolution: 'Señal sustituida por una de material reflectante.',
        },
      ] as Project['notes'],
      telemetryConnections: [
        {
          id: connectionId,
          name: 'Histórico de proceso — Planta Norte',
          url: 'https://influx.planta-norte.local:8086',
          org: 'planta-norte',
          bucket: 'proceso',
          tokenRef: { keyId: 'it360.influx.planta-norte', label: 'Token de lectura (solo lectura)' },
          timeoutMs: 8000,
          verifyTls: true,
          tlsExemptionReason: '',
          enabled: true,
        },
      ] as Project['telemetryConnections'],
      telemetryMappings: [
        {
          id: mappingPressure, connectionId, assetId: pumpA.id,
          variable: 'Presión de descarga', instrumentTag: transmitter.tag,
          measurement: 'presion', field: 'value', tags: { tag: 'PIT-2301' },
          unit: 'bar', decimals: 2, freshnessSeconds: 120, aggregation: 'mean',
          displayMin: 0, displayMax: 25, enabled: true,
        },
        {
          id: mappingTemp, connectionId, assetId: pumpA.id,
          variable: 'Temperatura de cojinete', instrumentTag: null,
          measurement: 'temperatura', field: 'value', tags: { tag: 'TI-2302' },
          unit: '°C', decimals: 1, freshnessSeconds: 300, aggregation: 'mean',
          displayMin: 0, displayMax: 120, enabled: true,
        },
        {
          id: mappingFlow, connectionId, assetId: pumpA.id,
          variable: 'Caudal', instrumentTag: null,
          measurement: 'caudal', field: 'value', tags: { tag: 'FIC-2300' },
          unit: 'm³/h', decimals: 1, freshnessSeconds: 60, aggregation: 'mean',
          displayMin: 0, displayMax: 200, enabled: true,
        },
        {
          id: mappingVib, connectionId, assetId: pumpA.id,
          variable: 'Vibración radial', instrumentTag: null,
          measurement: 'vibracion', field: 'rms', tags: { tag: 'VIB-2305' },
          unit: 'mm/s', decimals: 2, freshnessSeconds: 30, aggregation: 'max',
          displayMin: 0, displayMax: 12, enabled: true,
        },
      ] as Project['telemetryMappings'],
      conditionRules: [
        { id: uuid(), mappingId: mappingPressure, label: 'Presión alta', comparison: 'gt', threshold: 18, threshold2: null, level: 'alarm', hysteresis: 0.5, order: 0, enabled: true },
        { id: uuid(), mappingId: mappingPressure, label: 'Presión en atención', comparison: 'gt', threshold: 15, threshold2: null, level: 'warning', hysteresis: 0.3, order: 1, enabled: true },
        { id: uuid(), mappingId: mappingTemp, label: 'Cojinete caliente', comparison: 'gt', threshold: 85, threshold2: null, level: 'alarm', hysteresis: 2, order: 0, enabled: true },
        { id: uuid(), mappingId: mappingVib, label: 'Vibración elevada', comparison: 'gt', threshold: 7.1, threshold2: null, level: 'alarm', hysteresis: 0.4, order: 0, enabled: true },
        { id: uuid(), mappingId: mappingVib, label: 'Vibración en atención', comparison: 'gt', threshold: 4.5, threshold2: null, level: 'warning', hysteresis: 0.3, order: 1, enabled: true },
      ] as Project['conditionRules'],
      settings: {
        ...base.settings,
        entrySceneId: scene0.id,
        branding: { ...base.settings.branding, title: 'Recorrido U-200' },
      },
      users: [
        { id: 'u-luis', displayName: 'Luis', email: null, active: true, lastSeenAt: ISO(), createdAt: ISO(300) },
        { id: 'u-juan', displayName: 'Juan Jairo Mercado', email: null, active: true, lastSeenAt: ISO(1), createdAt: ISO(300) },
        { id: 'u-simon', displayName: 'Simón Panzza', email: null, active: true, lastSeenAt: ISO(2), createdAt: ISO(280) },
      ] as Project['users'],
      grants: [
        { id: uuid(), userId: 'u-luis', role: 'administrator', scope: { plantId: null, unitId: null, areaId: null, noteCategoryIds: [] }, grantedBy: 'u-luis', grantedAt: ISO(300), expiresAt: null },
        { id: uuid(), userId: 'u-juan', role: 'reviewer', scope: { plantId: null, unitId: null, areaId: null, noteCategoryIds: [] }, grantedBy: 'u-luis', grantedAt: ISO(300), expiresAt: null },
        { id: uuid(), userId: 'u-simon', role: 'contributor', scope: { plantId: null, unitId: null, areaId: null, noteCategoryIds: [] }, grantedBy: 'u-luis', grantedAt: ISO(280), expiresAt: null },
      ] as Project['grants'],
    },
  };
}
