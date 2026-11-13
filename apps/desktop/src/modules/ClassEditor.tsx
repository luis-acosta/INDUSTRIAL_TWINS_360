/**
 * Editor de clases de activo (X03).
 *
 * Una clase define la ficha técnica de todos los activos que la usan, así que
 * editarla tiene consecuencias que el autor no ve desde el formulario: quitar
 * un atributo deja de mostrar datos que siguen guardados, y marcar uno como
 * obligatorio deja incompletos activos que ayer estaban bien.
 *
 * El criterio aquí es que esas consecuencias se cuenten **con el número exacto
 * de activos afectados y antes de guardar**, y que aun así se pueda guardar: un
 * atributo mal puesto hay que poder quitarlo, y bloquearlo convertiría un error
 * del autor en algo permanente. Lo que sí se bloquea es lo que deja el proyecto
 * incoherente: claves duplicadas, ciclos de herencia, una magnitud sin unidad.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  affectedAssets,
  canDeleteClass,
  canSaveClass,
  classDraftFrom,
  classDraftToClass,
  eligibleParentClasses,
  emptyClassDraft,
  HIERARCHY_LABELS,
  HIERARCHY_LEVELS,
  inheritedAttributes,
  newAttribute,
  newUuid,
  validateClassDraft,
  type AssetClass,
  type AttributeDefinition,
  type AttributeType,
  type ClassDraft,
  type HierarchyLevel,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconAdd,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Select,
  TextArea,
  TextInput,
  Tooltip,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface ClassEditorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: ProjectStore;
}

const TYPE_LABELS: Readonly<Record<AttributeType, string>> = {
  text: 'Texto',
  longText: 'Texto largo',
  number: 'Número',
  quantity: 'Magnitud con unidad',
  boolean: 'Sí / no',
  date: 'Fecha',
  enum: 'Lista de valores',
  tagRef: 'Referencia a un TAG',
  url: 'Enlace',
};

export function ClassEditor({ open, onClose, store }: ClassEditorProps): JSX.Element {
  const project = store.project;
  const classes = project.assetClasses;

  const [selectedId, setSelectedId] = useState<Uuid | null>(classes[0]?.id ?? null);
  const [draft, setDraft] = useState<ClassDraft>(() =>
    classes[0] !== undefined ? classDraftFrom(classes[0]) : emptyClassDraft(),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = useMemo(
    () => classes.find((c) => c.id === selectedId) ?? null,
    [classes, selectedId],
  );

  // Cambiar de clase recarga el borrador. Conservar el anterior haría que el
  // autor editase una clase creyendo que edita otra, y eso en una clase
  // significa estropear la ficha de todos sus activos.
  useEffect(() => {
    setDraft(selected !== null ? classDraftFrom(selected) : emptyClassDraft());
  }, [selected]);

  const problems = useMemo(
    () =>
      validateClassDraft(draft, {
        classes,
        assets: project.assets,
        previous: selected,
      }),
    [draft, classes, project.assets, selected],
  );

  const savable = canSaveClass(problems);
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const advisories = problems.filter((p) => p.severity === 'advisory');

  const heredados = useMemo(() => inheritedAttributes(draft, classes), [draft, classes]);
  const parents = useMemo(() => eligibleParentClasses(draft, classes), [draft, classes]);

  const afectados = useMemo(
    () => (draft.id === null ? [] : affectedAssets(draft.id, classes, project.assets)),
    [draft.id, classes, project.assets],
  );

  const deletion = useMemo(
    () =>
      selected === null
        ? { allowed: false, reason: 'Primero guarde la clase.' }
        : canDeleteClass(selected.id, classes, project.assets),
    [selected, classes, project.assets],
  );

  const set = <K extends keyof ClassDraft>(key: K, value: ClassDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const patchAttribute = (index: number, patch: Partial<AttributeDefinition>): void =>
    setDraft((current) => ({
      ...current,
      attributes: current.attributes.map((definition, i) =>
        i === index ? { ...definition, ...patch } : definition,
      ),
    }));

  const removeAttribute = (index: number): void =>
    setDraft((current) => ({
      ...current,
      attributes: current.attributes.filter((_, i) => i !== index),
    }));

  const moveAttribute = (index: number, delta: number): void =>
    setDraft((current) => {
      const next = [...current.attributes];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      const moved = next[index];
      const other = next[target];
      if (moved === undefined || other === undefined) return current;
      next[index] = other;
      next[target] = moved;
      return { ...current, attributes: next };
    });

  const onNew = (): void => {
    setSelectedId(null);
    setDraft(emptyClassDraft());
  };

  const onSave = (): void => {
    if (!savable) return;
    const result = classDraftToClass(draft, newUuid());
    const assetClasses =
      selected === null
        ? [...classes, result]
        : classes.map((c) => (c.id === result.id ? result : c));

    store.updateProject(
      selected === null ? `Crear clase ${result.code}` : `Editar clase ${result.code}`,
      { assetClasses },
    );
    setSelectedId(result.id);
  };

  const onDelete = (): void => {
    if (selected === null || !deletion.allowed) return;
    store.updateProject(`Eliminar clase ${selected.code}`, {
      assetClasses: classes.filter((c) => c.id !== selected.id),
    });
    setConfirmDelete(false);
    setSelectedId(classes.find((c) => c.id !== selected.id)?.id ?? null);
  };

  const fieldError = (field: string): string | undefined =>
    problems.find((p) => p.field === field && p.severity === 'blocking')?.message;

  const fieldHint = (field: string, fallback?: string): string | undefined =>
    problems.find((p) => p.field === field && p.severity === 'advisory')?.message ?? fallback;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Clases de activo"
        description="Una clase define la ficha técnica de todos sus activos. Los atributos se heredan de la clase padre."
        size="xl"
        footer={
          <>
            {selected !== null && (
              <Tooltip content={deletion.reason}>
                <span style={{ marginRight: 'auto' }}>
                  <Button
                    variant="danger"
                    disabled={!deletion.allowed}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Eliminar clase
                  </Button>
                </span>
              </Tooltip>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <Button variant="primary" onClick={onSave} disabled={!savable}>
              {selected === null ? 'Crear clase' : 'Guardar clase'}
            </Button>
          </>
        }
      >
        <div className="class-editor">
          <aside className="class-editor__list">
            <div className="class-editor__list-head">
              <SectionLabel>Clases</SectionLabel>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Nueva clase"
                icon={<IconAdd size={13} />}
                onClick={onNew}
              />
            </div>

            <ul className="class-editor__items">
              {classes.map((assetClass) => (
                <li key={assetClass.id}>
                  <button
                    type="button"
                    className="class-editor__item"
                    aria-current={assetClass.id === selectedId}
                    onClick={() => setSelectedId(assetClass.id)}
                  >
                    <span className="class-editor__item-name">{assetClass.name}</span>
                    <span className="class-editor__item-code">{assetClass.code}</span>
                  </button>
                </li>
              ))}
              {selectedId === null && (
                <li>
                  <button type="button" className="class-editor__item" aria-current>
                    <span className="class-editor__item-name">Clase nueva</span>
                    <span className="class-editor__item-code">sin guardar</span>
                  </button>
                </li>
              )}
            </ul>
          </aside>

          <div className="class-editor__form">
            {!savable && (
              <Callout tone="warning" title="Falta algo para poder guardar">
                <ul className="asset-editor__problems">
                  {blocking.map((problem) => (
                    <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
                  ))}
                </ul>
              </Callout>
            )}

            {advisories.length > 0 && (
              <Callout tone="warning" title="Esto afecta a activos que ya existen">
                <ul className="asset-editor__problems">
                  {advisories.map((problem) => (
                    <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
                  ))}
                </ul>
              </Callout>
            )}

            <div className="asset-editor__grid">
              <Field
                label="Código"
                required
                error={fieldError('code')}
                hint="Mayúsculas, dígitos y guion bajo: PUMP_CENTRIFUGAL."
              >
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    mono
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={draft.code}
                    onChange={(event) => set('code', event.currentTarget.value.toUpperCase())}
                  />
                )}
              </Field>

              <Field label="Nombre" required error={fieldError('name')}>
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={draft.name}
                    onChange={(event) => set('name', event.currentTarget.value)}
                  />
                )}
              </Field>

              <Field
                label="Nivel habitual"
                hint={fieldHint('level', 'Sólo produce un aviso si un activo usa otro nivel.')}
              >
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    value={draft.level}
                    onChange={(event) =>
                      set('level', event.currentTarget.value as HierarchyLevel)
                    }
                  >
                    {HIERARCHY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {HIERARCHY_LABELS[level]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field
                label="Hereda de"
                error={fieldError('parentClassId')}
                hint="Los atributos de la clase padre se añaden a los de esta."
              >
                {({ id, describedBy, invalid }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={draft.parentClassId ?? ''}
                    onChange={(event) =>
                      set(
                        'parentClassId',
                        event.currentTarget.value === ''
                          ? null
                          : (event.currentTarget.value as Uuid),
                      )
                    }
                  >
                    <option value="">— no hereda —</option>
                    {parents
                      .filter((candidate) => candidate.id !== draft.id)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name} ({candidate.code})
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>

            <Field label="Descripción">
              {({ id }) => (
                <TextArea
                  id={id}
                  rows={2}
                  value={draft.description}
                  onChange={(event) => set('description', event.currentTarget.value)}
                />
              )}
            </Field>

            {draft.id !== null && (
              <PropertyList>
                <PropertyRow
                  label="Activos que la usan"
                  value={`${afectados.length} (contando las clases que heredan de ella)`}
                />
              </PropertyList>
            )}

            {heredados.length > 0 && (
              <section className="class-editor__inherited">
                <SectionLabel>Atributos heredados</SectionLabel>
                <ul className="class-editor__inherited-list">
                  {heredados.map((entry) => (
                    <li key={entry.definition.key}>
                      <span className="class-editor__mono">{entry.definition.key}</span>{' '}
                      {entry.definition.label}
                      {entry.definition.unit !== null && ` (${entry.definition.unit})`}
                      <Badge tone="neutral">de {entry.fromCode}</Badge>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="class-editor__attributes">
              <div className="class-editor__list-head">
                <SectionLabel>Atributos propios</SectionLabel>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconAdd size={13} />}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      attributes: [...current.attributes, newAttribute(current.attributes.length)],
                    }))
                  }
                >
                  Añadir atributo
                </Button>
              </div>

              {draft.attributes.length === 0 ? (
                <EmptyState
                  title="Sin atributos propios"
                  description="La ficha de sus activos mostrará sólo los atributos heredados, si los hay."
                />
              ) : (
                <ol className="class-editor__attr-list">
                  {draft.attributes.map((definition, index) => (
                    <li key={index} className="class-editor__attr">
                      <div className="asset-editor__grid">
                        <Field
                          label="Clave"
                          required
                          error={fieldError(`attributes.${index}.key`)}
                          hint={fieldHint(
                            `attributes.${index}.key`,
                            'Identifica el dato guardado; cambiarla deja de mostrar lo ya escrito.',
                          )}
                        >
                          {({ id, describedBy, invalid }) => (
                            <TextInput
                              id={id}
                              mono
                              aria-describedby={describedBy}
                              aria-invalid={invalid}
                              value={definition.key}
                              onChange={(event) =>
                                patchAttribute(index, {
                                  key: event.currentTarget.value.toLowerCase(),
                                })
                              }
                            />
                          )}
                        </Field>

                        <Field
                          label="Etiqueta"
                          required
                          error={fieldError(`attributes.${index}.label`)}
                        >
                          {({ id, describedBy, invalid }) => (
                            <TextInput
                              id={id}
                              aria-describedby={describedBy}
                              aria-invalid={invalid}
                              value={definition.label}
                              onChange={(event) =>
                                patchAttribute(index, { label: event.currentTarget.value })
                              }
                            />
                          )}
                        </Field>

                        <Field label="Tipo">
                          {({ id }) => (
                            <Select
                              id={id}
                              value={definition.type}
                              onChange={(event) =>
                                patchAttribute(index, {
                                  type: event.currentTarget.value as AttributeType,
                                })
                              }
                            >
                              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>

                        {definition.type === 'quantity' && (
                          <Field
                            label="Unidad"
                            required
                            error={fieldError(`attributes.${index}.unit`)}
                            hint="bar, °C, m³/h. No se infiere."
                          >
                            {({ id, describedBy, invalid }) => (
                              <TextInput
                                id={id}
                                aria-describedby={describedBy}
                                aria-invalid={invalid}
                                value={definition.unit ?? ''}
                                onChange={(event) =>
                                  patchAttribute(index, { unit: event.currentTarget.value })
                                }
                              />
                            )}
                          </Field>
                        )}

                        {definition.type === 'enum' && (
                          <Field
                            label="Valores admitidos"
                            required
                            error={fieldError(`attributes.${index}.options`)}
                            hint="Separados por coma."
                          >
                            {({ id, describedBy, invalid }) => (
                              <TextInput
                                id={id}
                                aria-describedby={describedBy}
                                aria-invalid={invalid}
                                value={definition.options.join(', ')}
                                onChange={(event) =>
                                  patchAttribute(index, {
                                    options: event.currentTarget.value
                                      .split(',')
                                      .map((option) => option.trim())
                                      .filter((option) => option.length > 0),
                                  })
                                }
                              />
                            )}
                          </Field>
                        )}

                        <Field label="Grupo" hint="Agrupa el atributo en la ficha.">
                          {({ id }) => (
                            <TextInput
                              id={id}
                              value={definition.group}
                              onChange={(event) =>
                                patchAttribute(index, { group: event.currentTarget.value })
                              }
                            />
                          )}
                        </Field>
                      </div>

                      <div className="class-editor__attr-actions">
                        <Checkbox
                          label="Obligatorio"
                          checked={definition.required}
                          onChange={(event) =>
                            patchAttribute(index, { required: event.currentTarget.checked })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === 0}
                          onClick={() => moveAttribute(index, -1)}
                          aria-label={`Subir ${definition.label || definition.key || 'atributo'}`}
                        >
                          Subir
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === draft.attributes.length - 1}
                          onClick={() => moveAttribute(index, 1)}
                          aria-label={`Bajar ${definition.label || definition.key || 'atributo'}`}
                        >
                          Bajar
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => removeAttribute(index)}
                          aria-label={`Quitar ${definition.label || definition.key || 'atributo'}`}
                        >
                          Quitar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        destructive
        title={selected === null ? 'Eliminar clase' : `Eliminar ${selected.code}`}
        confirmLabel="Eliminar"
        message={`${deletion.reason} La operación se puede deshacer con Ctrl+Z.`}
      />
    </>
  );
}

/** Sólo para pruebas y reutilización: etiquetas de los tipos de atributo. */
export const ATTRIBUTE_TYPE_LABELS: Readonly<Record<AttributeType, string>> = TYPE_LABELS;

export type { AssetClass };
