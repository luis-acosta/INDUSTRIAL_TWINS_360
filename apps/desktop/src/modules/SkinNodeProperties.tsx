/**
 * Propiedades de un componente de la interfaz
 * (F03, F05, F06, F07, F09, F11, F12, J05).
 *
 * Un panel largo, dividido en lo que el autor busca por separado: dónde está,
 * cómo se ve, qué contiene y cuándo aparece. El orden no es decorativo: la
 * colocación es lo que se ajusta diez veces y el estilo lo que se ajusta una,
 * así que va primero.
 *
 * Dos criterios que se repiten en todo el panel:
 *
 * - **Lo que afecta al recorrido publicado se dice aquí, no se descubre allí.**
 *   Un tamaño en porcentaje y uno en píxeles se comportan de forma distinta al
 *   cambiar de pantalla, y el panel lo explica en una línea en lugar de dejar
 *   que el autor lo averigüe publicando.
 * - **Nada se infiere.** Una imagen sin texto alternativo se avisa; no se
 *   inventa uno a partir del nombre del archivo, que produciría descripciones
 *   falsas en un lector de pantalla.
 */
import {
  COMPONENT_LABELS,
  INFO_VARIABLES,
  unknownVariables,
  type ComponentConfig,
  type Project,
  type Skin,
  type SkinNode,
} from '@it360/domain';
import { ComponentPanel } from './SkinComponentPanel';
import {
  Badge,
  Callout,
  Checkbox,
  Field,
  NumberInput,
  SectionLabel,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface SkinNodePropertiesProps {
  readonly store: ProjectStore;
  readonly skin: Skin;
  readonly node: SkinNode;
  readonly onChange: (
    label: string,
    patch: (node: SkinNode) => SkinNode,
    coalesceKey?: string,
  ) => void;
}

const ANCHOR_LABELS: Readonly<Record<string, string>> = {
  topLeft: 'Arriba izquierda',
  top: 'Arriba centro',
  topRight: 'Arriba derecha',
  left: 'Centro izquierda',
  center: 'Centro',
  right: 'Centro derecha',
  bottomLeft: 'Abajo izquierda',
  bottom: 'Abajo centro',
  bottomRight: 'Abajo derecha',
};

export function SkinNodeProperties({
  store,
  skin,
  node,
  onChange,
}: SkinNodePropertiesProps): JSX.Element {
  const project = store.project;

  const setBox = (patch: Partial<SkinNode['box']>, key: string): void =>
    onChange('Ajustar colocación', (current) => ({ ...current, box: { ...current.box, ...patch } }), `skin.box:${node.id}:${key}`);

  const setStyle = (patch: Partial<SkinNode['style']>, key: string): void =>
    onChange('Ajustar estilo', (current) => ({ ...current, style: { ...current.style, ...patch } }), `skin.style:${node.id}:${key}`);

  const setConfig = (patch: Record<string, unknown>, key: string): void =>
    onChange(
      'Ajustar componente',
      (current) => ({ ...current, config: { ...current.config, ...patch } as ComponentConfig }),
      `skin.config:${node.id}:${key}`,
    );

  const images = project.media.filter((media) => media.kind === 'image' && !media.quarantined);
  const fonts = project.media.filter((media) => media.kind === 'font' && !media.quarantined);

  return (
    <div className="skin-props">
      <header className="skin-props__head">
        <strong>{node.name}</strong>
        <Badge tone="neutral">{COMPONENT_LABELS[node.config.kind]}</Badge>
      </header>

      <Field label="Nombre" inline hint="Sólo para el editor; no se ve en el recorrido.">
        {({ id }) => (
          <TextInput
            id={id}
            size="sm"
            value={node.name}
            onChange={(event) =>
              onChange(
                'Renombrar componente',
                (current) => ({ ...current, name: event.target.value }),
                `skin.name:${node.id}`,
              )
            }
          />
        )}
      </Field>

      {/* ---------------- Colocación (F05, F06) ---------------- */}

      <SectionLabel>Colocación</SectionLabel>

      <Field
        label="Anclaje"
        inline
        hint="El punto de la pantalla desde el que se mide la posición."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={node.box.anchor}
            onChange={(event) => setBox({ anchor: event.currentTarget.value as SkinNode['box']['anchor'] }, 'anchor')}
          >
            {Object.entries(ANCHOR_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="skin-props__pair">
        <Field label="X" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={node.box.offsetX}
              onValueChange={(value) => setBox({ offsetX: value }, 'x')}
            />
          )}
        </Field>
        <Field label="Y" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={node.box.offsetY}
              onValueChange={(value) => setBox({ offsetY: value }, 'y')}
            />
          )}
        </Field>
      </div>

      <Field
        label="Ancho"
        inline
        hint={
          node.box.widthPercent !== null
            ? 'En porcentaje del contenedor: se adapta al tamaño de la pantalla.'
            : node.box.width === null
              ? 'Automático: se ajusta al contenido.'
              : 'En píxeles: el mismo tamaño en cualquier pantalla.'
        }
      >
        {({ id, describedBy }) => (
          <div className="skin-props__pair">
            <Select
              size="sm"
              aria-label="Modo del ancho"
              value={node.box.widthPercent !== null ? 'percent' : node.box.width === null ? 'auto' : 'px'}
              onChange={(event) => {
                const mode = event.currentTarget.value;
                if (mode === 'auto') setBox({ width: null, widthPercent: null }, 'wmode');
                else if (mode === 'percent') setBox({ width: null, widthPercent: 0.5 }, 'wmode');
                else setBox({ width: 200, widthPercent: null }, 'wmode');
              }}
            >
              <option value="auto">Automático</option>
              <option value="px">Píxeles</option>
              <option value="percent">Porcentaje</option>
            </Select>

            {node.box.widthPercent !== null ? (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={Math.round(node.box.widthPercent * 100)}
                unit="%"
                onValueChange={(value) =>
                  setBox({ widthPercent: Math.min(1, Math.max(0, value / 100)) }, 'w')
                }
              />
            ) : node.box.width !== null ? (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={node.box.width}
                unit="px"
                onValueChange={(value) => setBox({ width: Math.max(1, value) }, 'w')}
              />
            ) : null}
          </div>
        )}
      </Field>

      <Field
        label="Alto"
        inline
        hint={
          node.box.heightPercent !== null
            ? 'En porcentaje del contenedor.'
            : node.box.height === null
              ? 'Automático: se ajusta al contenido.'
              : 'En píxeles.'
        }
      >
        {({ id, describedBy }) => (
          <div className="skin-props__pair">
            <Select
              size="sm"
              aria-label="Modo del alto"
              value={node.box.heightPercent !== null ? 'percent' : node.box.height === null ? 'auto' : 'px'}
              onChange={(event) => {
                const mode = event.currentTarget.value;
                if (mode === 'auto') setBox({ height: null, heightPercent: null }, 'hmode');
                else if (mode === 'percent') setBox({ height: null, heightPercent: 0.5 }, 'hmode');
                else setBox({ height: 120, heightPercent: null }, 'hmode');
              }}
            >
              <option value="auto">Automático</option>
              <option value="px">Píxeles</option>
              <option value="percent">Porcentaje</option>
            </Select>

            {node.box.heightPercent !== null ? (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={Math.round(node.box.heightPercent * 100)}
                unit="%"
                onValueChange={(value) =>
                  setBox({ heightPercent: Math.min(1, Math.max(0, value / 100)) }, 'h')
                }
              />
            ) : node.box.height !== null ? (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={node.box.height}
                unit="px"
                onValueChange={(value) => setBox({ height: Math.max(1, value) }, 'h')}
              />
            ) : null}
          </div>
        )}
      </Field>

      {['container', 'tabs', 'carousel'].includes(node.config.kind) && (
        <div className="skin-props__pair">
          <Field label="Relleno" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                size="sm"
                value={node.box.padding}
                unit="px"
                onValueChange={(value) => setBox({ padding: Math.max(0, value) }, 'padding')}
              />
            )}
          </Field>
          <Field label="Separación" inline>
            {({ id }) => (
              <NumberInput
                id={id}
                size="sm"
                value={node.box.gap}
                unit="px"
                onValueChange={(value) => setBox({ gap: Math.max(0, value) }, 'gap')}
              />
            )}
          </Field>
        </div>
      )}

      {/* ---------------- Estilo (F11, F12) ---------------- */}

      <SectionLabel>Estilo</SectionLabel>

      <Field label="Fondo" inline>
        {({ id }) => (
          <Select
            id={id}
            size="sm"
            value={node.style.background.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value;
              if (kind === 'none') setStyle({ background: { kind: 'none' } }, 'bg');
              else if (kind === 'token')
                setStyle({ background: { kind: 'token', surfaceToken: 'overlay' } }, 'bg');
              else setStyle({ background: { kind: 'color', color: '#101418', opacity: 1 } }, 'bg');
            }}
          >
            <option value="none">Sin fondo</option>
            <option value="token">Del sistema de diseño</option>
            <option value="color">Color propio</option>
          </Select>
        )}
      </Field>

      {node.style.background.kind === 'color' && (
        <Field label="Color" inline>
          {({ id }) => (
            <TextInput
              id={id}
              size="sm"
              mono
              value={node.style.background.kind === 'color' ? node.style.background.color : ''}
              onChange={(event) =>
                setStyle(
                  {
                    background: {
                      kind: 'color',
                      color: event.target.value,
                      opacity:
                        node.style.background.kind === 'color' ? node.style.background.opacity : 1,
                    },
                  },
                  'bgcolor',
                )
              }
            />
          )}
        </Field>
      )}

      <div className="skin-props__pair">
        <Field label="Opacidad" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={Math.round(node.style.opacity * 100)}
              unit="%"
              onValueChange={(value) =>
                setStyle({ opacity: Math.min(1, Math.max(0, value / 100)) }, 'opacity')
              }
            />
          )}
        </Field>
        <Field label="Desenfoque" inline hint="Del fondo que queda detrás.">
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={node.style.backdropBlur}
              unit="px"
              onValueChange={(value) => setStyle({ backdropBlur: Math.max(0, value) }, 'blur')}
            />
          )}
        </Field>
      </div>

      <div className="skin-props__pair">
        <Field label="Radio" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={node.style.borderRadius}
              unit="px"
              onValueChange={(value) => setStyle({ borderRadius: Math.max(0, value) }, 'radius')}
            />
          )}
        </Field>
        <Field label="Borde" inline>
          {({ id }) => (
            <NumberInput
              id={id}
              size="sm"
              value={node.style.borderWidth}
              unit="px"
              onValueChange={(value) => setStyle({ borderWidth: Math.max(0, value) }, 'border')}
            />
          )}
        </Field>
      </div>

      <Field
        label="Tipografía"
        inline
        hint={
          fonts.length === 0
            ? 'El proyecto no tiene fuentes propias; se usa la del sistema.'
            : 'Se empaqueta con el recorrido publicado.'
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={node.style.fontMediaId ?? ''}
            disabled={fonts.length === 0}
            onChange={(event) =>
              setStyle(
                {
                  fontMediaId:
                    event.currentTarget.value === ''
                      ? null
                      : (event.currentTarget.value as SkinNode['style']['fontMediaId']),
                },
                'font',
              )
            }
          >
            <option value="">Del sistema</option>
            {fonts.map((font) => (
              <option key={font.id} value={font.id}>
                {font.originalName}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* ---------------- Contenido ---------------- */}

      <SectionLabel>Contenido</SectionLabel>
      <ConfigFields node={node} images={images} project={project} setConfig={setConfig} />

      {/* ---------------- Visibilidad (F05, J05) ---------------- */}

      <SectionLabel>Visibilidad</SectionLabel>

      <Field
        label="Visible al cargar"
        inline
        hint="Las acciones «mostrar» y «ocultar» lo cambian durante el recorrido."
      >
        {({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={node.initiallyVisible}
            onChange={(event) =>
              onChange('Cambiar visibilidad inicial', (current) => ({
                ...current,
                initiallyVisible: event.currentTarget.checked,
              }))
            }
          />
        )}
      </Field>

      <p className="skin-props__hint">Dispositivos en los que aparece:</p>
      <div className="skin-props__devices">
        {(['desktop', 'tablet', 'mobile', 'vr'] as const).map((device) => (
          <Checkbox
            key={device}
            label={DEVICE_LABELS[device]}
            checked={node.visibility[device]}
            onChange={(event) =>
              onChange(`Visibilidad en ${DEVICE_LABELS[device]}`, (current) => ({
                ...current,
                visibility: { ...current.visibility, [device]: event.currentTarget.checked },
              }))
            }
          />
        ))}
      </div>

      <Field
        label="Escenas"
        inline
        hint={
          node.sceneIds.length === 0
            ? 'Aparece en todas las escenas del recorrido.'
            : `Sólo en ${node.sceneIds.length} escena(s).`
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value=""
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === '') return;
              if (value === '__all') {
                onChange('Mostrar en todas las escenas', (current) => ({ ...current, sceneIds: [] }));
                return;
              }
              onChange('Limitar a una escena', (current) => ({
                ...current,
                sceneIds: current.sceneIds.includes(value as never)
                  ? current.sceneIds.filter((id2) => id2 !== value)
                  : [...current.sceneIds, value as never],
              }));
            }}
          >
            <option value="">— añadir o quitar escena —</option>
            <option value="__all">Todas las escenas</option>
            {project.scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {node.sceneIds.includes(scene.id) ? '✓ ' : ''}
                {scene.title}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Bloqueado" inline hint="Impide moverlo o eliminarlo por accidente.">
        {({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={node.locked}
            onChange={(event) =>
              onChange('Bloquear componente', (current) => ({
                ...current,
                locked: event.currentTarget.checked,
              }))
            }
          />
        )}
      </Field>

      {skin.layoutMode === 'fixed' && (
        <Callout tone="info" title="Interfaz de tamaño fijo">
          Toda la interfaz se escala desde {skin.designWidth}×{skin.designHeight}. Los porcentajes
          se calculan sobre ese tamaño de diseño, no sobre la pantalla real.
        </Callout>
      )}
    </div>
  );
}

const DEVICE_LABELS = {
  desktop: 'Escritorio',
  tablet: 'Tableta',
  mobile: 'Móvil',
  vr: 'Visor VR',
} as const;

/* ------------------------------------------------------------------ *
 * Campos propios de cada tipo de componente
 * ------------------------------------------------------------------ */

interface ConfigFieldsProps {
  readonly node: SkinNode;
  readonly images: readonly { readonly id: string; readonly originalName: string }[];
  readonly project: Project;
  readonly setConfig: (patch: Record<string, unknown>, key: string) => void;
}

function ConfigFields({ node, images, project, setConfig }: ConfigFieldsProps): JSX.Element {
  const config = node.config;

  if (config.kind === 'text') {
    return (
      <>
        <Field
          label="Texto"
          hint="Variables entre llaves dobles. Una que el visor no conozca sale vacía, así que se avisa aquí debajo."
        >
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              rows={3}
              aria-describedby={describedBy}
              value={config.template}
              onChange={(event) => setConfig({ template: event.target.value }, 'template')}
            />
          )}
        </Field>
        {unknownVariables(config.template).length > 0 && (
          <Callout tone="warning" title="Variables que el visor no rellena">
            {unknownVariables(config.template)
              .map((name) => `{{${name}}}`)
              .join(', ')}
            . Saldrán vacías.
          </Callout>
        )}

        {/* La lista sale del dominio, que es quien las rellena: escribirla a
            mano aquí ya produjo una vez un vocabulario distinto del que el
            visor entendía, y los textos salían en blanco. */}
        <details className="skin-props__variables">
          <summary>Variables disponibles</summary>
          <dl>
            {Object.entries(INFO_VARIABLES).map(([name, description]) => (
              <div key={name}>
                <dt>
                  <code>{`{{${name}}}`}</code>
                </dt>
                <dd>{description}</dd>
              </div>
            ))}
            <div>
              <dt>
                <code>{'{{score.<clave>}}'}</code>
              </dt>
              <dd>Puntuación con la clave que use el recorrido</dd>
            </div>
          </dl>
        </details>

        <Field label="Interpretar Markdown" inline>
          {({ id }) => (
            <Switch
              id={id}
              checked={config.markdown}
              onChange={(event) => setConfig({ markdown: event.currentTarget.checked }, 'md')}
            />
          )}
        </Field>
      </>
    );
  }

  if (config.kind === 'image') {
    return (
      <>
        <Field
          label="Imagen"
          inline
          hint={images.length === 0 ? 'El proyecto no tiene imágenes en la biblioteca.' : undefined}
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              size="sm"
              aria-describedby={describedBy}
              value={config.mediaId ?? ''}
              disabled={images.length === 0}
              onChange={(event) =>
                setConfig(
                  { mediaId: event.currentTarget.value === '' ? null : event.currentTarget.value },
                  'media',
                )
              }
            >
              <option value="">— sin imagen —</option>
              {images.map((image) => (
                <option key={image.id} value={image.id}>
                  {image.originalName}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Texto alternativo"
          hint="Lo que lee un lector de pantalla. No se deduce del nombre del archivo."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              size="sm"
              aria-describedby={describedBy}
              value={config.alt}
              onChange={(event) => setConfig({ alt: event.target.value }, 'alt')}
            />
          )}
        </Field>

        {config.alt.trim().length === 0 && config.mediaId !== null && (
          <Callout tone="warning" title="Sin texto alternativo">
            Quien use un lector de pantalla no sabrá qué muestra esta imagen.
          </Callout>
        )}

        <Field label="Ajuste" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.fit}
              onChange={(event) => setConfig({ fit: event.currentTarget.value }, 'fit')}
            >
              <option value="contain">Contener</option>
              <option value="cover">Cubrir</option>
              <option value="fill">Estirar</option>
            </Select>
          )}
        </Field>
      </>
    );
  }

  if (config.kind === 'button') {
    return (
      <>
        <Field label="Etiqueta" inline>
          {({ id }) => (
            <TextInput
              id={id}
              size="sm"
              value={config.label}
              onChange={(event) => setConfig({ label: event.target.value }, 'label')}
            />
          )}
        </Field>
        <Field label="Variante" inline>
          {({ id }) => (
            <Select
              id={id}
              size="sm"
              value={config.variant}
              onChange={(event) => setConfig({ variant: event.currentTarget.value }, 'variant')}
            >
              <option value="primary">Principal</option>
              <option value="secondary">Secundaria</option>
              <option value="ghost">Discreta</option>
              <option value="danger">Destructiva</option>
            </Select>
          )}
        </Field>
        <Field label="Ayuda emergente" inline>
          {({ id }) => (
            <TextInput
              id={id}
              size="sm"
              value={config.tooltip}
              onChange={(event) => setConfig({ tooltip: event.target.value }, 'tooltip')}
            />
          )}
        </Field>
      </>
    );
  }

  if (config.kind === 'container') {
    return (
      <>
        <Field label="Dirección" inline hint="«Libre» coloca los hijos por sus coordenadas.">
          {({ id, describedBy }) => (
            <Select
              id={id}
              size="sm"
              aria-describedby={describedBy}
              value={config.direction}
              onChange={(event) => setConfig({ direction: event.currentTarget.value }, 'dir')}
            >
              <option value="row">En fila</option>
              <option value="column">En columna</option>
              <option value="free">Libre</option>
            </Select>
          )}
        </Field>
        <Field label="Desplazable" inline>
          {({ id }) => (
            <Switch
              id={id}
              checked={config.scrollable}
              onChange={(event) => setConfig({ scrollable: event.currentTarget.checked }, 'scroll')}
            />
          )}
        </Field>
      </>
    );
  }

  if (config.kind === 'webframe') {
    const placeholder = config.url.includes('example.invalid');
    return (
      <>
        <Field
          label="Dirección"
          hint="Sólo https. El recorrido publicado se sirve por https y un marco http quedaría bloqueado."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              size="sm"
              mono
              aria-describedby={describedBy}
              value={config.url}
              onChange={(event) => setConfig({ url: event.target.value }, 'url')}
            />
          )}
        </Field>
        {placeholder && (
          <Callout tone="warning" title="Sin configurar">
            Este componente sigue con la dirección de ejemplo y no mostrará nada.
          </Callout>
        )}
      </>
    );
  }

  return <ComponentPanel node={node} project={project} setConfig={setConfig} />;
}
