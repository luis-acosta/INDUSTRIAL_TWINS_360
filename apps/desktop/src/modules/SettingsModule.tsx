/**
 * Ajustes del proyecto.
 *
 * Reúne lo que cambia el comportamiento del proyecto entero: identificación,
 * unicidad de TAG, guardado y respaldos, política de guiones y funciones
 * experimentales. Cada ajuste con consecuencias de seguridad lleva escrito al
 * lado qué implica activarlo, porque la configuración por defecto es la segura
 * y quien la cambia debe saber a cambio de qué.
 */
import {
  DEFAULT_SCRIPTING_POLICY,
  SCRIPTING_MODE_LABELS,
  TAG_SCOPE_LABELS,
  type ScriptingPolicy,
  type TagUniquenessScope,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Field,
  IconExperimental,
  IconLock,
  NumberInput,
  Panel,
  PropertyList,
  PropertyRow,
  Select,
  Switch,
  TextArea,
  TextInput,
  useToast,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';
import { APP_VERSION } from '../version';

export interface SettingsModuleProps {
  readonly store: ProjectStore;
}

export function SettingsModule({ store }: SettingsModuleProps): JSX.Element {
  const project = store.project;
  const settings = project.settings;
  const { push } = useToast();

  const setSettings = (label: string, patch: Partial<typeof settings>, coalesceKey?: string): void => {
    store.updateProject(label, { settings: { ...settings, ...patch } }, coalesceKey);
  };

  const setScripting = (patch: Partial<ScriptingPolicy>): void => {
    setSettings('Cambiar política de guiones', { scripting: { ...settings.scripting, ...patch } });
  };

  return (
    <div className="module">
      <header className="module__head">
        <div>
          <h1 className="module__title">Ajustes del proyecto</h1>
          <p className="module__subtitle">
            Formato v{project.schemaVersion} · aplicación {APP_VERSION}
          </p>
        </div>
      </header>

      <div className="module__body">
        <div className="module__grid">
          <Panel title="Identificación" level="raised">
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              <Field label="Título del proyecto">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={project.title}
                    onChange={(event) =>
                      store.updateProject('Renombrar proyecto', { title: event.currentTarget.value }, 'project.title')
                    }
                  />
                )}
              </Field>
              <Field label="Cliente">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={project.client}
                    onChange={(event) =>
                      store.updateProject('Cambiar cliente', { client: event.currentTarget.value }, 'project.client')
                    }
                  />
                )}
              </Field>
              <Field label="Instalación">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={project.site}
                    onChange={(event) =>
                      store.updateProject('Cambiar instalación', { site: event.currentTarget.value }, 'project.site')
                    }
                  />
                )}
              </Field>
              <Field label="Descripción">
                {({ id }) => (
                  <TextArea
                    id={id}
                    rows={3}
                    value={project.description}
                    onChange={(event) =>
                      store.updateProject('Editar descripción', { description: event.currentTarget.value }, 'project.desc')
                    }
                  />
                )}
              </Field>
            </div>
          </Panel>

          <Panel title="Catálogo y presentación" level="raised">
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              <Field
                label="Alcance de unicidad del TAG"
                inline
                hint="Determina dónde se exige que un TAG no se repita."
              >
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={settings.tagUniquenessScope}
                    onChange={(event) =>
                      setSettings('Cambiar alcance de TAG', {
                        tagUniquenessScope: event.currentTarget.value as TagUniquenessScope,
                      })
                    }
                  >
                    {Object.entries(TAG_SCOPE_LABELS).map(([scope, label]) => (
                      <option key={scope} value={scope}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Idioma del visor publicado" inline>
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={settings.language}
                    onChange={(event) => setSettings('Cambiar idioma', { language: event.currentTarget.value })}
                  >
                    <option value="es">Español</option>
                    <option value="en">English</option>
                    <option value="pt">Português</option>
                  </Select>
                )}
              </Field>

              <Field
                label="Zona horaria de presentación"
                inline
                hint="Los datos se guardan en UTC; esto sólo afecta a cómo se muestran."
              >
                {({ id }) => (
                  <TextInput
                    id={id}
                    size="sm"
                    value={settings.displayTimeZone}
                    onChange={(event) =>
                      setSettings('Cambiar zona horaria', { displayTimeZone: event.currentTarget.value }, 'settings.tz')
                    }
                  />
                )}
              </Field>
            </div>
          </Panel>

          <Panel title="Guardado y respaldos" level="raised">
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              <Field label="Guardado automático" inline hint="0 desactiva el guardado automático.">
                {() => (
                  <NumberInput
                    value={settings.autosaveMinutes}
                    onValueChange={(value) => setSettings('Cambiar guardado automático', { autosaveMinutes: value })}
                    min={0}
                    max={120}
                    step={1}
                    unit="min"
                    decimals={0}
                    aria-label="Minutos entre guardados automáticos"
                  />
                )}
              </Field>

              <Field label="Copias de respaldo" inline>
                {() => (
                  <NumberInput
                    value={settings.backupCount}
                    onValueChange={(value) => setSettings('Cambiar número de copias', { backupCount: value })}
                    min={0}
                    max={20}
                    step={1}
                    decimals={0}
                    aria-label="Copias de respaldo conservadas"
                  />
                )}
              </Field>

              {settings.backupCount < 3 && (
                <Callout tone="warning" title="Menos de tres copias deja poco margen">
                  Con una sola copia, guardar dos veces seguidas destruye la última versión buena. Tres
                  cubren el caso habitual: darse cuenta del error después del segundo guardado.
                </Callout>
              )}

              <PropertyList>
                <PropertyRow
                  label="Escritura"
                  value="temporal, sincronización a disco, rotación y renombrado"
                />
                <PropertyRow label="Formato" mono value=".ivp (ZIP con manifiesto y sumas)" />
              </PropertyList>
            </div>
          </Panel>

          <Panel
            title={
              <span style={{ display: 'inline-flex', gap: 'var(--it-space-2)', alignItems: 'center' }}>
                <IconLock size={14} /> JavaScript personalizado
              </span>
            }
            level="raised"
          >
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              {/* Riesgo alto declarado en el plan: deshabilitado por defecto,
                  sólo administradores, contexto aislado y sin acceso al
                  sistema operativo. La interfaz no puede relajar nada de eso;
                  sólo elegir entre los modos que el dominio permite. */}
              <Callout tone="warning" title="Función de riesgo alto">
                Los guiones se ejecutan en un contexto aislado, sin acceso al sistema de archivos, a la
                red ni al proyecto, y con límite de tiempo. Cada guion necesita aprobación explícita de un
                administrador, y los guiones de proyectos importados nunca se ejecutan sin aprobarse de
                nuevo.
              </Callout>

              <Field label="Modo" inline>
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={settings.scripting.mode}
                    onChange={(event) =>
                      setScripting({ mode: event.currentTarget.value as ScriptingPolicy['mode'] })
                    }
                  >
                    {Object.entries(SCRIPTING_MODE_LABELS).map(([mode, label]) => (
                      <option key={mode} value={mode}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Límite de ejecución" inline>
                {() => (
                  <NumberInput
                    value={settings.scripting.timeoutMs}
                    onValueChange={(value) => setScripting({ timeoutMs: value })}
                    min={50}
                    max={5000}
                    step={50}
                    unit="ms"
                    decimals={0}
                    disabled={settings.scripting.mode === 'disabled'}
                    aria-label="Límite de ejecución en milisegundos"
                  />
                )}
              </Field>

              <Switch
                label="Permitir también en el recorrido publicado"
                checked={settings.scripting.allowInPublished}
                disabled={settings.scripting.mode === 'disabled'}
                onChange={(event) => setScripting({ allowInPublished: event.currentTarget.checked })}
              />

              <PropertyList>
                <PropertyRow
                  label="Guiones aprobados"
                  mono
                  value={String(settings.scripting.approvals.length)}
                />
              </PropertyList>

              {settings.scripting.mode !== DEFAULT_SCRIPTING_POLICY.mode && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setScripting(DEFAULT_SCRIPTING_POLICY);
                    push({ tone: 'nominal', title: 'Política de guiones restaurada a la configuración segura' });
                  }}
                >
                  Restaurar configuración segura
                </Button>
              )}
            </div>
          </Panel>

          <Panel title="Disparadores del recorrido" level="raised">
            {/* El umbral de inactividad gobierna las acciones de «idle» (J04)
                en el recorrido publicado, y el ritmo depende del recorrido:
                una formación guiada quiere recuperar la atención en veinte
                segundos; un panel de sala de control que alguien mira de
                reojo durante un turno, no. */}
            <Field
              label="Inactividad antes de reaccionar"
              hint="Tras este tiempo sin gestos del visitante, el recorrido ejecuta las acciones configuradas «por inactividad»."
              inline
            >
              {() => (
                <NumberInput
                  aria-label="Segundos de inactividad"
                  min={5}
                  max={600}
                  step={5}
                  decimals={0}
                  unit="s"
                  value={Math.round(settings.idleTimeoutMs / 1000)}
                  onValueChange={(value) =>
                    setSettings('Cambiar la inactividad del recorrido', {
                      idleTimeoutMs: Math.round(value) * 1000,
                    })
                  }
                />
              )}
            </Field>
          </Panel>

          <Panel
            title={
              <span style={{ display: 'inline-flex', gap: 'var(--it-space-2)', alignItems: 'center' }}>
                <IconExperimental size={14} /> Funciones experimentales
              </span>
            }
            level="raised"
          >
            <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
              <Switch
                label="Habilitar algoritmos experimentales"
                checked={settings.experimentalFeatures}
                onChange={(event) =>
                  setSettings('Cambiar funciones experimentales', {
                    experimentalFeatures: event.currentTarget.checked,
                  })
                }
              />
              {/* No se presentan como terminadas porque no lo están: el plan
                  exige dejarlas marcadas como experimentales y con revisión
                  humana de sus resultados. */}
              <PropertyList>
                <PropertyRow
                  label="Conexión automática de escenas"
                  value={<Badge tone="experimental">propuestas que exigen confirmación</Badge>}
                />
                <PropertyRow
                  label="Cosido de panorámicas"
                  value={<Badge tone="experimental">servicio Python opcional</Badge>}
                />
              </PropertyList>
              <p style={{ margin: 0, fontSize: 'var(--it-text-xs)', color: 'var(--it-color-text-tertiary)' }}>
                Lo que generan estos algoritmos entra en el proyecto marcado y sin publicar. Nada se
                publica hasta que una persona lo confirma.
              </p>
            </div>
          </Panel>

          <Panel title="Estado del proyecto" level="raised">
            <PropertyList>
              <PropertyRow label="Identificador" mono value={project.id} />
              <PropertyRow label="Versión del formato" mono value={String(project.schemaVersion)} />
              <PropertyRow label="Creado" mono value={project.createdAt.slice(0, 16).replace('T', ' ')} />
              <PropertyRow label="Modificado" mono value={project.updatedAt.slice(0, 16).replace('T', ' ')} />
              <PropertyRow label="Guardado por" mono value={project.savedByVersion || 'sin guardar'} />
              <PropertyRow label="Escenas" mono value={String(store.stats.scenes)} />
              <PropertyRow label="Marcadores" mono value={String(store.stats.hotspots)} />
              <PropertyRow label="Activos" mono value={String(store.stats.assets)} />
              <PropertyRow label="Variables de telemetría" mono value={String(store.stats.telemetryVariables)} />
              <PropertyRow
                label="Medios"
                mono
                value={`${(store.stats.mediaBytes / 1_000_000).toFixed(1)} MB`}
              />
            </PropertyList>
          </Panel>
        </div>
      </div>
    </div>
  );
}
