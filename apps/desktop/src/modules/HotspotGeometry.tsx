/**
 * Geometría de un marcador (etapa 02: D01–D11, D15).
 *
 * El esquema admite seis formas y hasta ahora ninguna se podía configurar: el
 * marcador nacía como icono y se quedaba así. Aquí se elige la forma y se
 * editan sus propiedades.
 *
 * Las reglas viven en `@it360/domain/hotspot-geometry`, no aquí. Esta pantalla
 * las llama y enseña el motivo cuando el dominio dice no: un polígono que baja
 * de tres vértices, cuatro esquinas que quedarían alineadas, una forma que
 * exige un medio que no se ha elegido.
 *
 * Los vértices se editan en una lista numerada, no sólo arrastrando sobre la
 * panorámica. Arrastrar es más cómodo cuando se puede; la lista es lo que
 * permite trabajar con teclado y lo que da la cifra exacta cuando el contorno
 * tiene que coincidir con el borde de un equipo.
 */
import { useState } from 'react';
import {
  CORNER_LABELS,
  insertVertex,
  invertPolygon,
  isAnimatedIconCandidate,
  moveCorner,
  moveVertex,
  planShapeChange,
  radToDeg,
  removeVertex,
  resetCorners,
  shapeNeedsMedia,
  signedArea,
  validatePolygon,
  type Corners,
  type Hotspot,
  type HotspotGeometry,
  type HotspotShape,
  type Project,
  type Uuid,
  type Uv,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Field,
  IconAdd,
  IconTrash,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  TextArea,
  TextInput,
  useToast,
} from '@it360/ui';

export interface HotspotGeometryPanelProps {
  readonly project: Project;
  readonly hotspot: Hotspot;
  readonly onChange: (patch: Partial<Hotspot>, label: string, coalesceKey?: string) => void;
}

const SHAPE_LABELS: Readonly<Record<HotspotShape, string>> = {
  icon: 'Icono o imagen',
  text: 'Texto',
  polygon: 'Polígono sobre un equipo',
  projectedImage: 'Imagen proyectada',
  webframe: 'Contenido web',
  model: 'Modelo 3D',
};

const SHAPE_HINTS: Readonly<Record<HotspotShape, string>> = {
  icon: 'Un punto señalado con un icono propio o del catálogo.',
  text: 'Un rótulo sobre la escena. Admite variables del proyecto.',
  polygon: 'Marca el contorno de un equipo: toda su superficie responde.',
  projectedImage: 'Una imagen ajustada a cuatro esquinas de la panorámica.',
  webframe: 'Una página web embebida dentro de la escena.',
  model: 'Un modelo 3D colocado en la escena.',
};

export function HotspotGeometryPanel({
  project,
  hotspot,
  onChange,
}: HotspotGeometryPanelProps): JSX.Element {
  const { push } = useToast();
  const [pendingShape, setPendingShape] = useState<HotspotShape | null>(null);
  const geometry = hotspot.geometry;

  const images = project.media.filter((m) => m.kind === 'image');
  const models = project.media.filter((m) => m.kind === 'model');

  const setGeometry = (next: HotspotGeometry, label: string, coalesceKey?: string): void => {
    onChange({ geometry: next }, label, coalesceKey);
  };

  /**
   * Cambia la forma, avisando antes de lo que se pierde.
   *
   * No se pide confirmación cuando no hay nada que perder (un icono recién
   * creado sin imagen elegida): un diálogo que siempre dice «se perderá el
   * icono» acaba pulsándose sin leer.
   */
  const requestShape = (shape: HotspotShape): void => {
    if (shape === geometry.shape) return;

    if (shapeNeedsMedia(shape)) {
      const available = shape === 'model' ? models : images;
      if (available.length === 0) {
        push({
          tone: 'warning',
          title: shape === 'model' ? 'No hay modelos en el proyecto' : 'No hay imágenes en el proyecto',
          description: 'Importe el archivo en la biblioteca de medios antes de usar esta forma.',
        });
        return;
      }
    }

    setPendingShape(shape);
  };

  const applyShape = (): void => {
    if (pendingShape === null) return;

    const media: Uuid | null = shapeNeedsMedia(pendingShape)
      ? ((pendingShape === 'model' ? models[0]?.id : images[0]?.id) ?? null)
      : null;

    const result = planShapeChange(geometry, pendingShape, sphericalAnchor(hotspot), media);
    setPendingShape(null);

    if (!result.ok) {
      push({
        tone: 'alarm',
        title: result.error.message,
        ...(result.error.recovery !== undefined ? { description: result.error.recovery } : {}),
      });
      return;
    }

    setGeometry(result.value.geometry, `Cambiar a ${SHAPE_LABELS[pendingShape].toLowerCase()}`);
  };

  const pendingLosses =
    pendingShape === null
      ? []
      : (() => {
          const plan = planShapeChange(geometry, pendingShape, sphericalAnchor(hotspot), null);
          return plan.ok ? plan.value.losses : [];
        })();

  return (
    <div className="inspector__group">
      <Field label="Forma" inline hint={SHAPE_HINTS[geometry.shape]}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={geometry.shape}
            onChange={(event) => requestShape(event.currentTarget.value as HotspotShape)}
          >
            {(Object.keys(SHAPE_LABELS) as HotspotShape[]).map((shape) => (
              <option key={shape} value={shape}>
                {SHAPE_LABELS[shape]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {geometry.shape === 'icon' && (
        <IconGeometry
          geometry={geometry}
          images={images}
          onChange={(next, label, key) => setGeometry(next, label, key)}
        />
      )}

      {geometry.shape === 'text' && (
        <TextGeometry geometry={geometry} onChange={(next, label, key) => setGeometry(next, label, key)} />
      )}

      {geometry.shape === 'polygon' && (
        <PolygonGeometry geometry={geometry} onChange={(next, label) => setGeometry(next, label)} />
      )}

      {geometry.shape === 'projectedImage' && (
        <ProjectedImageGeometry
          geometry={geometry}
          images={images}
          onChange={(next, label, key) => setGeometry(next, label, key)}
        />
      )}

      {geometry.shape === 'webframe' && (
        <WebframeGeometry geometry={geometry} onChange={(next, label, key) => setGeometry(next, label, key)} />
      )}

      {geometry.shape === 'model' && (
        <ModelGeometry
          geometry={geometry}
          models={models}
          onChange={(next, label, key) => setGeometry(next, label, key)}
        />
      )}

      <ConfirmDialog
        open={pendingShape !== null}
        onCancel={() => setPendingShape(null)}
        onConfirm={applyShape}
        title="Cambiar la forma del marcador"
        confirmLabel="Cambiar"
        message={
          pendingLosses.length === 0
            ? `El marcador pasará a ser ${SHAPE_LABELS[pendingShape ?? 'icon'].toLowerCase()}. Se puede deshacer con Ctrl+Z.`
            : `Se perderá ${pendingLosses.join(' y ')}. La posición se conserva y el cambio se puede deshacer con Ctrl+Z.`
        }
      />
    </div>
  );
}

/** Ancla esférica del marcador; los otros espacios no tienen yaw/pitch. */
const sphericalAnchor = (hotspot: Hotspot): { yaw: number; pitch: number } =>
  hotspot.anchor.space === 'spherical'
    ? { yaw: hotspot.anchor.yaw, pitch: hotspot.anchor.pitch }
    : { yaw: 0, pitch: 0 };

/* ------------------------------------------------------------------ *
 * Icono (D01, D15)
 * ------------------------------------------------------------------ */

const BUILTIN_ICONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'marker', label: 'Marcador' },
  { id: 'arrow', label: 'Flecha' },
  { id: 'info', label: 'Información' },
  { id: 'equipment', label: 'Equipo' },
  { id: 'instrument', label: 'Instrumento' },
  { id: 'document', label: 'Documento' },
  { id: 'warning', label: 'Aviso' },
  { id: 'door', label: 'Paso o puerta' },
];

function IconGeometry({
  geometry,
  images,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'icon' }>;
  images: Project['media'];
  onChange: (next: HotspotGeometry, label: string, coalesceKey?: string) => void;
}): JSX.Element {
  const chosen = images.find((m) => m.id === geometry.mediaId) ?? null;
  const animated = chosen !== null && isAnimatedIconCandidate(chosen);

  return (
    <>
      <Field
        label="Imagen propia"
        inline
        hint="Sin imagen propia se usa un icono del catálogo."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={geometry.mediaId ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange(
                { ...geometry, mediaId: value === '' ? null : (value as Uuid) },
                'Cambiar icono del marcador',
              );
            }}
          >
            <option value="">Icono del catálogo</option>
            {images.map((media) => (
              <option key={media.id} value={media.id}>
                {media.originalName}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {geometry.mediaId === null && (
        <Field label="Icono" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={geometry.builtinIcon}
              onChange={(event) =>
                onChange({ ...geometry, builtinIcon: event.currentTarget.value }, 'Cambiar icono')
              }
            >
              {BUILTIN_ICONS.map((icon) => (
                <option key={icon.id} value={icon.id}>
                  {icon.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {animated && (
        <Callout tone="info" title="Icono animado">
          Se reproducirá su animación en el recorrido publicado. Un icono que se mueve llama la
          atención, así que conviene reservarlo para lo que de verdad la necesita.
        </Callout>
      )}

      <Field label="Tamaño" inline hint="Píxeles a distancia nominal.">
        {({ id, describedBy }) => (
          <NumberInput
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={geometry.sizePx}
            min={8}
            max={512}
            step={2}
            unit="px"
            onValueChange={(value) =>
              onChange({ ...geometry, sizePx: Math.round(value) }, 'Cambiar tamaño del icono', 'hotspot.size')
            }
          />
        )}
      </Field>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Texto (D02)
 * ------------------------------------------------------------------ */

function TextGeometry({
  geometry,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'text' }>;
  onChange: (next: HotspotGeometry, label: string, coalesceKey?: string) => void;
}): JSX.Element {
  return (
    <>
      <Field
        label="Texto"
        hint="Admite variables del proyecto, como {{asset.tag}} o {{scene.title}}."
      >
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            rows={3}
            value={geometry.template}
            onChange={(event) =>
              onChange(
                { ...geometry, template: event.currentTarget.value },
                'Editar texto del marcador',
                'hotspot.template',
              )
            }
          />
        )}
      </Field>

      <Field label="Anchura máxima" inline hint="El texto se parte en varias líneas al llegar.">
        {({ id, describedBy }) => (
          <NumberInput
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={geometry.maxWidthPx}
            min={40}
            max={1200}
            step={10}
            unit="px"
            onValueChange={(value) =>
              onChange(
                { ...geometry, maxWidthPx: Math.round(value) },
                'Cambiar anchura del texto',
                'hotspot.width',
              )
            }
          />
        )}
      </Field>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Polígono (D03, D11)
 * ------------------------------------------------------------------ */

function PolygonGeometry({
  geometry,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'polygon' }>;
  onChange: (next: HotspotGeometry, label: string) => void;
}): JSX.Element {
  const { push } = useToast();
  const problems = validatePolygon(geometry.points);
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const advisories = problems.filter((p) => p.severity === 'advisory');

  const setPoints = (points: readonly Uv[], label: string): void => {
    onChange({ ...geometry, points: [...points] }, label);
  };

  const onRemove = (index: number): void => {
    const result = removeVertex(geometry.points, index);
    if (!result.ok) {
      push({
        tone: 'warning',
        title: result.error.message,
        ...(result.error.recovery !== undefined ? { description: result.error.recovery } : {}),
      });
      return;
    }
    setPoints(result.value, 'Quitar vértice');
  };

  /** El vértice nuevo se coloca en el lado más largo, que es donde estorba menos. */
  const onAdd = (): void => {
    const mid = midpointOfLongestSide(geometry.points);
    setPoints(insertVertex(geometry.points, mid), 'Añadir vértice');
  };

  return (
    <>
      {blocking.length > 0 && (
        <Callout tone="alarm" title="El contorno no se puede usar así">
          <ul className="polygon__problems">
            {blocking.map((problem, index) => (
              <li key={`b${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      {advisories.length > 0 && (
        <Callout tone="info" title="Conviene revisar">
          <ul className="polygon__problems">
            {advisories.map((problem, index) => (
              <li key={`a${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="polygon__head">
        <SectionLabel>
          Vértices
          <Badge tone="neutral" mono>
            {geometry.points.length}
          </Badge>
        </SectionLabel>
        <span className="polygon__area">
          superficie {(Math.abs(signedArea(geometry.points)) * 100).toFixed(2)} %
        </span>
      </div>

      <ol className="polygon__points" aria-label="Vértices del polígono">
        {geometry.points.map((point, index) => (
          <li key={index} className="polygon__point">
            <span className="polygon__ordinal" aria-hidden>
              {index + 1}
            </span>
            <NumberInput
              size="sm"
              aria-label={`Azimut del vértice ${index + 1}`}
              value={Number(radToDeg(uvYaw(point)).toFixed(2))}
              min={-180}
              max={180}
              step={0.5}
              unit="°"
              onValueChange={(deg) =>
                setPoints(
                  moveVertex(geometry.points, index, { u: yawToU(deg), v: point.v }),
                  'Mover vértice',
                )
              }
            />
            <NumberInput
              size="sm"
              aria-label={`Elevación del vértice ${index + 1}`}
              value={Number(radToDeg(uvPitch(point)).toFixed(2))}
              min={-90}
              max={90}
              step={0.5}
              unit="°"
              onValueChange={(deg) =>
                setPoints(
                  moveVertex(geometry.points, index, { u: point.u, v: pitchToV(deg) }),
                  'Mover vértice',
                )
              }
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label={`Quitar vértice ${index + 1}`}
              disabled={geometry.points.length <= 3}
              onClick={() => onRemove(index)}
              icon={<IconTrash size={13} />}
            />
          </li>
        ))}
      </ol>

      <Button size="sm" variant="ghost" icon={<IconAdd size={13} />} onClick={onAdd}>
        Añadir vértice
      </Button>

      <Switch
        label="Invertir el polígono"
        checked={geometry.inverted}
        onChange={() => onChange(invertPolygon(geometry), 'Invertir polígono')}
      />
      <p className="inspector__hint">
        {geometry.inverted
          ? 'La zona activa es todo lo que queda FUERA del contorno.'
          : 'La zona activa es el interior del contorno.'}
      </p>
    </>
  );
}

/** Punto medio del lado más largo, en UV. */
function midpointOfLongestSide(points: readonly Uv[]): Uv {
  let best = { u: 0.5, v: 0.5 };
  let bestLength = -1;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Uv;
    const b = points[(i + 1) % points.length] as Uv;
    // `u` desenrollado: un lado que cruza la costura es corto, no larguísimo.
    const du = shortestDeltaU(a.u, b.u);
    const length = Math.hypot(du, b.v - a.v);
    if (length > bestLength) {
      bestLength = length;
      best = { u: ((a.u + du / 2) % 1 + 1) % 1, v: (a.v + b.v) / 2 };
    }
  }

  return best;
}

const shortestDeltaU = (from: number, to: number): number => {
  const delta = to - from;
  if (delta > 0.5) return delta - 1;
  if (delta < -0.5) return delta + 1;
  return delta;
};

/* ------------------------------------------------------------------ *
 * Imagen proyectada (D05)
 * ------------------------------------------------------------------ */

function ProjectedImageGeometry({
  geometry,
  images,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'projectedImage' }>;
  images: Project['media'];
  onChange: (next: HotspotGeometry, label: string, coalesceKey?: string) => void;
}): JSX.Element {
  const { push } = useToast();

  const setCorners = (corners: Corners, label: string): void => {
    onChange({ ...geometry, corners: [corners[0], corners[1], corners[2], corners[3]] }, label);
  };

  const onMove = (index: number, to: Uv): void => {
    const result = moveCorner(geometry.corners, index, to);
    if (!result.ok) {
      push({
        tone: 'warning',
        title: result.error.message,
        ...(result.error.recovery !== undefined ? { description: result.error.recovery } : {}),
      });
      return;
    }
    setCorners(result.value, 'Mover esquina');
  };

  return (
    <>
      <Field label="Imagen" inline>
        {({ id }) => (
          <Select
            id={id}
            size="sm"
            value={geometry.mediaId}
            onChange={(event) =>
              onChange(
                { ...geometry, mediaId: event.currentTarget.value as Uuid },
                'Cambiar imagen proyectada',
              )
            }
          >
            {images.map((media) => (
              <option key={media.id} value={media.id}>
                {media.originalName}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Opacidad" inline>
        {({ id }) => (
          <NumberInput
            id={id}
            size="sm"
            value={Number(geometry.opacity.toFixed(2))}
            min={0}
            max={1}
            step={0.05}
            decimals={2}
            onValueChange={(value) =>
              onChange({ ...geometry, opacity: value }, 'Cambiar opacidad', 'hotspot.opacity')
            }
          />
        )}
      </Field>

      <SectionLabel>Esquinas</SectionLabel>
      <ol className="polygon__points" aria-label="Esquinas de la imagen proyectada">
        {geometry.corners.map((corner, index) => (
          <li key={index} className="polygon__point">
            <span className="polygon__corner-label">{CORNER_LABELS[index]}</span>
            <NumberInput
              size="sm"
              aria-label={`Azimut de la esquina ${CORNER_LABELS[index] ?? index + 1}`}
              value={Number(radToDeg(uvYaw(corner)).toFixed(2))}
              min={-180}
              max={180}
              step={0.5}
              unit="°"
              onValueChange={(deg) => onMove(index, { u: yawToU(deg), v: corner.v })}
            />
            <NumberInput
              size="sm"
              aria-label={`Elevación de la esquina ${CORNER_LABELS[index] ?? index + 1}`}
              value={Number(radToDeg(uvPitch(corner)).toFixed(2))}
              min={-90}
              max={90}
              step={0.5}
              unit="°"
              onValueChange={(deg) => onMove(index, { u: corner.u, v: pitchToV(deg) })}
            />
          </li>
        ))}
      </ol>

      <Button
        size="sm"
        variant="ghost"
        onClick={() => setCorners(resetCorners(geometry.corners), 'Restablecer esquinas')}
      >
        Restablecer a rectángulo
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Contenido web y modelo
 * ------------------------------------------------------------------ */

function WebframeGeometry({
  geometry,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'webframe' }>;
  onChange: (next: HotspotGeometry, label: string, coalesceKey?: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(geometry.url);
  const valid = isHttpUrl(draft);

  return (
    <>
      <Field
        label="Dirección"
        {...(valid ? {} : { error: 'Debe ser una dirección http o https completa.' })}
        hint="Al publicar, el paquete sólo permite enmarcar las direcciones declaradas aquí."
      >
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => {
              // Se confirma al salir del campo: una dirección a medio escribir
              // no es válida y el esquema la rechazaría en cada pulsación.
              if (isHttpUrl(draft)) onChange({ ...geometry, url: draft }, 'Cambiar dirección web');
              else setDraft(geometry.url);
            }}
          />
        )}
      </Field>

      <Field label="Anchura" inline>
        {({ id }) => (
          <NumberInput
            id={id}
            size="sm"
            value={geometry.widthPx}
            min={80}
            max={4096}
            step={10}
            unit="px"
            onValueChange={(value) =>
              onChange({ ...geometry, widthPx: Math.round(value) }, 'Cambiar anchura', 'hotspot.w')
            }
          />
        )}
      </Field>

      <Field label="Altura" inline>
        {({ id }) => (
          <NumberInput
            id={id}
            size="sm"
            value={geometry.heightPx}
            min={60}
            max={4096}
            step={10}
            unit="px"
            onValueChange={(value) =>
              onChange({ ...geometry, heightPx: Math.round(value) }, 'Cambiar altura', 'hotspot.h')
            }
          />
        )}
      </Field>
    </>
  );
}

function ModelGeometry({
  geometry,
  models,
  onChange,
}: {
  geometry: Extract<HotspotGeometry, { shape: 'model' }>;
  models: Project['media'];
  onChange: (next: HotspotGeometry, label: string, coalesceKey?: string) => void;
}): JSX.Element {
  return (
    <>
      <Field label="Modelo" inline>
        {({ id }) => (
          <Select
            id={id}
            size="sm"
            value={geometry.mediaId}
            onChange={(event) =>
              onChange({ ...geometry, mediaId: event.currentTarget.value as Uuid }, 'Cambiar modelo')
            }
          >
            {models.map((media) => (
              <option key={media.id} value={media.id}>
                {media.originalName}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Escala" inline>
        {({ id }) => (
          <NumberInput
            id={id}
            size="sm"
            value={Number(geometry.sizeScale.toFixed(2))}
            min={0.01}
            max={100}
            step={0.1}
            decimals={2}
            onValueChange={(value) =>
              onChange({ ...geometry, sizeScale: value }, 'Cambiar escala del modelo', 'hotspot.scale')
            }
          />
        )}
      </Field>
    </>
  );
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ *
 * UV y grados
 *
 * El autor piensa en azimut y elevación, no en coordenadas de textura. La
 * conversión es la misma que usa el dominio, en el sentido contrario.
 * ------------------------------------------------------------------ */

const uvYaw = (point: Uv): number => point.u * Math.PI * 2 - Math.PI;
const uvPitch = (point: Uv): number => (0.5 - point.v) * Math.PI;

const yawToU = (deg: number): number => {
  const rad = (deg * Math.PI) / 180;
  return ((rad + Math.PI) / (Math.PI * 2) % 1 + 1) % 1;
};

const pitchToV = (deg: number): number => {
  const rad = (Math.min(Math.max(deg, -90), 90) * Math.PI) / 180;
  return Math.min(Math.max(0.5 - rad / Math.PI, 0), 1);
};
