/**
 * Ajustes propios de cada componente de la interfaz (F07–F13).
 *
 * Existe porque faltaba: el panel de propiedades cubría texto, imagen, botón,
 * contenedor, contenido web y la etiqueta del menú, y para todo lo demás
 * mostraba «no tiene más ajustes propios». Era falso, y además dejaba
 * componentes inservibles: un contenedor de pestañas sin forma de añadir una
 * pestaña, un menú desplegable sin forma de añadir una entrada, una lista de
 * miniaturas sin orientación ni tamaño.
 *
 * Las acciones de las entradas de un menú y las del fin de un temporizador se
 * editan con el mismo editor de acciones que las de cualquier componente: son
 * la misma lista con las mismas reglas, y duplicarlo habría significado dos
 * sitios donde arreglar el próximo defecto.
 */
import { useState } from 'react';
import {
  COMPONENT_LABELS,
  type Action,
  type ComponentConfig,
  type Project,
  type SkinNode,
} from '@it360/domain';
import {
  Button,
  Callout,
  Field,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  TextInput,
} from '@it360/ui';
import { ActionEditor } from './ActionEditor';

export interface SkinComponentPanelProps {
  readonly node: SkinNode;
  readonly project: Project;
  readonly setConfig: (patch: Record<string, unknown>, key: string) => void;
}

const PROGRESS_SOURCES = [
  ['tour', 'Avance del recorrido'],
  ['media', 'Avance del audio o vídeo'],
  ['score', 'Puntuación'],
  ['quiz', 'Avance de la evaluación'],
] as const;

const ASSET_TABS = [
  ['overview', 'Resumen'],
  ['attributes', 'Atributos'],
  ['documents', 'Documentos'],
  ['telemetry', 'Proceso'],
  ['notes', 'Notas'],
] as const;

export function ComponentPanel({
  node,
  project,
  setConfig,
}: SkinComponentPanelProps): JSX.Element {
  const config: ComponentConfig = node.config;

  switch (config.kind) {
    case 'dropdown':
      return <DropdownPanel config={config} project={project} setConfig={setConfig} />;

    case 'tabs':
      return <TabsPanel config={config} setConfig={setConfig} />;

    case 'progressBar':
      return (
        <>
          <Field label="Qué representa" inline>
            {({ id }) => (
              <Select
                id={id}
                value={config.source}
                onChange={(event) => setConfig({ source: event.currentTarget.value }, 'source')}
              >
                {PROGRESS_SOURCES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {config.source === 'score' && (
            <Field label="Clave de puntuación" inline hint="La que usen las acciones del recorrido.">
              {({ id }) => (
                <TextInput
                  id={id}
                  size="sm"
                  value={config.scoreKey}
                  onChange={(event) => setConfig({ scoreKey: event.currentTarget.value }, 'key')}
                />
              )}
            </Field>
          )}

          <Field label="Mostrar el porcentaje" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showLabel}
                onChange={(event) => setConfig({ showLabel: event.currentTarget.checked }, 'label')}
              />
            )}
          </Field>

          {config.source === 'media' && (
            <Callout tone="warning" title="El avance del audio todavía no llega al visor">
              Esta barra quedará en reposo en el recorrido publicado. Las de recorrido y evaluación
              sí funcionan.
            </Callout>
          )}
        </>
      );

    case 'thumbnailList':
      return (
        <>
          <Field label="Orientación" inline>
            {({ id }) => (
              <Select
                id={id}
                value={config.orientation}
                onChange={(event) =>
                  setConfig({ orientation: event.currentTarget.value }, 'orientation')
                }
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </Select>
            )}
          </Field>

          <Field label="Tamaño" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                value={config.thumbnailSize}
                min={48}
                max={320}
                step={8}
                decimals={0}
                unit="px"
                onValueChange={(value) =>
                  setConfig({ thumbnailSize: Math.round(value) }, 'thumbSize')
                }
              />
            )}
          </Field>

          <Field label="Mostrar los títulos" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showTitles}
                onChange={(event) => setConfig({ showTitles: event.currentTarget.checked }, 'titles')}
              />
            )}
          </Field>

          <p className="skin-props__hint">
            {config.sceneIds.length === 0
              ? 'Incluye todas las escenas publicables, en su orden.'
              : `Limitada a ${config.sceneIds.length} escena(s).`}
          </p>
        </>
      );

    case 'carousel':
      return (
        <>
          <Field label="Avance automático" inline hint="0 para no avanzar solo.">
            {({ id }) => (
              <NumberInput
                id={id}
                value={config.autoAdvanceMs / 1000}
                min={0}
                max={60}
                step={1}
                decimals={0}
                unit="s"
                onValueChange={(value) =>
                  setConfig({ autoAdvanceMs: Math.round(value) * 1000 }, 'auto')
                }
              />
            )}
          </Field>

          <Field label="Volver al principio al final" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.loop}
                onChange={(event) => setConfig({ loop: event.currentTarget.checked }, 'loop')}
              />
            )}
          </Field>

          <Field label="Mostrar flechas" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showArrows}
                onChange={(event) => setConfig({ showArrows: event.currentTarget.checked }, 'arrows')}
              />
            )}
          </Field>

          <Field label="Mostrar puntos" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showDots}
                onChange={(event) => setConfig({ showDots: event.currentTarget.checked }, 'dots')}
              />
            )}
          </Field>

          {config.autoAdvanceMs > 0 && (
            <Callout tone="warning" title="El avance automático todavía no llega al visor">
              En el recorrido publicado el carrusel se avanza con las flechas. El ajuste se guarda.
            </Callout>
          )}
        </>
      );

    case 'planView':
      return (
        <>
          <Field label="Plano" inline hint="Vacío: el de la escena actual.">
            {({ id }) => (
              <Select
                id={id}
                value={config.planId ?? ''}
                onChange={(event) =>
                  setConfig(
                    { planId: event.currentTarget.value === '' ? null : event.currentTarget.value },
                    'plan',
                  )
                }
              >
                <option value="">El de la escena</option>
                {project.plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Mostrar el radar" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showRadar}
                onChange={(event) => setConfig({ showRadar: event.currentTarget.checked }, 'radar')}
              />
            )}
          </Field>

          <Field label="Permitir cambiar de zona" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.allowFloorSwitch}
                onChange={(event) =>
                  setConfig({ allowFloorSwitch: event.currentTarget.checked }, 'floors')
                }
              />
            )}
          </Field>
        </>
      );

    case 'assetPanel':
      return (
        <>
          <Field label="Activo" inline hint="Vacío: el que esté seleccionado en la escena.">
            {({ id }) => (
              <Select
                id={id}
                value={config.assetId ?? ''}
                onChange={(event) =>
                  setConfig(
                    { assetId: event.currentTarget.value === '' ? null : event.currentTarget.value },
                    'asset',
                  )
                }
              >
                <option value="">El seleccionado</option>
                {project.assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.tag} · {asset.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <SectionLabel>Secciones visibles</SectionLabel>
          {ASSET_TABS.map(([value, label]) => (
            <Field key={value} label={label} inline>
              {({ id }) => (
                <Switch
                  id={id}
                  checked={config.visibleTabs.includes(value)}
                  onChange={(event) =>
                    setConfig(
                      {
                        visibleTabs: event.currentTarget.checked
                          ? [...config.visibleTabs, value]
                          : config.visibleTabs.filter((tab) => tab !== value),
                      },
                      'tabs',
                    )
                  }
                />
              )}
            </Field>
          ))}
        </>
      );

    case 'telemetryPanel':
      return (
        <>
          <Field label="Disposición" inline>
            {({ id }) => (
              <Select
                id={id}
                value={config.layout}
                onChange={(event) => setConfig({ layout: event.currentTarget.value }, 'layout')}
              >
                <option value="list">Lista</option>
                <option value="grid">Cuadrícula</option>
                <option value="gauges">Indicadores</option>
              </Select>
            )}
          </Field>

          <Field label="Refresco" inline hint="0 para pedir el dato sólo al abrir.">
            {({ id }) => (
              <NumberInput
                id={id}
                value={config.refreshSeconds}
                min={0}
                max={3600}
                step={5}
                decimals={0}
                unit="s"
                onValueChange={(value) =>
                  setConfig({ refreshSeconds: Math.round(value) }, 'refresh')
                }
              />
            )}
          </Field>

          <SectionLabel>Variables</SectionLabel>
          {project.telemetryMappings.length === 0 ? (
            <p className="skin-props__hint">
              El proyecto no tiene variables de proceso. Se declaran en el módulo de telemetría.
            </p>
          ) : (
            project.telemetryMappings.map((mapping) => (
              <Field key={mapping.id} label={mapping.variable} inline>
                {({ id }) => (
                  <Switch
                    id={id}
                    checked={config.mappingIds.includes(mapping.id)}
                    onChange={(event) =>
                      setConfig(
                        {
                          mappingIds: event.currentTarget.checked
                            ? [...config.mappingIds, mapping.id]
                            : config.mappingIds.filter((candidate) => candidate !== mapping.id),
                        },
                        'mappings',
                      )
                    }
                  />
                )}
              </Field>
            ))
          )}

          <Callout tone="warning" title="Este panel todavía no llega al visor">
            El ajuste se guarda, pero el recorrido publicado lo dice en su sitio en lugar de
            dibujarlo. La ficha de activo sí muestra sus variables de proceso.
          </Callout>
        </>
      );

    case 'notesPanel':
      return (
        <>
          <Field label="Alcance" inline>
            {({ id }) => (
              <Select
                id={id}
                value={config.scope}
                onChange={(event) => setConfig({ scope: event.currentTarget.value }, 'scope')}
              >
                <option value="scene">La escena actual</option>
                <option value="asset">El activo seleccionado</option>
                <option value="project">Todo el proyecto</option>
              </Select>
            )}
          </Field>

          <Field label="Permitir crear notas" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.allowCreate}
                onChange={(event) => setConfig({ allowCreate: event.currentTarget.checked }, 'create')}
              />
            )}
          </Field>
        </>
      );

    case 'quizCard':
      return (
        <Field label="Evaluación" inline>
          {({ id }) => (
            <Select
              id={id}
              value={config.quizId ?? ''}
              onChange={(event) =>
                setConfig(
                  { quizId: event.currentTarget.value === '' ? null : event.currentTarget.value },
                  'quiz',
                )
              }
            >
              <option value="">Sin asignar</option>
              {project.quizzes.map((quiz) => (
                <option key={quiz.id} value={quiz.id}>
                  {quiz.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'scoreBoard':
      return (
        <>
          <KeyListField
            keys={config.scoreKeys}
            onCommit={(scoreKeys) => setConfig({ scoreKeys }, 'keys')}
          />

          <Field label="Mostrar el tiempo" inline>
            {({ id }) => (
              <Switch
                id={id}
                checked={config.showTime}
                onChange={(event) => setConfig({ showTime: event.currentTarget.checked }, 'time')}
              />
            )}
          </Field>
        </>
      );

    case 'timer':
      return (
        <>
          <Field label="Modo" inline>
            {({ id }) => (
              <Select
                id={id}
                value={config.mode}
                onChange={(event) => setConfig({ mode: event.currentTarget.value }, 'mode')}
              >
                <option value="elapsed">Tiempo transcurrido</option>
                <option value="countdown">Cuenta atrás</option>
              </Select>
            )}
          </Field>

          {config.mode === 'countdown' && (
            <>
              <Field label="Duración" inline>
                {({ id }) => (
                  <NumberInput
                    id={id}
                    value={config.durationS}
                    min={1}
                    max={86_400}
                    step={30}
                    decimals={0}
                    unit="s"
                    onValueChange={(value) =>
                      setConfig({ durationS: Math.max(1, Math.round(value)) }, 'duration')
                    }
                  />
                )}
              </Field>

              <Callout tone="warning" title="Las acciones al agotarse todavía no llegan al visor">
                La cuenta atrás se muestra; lo que el autor encadene al agotarse se guarda pero no
                se ejecuta aún en el recorrido publicado.
              </Callout>
            </>
          )}
        </>
      );

    case 'spacer':
      return (
        <Field label="Ocupa el espacio libre" inline>
          {({ id }) => (
            <Switch
              id={id}
              checked={config.flexible}
              onChange={(event) => setConfig({ flexible: event.currentTarget.checked }, 'flex')}
            />
          )}
        </Field>
      );

    default:
      return (
        <p className="skin-props__hint">
          «{COMPONENT_LABELS[config.kind]}» se configura con su colocación, su estilo y sus
          acciones.
        </p>
      );
  }
}

/* ------------------------------------------------------------------ *
 * Lista de claves separadas por comas
 * ------------------------------------------------------------------ */

/**
 * Campo de claves que se confirma al salir, no en cada tecla.
 *
 * Con confirmación en cada tecla el campo era inservible: al escribir la coma,
 * la lista se volvía a formatear sin ella y la coma desaparecía, así que no se
 * podía escribir más de una clave. El texto se mantiene aquí mientras se
 * escribe y se interpreta al salir del campo o al pulsar Intro, que es la
 * misma disciplina que usan los campos numéricos de esta aplicación.
 */
function KeyListField({
  keys,
  onCommit,
}: {
  readonly keys: readonly string[];
  readonly onCommit: (keys: readonly string[]) => void;
}): JSX.Element {
  const [text, setText] = useState(keys.join(', '));

  const commit = (): void => {
    const parsed = text
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');

    // Sólo se avisa si de verdad cambia, para no ensuciar el historial de
    // deshacer con un paso por cada vez que el campo pierde el foco.
    if (parsed.join('\u0000') !== keys.join('\u0000')) onCommit(parsed);
    setText(parsed.join(', '));
  };

  return (
    <Field label="Claves" inline hint="Separadas por comas. Vacío: todas las que use el recorrido.">
      {({ id }) => (
        <TextInput
          id={id}
          size="sm"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      )}
    </Field>
  );
}

/* ------------------------------------------------------------------ *
 * Menú desplegable (F07)
 * ------------------------------------------------------------------ */

function DropdownPanel({
  config,
  project,
  setConfig,
}: {
  readonly config: Extract<ComponentConfig, { kind: 'dropdown' }>;
  readonly project: Project;
  readonly setConfig: (patch: Record<string, unknown>, key: string) => void;
}): JSX.Element {
  const [openItem, setOpenItem] = useState<string | null>(null);

  const anchorScene = project.scenes.find((scene) => scene.id === project.settings.entrySceneId) ??
    project.scenes[0] ??
    null;

  const patchItems = (items: typeof config.items, key: string): void =>
    setConfig({ items: [...items] }, key);

  return (
    <>
      <Field label="Etiqueta del menú" inline>
        {({ id }) => (
          <TextInput
            id={id}
            size="sm"
            value={config.label}
            onChange={(event) => setConfig({ label: event.currentTarget.value }, 'label')}
          />
        )}
      </Field>

      <SectionLabel
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const id = `op-${config.items.length + 1}-${Date.now().toString(36)}`;
              patchItems(
                [...config.items, { id, label: `Opción ${config.items.length + 1}`, icon: '', actions: [] }],
                'addItem',
              );
              setOpenItem(id);
            }}
          >
            Añadir
          </Button>
        }
      >
        Entradas
      </SectionLabel>

      {config.items.length === 0 ? (
        <Callout tone="warning" title="El menú está vacío">
          Un menú sin entradas se abre y no ofrece nada. Añada al menos una.
        </Callout>
      ) : (
        config.items.map((item) => (
          <div key={item.id} className="skin-props__item">
            <Field label="Texto" inline>
              {({ id }) => (
                <TextInput
                  id={id}
                  size="sm"
                  value={item.label}
                  onChange={(event) =>
                    patchItems(
                      config.items.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, label: event.currentTarget.value }
                          : candidate,
                      ),
                      `item.${item.id}`,
                    )
                  }
                />
              )}
            </Field>

            <div className="skin-props__item-row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
              >
                {openItem === item.id ? 'Ocultar acciones' : `Acciones (${item.actions.length})`}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  patchItems(
                    config.items.filter((candidate) => candidate.id !== item.id),
                    'removeItem',
                  )
                }
              >
                Quitar
              </Button>
            </div>

            {openItem === item.id && (
              <ActionEditor
                actions={item.actions}
                project={project}
                scene={{ id: anchorScene?.id ?? '', title: anchorScene?.title ?? 'Escena' }}
                title={`Al elegir «${item.label}»`}
                emptyWarning={{
                  title: 'Esta entrada no hace nada',
                  detail: 'Se puede elegir y no ocurre nada, que el visitante lee como un fallo.',
                }}
                fixedEvent="click"
                onChange={(actions: readonly Action[]) =>
                  patchItems(
                    config.items.map((candidate) =>
                      candidate.id === item.id ? { ...candidate, actions: [...actions] } : candidate,
                    ),
                    `itemActions.${item.id}`,
                  )
                }
              />
            )}
          </div>
        ))
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Contenedor de pestañas (F08)
 * ------------------------------------------------------------------ */

function TabsPanel({
  config,
  setConfig,
}: {
  readonly config: Extract<ComponentConfig, { kind: 'tabs' }>;
  readonly setConfig: (patch: Record<string, unknown>, key: string) => void;
}): JSX.Element {
  return (
    <>
      <SectionLabel
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setConfig(
                {
                  tabs: [
                    ...config.tabs,
                    {
                      id: `tab-${config.tabs.length + 1}-${Date.now().toString(36)}`,
                      label: `Pestaña ${config.tabs.length + 1}`,
                      icon: '',
                    },
                  ],
                },
                'addTab',
              )
            }
          >
            Añadir
          </Button>
        }
      >
        Pestañas
      </SectionLabel>

      {config.tabs.map((tab) => (
        <div key={tab.id} className="skin-props__item">
          <Field label="Título" inline>
            {({ id }) => (
              <TextInput
                id={id}
                size="sm"
                value={tab.label}
                onChange={(event) =>
                  setConfig(
                    {
                      tabs: config.tabs.map((candidate) =>
                        candidate.id === tab.id
                          ? { ...candidate, label: event.currentTarget.value }
                          : candidate,
                      ),
                    },
                    `tab.${tab.id}`,
                  )
                }
              />
            )}
          </Field>

          <div className="skin-props__item-row">
            <Field label="Abrir por esta" inline>
              {({ id }) => (
                <Switch
                  id={id}
                  checked={config.activeTabId === tab.id}
                  onChange={(event) =>
                    setConfig({ activeTabId: event.currentTarget.checked ? tab.id : null }, 'active')
                  }
                />
              )}
            </Field>

            {/* Una pestaña menos no puede quedar: el esquema exige al menos
                una, y un contenedor sin ninguna no sabría qué mostrar. */}
            {config.tabs.length > 1 && (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  setConfig(
                    {
                      tabs: config.tabs.filter((candidate) => candidate.id !== tab.id),
                      activeTabId: config.activeTabId === tab.id ? null : config.activeTabId,
                    },
                    'removeTab',
                  )
                }
              >
                Quitar
              </Button>
            )}
          </div>
        </div>
      ))}

      <p className="skin-props__hint">
        Cada componente hijo pertenece a una pestaña: se elige en sus propias propiedades.
      </p>
    </>
  );
}
