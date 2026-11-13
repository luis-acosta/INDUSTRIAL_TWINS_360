/**
 * Organizador de etiquetas del proyecto (Y08).
 *
 * Asignar etiquetas es la mitad fácil; la otra es arreglarlas cuando ya hay
 * cuarenta escenas etiquetadas de seis maneras. Aquí se ve cuánto se usa cada
 * una y se puede renombrar, fundir o quitar en todo el proyecto de una vez.
 *
 * Dos avisos que no son adorno:
 *
 *  - **Renombrar a una etiqueta que ya existe es fundir**, y se dice antes de
 *    hacerlo con las dos cifras de uso. El autor casi siempre quiere eso
 *    —acaba de descubrir que tenía «critico» y «crítico»—, pero debe saber que
 *    la otra deja de existir.
 *  - **Quitar una etiqueta no se puede deshacer desde aquí**, sólo con el
 *    historial. Se dice cuántos elementos la pierden, porque «quitar» una
 *    etiqueta usada en treinta sitios no es lo mismo que en uno.
 */
import { useMemo, useState } from 'react';
import {
  deleteTagFromProject,
  mergeTagsInProject,
  normalizeTagLabel,
  renameTagInProject,
  tagUsage,
  type Project,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconMerge,
  IconTag,
  IconTrash,
  TextInput,
} from '@it360/ui';

export interface TagManagerProps {
  readonly open: boolean;
  readonly project: Project;
  readonly onClose: () => void;
  readonly onApply: (project: Project, label: string) => void;
}

type Pending =
  | { readonly kind: 'rename'; readonly tag: string; readonly to: string }
  | { readonly kind: 'delete'; readonly tag: string }
  | { readonly kind: 'merge'; readonly tags: readonly string[]; readonly to: string };

export function TagManager({ open, project, onClose, onApply }: TagManagerProps): JSX.Element {
  const usage = useMemo(() => tagUsage(project), [project]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [mergeTarget, setMergeTarget] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);

  const countOf = (tag: string): number => usage.find((u) => u.tag === tag)?.total ?? 0;

  const startRename = (tag: string): void => {
    setEditing(tag);
    setDraft(tag);
  };

  /**
   * Confirma el renombrado.
   *
   * La guarda sobre `pending` no es por costumbre: al abrirse el diálogo de
   * confirmación el foco sale del campo, y su `onBlur` volvería a llamar aquí
   * con el mismo valor. Con la guarda manda la confirmación ya visible.
   */
  const confirmRename = (tag: string): void => {
    if (pending !== null) return;

    const to = normalizeTagLabel(draft);
    if (to === '' || to === tag) {
      setEditing(null);
      return;
    }
    setPending({ kind: 'rename', tag, to });
  };

  const apply = (): void => {
    if (pending === null) return;

    if (pending.kind === 'rename') {
      onApply(
        renameTagInProject(project, pending.tag, pending.to),
        `Renombrar la etiqueta ${pending.tag}`,
      );
      setEditing(null);
    } else if (pending.kind === 'delete') {
      onApply(deleteTagFromProject(project, pending.tag), `Quitar la etiqueta ${pending.tag}`);
    } else {
      onApply(
        mergeTagsInProject(project, pending.tags, pending.to),
        `Fundir ${pending.tags.length} etiquetas en ${pending.to}`,
      );
      setSelected([]);
      setMergeTarget('');
    }

    setPending(null);
  };

  const toggle = (tag: string): void => {
    setSelected((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Organizar etiquetas"
        description="Renombrar, fundir o quitar etiquetas en todo el proyecto."
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            Cerrar
          </Button>
        }
      >
        {usage.length === 0 ? (
          <EmptyState
            icon={<IconTag size={28} />}
            title="Ninguna etiqueta todavía"
            description="Las etiquetas se asignan desde la escena o el marcador, y sirven para buscar escribiendo # en el buscador."
          />
        ) : (
          <>
            {selected.length > 1 && (
              <Callout tone="info" title={`${selected.length} etiquetas seleccionadas`}>
                <div className="tag-manager__merge">
                  <Field label="Fundir en">
                    {({ id }) => (
                      <TextInput
                        id={id}
                        size="sm"
                        value={mergeTarget}
                        placeholder={selected[0]}
                        onChange={(event) => setMergeTarget(event.currentTarget.value)}
                      />
                    )}
                  </Field>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconMerge size={13} />}
                    disabled={normalizeTagLabel(mergeTarget || (selected[0] ?? '')) === ''}
                    onClick={() =>
                      setPending({
                        kind: 'merge',
                        tags: selected,
                        to: normalizeTagLabel(mergeTarget || (selected[0] ?? '')),
                      })
                    }
                  >
                    Fundir
                  </Button>
                </div>
              </Callout>
            )}

            <ul className="tag-manager__list" aria-label="Etiquetas del proyecto">
              {usage.map((entry) => (
                <li key={entry.tag} className="tag-manager__row">
                  <label className="tag-manager__pick">
                    <input
                      type="checkbox"
                      checked={selected.includes(entry.tag)}
                      aria-label={`Seleccionar la etiqueta ${entry.tag}`}
                      onChange={() => toggle(entry.tag)}
                    />
                  </label>

                  {editing === entry.tag ? (
                    <TextInput
                      size="sm"
                      autoFocus
                      value={draft}
                      aria-label={`Nuevo nombre para ${entry.tag}`}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          /*
                           * La pulsación se detiene aquí. Si sigue subiendo,
                           * llega al diálogo de confirmación que este mismo
                           * Intro acaba de abrir y lo cierra: el autor ve el
                           * diálogo parpadear y concluye que no pasó nada.
                           */
                          event.preventDefault();
                          event.stopPropagation();
                          confirmRename(entry.tag);
                        }
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setEditing(null);
                        }
                      }}
                      onBlur={() => confirmRename(entry.tag)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="tag-manager__name"
                      onClick={() => startRename(entry.tag)}
                    >
                      {entry.tag}
                    </button>
                  )}

                  <span className="tag-manager__count">
                    {entry.scenes > 0 && (
                      <Badge tone="neutral" mono>
                        {entry.scenes} escena(s)
                      </Badge>
                    )}
                    {entry.hotspots > 0 && (
                      <Badge tone="neutral" mono>
                        {entry.hotspots} marcador(es)
                      </Badge>
                    )}
                  </span>

                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Quitar la etiqueta ${entry.tag} de todo el proyecto`}
                    onClick={() => setPending({ kind: 'delete', tag: entry.tag })}
                    icon={<IconTrash size={13} />}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Dialog>

      <ConfirmDialog
        open={pending !== null}
        onCancel={() => setPending(null)}
        onConfirm={apply}
        destructive={pending?.kind === 'delete'}
        title={
          pending?.kind === 'delete'
            ? 'Quitar la etiqueta'
            : pending?.kind === 'merge'
              ? 'Fundir etiquetas'
              : 'Renombrar la etiqueta'
        }
        confirmLabel={
          pending?.kind === 'delete' ? 'Quitar' : pending?.kind === 'merge' ? 'Fundir' : 'Renombrar'
        }
        message={describe(pending, countOf)}
      />
    </>
  );
}

/**
 * Lo que se le dice al autor antes de aplicar.
 *
 * Con las cifras de uso: «quitar» una etiqueta usada en treinta sitios no es
 * lo mismo que en uno, y renombrar sobre una existente es fundir.
 */
function describe(pending: Pending | null, countOf: (tag: string) => number): string {
  if (pending === null) return '';

  if (pending.kind === 'delete') {
    return (
      `La etiqueta «${pending.tag}» desaparecerá de ${countOf(pending.tag)} elemento(s) del ` +
      'proyecto. Se puede deshacer con Ctrl+Z.'
    );
  }

  if (pending.kind === 'merge') {
    const total = pending.tags.reduce((sum, tag) => sum + countOf(tag), 0);
    return (
      `${pending.tags.length} etiquetas pasarán a ser «${pending.to}», en ${total} elemento(s). ` +
      'Las originales dejarán de existir. Se puede deshacer con Ctrl+Z.'
    );
  }

  const existing = countOf(pending.to);
  if (existing > 0) {
    return (
      `«${pending.to}» ya existe en ${existing} elemento(s), así que las dos quedarán fundidas: ` +
      `«${pending.tag}» dejará de existir y sus ${countOf(pending.tag)} elemento(s) pasarán a ` +
      '«' + pending.to + '». Se puede deshacer con Ctrl+Z.'
    );
  }

  return (
    `«${pending.tag}» pasará a llamarse «${pending.to}» en ${countOf(pending.tag)} elemento(s). ` +
    'Se puede deshacer con Ctrl+Z.'
  );
}
