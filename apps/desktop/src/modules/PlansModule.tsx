/**
 * Planos, zonas y radar (G01–G05).
 *
 * Lo que el autor viene a hacer aquí es una cosa: decir dónde está cada
 * escena. Todo lo demás —nombre, zona, orientación— es secundario, así que el
 * plano ocupa la pantalla y los puntos se colocan pulsando sobre él.
 *
 * Tres decisiones que cuesta reconstruir luego:
 *
 * **Se coloca pulsando, y la escena la elige el autor antes.** La alternativa
 * —colocar un punto vacío y asignarle escena después— deja puntos huérfanos en
 * el plano, que es exactamente lo que el visitante se encuentra roto.
 *
 * **La orientación se ajusta viendo el radar, no escribiendo grados.** Nadie
 * sabe cuántos grados está girado su plano; lo que sí sabe es si la flecha
 * apunta a la puerta por la que se entra. Por eso el radar del punto
 * seleccionado se dibuja mientras se mueve el control.
 *
 * **Las escenas sin punto están siempre a la vista.** Un plano al 80 % no se
 * distingue de uno terminado mirándolo, y el visitante sólo descubre el hueco
 * cuando llega a una sala que el plano no sitúa.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createPlan,
  createPlanMarker,
  clampPlanPoint,
  groupPlansByFloor,
  planBearingDegrees,
  radarCone,
  radarConePoints,
  scenesWithoutMarker,
  validatePlans,
  type CameraView,
  type Media,
  type Plan,
  type PlanMarker,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CountPill,
  EmptyState,
  Field,
  IconPlan,
  NumberInput,
  Select,
  SectionLabel,
  Slider,
  Switch,
  TextInput,
  useToast,
} from '@it360/ui';
import { importImageFile } from '../platform/image-import';
import type { ProjectStore } from '../state/project-store';

export interface PlansModuleProps {
  readonly store: ProjectStore;
  readonly mediaUrls: ReadonlyMap<string, string>;
  /** Registra la URL de una imagen recién importada. */
  readonly onMediaUrl: (mediaId: string, url: string) => void;
  /** Escena activa en el editor: es la que recibe el punto al pulsar. */
  readonly activeSceneId: string | null;
  readonly onSelectScene: (sceneId: string) => void;
}

/** Vista de referencia para dibujar el radar mientras se orienta. */
const SAMPLE_VIEW: CameraView = { yaw: 0, pitch: 0, fov: 75 };

const DEG = (rad: number): number => Math.round((rad * 180) / Math.PI);
const RAD = (deg: number): number => (deg * Math.PI) / 180;

export function PlansModule({
  store,
  mediaUrls,
  onMediaUrl,
  activeSceneId,
  onSelectScene,
}: PlansModuleProps): JSX.Element {
  const { project } = store;
  const { push } = useToast();

  const [planId, setPlanId] = useState<string | null>(project.plans[0]?.id ?? null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<'plan' | 'marker' | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const plan = useMemo(
    () => project.plans.find((p) => p.id === planId) ?? project.plans[0] ?? null,
    [project.plans, planId],
  );

  const markers = useMemo(
    () => (plan === null ? [] : project.planMarkers.filter((m) => m.planId === plan.id)),
    [project.planMarkers, plan],
  );

  const marker = useMemo(
    () => markers.find((m) => m.id === markerId) ?? null,
    [markers, markerId],
  );

  const floors = useMemo(() => groupPlansByFloor(project.plans), [project.plans]);

  const problems = useMemo(
    () =>
      validatePlans(project.plans, project.planMarkers, {
        sceneIds: new Set<string>(project.scenes.map((s) => s.id)),
        mediaIds: new Set<string>(project.media.map((m) => m.id)),
      }),
    [project.plans, project.planMarkers, project.scenes, project.media],
  );

  const unplaced = useMemo(
    () => scenesWithoutMarker(project.scenes.map((s) => s.id), project.planMarkers),
    [project.scenes, project.planMarkers],
  );

  const sceneTitle = useCallback(
    (id: string): string => project.scenes.find((s) => s.id === id)?.title ?? 'Escena eliminada',
    [project.scenes],
  );

  /* ---------------------------------------------------------------- *
   * Alta del plano
   * ---------------------------------------------------------------- */

  const onPickImage = async (file: File): Promise<void> => {
    setProblem(null);
    setImporting(true);
    try {
      const result = await importImageFile(file, project.media, { folder: 'media/planos' });
      // Un fallo inesperado tiene que verse. Sin el `catch` de abajo, el autor
      // pulsa, no pasa nada y no hay nada que mirar: el peor de los estados.
      if (!result.ok) {
        setProblem(
          result.error.recovery === undefined
            ? result.error.message
            : `${result.error.message} ${result.error.recovery}`,
        );
        return;
      }

      const { media, reused, url } = result.value;
      if (url !== '') onMediaUrl(media.id, url);

      const created = createPlan(media.id, planNameFor(file.name, project.plans));
      const nextMedia: readonly Media[] = reused ? project.media : [...project.media, media];

      store.updateProject(`Añadir plano ${created.name}`, {
        media: [...nextMedia],
        plans: [...project.plans, created],
      });
      setPlanId(created.id);
      setMarkerId(null);
      push({
        tone: 'nominal',
        title: `Plano «${created.name}» añadido`,
        ...(reused ? { description: 'La imagen ya estaba en el proyecto; no se ha duplicado.' } : {}),
      });
    } catch (cause: unknown) {
      setProblem(
        `No se pudo leer «${file.name}»: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  const savePlan = (patch: Partial<Plan>, label: string, coalesceKey?: string): void => {
    if (plan === null) return;
    store.updateProject(
      label,
      { plans: project.plans.map((p) => (p.id === plan.id ? { ...p, ...patch } : p)) },
      coalesceKey,
    );
  };

  const saveMarker = (patch: Partial<PlanMarker>, label: string, coalesceKey?: string): void => {
    if (marker === null) return;
    store.updateProject(
      label,
      {
        planMarkers: project.planMarkers.map((m) => (m.id === marker.id ? { ...m, ...patch } : m)),
      },
      coalesceKey,
    );
  };

  /* ---------------------------------------------------------------- *
   * Colocar puntos
   * ---------------------------------------------------------------- */

  /**
   * Convierte un clic en el `<img>` a coordenadas del plano (0–1).
   *
   * Se usa el rectángulo de la imagen y no el del contenedor: la imagen se
   * ajusta con `object-fit: contain` y dejan bandas a los lados, de modo que
   * un clic en la banda daría una posición falsa dentro del plano.
   */
  const pointFromEvent = (event: React.MouseEvent<HTMLElement>): { x: number; y: number } | null => {
    const image = imageRef.current;
    if (image === null) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return clampPlanPoint({
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    });
  };

  const onPlaceAt = (event: React.MouseEvent<HTMLElement>): void => {
    if (plan === null) return;
    const point = pointFromEvent(event);
    if (point === null) return;

    if (activeSceneId === null) {
      push({ tone: 'warning', title: 'Elija primero la escena que quiere situar' });
      return;
    }

    const existing = project.planMarkers.find((m) => m.sceneId === activeSceneId);
    if (existing !== undefined) {
      // Una escena en dos sitios del plano es una contradicción: se mueve el
      // punto que ya tenía en lugar de añadir otro.
      store.updateProject(`Mover punto de ${sceneTitle(activeSceneId)}`, {
        planMarkers: project.planMarkers.map((m) =>
          m.id === existing.id ? { ...m, planId: plan.id, position: point } : m,
        ),
      });
      setMarkerId(existing.id);
      return;
    }

    const created = createPlanMarker(plan.id, activeSceneId, point);
    store.updateProject(`Situar ${sceneTitle(activeSceneId)} en el plano`, {
      planMarkers: [...project.planMarkers, created],
    });
    setMarkerId(created.id);
  };

  const onDelete = (): void => {
    if (confirmDelete === 'plan' && plan !== null) {
      store.updateProject(`Eliminar plano ${plan.name}`, {
        plans: project.plans.filter((p) => p.id !== plan.id),
        planMarkers: project.planMarkers.filter((m) => m.planId !== plan.id),
      });
      push({ tone: 'neutral', title: `Plano «${plan.name}» eliminado` });
      setPlanId(project.plans.find((p) => p.id !== plan.id)?.id ?? null);
      setMarkerId(null);
    } else if (confirmDelete === 'marker' && marker !== null) {
      store.updateProject(`Quitar punto de ${sceneTitle(marker.sceneId)}`, {
        planMarkers: project.planMarkers.filter((m) => m.id !== marker.id),
      });
      setMarkerId(null);
    }
    setConfirmDelete(null);
  };

  /* ---------------------------------------------------------------- *
   * Interfaz
   * ---------------------------------------------------------------- */

  if (project.plans.length === 0) {
    return (
      <div className="plans">
        <div className="plans__main">
          {problem !== null && (
            <Callout tone="alarm" title="No se pudo añadir el plano">
              {problem}
            </Callout>
          )}
          <EmptyState
            icon={<IconPlan size={28} />}
            title="Sin planos"
            description="Un plano sitúa cada escena y le dice al visitante hacia dónde mira. Elija la imagen del plano de planta: PNG, JPEG o SVG exportado de su herramienta de dibujo."
            action={
              <label className="csv-dialog__file">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif,image/svg+xml"
                  aria-label="Imagen del plano"
                  disabled={importing}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file !== undefined) void onPickImage(file);
                  }}
                />
              </label>
            }
          />
        </div>
      </div>
    );
  }

  const planUrl = plan === null ? undefined : mediaUrls.get(plan.mediaId);
  const cone = plan === null || marker === null ? null : radarCone(SAMPLE_VIEW, plan, marker);

  return (
    <div className="plans">
      <div className="plans__main">
        {problem !== null && (
          <Callout tone="alarm" title="No se pudo añadir el plano" onDismiss={() => setProblem(null)}>
            {problem}
          </Callout>
        )}

        {problems.length > 0 && (
          <Callout
            tone={problems.some((p) => p.severity === 'blocking') ? 'alarm' : 'warning'}
            title={problems.some((p) => p.severity === 'blocking') ? 'Los planos no se pueden publicar' : 'Revise los planos'}
          >
            <ul className="plans__problems">
              {problems.map((p) => (
                <li key={`${p.planId ?? 'x'}-${p.message}`}>{p.message}</li>
              ))}
            </ul>
          </Callout>
        )}

        {plan !== null && (
          <>
            <div className="plans__canvas-head">
              <strong>{plan.name}</strong>
              {plan.floor !== '' && <Badge tone="neutral">{plan.floor}</Badge>}
              <CountPill count={markers.length} label="puntos situados" />
              <span className="plans__hint">
                {activeSceneId === null
                  ? 'Elija una escena en la lista para situarla.'
                  : `Pulse sobre el plano para situar «${sceneTitle(activeSceneId)}».`}
              </span>
            </div>

            <div className="plans__canvas">
              {planUrl === undefined ? (
                <Callout tone="alarm" title="Falta la imagen de este plano">
                  La imagen no está en el proyecto. Vuelva a importarla o elimine el plano.
                </Callout>
              ) : (
                <button
                  type="button"
                  className="plans__surface"
                  aria-label={`Situar la escena en el plano ${plan.name}`}
                  onClick={onPlaceAt}
                >
                  <img ref={imageRef} className="plans__image" src={planUrl} alt="" />
                  {cone !== null && marker !== null && (
                    <svg className="plans__radar" viewBox="0 0 100 100" aria-hidden="true">
                      <polygon
                        points={radarConePoints(
                          cone,
                          { x: marker.position.x * 100, y: marker.position.y * 100 },
                          26,
                        )
                          .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
                          .join(' ')}
                      />
                    </svg>
                  )}
                  {markers.map((m) => (
                    <span
                      key={m.id}
                      className={`plans__dot${m.id === marker?.id ? ' plans__dot--active' : ''}`}
                      style={{ left: `${m.position.x * 100}%`, top: `${m.position.y * 100}%` }}
                      aria-hidden="true"
                    />
                  ))}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <aside className="plans__side">
        <SectionLabel
          actions={
            <label className="csv-dialog__file csv-dialog__file--compact">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif,image/svg+xml"
                aria-label="Imagen de otro plano"
                disabled={importing}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file !== undefined) void onPickImage(file);
                }}
              />
            </label>
          }
        >
          Planos
        </SectionLabel>

        <ul className="plans__list">
          {floors.map((floor) => (
            <li key={floor.floor} className="plans__floor">
              {floors.length > 1 && (
                <span className="plans__floor-name">{floor.floor === '' ? 'Sin zona' : floor.floor}</span>
              )}
              <ul>
                {floor.plans.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`plans__item${p.id === plan?.id ? ' plans__item--active' : ''}`}
                      aria-current={p.id === plan?.id ? 'true' : undefined}
                      onClick={() => {
                        setPlanId(p.id);
                        setMarkerId(null);
                      }}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {plan !== null && (
          <>
            <SectionLabel>Este plano</SectionLabel>
            <Field label="Nombre">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={plan.name}
                  onChange={(event) =>
                    savePlan({ name: event.currentTarget.value }, 'Renombrar plano', `plan.name.${plan.id}`)
                  }
                />
              )}
            </Field>

            <Field label="Zona o planta" hint="Agrupa los planos en el visor.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={plan.floor}
                  onChange={(event) =>
                    savePlan({ floor: event.currentTarget.value }, 'Cambiar zona del plano', `plan.floor.${plan.id}`)
                  }
                />
              )}
            </Field>

            <Field label="Orden de la zona" hint="Menor arriba, como se verá en el visor.">
              {({ id, describedBy }) => (
                <NumberInput
                  id={id}
                  aria-describedby={describedBy}
                  value={plan.floorOrder}
                  step={1}
                  onValueChange={(value) =>
                    savePlan({ floorOrder: Math.round(value) }, 'Reordenar zona del plano')
                  }
                />
              )}
            </Field>

            <Field
              label="Giro del plano"
              inline
              hint="Cuántos grados está girada la imagen respecto al norte. Ajústelo mirando el radar."
            >
              {() => (
                <Slider
                  min={-180}
                  max={180}
                  step={1}
                  decimals={0}
                  unit="°"
                  value={DEG(plan.orientation.northRad)}
                  aria-label="Giro del plano en grados"
                  onValueChange={(value) =>
                    savePlan(
                      { orientation: { ...plan.orientation, northRad: RAD(value) } },
                      'Girar el plano',
                      `plan.north.${plan.id}`,
                    )
                  }
                />
              )}
            </Field>

            <div className="plans__row">
              <Switch
                checked={plan.showRadar}
                onChange={(event) =>
                  savePlan({ showRadar: event.currentTarget.checked }, 'Cambiar radar del plano')
                }
                label="Mostrar radar de mirada"
              />
            </div>

            <Field label="Apertura del radar" inline hint="Se recorta al campo de visión real del visor.">
              {() => (
                <Slider
                  min={5}
                  max={180}
                  step={1}
                  decimals={0}
                  unit="°"
                  value={plan.radarApertureDeg}
                  aria-label="Apertura del radar en grados"
                  onValueChange={(value) =>
                    savePlan({ radarApertureDeg: value }, 'Cambiar apertura del radar', `plan.aperture.${plan.id}`)
                  }
                />
              )}
            </Field>

            <Button variant="danger" onClick={() => setConfirmDelete('plan')}>
              Eliminar plano
            </Button>
          </>
        )}

        <SectionLabel>Puntos situados</SectionLabel>

        {markers.length === 0 ? (
          <p className="plans__empty">
            Ninguna escena situada en este plano. Elija una escena y pulse sobre el plano.
          </p>
        ) : (
          <ul className="plans__markers">
            {markers.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`plans__item${m.id === marker?.id ? ' plans__item--active' : ''}`}
                  onClick={() => {
                    setMarkerId(m.id);
                    onSelectScene(m.sceneId);
                  }}
                >
                  {m.label !== '' ? m.label : sceneTitle(m.sceneId)}
                </button>
              </li>
            ))}
          </ul>
        )}

        {marker !== null && plan !== null && (
          <>
            <Field label="Escena" hint="Adónde lleva este punto.">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={marker.sceneId}
                  onChange={(event) =>
                    saveMarker(
                      { sceneId: event.currentTarget.value as PlanMarker['sceneId'] },
                      'Cambiar escena del punto',
                    )
                  }
                >
                  {project.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Rótulo" hint="Vacío: se usa el título de la escena.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={marker.label}
                  onChange={(event) =>
                    saveMarker({ label: event.currentTarget.value }, 'Cambiar rótulo del punto', `marker.label.${marker.id}`)
                  }
                />
              )}
            </Field>

            <Field
              label="Orientación de la escena"
              inline
              hint="Hacia dónde mira el yaw cero de esta panorámica. El radar del plano se mueve con este control."
            >
              {() => (
                <Slider
                  min={-180}
                  max={180}
                  step={1}
                  decimals={0}
                  unit="°"
                  value={DEG(marker.headingRad)}
                  aria-label="Orientación de la escena en grados"
                  onValueChange={(value) =>
                    saveMarker({ headingRad: RAD(value) }, 'Orientar la escena en el plano', `marker.heading.${marker.id}`)
                  }
                />
              )}
            </Field>

            <p className="plans__bearing">
              Rumbo del radar: {Math.round(planBearingDegrees(SAMPLE_VIEW, plan, marker))}°
            </p>

            <Button variant="danger" onClick={() => setConfirmDelete('marker')}>
              Quitar punto
            </Button>
          </>
        )}

        {unplaced.length > 0 && (
          <>
            <SectionLabel>Escenas sin situar</SectionLabel>
            <ul className="plans__unplaced">
              {unplaced.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className={`plans__item${id === activeSceneId ? ' plans__item--active' : ''}`}
                    onClick={() => onSelectScene(id)}
                  >
                    {sceneTitle(id)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      {confirmDelete !== null && (
        <ConfirmDialog
          open
          title={confirmDelete === 'plan' ? 'Eliminar este plano' : 'Quitar este punto'}
          message={
            confirmDelete === 'plan'
              ? `Se eliminará «${plan?.name ?? ''}» y los ${markers.length} puntos situados en él. La imagen se conserva en el proyecto.`
              : 'La escena dejará de estar situada en el plano. La escena no se borra.'
          }
          confirmLabel={confirmDelete === 'plan' ? 'Eliminar plano' : 'Quitar punto'}
          destructive
          onConfirm={onDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** Nombre inicial del plano a partir del archivo, sin repetir. */
function planNameFor(fileName: string, existing: readonly Plan[]): string {
  const dot = fileName.lastIndexOf('.');
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  const base = stem === '' ? 'Plano' : stem.slice(0, 200);

  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}
