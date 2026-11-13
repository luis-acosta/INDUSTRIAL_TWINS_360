/**
 * Editor de interfaces (F01–F04, F07, Y06).
 *
 * Tres zonas: el árbol y la paleta a la izquierda, el lienzo en el centro y las
 * propiedades a la derecha. Es la disposición que ya conoce quien ha usado una
 * herramienta de este tipo, y no hay razón para inventar otra.
 *
 * Todas las operaciones del árbol pasan por `@it360/domain/skin-editing`, que
 * es donde se comprueba lo que destruye una interfaz: meter un contenedor
 * dentro de sí mismo, duplicar identificadores, anidar sin fin. Este componente
 * sólo las llama y enseña el motivo cuando el dominio dice no.
 *
 * El árbol es además la vía de teclado: todo lo que se puede hacer arrastrando
 * se puede hacer desde él. Un editor que sólo responde al ratón deja fuera a
 * quien no puede usarlo, y en una sala de control eso no es una hipótesis.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  collectIds,
  COMPONENT_LABELS,
  copyNode,
  createNode,
  duplicateNode,
  findSkinNode,
  insertNode,
  insertSavedComponent,
  moveNode,
  pasteNode,
  realSkins,
  removalImpact,
  removeNode,
  savedComponentName,
  savedComponents,
  saveComponent,
  skinFromTemplate,
  skinNodePath,
  SKIN_TEMPLATES,
  updateNode,
  validateSkin,
  walkSkin,
  type ComponentKind,
  type Skin,
  type SkinClipboard,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconAdd,
  SectionLabel,
  Select,
  TextInput,
  useToast,
} from '@it360/ui';
import { SkinCanvas } from './SkinCanvas';
import { SkinNodeProperties } from './SkinNodeProperties';
import type { ProjectStore } from '../state/project-store';

export interface SkinEditorProps {
  readonly store: ProjectStore;
}

/** Componentes que la paleta ofrece, agrupados por para qué sirven. */
const PALETTE: readonly { readonly group: string; readonly kinds: readonly ComponentKind[] }[] = [
  { group: 'Estructura', kinds: ['container', 'tabs', 'carousel', 'spacer'] },
  { group: 'Contenido', kinds: ['text', 'image', 'button', 'dropdown', 'webframe'] },
  { group: 'Recorrido', kinds: ['thumbnailList', 'planView', 'progressBar'] },
  { group: 'Industrial', kinds: ['assetPanel', 'telemetryPanel', 'notesPanel'] },
  { group: 'Formación', kinds: ['quizCard', 'scoreBoard', 'timer'] },
];

export function SkinEditor({ store }: SkinEditorProps): JSX.Element {
  const { push } = useToast();
  const project = store.project;

  const skins = useMemo(() => realSkins(project.skins), [project.skins]);
  const library = useMemo(() => savedComponents(project.skins), [project.skins]);

  const [skinId, setSkinId] = useState<string | null>(skins[0]?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<SkinClipboard | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [saveComponentFor, setSaveComponentFor] = useState<string | null>(null);
  const [componentName, setComponentName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const skin = useMemo(() => skins.find((s) => s.id === skinId) ?? null, [skins, skinId]);

  // Si la interfaz abierta desaparece —deshacer, o la borró otro módulo— se
  // pasa a la primera, en lugar de dejar el editor en blanco sin explicación.
  useEffect(() => {
    if (skin === null && skins.length > 0) setSkinId(skins[0]?.id ?? null);
  }, [skin, skins]);

  useEffect(() => {
    setSelectedId(null);
  }, [skinId]);

  const selected = useMemo(
    () => (skin === null || selectedId === null ? null : findSkinNode(skin.root, selectedId)),
    [skin, selectedId],
  );

  const problems = useMemo(() => (skin === null ? [] : validateSkin(skin)), [skin]);

  /** Escribe la interfaz en el proyecto, pasando por el historial. */
  const write = (label: string, next: Skin, coalesceKey?: string): void => {
    store.updateProject(
      label,
      {
        skins: project.skins.map((candidate) =>
          candidate.id === next.id ? { ...next, updatedAt: new Date().toISOString() } : candidate,
        ),
      },
      coalesceKey,
    );
  };

  /** Enseña el motivo del dominio tal cual, sin reescribirlo. */
  const refuse = (message: string, recovery?: string): void => {
    push({
      tone: 'warning',
      title: message,
      ...(recovery !== undefined ? { description: recovery } : {}),
    });
  };

  const apply = (
    label: string,
    operation: { ok: true; value: Skin } | { ok: false; error: { message: string; recovery?: string } },
    coalesceKey?: string,
  ): void => {
    if (!operation.ok) {
      refuse(operation.error.message, operation.error.recovery);
      return;
    }
    write(label, operation.value, coalesceKey);
  };

  /* --- Operaciones --- */

  const addComponent = (kind: ComponentKind): void => {
    if (skin === null) return;
    const node = createNode({ kind, taken: collectIds(skin.root) });

    // Si hay un contenedor seleccionado, el componente nuevo entra dentro: es
    // lo que el autor espera tras haber elegido dónde quiere trabajar.
    const parentId =
      selected !== null && ['container', 'tabs', 'carousel'].includes(selected.config.kind)
        ? selected.id
        : null;

    const result = insertNode(skin, node, { parentId });
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    write(`Añadir ${COMPONENT_LABELS[kind]}`, result.value);
    setSelectedId(node.id);
  };

  const onReparent = (nodeId: string, parentId: string | null): void => {
    if (skin === null) return;
    apply('Mover componente', moveNode(skin, nodeId, { parentId }));
  };

  const onMoveTo = (nodeId: string, offsetX: number, offsetY: number): void => {
    if (skin === null) return;
    apply(
      'Colocar componente',
      updateNode(skin, nodeId, (node) => ({ ...node, box: { ...node.box, offsetX, offsetY } })),
      // Se agrupa por nodo para que arrastrar no llene el historial de pasos.
      `skin.move:${nodeId}`,
    );
  };

  const onResize = (nodeId: string, width: number, height: number): void => {
    if (skin === null) return;
    apply(
      'Cambiar tamaño del componente',
      updateNode(skin, nodeId, (node) => ({
        ...node,
        box: { ...node.box, width, height, widthPercent: null, heightPercent: null },
      })),
      `skin.size:${nodeId}`,
    );
  };

  const onReorder = (nodeId: string, delta: number): void => {
    if (skin === null) return;
    const path = skinNodePath(skin.root, nodeId);
    const parentId = path === null || path.length <= 1 ? null : (path[path.length - 2] ?? null);
    const siblings = parentId === null ? skin.root : (findSkinNode(skin.root, parentId)?.children ?? []);
    const index = siblings.findIndex((sibling) => sibling.id === nodeId);
    if (index < 0) return;

    apply('Reordenar componente', moveNode(skin, nodeId, { parentId, index: index + delta }));
  };

  const onDelete = (): void => {
    if (skin === null || deleting === null) return;
    const result = removeNode(skin, deleting);
    setDeleting(null);
    if (!result.ok) {
      refuse(result.error.message, result.error.recovery);
      return;
    }
    write('Eliminar componente', result.value);
    setSelectedId(null);
  };

  const onDuplicate = (): void => {
    if (skin === null || selectedId === null) return;
    apply('Duplicar componente', duplicateNode(skin, selectedId));
  };

  const onCopy = (): void => {
    if (skin === null || selectedId === null) return;
    const copied = copyNode(skin, selectedId);
    if (copied === null) return;
    setClipboard(copied);
    push({ tone: 'info', title: `«${copied.node.name}» copiado` });
  };

  const onPaste = (): void => {
    if (skin === null || clipboard === null) return;
    const parentId =
      selected !== null && ['container', 'tabs', 'carousel'].includes(selected.config.kind)
        ? selected.id
        : null;
    apply('Pegar componente', pasteNode(skin, clipboard, { parentId }));
  };

  const onSaveToLibrary = (): void => {
    if (skin === null || saveComponentFor === null) return;
    const node = findSkinNode(skin.root, saveComponentFor);
    if (node === null) return;

    const component = saveComponent(node, componentName, new Date().toISOString());
    store.updateProject(`Guardar «${componentName}» en la biblioteca`, {
      skins: [...project.skins, component],
    });
    setSaveComponentFor(null);
    setComponentName('');
  };

  const onInsertFromLibrary = (componentId: string): void => {
    if (skin === null) return;
    const component = library.find((candidate) => candidate.id === componentId);
    if (component === undefined) return;

    const parentId =
      selected !== null && ['container', 'tabs', 'carousel'].includes(selected.config.kind)
        ? selected.id
        : null;
    apply('Insertar componente de la biblioteca', insertSavedComponent(skin, component, { parentId }));
  };

  const onCreateFromTemplate = (templateId: string | null): void => {
    const now = new Date().toISOString();
    const template = SKIN_TEMPLATES.find((candidate) => candidate.id === templateId);

    const created =
      template === undefined
        ? skinFromTemplate(
            { ...SKIN_TEMPLATES[0]!, build: () => [] },
            { name: 'Interfaz nueva', now },
          )
        : skinFromTemplate(template, { now });

    const fresh = template === undefined ? { ...created, templateId: null } : created;

    store.updateProject(`Crear interfaz «${fresh.name}»`, { skins: [...project.skins, fresh] });
    setSkinId(fresh.id);
    setTemplatesOpen(false);
  };

  const onDeleteSkin = (): void => {
    if (skin === null) return;
    if (project.settings.defaultSkinId === skin.id) {
      refuse(
        `«${skin.name}» es la interfaz predeterminada del proyecto`,
        'Elija otra como predeterminada en los ajustes antes de eliminarla.',
      );
      return;
    }
    store.updateProject(`Eliminar interfaz «${skin.name}»`, {
      skins: project.skins.filter((candidate) => candidate.id !== skin.id),
    });
    setSkinId(null);
  };

  const impact = skin === null || deleting === null ? null : removalImpact(skin, deleting);

  /* --- Render --- */

  if (skin === null) {
    return (
      <div className="module">
        <div className="module__head">
          <h2 className="module__title">Interfaz del recorrido</h2>
        </div>
        <EmptyState
          title="El proyecto no tiene ninguna interfaz"
          description="Una interfaz define qué ve el visitante encima de la panorámica: la navegación, el plano, los paneles. Parta de una plantilla o empiece de cero."
          action={
            <Button variant="primary" onClick={() => setTemplatesOpen(true)}>
              Crear interfaz
            </Button>
          }
        />
        <TemplateGallery
          open={templatesOpen}
          onClose={() => setTemplatesOpen(false)}
          onChoose={onCreateFromTemplate}
        />
      </div>
    );
  }

  return (
    <div className="module module--skin">
      <div className="module__head">
        <h2 className="module__title">Interfaz del recorrido</h2>

        <Select
          size="sm"
          aria-label="Interfaz que se está editando"
          value={skin.id}
          onChange={(event) => setSkinId(event.currentTarget.value)}
        >
          {skins.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </Select>

        <div className="module__head-actions">
          <Button size="sm" variant="secondary" onClick={() => setTemplatesOpen(true)}>
            Nueva interfaz
          </Button>
          <Button size="sm" variant="ghost" onClick={onDeleteSkin}>
            Eliminar interfaz
          </Button>
        </div>
      </div>

      <div className="skin-editor">
        {/* ---------------- Árbol y paleta ---------------- */}

        <aside className="skin-editor__left">
          <SectionLabel>Componentes</SectionLabel>

          {skin.root.length === 0 ? (
            <p className="skin-editor__hint">Todavía no hay ninguno.</p>
          ) : (
            <ul className="skin-editor__tree" role="tree" aria-label="Árbol de componentes">
              {[...walkSkin(skin.root)].map(({ node, depth }) => (
                <li key={node.id} role="none">
                  <button
                    type="button"
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={node.id === selectedId}
                    className="skin-editor__tree-item"
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    onClick={() => setSelectedId(node.id)}
                  >
                    <span className="skin-editor__tree-name">{node.name}</span>
                    <span className="skin-editor__tree-kind">
                      {COMPONENT_LABELS[node.config.kind]}
                    </span>
                    {node.locked && <Badge tone="neutral">bloqueado</Badge>}
                    {!node.initiallyVisible && <Badge tone="neutral">oculto</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selected !== null && (
            <div className="skin-editor__tree-actions">
              <Button size="sm" variant="ghost" onClick={() => onReorder(selected.id, -1)}>
                Subir
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onReorder(selected.id, 1)}>
                Bajar
              </Button>
              <Button size="sm" variant="ghost" onClick={onDuplicate}>
                Duplicar
              </Button>
              <Button size="sm" variant="ghost" onClick={onCopy}>
                Copiar
              </Button>
              <Button size="sm" variant="ghost" disabled={clipboard === null} onClick={onPaste}>
                Pegar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSaveComponentFor(selected.id);
                  setComponentName(selected.name);
                }}
              >
                Guardar en biblioteca
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setDeleting(selected.id)}>
                Eliminar
              </Button>
            </div>
          )}

          <SectionLabel>Añadir</SectionLabel>
          {PALETTE.map((group) => (
            <div key={group.group} className="skin-editor__palette-group">
              <p className="skin-editor__palette-title">{group.group}</p>
              <div className="skin-editor__palette">
                {group.kinds.map((kind) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant="secondary"
                    icon={<IconAdd size={12} />}
                    onClick={() => addComponent(kind)}
                  >
                    {COMPONENT_LABELS[kind]}
                  </Button>
                ))}
              </div>
            </div>
          ))}

          {library.length > 0 && (
            <>
              <SectionLabel>Biblioteca</SectionLabel>
              <div className="skin-editor__palette">
                {library.map((component) => (
                  <Button
                    key={component.id}
                    size="sm"
                    variant="secondary"
                    icon={<IconAdd size={12} />}
                    onClick={() => onInsertFromLibrary(component.id)}
                  >
                    {savedComponentName(component)}
                  </Button>
                ))}
              </div>
            </>
          )}
        </aside>

        {/* ---------------- Lienzo ---------------- */}

        <div className="skin-editor__center">
          {problems.length > 0 && (
            <Callout tone="warning" title="Revisar antes de publicar">
              <ul className="asset-editor__problems">
                {problems.slice(0, 5).map((problem) => (
                  <li key={`${problem.nodeId}:${problem.message}`}>
                    <b>{problem.nodeName}</b>: {problem.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <SkinCanvas
            skin={skin}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onReparent={onReparent}
            onMoveTo={onMoveTo}
            onResize={onResize}
          />

          <p className="skin-editor__hint">
            El lienzo coloca los componentes con el mismo cálculo que el recorrido publicado.
            Arrastre para mover, suelte sobre un contenedor para meterlo dentro, y use el tirador de
            la esquina —o las flechas, con el tirador enfocado— para cambiar el tamaño.
          </p>
        </div>

        {/* ---------------- Propiedades ---------------- */}

        <aside className="skin-editor__right">
          {selected === null ? (
            <EmptyState
              title="Nada seleccionado"
              description="Elija un componente en el lienzo o en el árbol para ver sus propiedades."
            />
          ) : (
            <SkinNodeProperties
              store={store}
              skin={skin}
              node={selected}
              onChange={(label, patch, coalesceKey) =>
                apply(label, updateNode(skin, selected.id, patch), coalesceKey)
              }
            />
          )}
        </aside>
      </div>

      <TemplateGallery
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onChoose={onCreateFromTemplate}
      />

      <Dialog
        open={saveComponentFor !== null}
        onClose={() => setSaveComponentFor(null)}
        title="Guardar en la biblioteca"
        description="El componente queda guardado en este proyecto y se puede insertar en cualquiera de sus interfaces."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveComponentFor(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              disabled={componentName.trim().length === 0}
              onClick={onSaveToLibrary}
            >
              Guardar
            </Button>
          </>
        }
      >
        <Field label="Nombre del componente" required>
          {({ id }) => (
            <TextInput
              id={id}
              value={componentName}
              onChange={(event) => setComponentName(event.currentTarget.value)}
            />
          )}
        </Field>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={onDelete}
        destructive
        title="Eliminar componente"
        confirmLabel="Eliminar"
        message={
          impact === null
            ? ''
            : [
                impact.total > 1
                  ? `Se eliminarán ${impact.total} componentes: «${impact.node.name}» y lo que tiene dentro.`
                  : `Se eliminará «${impact.node.name}».`,
                impact.referencedBy.length > 0
                  ? `Estos componentes tienen acciones que lo nombran y dejarán de funcionar: ${impact.referencedBy.join(', ')}.`
                  : '',
                'La operación se puede deshacer con Ctrl+Z.',
              ]
                .filter((part) => part.length > 0)
                .join(' ')
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Galería de plantillas (F02)
 * ------------------------------------------------------------------ */

interface TemplateGalleryProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChoose: (templateId: string | null) => void;
}

function TemplateGallery({ open, onClose, onChoose }: TemplateGalleryProps): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nueva interfaz"
      description="Una plantilla es un punto de partida: lo que se crea es una interfaz propia del proyecto, que puede cambiar entera. No queda ningún vínculo con la plantilla."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="secondary" onClick={() => onChoose(null)}>
            Empezar de cero
          </Button>
        </>
      }
    >
      <div className="skin-templates">
        {SKIN_TEMPLATES.map((template) => (
          <article key={template.id} className="skin-templates__card">
            <h3>{template.name}</h3>
            <p className="skin-templates__description">{template.description}</p>
            <p className="skin-templates__guidance">{template.guidance}</p>
            <Button variant="primary" size="sm" onClick={() => onChoose(template.id)}>
              Usar «{template.name}»
            </Button>
          </article>
        ))}
      </div>
    </Dialog>
  );
}
