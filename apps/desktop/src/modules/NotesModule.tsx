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
  assignNote,
  assignableUsers,
  tasksAssignedTo,
  filterNotes,
  hiddenNoteCount,
  notesVisibleTo,
  isFieldNote,
  isOverdue,
  NOTE_PRIORITY_LABELS,
  NOTE_STATUS_LABELS,
  newUuid,
  noteStatusSchema,
  notePrioritySchema,
  sortNotes,
  type Note,
  type User,
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
  /**
   * Categorías de nota que el usuario puede ver (P04).
   *
   * `undefined` o `null` significan «sin restricción», que es el caso de un
   * puesto sin servicio de permisos configurado: el editor local no puede
   * inventarse una restricción que nadie le ha dado.
   */
  readonly allowedCategories?: readonly string[] | null;
  /**
   * Identificador del usuario del puesto (P05).
   *
   * Es el mismo que el servicio usa para los permisos y el que se guarda al
   * asignar: así «asignadas a mí» señala las mismas notas que el servicio
   * atribuye a esta persona. Sin servicio configurado el identificador es el
   * del equipo local, y el filtro sigue sirviendo para un equipo que ya se
   * conoce.
   */
  readonly currentUserId?: string | null;
  /**
   * Avisa por correo de una asignación (P07).
   *
   * Opcional porque un editor sin servicio configurado no puede avisar de
   * nada. Sin esto, asignar una nota a alguien que no abre el editor en tres
   * días no es una tarea: es un apunte.
   */
  readonly onNotifyAssignment?: (note: Note, user: User) => void;
}

/**
 * Estados que el selector del inspector ofrece.
 *
 * `resolved` y `archived` quedan fuera a propósito: cada uno tiene su botón y
 * su diálogo, porque exigen un dato que el selector no pide.
 */
const WORKING_STATUSES: readonly NoteStatus[] = ['open', 'inProgress', 'blocked'];

export function NotesModule({
  store,
  onGoToScene,
  allowedCategories,
  currentUserId,
  onNotifyAssignment,
}: NotesModuleProps): JSX.Element {
  const [filter, setFilter] = useState<NoteFilter>(EMPTY_NOTE_FILTER);
  const [sort, setSort] = useState<NoteSort>('priorityThenDue');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const { push } = useToast();
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [fieldImportOpen, setFieldImportOpen] = useState(false);

  /**
   * Notas que este usuario puede ver (P04).
   *
   * El recorte se aplica **antes** del filtro de la pantalla: si se aplicara
   * después, los contadores de los filtros incluirían notas que el usuario no
   * puede abrir, y al pulsar «Seguridad: 4» aparecerían dos.
   *
   * Esto es presentación, no seguridad: las notas están en el archivo del
   * proyecto y quien lo tiene las tiene. Lo que evita es que una pantalla
   * muestre a un contratista las notas internas de mantenimiento cuando
   * trabajan sobre el mismo proyecto.
   */
  const notes = useMemo(
    () => notesVisibleTo(store.project.notes, allowedCategories ?? null),
    [store.project.notes, allowedCategories],
  );
  const hidden = useMemo(
    () => hiddenNoteCount(store.project.notes, allowedCategories ?? null),
    [store.project.notes, allowedCategories],
  );
  const visible = useMemo(() => sortNotes(filterNotes(notes, filter, now), sort), [notes, filter, sort, now]);

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  /**
   * Personas a las que se puede asignar (P05).
   *
   * Las inactivas quedan fuera —asignar a quien ya no está produce una tarea
   * que nadie va a mirar— salvo la que ya es responsable de la nota abierta:
   * si se excluyera, abrir la nota cambiaría su responsable o lo dejaría en
   * blanco, y el histórico de la tarea no se puede perder por abrirla.
   */
  const team = useMemo(
    () => assignableUsers(store.project.users, selected),
    [store.project.users, selected],
  );

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const note of notes) byStatus[note.status] = (byStatus[note.status] ?? 0) + 1;
    return byStatus;
  }, [notes]);

  const overdue = useMemo(() => notes.filter((n) => isOverdue(n, now)).length, [notes, now]);

  /**
   * Tareas pendientes de quien está en el puesto (P05).
   *
   * Se cuentan sobre las notas visibles y no sobre el filtro de la pantalla:
   * el número tiene que seguir diciendo lo mismo cuando se filtra por otra
   * cosa, porque es lo que se mira al entrar.
   */
  const myTasks = useMemo(
    () => (currentUserId == null ? [] : tasksAssignedTo(notes, currentUserId, now)),
    [notes, currentUserId, now],
  );
  const mineOnly =
    currentUserId != null &&
    filter.assigneeIds.length === 1 &&
    filter.assigneeIds[0] === currentUserId;

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
              {myTasks.length > 0 && <> · {myTasks.length} asignada(s) a usted</>}
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
          {/* El interruptor se oculta si no hay identidad con la que comparar:
              un «asignadas a mí» que no puede saber quién es «mí» devolvería
              siempre una lista vacía y parecería que no hay tareas. */}
          {currentUserId != null && (
            <Switch
              label="Asignadas a mí"
              checked={mineOnly}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  assigneeIds: event.currentTarget.checked ? [currentUserId] : [],
                })
              }
            />
          )}
        </div>

        <div className="module__body">
          {/* El recorte se dice en lugar de callarlo: una lista recortada en
              silencio hace pensar que el proyecto está incompleto, y alguien
              acaba creando otra vez una nota que ya existía y no podía ver. */}
          {hidden > 0 && (
            <Callout tone="info" title="Hay notas que no puede ver">
              {hidden === 1
                ? 'Una nota pertenece a una categoría que no tiene concedida.'
                : `${hidden} notas pertenecen a categorías que no tiene concedidas.`}{' '}
              Si necesita verlas, pídaselo al administrador de la instalación.
            </Callout>
          )}

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

              {/* Responsable del equipo del proyecto y no texto libre (P05).
                  Con texto libre, el identificador que se guardaba era siempre
                  «local»: filtrar «asignadas a mí» no podía funcionar, y dos
                  formas de escribir el mismo nombre eran dos responsables
                  distintos al buscar e iguales al identificar. */}
              <Field
                label="Responsable"
                inline
                hint={
                  team.length === 0
                    ? 'El proyecto todavía no tiene equipo: añada personas en Ajustes para poder asignar.'
                    : undefined
                }
              >
                {({ id }) => (
                  <Select
                    id={id}
                    size="sm"
                    disabled={team.length === 0}
                    value={selected.assigneeId ?? ''}
                    onChange={(event) => {
                      const chosen = team.find((user) => user.id === event.currentTarget.value) ?? null;
                      const assigned = assignNote(selected, chosen, new Date().toISOString());
                      updateNote(
                        selected.id,
                        chosen === null ? 'Quitar responsable' : `Asignar a ${chosen.displayName}`,
                        {
                          assigneeId: assigned.assigneeId,
                          assigneeName: assigned.assigneeName,
                        },
                        `note.assignee:${selected.id}`,
                      );

                      /* Aviso por correo (P07). Se manda al asignar y no al
                         guardar el proyecto: lo que hay que avisar es la
                         asignación, y esperar al guardado la mandaría también
                         cuando el autor cambia de idea dos veces seguidas. Se
                         avisa con la nota ya asignada para que el correo no
                         describa un estado que todavía no existe. */
                      if (chosen !== null) onNotifyAssignment?.(assigned, chosen);
                    }}
                  >
                    <option value="">Sin asignar</option>
                    {team.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName}
                        {user.active ? '' : ' (inactivo)'}
                      </option>
                    ))}
                  </Select>
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
