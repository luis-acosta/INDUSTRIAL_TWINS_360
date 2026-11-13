/**
 * Notas y tareas.
 *
 * La lista es el centro del módulo porque el uso real es revisar lo
 * pendiente, no leer una nota concreta: filtrar por estado, prioridad y
 * responsable, y ver de un golpe qué está vencido. El detalle se abre a la
 * derecha sin perder la lista de vista.
 */
import { useMemo, useState } from 'react';
import {
  canTransition,
  EMPTY_NOTE_FILTER,
  filterNotes,
  isFieldNote,
  isOverdue,
  NOTE_PRIORITY_LABELS,
  NOTE_STATUS_LABELS,
  newUuid,
  noteStatusSchema,
  notePrioritySchema,
  sortNotes,
  type Note,
  type NoteFilter,
  type NoteSort,
  type NoteStatus,
  type Uuid,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  Field,
  IconAdd,
  IconNote,
  IconPanorama,
  IconSearch,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Select,
  Switch,
  TextArea,
  TextInput,
  useToast,
} from '@it360/ui';
import { CategoryManager } from './CategoryManager';
import { FieldNoteImport } from './FieldNoteImport';
import { NoteAuthoring } from './NoteAuthoring';
import type { ProjectStore } from '../state/project-store';

export interface NotesModuleProps {
  readonly store: ProjectStore;
  readonly onGoToScene: (sceneId: string) => void;
}

/**
 * Estados que el selector del inspector ofrece.
 *
 * `resolved` y `archived` quedan fuera a propósito: cada uno tiene su botón y
 * su diálogo, porque exigen un dato que el selector no pide.
 */
const WORKING_STATUSES: readonly NoteStatus[] = ['open', 'inProgress', 'blocked'];

export function NotesModule({ store, onGoToScene }: NotesModuleProps): JSX.Element {
  const [filter, setFilter] = useState<NoteFilter>(EMPTY_NOTE_FILTER);
  const [sort, setSort] = useState<NoteSort>('priorityThenDue');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const { push } = useToast();
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [fieldImportOpen, setFieldImportOpen] = useState(false);

  const notes = store.project.notes;
  const visible = useMemo(() => sortNotes(filterNotes(notes, filter, now), sort), [notes, filter, sort, now]);
  const selected = notes.find((n) => n.id === selectedId) ?? null;

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const note of notes) byStatus[note.status] = (byStatus[note.status] ?? 0) + 1;
    return byStatus;
  }, [notes]);

  const overdue = useMemo(() => notes.filter((n) => isOverdue(n, now)).length, [notes, now]);

  const writeNotes = (label: string, next: readonly Note[]): void => {
    store.updateProject(label, { notes: [...next] });
  };

  const updateNote = (id: string, label: string, patch: Partial<Note>, coalesceKey?: string): void => {
    store.updateProject(
      label,
      {
        notes: notes.map((n) =>
          n.id === id ? { ...n, ...patch, updatedAt: new Date().toISOString() } : n,
        ),
      },
      coalesceKey,
    );
  };

  const addNote = (): void => {
    const nowIso = new Date().toISOString();
    const created: Note = {
      id: newUuid(),
      projectId: store.project.id,
      title: 'Nueva observación',
      body: '',
      anchor: null,
      sceneId: null,
      assetId: null,
      categoryId: 'other',
      priority: 'normal',
      status: 'open',
      assigneeId: null,
      assigneeName: null,
      dueDate: null,
      attachments: [],
      comments: [],
      authorId: 'local',
      authorName: 'Usuario local',
      createdAt: nowIso,
      updatedAt: nowIso,
      resolvedAt: null,
      resolvedById: null,
      resolution: '',
    };
    writeNotes('Añadir nota', [...notes, created]);
    setSelectedId(created.id);
  };

  /**
   * Cambio de estado con la máquina de estados del dominio.
   *
   * El selector sólo ofrece destinos válidos, pero la comprobación se repite
   * aquí porque la regla vive en el dominio y no en el componente: mañana
   * puede haber otra interfaz y la transición debe seguir siendo la misma.
   */
  const changeStatus = (note: Note, next: NoteStatus): void => {
    if (!canTransition(note.status, next)) {
      push({
        tone: 'warning',
        title: 'Transición no permitida',
        description: `Una nota «${NOTE_STATUS_LABELS[note.status]}» no puede pasar a «${NOTE_STATUS_LABELS[next]}».`,
      });
      return;
    }
    if (next === 'resolved' && note.resolution.trim().length === 0) {
      push({
        tone: 'warning',
        title: 'Falta el resumen de resolución',
        description: 'Escriba cómo se resolvió antes de cerrar la nota: en seis meses nadie recordará por qué se cerró.',
      });
      return;
    }
    updateNote(note.id, `Cambiar estado a ${NOTE_STATUS_LABELS[next]}`, {
      status: next,
      resolvedAt: next === 'resolved' ? new Date().toISOString() : null,
      resolvedById: next === 'resolved' ? 'local' : null,
    });
  };

  return (
    <div className="module module--split module--split-wide">
      <div className="module__content">
        <header className="module__head">
          <div>
            <h1 className="module__title">Notas y tareas</h1>
            <p className="module__subtitle">
              {notes.length} registro(s) · {counts['open'] ?? 0} abiertas · {counts['inProgress'] ?? 0} en curso
              {overdue > 0 && <> · {overdue} vencida(s)</>}
            </p>
          </div>
          <div className="module__head-actions">
            <Button size="sm" variant="secondary" onClick={() => setFieldImportOpen(true)}>
              Importar de campo
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCategoriesOpen(true)}>
              Categorías
            </Button>
            <Button size="sm" variant="primary" icon={<IconAdd size={14} />} onClick={addNote}>
              Nueva nota
            </Button>
          </div>
        </header>

        <div className="module__filters">
          <TextInput
            size="sm"
            placeholder="Buscar en asunto y cuerpo"
            prefix={<IconSearch size={13} />}
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.currentTarget.value })}
            aria-label="Buscar notas"
          />
          <Select
            size="sm"
            value={filter.statuses.length === 1 ? filter.statuses[0] : 'all'}
            onChange={(event) =>
              setFilter({
                ...filter,
                statuses:
                  event.currentTarget.value === 'all'
                    ? []
                    : [noteStatusSchema.parse(event.currentTarget.value)],
              })
            }
            aria-label="Filtrar por estado"
          >
            <option value="all">Todos los estados</option>
            {Object.entries(NOTE_STATUS_LABELS).map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            value={filter.priorities.length === 1 ? filter.priorities[0] : 'all'}
            onChange={(event) =>
              setFilter({
                ...filter,
                priorities:
                  event.currentTarget.value === 'all'
                    ? []
                    : [notePrioritySchema.parse(event.currentTarget.value)],
              })
            }
            aria-label="Filtrar por prioridad"
          >
            <option value="all">Todas las prioridades</option>
            {Object.entries(NOTE_PRIORITY_LABELS).map(([priority, label]) => (
              <option key={priority} value={priority}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as NoteSort)}
            aria-label="Ordenar"
          >
            <option value="priorityThenDue">Prioridad y fecha</option>
            <option value="dueDate">Fecha comprometida</option>
            <option value="newest">Más recientes</option>
            <option value="oldest">Más antiguas</option>
            <option value="status">Estado</option>
            <option value="title">Asunto</option>
          </Select>
          <Switch
            label="Sólo vencidas"
            checked={filter.onlyOverdue}
            onChange={(event) => setFilter({ ...filter, onlyOverdue: event.currentTarget.checked })}
          />
        </div>

        <div className="module__body">
          <DataTable
            label="Notas del proyecto"
            rows={visible}
            rowKey={(row) => row.id}
            selectedKey={selectedId}
            onSelect={(row) => setSelectedId(row.id)}
            rowTone={(row) => (isOverdue(row, now) ? 'alarm' : row.priority === 'urgent' ? 'warning' : undefined)}
            emptyMessage="Ninguna nota coincide con el filtro"
            columns={[
              {
                id: 'priority',
                header: 'Prio.',
                width: '96px',
                sortable: true,
                render: (row) => (
                  <Badge
                    tone={
                      row.priority === 'urgent'
                        ? 'alarm'
                        : row.priority === 'high'
                          ? 'warning'
                          : row.priority === 'low'
                            ? 'neutral'
                            : 'info'
                    }
                  >
                    {NOTE_PRIORITY_LABELS[row.priority]}
                  </Badge>
                ),
              },
              {
                id: 'title',
                header: 'Asunto',
                sortable: true,
                sortValue: (row) => row.title,
                // Se distingue de un vistazo la observación que llegó del
                // recorrido publicado: su autor está declarado, no verificado,
                // y eso cambia cuánto se puede apoyar uno en ella.
                render: (row) => (
                  <span className="notes__title">
                    {row.title}
                    {isFieldNote(row) && <Badge tone="info">de campo</Badge>}
                  </span>
                ),
              },
              {
                id: 'asset',
                header: 'Activo',
                width: '140px',
                mono: true,
                render: (row) =>
                  row.assetId === null
                    ? '—'
                    : (store.project.assets.find((a) => a.id === row.assetId)?.tag ?? 'activo inexistente'),
              },
              {
                id: 'assignee',
                header: 'Responsable',
                width: '160px',
                render: (row) => row.assigneeName ?? 'sin asignar',
              },
              {
                id: 'status',
                header: 'Estado',
                width: '130px',
                sortable: true,
                render: (row) => (
                  <Badge
                    tone={
                      row.status === 'resolved'
                        ? 'nominal'
                        : row.status === 'blocked'
                          ? 'alarm'
                          : row.status === 'archived'
                            ? 'neutral'
                            : 'warning'
                    }
                  >
                    {NOTE_STATUS_LABELS[row.status]}
                  </Badge>
                ),
              },
              {
                id: 'due',
                header: 'Vence',
                width: '120px',
                mono: true,
                sortable: true,
                sortValue: (row) => row.dueDate ?? '9999',
                render: (row) =>
                  row.dueDate === null ? (
                    '—'
                  ) : isOverdue(row, now) ? (
                    <span style={{ color: 'var(--it-color-status-alarm)' }}>{row.dueDate.slice(0, 10)}</span>
                  ) : (
                    row.dueDate.slice(0, 10)
                  ),
              },
            ]}
          />
        </div>
      </div>

      <aside className="app__inspector">
        {selected === null ? (
          <div className="inspector__body">
            <EmptyState
              icon={<IconNote size={28} />}
              title="Sin nota seleccionada"
              description="Elija una nota de la lista para ver y editar su contenido."
            />
          </div>
        ) : (
          <>
            <div className="inspector__head">
              <div style={{ minWidth: 0 }}>
                <h2 className="inspector__title">{selected.title}</h2>
                <p className="inspector__subtitle">
                  {selected.authorName} · {selected.createdAt.slice(0, 10)}
                </p>
              </div>
              {isOverdue(selected, now) && (
                <Badge tone="alarm" dot>
                  Vencida
                </Badge>
              )}
            </div>

            <div className="inspector__body inspector__group">
              <Field label="Asunto">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={selected.title}
                    onChange={(event) =>
                      updateNote(selected.id, 'Editar asunto', { title: event.currentTarget.value }, `note.title:${selected.id}`)
                    }
                  />
                )}
              </Field>

              <Field label="Descripción">
                {({ id }) => (
                  <TextArea
                    id={id}
                    rows={5}
                    value={selected.body}
                    onChange={(event) =>
                      updateNote(selected.id, 'Editar descripción', { body: event.currentTarget.value }, `note.body:${selected.id}`)
                    }
                  />
                )}
              </Field>

              {/*
                El selector sólo ofrece los estados de trabajo. «Resuelta» y
                «Archivada» viven en sus propios botones, más abajo, porque
                ambas piden algo que un selector no puede recoger: el resumen
                de cómo se resolvió y el motivo del archivo. Ofrecerlas aquí
                daba un camino que siempre terminaba en un aviso de error.
              */}
              <Field
                label="Estado"
                inline
                hint="Resolver y archivar están en «Cierre», más abajo."
              >
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    size="sm"
                    aria-describedby={describedBy}
                    value={selected.status}
                    onChange={(event) => changeStatus(selected, event.currentTarget.value as NoteStatus)}
                  >
                    <option value={selected.status}>{NOTE_STATUS_LABELS[selected.status]}</option>
                    {WORKING_STATUSES.filter(
                      (status) =>
                        status !== selected.status && canTransition(selected.status, status),
                    ).map((status) => (
                      <option key={status} value={status}>
                        {NOTE_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Prioridad" inline>
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={selected.priority}
                    onChange={(event) =>
                      updateNote(selected.id, 'Cambiar prioridad', {
                        priority: notePrioritySchema.parse(event.currentTarget.value),
                      })
                    }
                  >
                    {Object.entries(NOTE_PRIORITY_LABELS).map(([priority, label]) => (
                      <option key={priority} value={priority}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Responsable" inline>
                {({ id }) => (
                  <TextInput
                    id={id}
                    size="sm"
                    value={selected.assigneeName ?? ''}
                    placeholder="sin asignar"
                    onChange={(event) =>
                      updateNote(
                        selected.id,
                        'Asignar responsable',
                        {
                          assigneeName: event.currentTarget.value.length === 0 ? null : event.currentTarget.value,
                          assigneeId: event.currentTarget.value.length === 0 ? null : 'local',
                        },
                        `note.assignee:${selected.id}`,
                      )
                    }
                  />
                )}
              </Field>

              <Field label="Fecha comprometida" inline>
                {({ id }) => (
                  <TextInput
                    id={id}
                    size="sm"
                    type="date"
                    value={selected.dueDate?.slice(0, 10) ?? ''}
                    onChange={(event) =>
                      updateNote(selected.id, 'Cambiar fecha comprometida', {
                        dueDate:
                          event.currentTarget.value.length === 0
                            ? null
                            : new Date(`${event.currentTarget.value}T12:00:00Z`).toISOString(),
                      })
                    }
                  />
                )}
              </Field>

              <Field label="Activo" inline>
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    value={selected.assetId ?? ''}
                    onChange={(event) =>
                      updateNote(selected.id, 'Vincular activo', {
                        assetId: event.currentTarget.value.length === 0 ? null : (event.currentTarget.value as Uuid),
                      })
                    }
                  >
                    <option value="">sin vincular</option>
                    {store.project.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.tag} — {asset.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              {selected.resolution.length > 0 && (
                <>
                  <SectionLabel>Resolución</SectionLabel>
                  <Callout tone="nominal" title="Cómo se resolvió">
                    {selected.resolution}
                  </Callout>
                </>
              )}

              {selected.sceneId !== null && (
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth
                  icon={<IconPanorama size={14} />}
                  onClick={() => {
                    if (selected.sceneId !== null) onGoToScene(selected.sceneId);
                  }}
                >
                  Ver el punto del recorrido
                </Button>
              )}

              <NoteAuthoring
                store={store}
                note={selected}
                onWrite={(label, next) =>
                  writeNotes(label, notes.map((n) => (n.id === next.id ? next : n)))
                }
              />

              <SectionLabel>Trazabilidad</SectionLabel>
              <PropertyList>
                <PropertyRow label="Creada" mono value={selected.createdAt.slice(0, 16).replace('T', ' ')} />
                <PropertyRow label="Modificada" mono value={selected.updatedAt.slice(0, 16).replace('T', ' ')} />
                {selected.resolvedAt !== null && (
                  <PropertyRow label="Resuelta" mono value={selected.resolvedAt.slice(0, 16).replace('T', ' ')} />
                )}
              </PropertyList>
            </div>
          </>
        )}
      </aside>

      <CategoryManager
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        store={store}
      />

      <FieldNoteImport
        open={fieldImportOpen}
        onClose={() => setFieldImportOpen(false)}
        store={store}
      />
    </div>
  );
}
