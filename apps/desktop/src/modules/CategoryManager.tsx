/**
 * Gestión de categorías de nota (P03).
 *
 * Las categorías son el eje por el que un responsable de planta lee cien
 * observaciones: cuántas fugas, cuántas de seguridad, cuántas de orden y
 * limpieza. Por eso se pueden crear y renombrar, y por eso **una categoría en
 * uso no se borra**: reasignar sus notas a «Otro» automáticamente sería cómodo
 * y mentiroso, porque una observación clasificada como fuga pasaría a no estar
 * clasificada sin que nadie lo decidiera.
 *
 * Renombrar el identificador arrastra las notas en la misma operación. Hacerlo
 * en dos pasos dejaría, entre uno y otro, notas apuntando a una categoría que
 * no existe, y el filtro por categoría no las encontraría.
 */
import { useState } from 'react';
import {
  canDeleteCategory,
  countByCategory,
  DEFAULT_NOTE_CATEGORIES,
  orphanCategories,
  renameCategoryId,
  validateCategory,
  type CategoryDraft,
  type NoteCategory,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconAdd,
  Select,
  TextInput,
  Tooltip,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface CategoryManagerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: ProjectStore;
}

const COLOR_LABELS: Readonly<Record<NoteCategory['colorToken'], string>> = {
  accent: 'Acento',
  nominal: 'Normal',
  warning: 'Aviso',
  alarm: 'Alarma',
  info: 'Información',
  experimental: 'Experimental',
  neutral: 'Neutro',
};

const emptyDraft = (): CategoryDraft => ({
  id: '',
  label: '',
  colorToken: 'neutral',
  description: '',
});

export function CategoryManager({ open, onClose, store }: CategoryManagerProps): JSX.Element {
  const categories = store.project.noteCategories;
  const notes = store.project.notes;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(emptyDraft);
  const [deleting, setDeleting] = useState<string | null>(null);

  const counts = countByCategory(notes, categories);
  const orphans = orphanCategories(notes, categories);

  const problems = validateCategory(draft, categories, editingId);
  const savable = problems.length === 0 && draft.id.trim().length > 0;

  const startNew = (): void => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const startEdit = (category: NoteCategory): void => {
    setEditingId(category.id);
    setDraft({
      id: category.id,
      label: category.label,
      colorToken: category.colorToken,
      description: category.description,
    });
  };

  const onSave = (): void => {
    if (!savable) return;
    const id = draft.id.trim();

    if (editingId === null) {
      store.updateProject(`Crear categoría ${draft.label}`, {
        noteCategories: [
          ...categories,
          { id, label: draft.label.trim(), colorToken: draft.colorToken, description: draft.description },
        ],
      });
      setDraft(emptyDraft());
      return;
    }

    // Renombrar el identificador y mover las notas en la misma operación: en
    // dos pasos habría un instante con notas apuntando a algo que no existe.
    const renamed = renameCategoryId(categories, notes, editingId, id);
    store.updateProject(`Editar categoría ${draft.label}`, {
      noteCategories: renamed.categories.map((category) =>
        category.id === id
          ? {
              ...category,
              label: draft.label.trim(),
              colorToken: draft.colorToken,
              description: draft.description,
            }
          : category,
      ),
      notes: [...renamed.notes],
    });
    setEditingId(id);
  };

  const onDelete = (): void => {
    if (deleting === null) return;
    const check = canDeleteCategory(deleting, notes);
    if (!check.allowed) {
      setDeleting(null);
      return;
    }
    store.updateProject('Eliminar categoría', {
      noteCategories: categories.filter((category) => category.id !== deleting),
    });
    if (editingId === deleting) startNew();
    setDeleting(null);
  };

  /** Restaura el juego de categorías que trae el producto. */
  const onRestoreDefaults = (): void => {
    const existing = new Set(categories.map((category) => category.id));
    const missing = DEFAULT_NOTE_CATEGORIES.filter((category) => !existing.has(category.id)).map(
      (category) => ({ ...category, description: '' }),
    );
    if (missing.length === 0) return;
    store.updateProject(`Restaurar ${missing.length} categoría(s) estándar`, {
      noteCategories: [...categories, ...missing],
    });
  };

  const deletionCheck = deleting === null ? null : canDeleteCategory(deleting, notes);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Categorías de nota"
        description="Clasifican las observaciones. Una categoría en uso no se puede eliminar: sus notas dejarían de aparecer en el filtro."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={onRestoreDefaults} style={{ marginRight: 'auto' }}>
              Restaurar las estándar
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <Button variant="primary" onClick={onSave} disabled={!savable}>
              {editingId === null ? 'Crear categoría' : 'Guardar categoría'}
            </Button>
          </>
        }
      >
        <div className="csv-dialog">
          {orphans.length > 0 && (
            <Callout tone="warning" title="Hay notas con categorías sin definir">
              {orphans.map((id) => `«${id}»`).join(', ')}. El filtro por categoría no las
              encuentra. Cree esas categorías con el mismo identificador, o reclasifique las notas.
            </Callout>
          )}

          {categories.length === 0 ? (
            <EmptyState
              title="El proyecto no define categorías"
              description="Use «Restaurar las estándar» para partir del juego que trae el producto."
            />
          ) : (
            <DataTable
              label="Categorías del proyecto"
              compact
              rowKey={(row) => row.id}
              rows={categories}
              selectedKey={editingId}
              onSelect={startEdit}
              columns={[
                { id: 'label', header: 'Nombre', render: (row) => row.label },
                { id: 'id', header: 'Identificador', mono: true, render: (row) => row.id },
                {
                  id: 'color',
                  header: 'Color',
                  render: (row) => <Badge tone={row.colorToken}>{COLOR_LABELS[row.colorToken]}</Badge>,
                },
                {
                  id: 'count',
                  header: 'Notas',
                  align: 'end',
                  sortable: true,
                  sortValue: (row) => counts[row.id] ?? 0,
                  render: (row) => counts[row.id] ?? 0,
                },
                {
                  id: 'actions',
                  header: '',
                  align: 'end',
                  render: (row) => {
                    const check = canDeleteCategory(row.id, notes);
                    return (
                      <Tooltip content={check.reason}>
                        <span>
                          <Button
                            size="sm"
                            variant="quiet"
                            disabled={!check.allowed}
                            aria-label={`Eliminar ${row.label}`}
                            onClick={() => setDeleting(row.id)}
                          >
                            Eliminar
                          </Button>
                        </span>
                      </Tooltip>
                    );
                  },
                },
              ]}
            />
          )}

          <section className="csv-dialog__section">
            <div className="class-editor__list-head">
              <strong>{editingId === null ? 'Nueva categoría' : `Editar «${editingId}»`}</strong>
              {editingId !== null && (
                <Button size="sm" variant="ghost" icon={<IconAdd size={13} />} onClick={startNew}>
                  Nueva
                </Button>
              )}
            </div>

            <div className="asset-editor__grid">
              <Field
                label="Nombre visible"
                required
                error={problems.find((p) => p.field === 'label')?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.currentTarget.value })}
                  />
                )}
              </Field>

              <Field
                label="Identificador"
                required
                error={problems.find((p) => p.field === 'id')?.message}
                hint={
                  editingId !== null && (counts[editingId] ?? 0) > 0
                    ? `Cambiarlo mueve también las ${counts[editingId]} nota(s) que lo usan.`
                    : 'Minúsculas, dígitos, guion y guion bajo.'
                }
              >
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    mono
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={draft.id}
                    onChange={(event) =>
                      setDraft({ ...draft, id: event.currentTarget.value.toLowerCase() })
                    }
                  />
                )}
              </Field>

              <Field label="Color" hint="Tiñe la nota en la lista y el marcador en el recorrido.">
                {({ id }) => (
                  <Select
                    id={id}
                    value={draft.colorToken}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        colorToken: event.currentTarget.value as NoteCategory['colorToken'],
                      })
                    }
                  >
                    {Object.entries(COLOR_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Descripción">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={draft.description}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.currentTarget.value })
                    }
                  />
                )}
              </Field>
            </div>
          </section>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={onDelete}
        destructive
        title="Eliminar categoría"
        confirmLabel="Eliminar"
        message={`${deletionCheck?.reason ?? ''} La operación se puede deshacer con Ctrl+Z.`}
      />
    </>
  );
}
