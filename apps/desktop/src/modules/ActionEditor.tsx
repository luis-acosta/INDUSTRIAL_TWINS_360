/**
 * Editor de acciones de un marcador (C01, C11, D13, J01-J04).
 *
 * Es la pieza que convierte el editor en editor: hasta ahora se podían colocar
 * marcadores y no se les podía dar nada que hacer. Un marcador sin acciones se
 * ve y no responde al pulsarlo, que es la peor forma de parecer roto.
 *
 * Dos decisiones de diseño que no son evidentes:
 *
 * **Sólo se ofrecen los tipos de acción que el editor sabe configurar.** El
 * dominio declara veintiséis; esta pantalla ofrece los que tienen formulario y
 * cuyo destino se puede elegir con lo que hay en el proyecto. Ofrecer los
 * demás produciría acciones a medio configurar que fallan en el visor, y el
 * autor no sabría por qué.
 *
 * **El destino se elige de una lista, no se escribe.** Un identificador
 * teclead a mano es un enlace roto esperando a que alguien publique. Las
 * listas vienen del proyecto, así que sólo se puede apuntar a algo que existe.
 */
import { useState } from 'react';
import {
  newUuid,
  type Action,
  type ActionConfig,
  type ActionEvent,
  type Project,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  Field,
  IconAdd,
  IconTrash,
  Menu,
  NumberInput,
  Panel,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Select,
  Switch,
  TextInput,
  Tooltip,
} from '@it360/ui';

/**
 * Tipos de acción que esta pantalla sabe configurar.
 *
 * La lista es corta a propósito y crece cuando cada tipo tenga su formulario.
 * Un desplegable con veintiséis opciones de las que quince no se pueden
 * terminar de configurar es peor que uno con once que funcionan.
 */
const EDITABLE_TYPES = [
  'goToScene',
  'lookAt',
  'showAsset',
  'openDocument',
  'openMedia',
  'openUrl',
  'downloadFile',
  'showPlan',
  'startTour',
  'startQuiz',
  'wait',
] as const;

type EditableType = (typeof EDITABLE_TYPES)[number];

const TYPE_LABELS: Readonly<Record<EditableType, string>> = {
  goToScene: 'Ir a otra escena',
  lookAt: 'Mirar hacia un punto',
  showAsset: 'Abrir la ficha de un activo',
  openDocument: 'Abrir un documento',
  openMedia: 'Abrir una imagen o vídeo',
  openUrl: 'Abrir un enlace externo',
  downloadFile: 'Descargar un archivo',
  showPlan: 'Mostrar el plano',
  startTour: 'Iniciar un recorrido guiado',
  startQuiz: 'Iniciar una evaluación',
  wait: 'Esperar antes de la siguiente',
};

/**
 * Eventos que tienen sentido en un marcador.
 *
 * Los de escena, recorrido y evaluación se disparan en otros objetos; ofrecerlos
 * aquí crearía acciones que nunca se ejecutan.
 */
const HOTSPOT_EVENTS: readonly ActionEvent[] = [
  'click',
  'hover',
  'hoverOut',
  'focusEnter',
  'focusExit',
];

const EVENT_LABELS: Readonly<Record<string, string>> = {
  click: 'Al pulsar',
  hover: 'Al pasar el puntero',
  hoverOut: 'Al salir el puntero',
  focusEnter: 'Al mirarlo (mirada sostenida)',
  focusExit: 'Al dejar de mirarlo',
  waypointReached: 'Al llegar a la parada',
  scoreThreshold: 'Al alcanzar el objetivo',
};

export interface ActionEditorProps {
  readonly project: Project;
  readonly scene: { readonly id: string; readonly title: string };
  /**
   * Acciones que se editan.
   *
   * El editor no sabe de dónde vienen: un marcador, una parada de un
   * recorrido o un objetivo de puntuación tienen la misma lista y las mismas
   * reglas, y acoplarlo al marcador obligaría a duplicarlo para los otros
   * dos.
   */
  readonly actions: readonly Action[];
  readonly onChange: (actions: readonly Action[], label: string) => void;
  /** Encabezado del panel; por defecto, «Acciones». */
  readonly title?: string;
  /**
   * Aviso cuando la lista está vacía.
   *
   * Un marcador sin acciones es un error (se ve pero no responde); una parada
   * o un objetivo sin acciones es normal. El aviso lo pone quien sabe cuál de
   * los dos casos es.
   */
  readonly emptyWarning?: { readonly title: string; readonly detail: string } | null;
  /**
   * Evento fijo de todas las acciones de esta lista.
   *
   * Un marcador se pulsa, se señala con la mirada o se abandona, así que elegir
   * el evento tiene sentido. Una parada de recorrido sólo tiene un momento
   * —llegar— y un objetivo sólo uno —alcanzarse—: ofrecer ahí un «al pulsar»
   * dejaría acciones que no se ejecutan nunca, sin que nada lo advierta.
   */
  readonly fixedEvent?: ActionEvent | null;
}

export function ActionEditor({
  project,
  scene,
  actions: current,
  onChange,
  title = 'Acciones',
  emptyWarning = null,
  fixedEvent = null,
}: ActionEditorProps): JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const otherScenes = project.scenes.filter((s) => s.id !== scene.id);

  /** Configuración inicial de cada tipo, con destino ya elegido si hay uno. */
  const defaultConfig = (type: EditableType): ActionConfig | null => {
    switch (type) {
      case 'goToScene': {
        const target = otherScenes[0];
        // Sin otra escena a la que ir, la acción no se puede completar. Se
        // avisa en lugar de crearla apuntando a la propia escena, que produce
        // un marcador que no hace nada visible.
        if (target === undefined) return null;
        return {
          type: 'goToScene',
          sceneId: target.id,
          entryMode: 'smart',
          transition: { kind: 'fade', durationMs: 450, useGeometry: false },
        };
      }
      case 'lookAt':
        return { type: 'lookAt', durationMs: 900, view: { yaw: 0, pitch: 0, fov: 60 } };
      case 'showAsset': {
        const asset = project.assets[0];
        if (asset === undefined) return null;
        return { type: 'showAsset', assetId: asset.id, tab: 'overview' };
      }
      case 'openDocument': {
        const document = project.documents[0];
        if (document === undefined) return null;
        return { type: 'openDocument', documentId: document.id, page: 1 };
      }
      case 'openMedia': {
        const media = project.media[0];
        if (media === undefined) return null;
        return { type: 'openMedia', mediaId: media.id, albumMediaIds: [], autoplay: false };
      }
      case 'openUrl':
        return { type: 'openUrl', url: 'https://', external: true };
      case 'downloadFile': {
        const media = project.media[0];
        if (media === undefined) return null;
        return { type: 'downloadFile', mediaId: media.id, suggestedName: '' };
      }
      case 'showPlan': {
        const plan = project.plans[0];
        if (plan === undefined) return null;
        return { type: 'showPlan', planId: plan.id };
      }
      case 'startTour': {
        const tour = project.tours[0];
        if (tour === undefined) return null;
        return { type: 'startTour', tourId: tour.id, fromWaypointIndex: 0 };
      }
      case 'startQuiz': {
        const quiz = project.quizzes[0];
        if (quiz === undefined) return null;
        return { type: 'startQuiz', quizId: quiz.id };
      }
      case 'wait':
        return { type: 'wait', durationMs: 1000 };
      default:
        return null;
    }
  };

  const add = (type: EditableType): void => {
    const config = defaultConfig(type);
    if (config === null) return;

    const action: Action = {
      id: newUuid(),
      event: fixedEvent ?? 'click',
      config,
      order: current.length,
      delayMs: 0,
      focusDwellMs: 1200,
      once: false,
      requiresScore: null,
      enabled: true,
    };
    onChange([...current, action], `Añadir acción «${TYPE_LABELS[type]}»`);
  };

  const update = (id: string, patch: Partial<Action>, label: string): void => {
    onChange(
      current.map((action) => (action.id === id ? { ...action, ...patch } : action)),
      label,
    );
  };

  const updateConfig = (id: string, config: ActionConfig, label: string): void => {
    update(id, { config }, label);
  };

  const remove = (id: string): void => {
    onChange(
      current.filter((action) => action.id !== id),
      'Eliminar acción',
    );
  };

  const move = (id: string, direction: -1 | 1): void => {
    const index = current.findIndex((action) => action.id === id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= current.length) return;

    const reordered = [...current];
    const moved = reordered[index];
    const displaced = reordered[target];
    if (moved === undefined || displaced === undefined) return;
    reordered[index] = displaced;
    reordered[target] = moved;

    onChange(
      reordered.map((action, position) => ({ ...action, order: position })),
      'Reordenar acciones',
    );
  };

  /** Tipos que se pueden añadir ahora mismo, con el motivo si no se puede. */
  const availability = EDITABLE_TYPES.map((type) => ({
    type,
    available: defaultConfig(type) !== null,
  }));

  return (
    <div className="inspector__group">
      <SectionLabel>
        {title}
        {current.length > 0 && <Badge tone="neutral">{current.length}</Badge>}
      </SectionLabel>

      {current.length === 0 && emptyWarning !== null && (
        <Callout tone="warning" title={emptyWarning.title}>
          {emptyWarning.detail}
        </Callout>
      )}

      {current.map((action, index) => (
        <Panel
          key={action.id}
          level="raised"
          title={TYPE_LABELS[action.config.type as EditableType] ?? action.config.type}
          actions={
            <>
              <Tooltip content="Subir">
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<span aria-hidden="true">↑</span>}
                  aria-label="Subir la acción"
                  disabled={index === 0}
                  onClick={() => move(action.id, -1)}
                />
              </Tooltip>
              <Tooltip content="Bajar">
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<span aria-hidden="true">↓</span>}
                  aria-label="Bajar la acción"
                  disabled={index === current.length - 1}
                  onClick={() => move(action.id, 1)}
                />
              </Tooltip>
              <Tooltip content="Eliminar">
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconTrash size={13} />}
                  aria-label="Eliminar la acción"
                  onClick={() => setConfirmRemove(action.id)}
                />
              </Tooltip>
            </>
          }
        >
          <div className="inspector__group">
            {fixedEvent === null ? (
              <Field label="Cuándo" inline>
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={action.event}
                    onChange={(event) =>
                      update(action.id, { event: event.currentTarget.value as ActionEvent }, 'Cambiar evento')
                    }
                  >
                    {HOTSPOT_EVENTS.map((event) => (
                      <option key={event} value={event}>
                        {EVENT_LABELS[event] ?? event}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <PropertyList>
                <PropertyRow label="Cuándo" value={EVENT_LABELS[fixedEvent] ?? fixedEvent} />
              </PropertyList>
            )}

            {action.event === 'focusEnter' && (
              <Field
                label="Mirada sostenida"
                inline
                hint="Un disparo instantáneo al centrar activaría todo lo que queda de paso."
              >
                {() => (
                  <NumberInput
                    value={action.focusDwellMs}
                    onValueChange={(value) =>
                      update(action.id, { focusDwellMs: Math.round(value) }, 'Ajustar mirada sostenida')
                    }
                    min={0}
                    max={10_000}
                    step={100}
                    unit="ms"
                    decimals={0}
                    aria-label="Milisegundos de mirada sostenida"
                  />
                )}
              </Field>
            )}

            <ActionConfigFields
              project={project}
              action={action}
              onChange={(config, label) => updateConfig(action.id, config, label)}
            />

            <Field label="Retardo" inline hint="Espera antes de ejecutar la acción.">
              {() => (
                <NumberInput
                  value={action.delayMs}
                  onValueChange={(value) => update(action.id, { delayMs: Math.round(value) }, 'Ajustar retardo')}
                  min={0}
                  max={600_000}
                  step={100}
                  unit="ms"
                  decimals={0}
                  aria-label="Retardo en milisegundos"
                />
              )}
            </Field>

            <Switch
              label="Ejecutar una sola vez por sesión"
              checked={action.once}
              onChange={(event) =>
                update(action.id, { once: event.currentTarget.checked }, 'Cambiar «una sola vez»')
              }
            />

            <Switch
              label="Acción habilitada"
              checked={action.enabled}
              onChange={(event) =>
                update(action.id, { enabled: event.currentTarget.checked }, 'Habilitar o deshabilitar acción')
              }
            />
          </div>
        </Panel>
      ))}

      <Menu
        label="Añadir acción"
        align="start"
        trigger={(props) => (
          <Button size="sm" variant="secondary" fullWidth icon={<IconAdd size={14} />} {...props}>
            Añadir acción
          </Button>
        )}
        items={availability.map(({ type, available }) => ({
          id: type,
          label: available ? TYPE_LABELS[type] : `${TYPE_LABELS[type]} (nada a lo que apuntar)`,
          // Deshabilitada en lugar de oculta: así el autor ve que la acción
          // existe y entiende que le falta contenido en el proyecto, en lugar
          // de buscarla sin encontrarla.
          disabled: !available,
          onSelect: () => add(type),
        }))}
      />

      <ConfirmDialog
        open={confirmRemove !== null}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove !== null) remove(confirmRemove);
          setConfirmRemove(null);
        }}
        title="Eliminar acción"
        message="El marcador dejará de hacer lo que hacía esta acción. Se puede deshacer."
        confirmLabel="Eliminar"
        destructive
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Campos propios de cada tipo
 * ------------------------------------------------------------------ */

function ActionConfigFields({
  project,
  action,
  onChange,
}: {
  readonly project: Project;
  readonly action: Action;
  readonly onChange: (config: ActionConfig, label: string) => void;
}): JSX.Element | null {
  const config = action.config;

  switch (config.type) {
    case 'goToScene':
      return (
        <>
          <Field label="Escena destino" inline>
            {({ id }) => (
              <Select
                id={id}
                size="sm"
                value={config.sceneId}
                onChange={(event) =>
                  onChange(
                    { ...config, sceneId: event.currentTarget.value as Uuid },
                    'Cambiar escena destino',
                  )
                }
              >
                {project.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Vista al llegar"
            inline
            hint="«Inteligente» mira hacia donde se sigue avanzando, no hacia el punto del que se viene."
          >
            {({ id }) => (
              <Select
                id={id}
                size="sm"
                value={config.entryMode}
                onChange={(event) =>
                  onChange(
                    { ...config, entryMode: event.currentTarget.value as typeof config.entryMode },
                    'Cambiar modo de entrada',
                  )
                }
              >
                <option value="smart">Entrada inteligente</option>
                <option value="initialView">Vista inicial de la escena</option>
                <option value="keepOrientation">Conservar la orientación</option>
                <option value="custom">Vista personalizada</option>
              </Select>
            )}
          </Field>

          <Field label="Transición" inline>
            {({ id }) => (
              <Select
                id={id}
                size="sm"
                value={config.transition.kind}
                onChange={(event) =>
                  onChange(
                    {
                      ...config,
                      transition: {
                        ...config.transition,
                        kind: event.currentTarget.value as typeof config.transition.kind,
                      },
                    },
                    'Cambiar transición',
                  )
                }
              >
                <option value="cut">Corte</option>
                <option value="fade">Fundido</option>
                <option value="zoomThrough">Avance con zoom</option>
                <option value="dolly3d">Desplazamiento 3D</option>
              </Select>
            )}
          </Field>

          {config.transition.kind !== 'cut' && (
            <Field label="Duración" inline>
              {() => (
                <NumberInput
                  value={config.transition.durationMs}
                  onValueChange={(value) =>
                    onChange(
                      {
                        ...config,
                        transition: { ...config.transition, durationMs: Math.round(value) },
                      },
                      'Ajustar duración de la transición',
                    )
                  }
                  min={80}
                  max={4000}
                  step={50}
                  unit="ms"
                  decimals={0}
                  aria-label="Duración de la transición"
                />
              )}
            </Field>
          )}

          {(config.transition.kind === 'zoomThrough' || config.transition.kind === 'dolly3d') && (
            <>
              <Checkbox
                label="Usar la geometría 3D de fondo"
                checked={config.transition.useGeometry}
                onChange={(event) =>
                  onChange(
                    {
                      ...config,
                      transition: {
                        ...config.transition,
                        useGeometry: event.currentTarget.checked,
                      },
                    },
                    'Cambiar fondo de la transición',
                  )
                }
              />
              <p className="inspector__hint">
                Cuando la escena de destino es un modelo 3D, el desplazamiento se apoya en su
                geometría. Si no la hay, la transición pasa a fundido sin avisar al visitante:
                es una mejora visual, no una función que deba poder fallar a la vista.
              </p>
            </>
          )}
        </>
      );

    case 'showAsset':
      return (
        <Field label="Activo" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.assetId}
              onChange={(event) =>
                onChange({ ...config, assetId: event.currentTarget.value as Uuid }, 'Cambiar activo')
              }
            >
              {project.assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.tag} — {asset.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'openDocument':
      return (
        <Field label="Documento" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.documentId}
              onChange={(event) =>
                onChange(
                  { ...config, documentId: event.currentTarget.value as Uuid },
                  'Cambiar documento',
                )
              }
            >
              {project.documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.documentCode.length > 0 ? `${document.documentCode} — ` : ''}
                  {document.title}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'openMedia':
    case 'downloadFile':
      return (
        <Field label="Archivo" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.mediaId}
              onChange={(event) =>
                onChange({ ...config, mediaId: event.currentTarget.value as Uuid }, 'Cambiar archivo')
              }
            >
              {project.media.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.originalName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'openUrl':
      return (
        <>
          <Field
            label="Dirección"
            hint="Se abre en una pestaña nueva: un sitio externo dentro del recorrido secuestra los gestos de la panorámica."
          >
            {({ id }) => (
              <TextInput
                id={id}
                value={config.url}
                onChange={(event) => onChange({ ...config, url: event.currentTarget.value }, 'Cambiar enlace')}
              />
            )}
          </Field>
          {!/^https:\/\/.+/.test(config.url) && (
            <Callout tone="warning">
              Use una dirección completa que empiece por <code>https://</code>. Un enlace sin
              protocolo se interpreta como una ruta del propio paquete y no lleva a ninguna parte.
            </Callout>
          )}
        </>
      );

    case 'showPlan':
      return (
        <Field label="Plano" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.planId}
              onChange={(event) =>
                onChange({ ...config, planId: event.currentTarget.value as Uuid }, 'Cambiar plano')
              }
            >
              {project.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'startTour':
      return (
        <Field label="Recorrido" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.tourId}
              onChange={(event) =>
                onChange({ ...config, tourId: event.currentTarget.value as Uuid }, 'Cambiar recorrido')
              }
            >
              {project.tours.map((tour) => (
                <option key={tour.id} value={tour.id}>
                  {tour.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'startQuiz':
      return (
        <Field label="Evaluación" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.quizId}
              onChange={(event) =>
                onChange({ ...config, quizId: event.currentTarget.value as Uuid }, 'Cambiar evaluación')
              }
            >
              {project.quizzes.map((quiz) => (
                <option key={quiz.id} value={quiz.id}>
                  {quiz.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'wait':
      return (
        <Field label="Espera" inline>
          {() => (
            <NumberInput
              value={config.durationMs}
              onValueChange={(value) =>
                onChange({ ...config, durationMs: Math.round(value) }, 'Ajustar espera')
              }
              min={0}
              max={60_000}
              step={100}
              unit="ms"
              decimals={0}
              aria-label="Milisegundos de espera"
            />
          )}
        </Field>
      );

    case 'lookAt':
      return (
        <PropertyList>
          <PropertyRow label="Azimut" mono value={`${config.view.yaw.toFixed(2)} rad`} />
          <PropertyRow label="Elevación" mono value={`${config.view.pitch.toFixed(2)} rad`} />
          <PropertyRow label="Campo de visión" mono value={`${config.view.fov.toFixed(0)}°`} />
        </PropertyList>
      );

    default:
      // Un tipo que el editor no sabe configurar se muestra en lectura en
      // lugar de ocultarse: el autor debe poder ver qué hace el marcador
      // aunque haya que cambiarlo por otra vía.
      return (
        <PropertyList>
          <PropertyRow label="Tipo" mono value={config.type} />
          <PropertyRow
            label="Configuración"
            value="Este tipo de acción todavía no se edita desde aquí"
            tone="experimental"
          />
        </PropertyList>
      );
  }
}
