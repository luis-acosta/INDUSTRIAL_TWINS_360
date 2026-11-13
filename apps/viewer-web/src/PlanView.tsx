/**
 * Plano del recorrido, con zonas y radar (G01–G05).
 *
 * Lo que el visitante necesita del plano son tres cosas: dónde está, hacia
 * dónde mira y adónde puede ir. Antes sólo se mostraba el primer plano del
 * proyecto, con los puntos como círculos sin nombre y el rumbo escrito en
 * texto al pie —que nadie convierte mentalmente a una dirección mientras
 * camina por una planta—.
 *
 * El radar se dibuja como cono sobre el punto donde está el visitante, que es
 * la forma en que se lee de un vistazo. Si la escena actual no tiene punto en
 * el plano, no se dibuja: un cono colocado en el centro «por poner algo»
 * afirmaría una posición falsa, y el visitante se fía del radar.
 */
import { useMemo, useState } from 'react';
import {
  groupPlansByFloor,
  markerForScene,
  planBearingDegrees,
  planForScene,
  DEFAULT_VIEWPORT_ASPECT,
  radarCone,
  radarConePoints,
  type Manifest,
} from '@it360/domain';
import { Badge, EmptyState, Tab, TabList, Tabs, cx } from '@it360/ui';
import type { CameraView } from '@it360/domain';

/** Lado de la caja del radar, en píxeles de pantalla. */
const RADAR_BOX_PX = 132;

/** Radio del cono dentro de su caja de 100 unidades. */
const RADAR_RADIUS = 46;

export interface PlanViewProps {
  readonly manifest: Manifest;
  /**
   * Relación de aspecto del visor, para acotar el cono al campo horizontal.
   *
   * La cámara declara el campo vertical; cuánto se ve a lo ancho depende de la
   * forma de la ventana. Sin este dato se supone 16:9.
   */
  readonly aspect?: number;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly activeSceneId: string | null;
  readonly view: CameraView | null;
  readonly onSelect: (sceneId: string) => void;
}

export function PlanView({
  manifest,
  aspect,
  mediaUrls,
  activeSceneId,
  view,
  onSelect,
}: PlanViewProps): JSX.Element {
  const floors = useMemo(() => groupPlansByFloor(manifest.plans), [manifest.plans]);

  /**
   * Plano mostrado al abrir: el de la escena actual.
   *
   * Abrir siempre por el primero obligaría al visitante a buscar en qué zona
   * está, que es justo lo que venía a averiguar.
   */
  const initial = useMemo(
    () =>
      (activeSceneId === null
        ? null
        : planForScene(manifest.plans, manifest.planMarkers, activeSceneId)
      )?.id ?? manifest.plans[0]?.id ?? null,
    [manifest.plans, manifest.planMarkers, activeSceneId],
  );

  const [planId, setPlanId] = useState<string | null>(initial);
  const plan = manifest.plans.find((p) => p.id === (planId ?? initial)) ?? manifest.plans[0];

  if (plan === undefined) {
    return <EmptyState title="El recorrido no incluye planos" />;
  }

  const url = mediaUrls.get(plan.mediaId);
  const markers = manifest.planMarkers.filter((m) => m.planId === plan.id);
  const here = activeSceneId === null ? null : markerForScene(markers, plan.id, activeSceneId);

  const cone =
    view !== null && here !== null && plan.showRadar
      ? radarCone(view, plan, here, aspect ?? DEFAULT_VIEWPORT_ASPECT)
      : null;

  /**
   * El cono se dibuja en su propia caja cuadrada, centrada en el punto.
   *
   * Extenderlo sobre todo el plano exigiría estirar el `viewBox` con la forma
   * de la imagen, y entonces un cono de sesenta grados sobre un plano 2:1 se
   * vería como uno de cien: el ángulo que el visitante lee sería falso. Una
   * caja cuadrada mantiene el ángulo verdadero sea como sea el plano.
   */
  const conePath =
    cone === null
      ? null
      : radarConePoints(cone, { x: 0, y: 0 }, RADAR_RADIUS)
          .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
          .join(' ') + ' Z';

  /* Las zonas sólo se ofrecen si hay más de una: un selector con una sola
     opción es ruido. */
  const showFloors = floors.length > 1 || (floors[0]?.plans.length ?? 0) > 1;

  return (
    <div className="planview">
      {showFloors && (
        <Tabs value={plan.id} onValueChange={setPlanId}>
          <TabList label="Zonas y planos">
            {floors.flatMap((group) =>
              group.plans.map((candidate) => (
                <Tab key={candidate.id} id={candidate.id}>
                  {group.floor === '' ? candidate.name : `${group.floor} · ${candidate.name}`}
                </Tab>
              )),
            )}
          </TabList>
        </Tabs>
      )}

      {url === undefined ? (
        <EmptyState title="Falta la imagen del plano en el paquete" />
      ) : (
        <div className="planview__frame">
          <img src={url} alt={`Plano ${plan.name}`} />

          {conePath !== null && here !== null && (
            <svg
              className="planview__radar"
              viewBox="-50 -50 100 100"
              width={RADAR_BOX_PX}
              height={RADAR_BOX_PX}
              style={{
                left: `calc(${here.position.x * 100}% - ${RADAR_BOX_PX / 2}px)`,
                top: `calc(${here.position.y * 100}% - ${RADAR_BOX_PX / 2}px)`,
              }}
              aria-hidden
            >
              <path d={conePath} />
            </svg>
          )}

          {markers.map((marker) => {
            const isHere = marker.sceneId === activeSceneId;
            const scene = manifest.scenes.find((s) => s.id === marker.sceneId);
            const name = marker.label !== '' ? marker.label : (scene?.title ?? 'Escena');

            return (
              <button
                key={marker.id}
                type="button"
                className={cx('planview__marker', isHere && 'planview__marker--active')}
                style={{ left: `${marker.position.x * 100}%`, top: `${marker.position.y * 100}%` }}
                aria-label={isHere ? `${name} (está aquí)` : `Ir a ${name}`}
                aria-current={isHere}
                onClick={() => onSelect(marker.sceneId)}
              >
                <span className="planview__marker-label">{name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="planview__foot">
        {here === null ? (
          <span className="planview__hint">
            La escena actual no está situada en este plano.
          </span>
        ) : (
          view !== null && (
            <Badge tone="neutral" mono>
              rumbo {planBearingDegrees(view, plan, here)}°
            </Badge>
          )
        )}
        <span className="planview__hint">
          {markers.length} punto(s) navegable(s)
        </span>
      </div>
    </div>
  );
}
