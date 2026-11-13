/**
 * Presentación de datos: árbol, tabla, barras de progreso y tiras de
 * miniaturas.
 *
 * Son los componentes que llevan el peso de la aplicación: el árbol de
 * escenas y el de activos, la tabla de notas y la de variables, el carrusel
 * de escenas del visor. Por eso se construyen una vez aquí y no en cada
 * pantalla.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Badge, cx, toneColor, type Tone } from './primitives';

/* ------------------------------------------------------------------ *
 * Barra de progreso
 * ------------------------------------------------------------------ */

export interface ProgressBarProps {
  /** Valor entre 0 y 1. `null` = progreso indeterminado. */
  readonly value: number | null;
  readonly label?: string;
  readonly tone?: Tone;
  readonly showValue?: boolean;
  readonly size?: 'sm' | 'md';
}

export function ProgressBar({
  value,
  label,
  tone = 'accent',
  showValue = false,
  size = 'md',
}: ProgressBarProps): JSX.Element {
  const clamped = value === null ? null : Math.min(Math.max(value, 0), 1);
  const percent = clamped === null ? 0 : Math.round(clamped * 100);

  return (
    <div className={cx('it-progress', `it-progress--${size}`)}>
      {(label !== undefined || showValue) && (
        <div className="it-progress__head">
          {label !== undefined && <span className="it-progress__label">{label}</span>}
          {showValue && clamped !== null && <span className="it-progress__value">{percent}%</span>}
        </div>
      )}
      <div
        className={cx('it-progress__track', clamped === null && 'it-progress__track--indeterminate')}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped === null ? undefined : percent}
        aria-label={label}
      >
        <span
          className="it-progress__fill"
          style={{ width: clamped === null ? '35%' : `${percent}%`, background: toneColor(tone) }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Árbol
 * ------------------------------------------------------------------ */

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Texto secundario a la derecha: TAG, recuento, estado. */
  readonly meta?: ReactNode;
  readonly tone?: Tone;
  readonly children?: readonly TreeNode[];
  readonly disabled?: boolean;
  /** Muestra una marca de advertencia junto al nodo. */
  readonly warning?: string;
}

export interface TreeProps {
  readonly nodes: readonly TreeNode[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly expandedIds: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly label: string;
  readonly emptyMessage?: string;
  /** Acciones contextuales por nodo, mostradas al pasar el puntero. */
  readonly renderActions?: (node: TreeNode) => ReactNode;
}

interface FlatNode {
  readonly node: TreeNode;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

/**
 * Árbol con navegación por teclado completa.
 *
 * Implementa el patrón ARIA de árbol: flechas arriba y abajo recorren los
 * nodos visibles, derecha expande o baja al primer hijo, izquierda contrae o
 * sube al padre. Es la diferencia entre poder recorrer doscientas escenas con
 * el teclado y tener que buscarlas con el ratón una a una.
 *
 * El aplanado se recalcula en cada cambio de expansión y no se mantiene como
 * estado: derivarlo evita que la lista visible y el conjunto de expandidos se
 * desincronicen, que es el fallo típico de los árboles con estado duplicado.
 */
export function Tree({
  nodes,
  selectedId,
  onSelect,
  expandedIds,
  onToggle,
  label,
  emptyMessage = 'Sin elementos',
  renderActions,
}: TreeProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => {
    const out: FlatNode[] = [];
    const walk = (list: readonly TreeNode[], depth: number): void => {
      for (const node of list) {
        const hasChildren = (node.children?.length ?? 0) > 0;
        const expanded = hasChildren && expandedIds.has(node.id);
        out.push({ node, depth, hasChildren, expanded });
        if (expanded && node.children !== undefined) walk(node.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }, [nodes, expandedIds]);

  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (list: readonly TreeNode[], parent: string | null): void => {
      for (const node of list) {
        if (parent !== null) map.set(node.id, parent);
        if (node.children !== undefined) walk(node.children, node.id);
      }
    };
    walk(nodes, null);
    return map;
  }, [nodes]);

  const focusNode = useCallback((id: string) => {
    containerRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentId = (event.target as HTMLElement).dataset['nodeId'];
    if (currentId === undefined) return;
    const index = flat.findIndex((f) => f.node.id === currentId);
    if (index < 0) return;
    const current = flat[index];
    if (current === undefined) return;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = flat[Math.min(index + 1, flat.length - 1)];
        if (next !== undefined) focusNode(next.node.id);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = flat[Math.max(index - 1, 0)];
        if (prev !== undefined) focusNode(prev.node.id);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (current.hasChildren && !current.expanded) {
          onToggle(current.node.id);
        } else if (current.expanded) {
          const next = flat[index + 1];
          if (next !== undefined) focusNode(next.node.id);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (current.expanded) {
          onToggle(current.node.id);
        } else {
          const parent = parentOf.get(current.node.id);
          if (parent !== undefined) focusNode(parent);
        }
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (flat[0] !== undefined) focusNode(flat[0].node.id);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = flat[flat.length - 1];
        if (last !== undefined) focusNode(last.node.id);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (current.node.disabled !== true) onSelect(current.node.id);
        break;
      }
      default:
        break;
    }
  };

  if (flat.length === 0) {
    return <p className="it-tree__empty">{emptyMessage}</p>;
  }

  return (
    <div ref={containerRef} className="it-tree" role="tree" aria-label={label} onKeyDown={onKeyDown}>
      {flat.map(({ node, depth, hasChildren, expanded }) => {
        const selected = node.id === selectedId;
        return (
          <div
            key={node.id}
            role="treeitem"
            data-node-id={node.id}
            aria-selected={selected}
            aria-expanded={hasChildren ? expanded : undefined}
            aria-level={depth + 1}
            aria-disabled={node.disabled || undefined}
            tabIndex={selected || (selectedId === null && flat[0]?.node.id === node.id) ? 0 : -1}
            className={cx('it-tree__item', selected && 'it-tree__item--selected', node.disabled === true && 'it-tree__item--disabled')}
            style={{ paddingLeft: `calc(var(--it-space-2) + ${depth} * var(--it-space-4))` }}
            onClick={() => {
              if (node.disabled !== true) onSelect(node.id);
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              className={cx('it-tree__twisty', !hasChildren && 'it-tree__twisty--leaf')}
              aria-hidden="true"
              onClick={(event) => {
                event.stopPropagation();
                if (hasChildren) onToggle(node.id);
              }}
            >
              {hasChildren && (
                <svg viewBox="0 0 12 12" className={cx(expanded && 'it-tree__twisty--open')}>
                  <path d="M4.5 3 8 6l-3.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            {node.icon !== undefined && (
              <span className="it-tree__icon" style={node.tone !== undefined ? { color: toneColor(node.tone) } : undefined} aria-hidden="true">
                {node.icon}
              </span>
            )}
            <span className="it-tree__label">{node.label}</span>
            {node.warning !== undefined && (
              <span className="it-tree__warning" title={node.warning} aria-label={node.warning}>
                <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor">
                  <path d="M6 1 11 10.5H1z" opacity="0.25" />
                  <path d="M6 4.2v3M6 8.6v.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                </svg>
              </span>
            )}
            {node.meta !== undefined && <span className="it-tree__meta">{node.meta}</span>}
            {renderActions !== undefined && <span className="it-tree__actions">{renderActions(node)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tabla
 * ------------------------------------------------------------------ */

export interface Column<T> {
  readonly id: string;
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  readonly width?: string;
  readonly align?: 'start' | 'end' | 'center';
  readonly sortable?: boolean;
  /** Valor por el que ordenar; si falta, se ordena por el texto renderizado. */
  readonly sortValue?: (row: T) => string | number;
  readonly mono?: boolean;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly label: string;
  readonly selectedKey?: string | null;
  readonly onSelect?: (row: T) => void;
  readonly emptyMessage?: string;
  readonly compact?: boolean;
  /** Tono de la fila: resalta alarmas o elementos vencidos. */
  readonly rowTone?: (row: T) => Tone | undefined;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
  selectedKey = null,
  onSelect,
  emptyMessage = 'Sin registros',
  compact = false,
  rowTone,
}: DataTableProps<T>): JSX.Element {
  const [sort, setSort] = useState<{ columnId: string; direction: 'asc' | 'desc' } | null>(null);

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.id === sort.columnId);
    if (column === undefined) return rows;
    const getValue = column.sortValue ?? ((row: T) => String(column.render(row) ?? ''));
    return [...rows].sort((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'es', { numeric: true });
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const toggleSort = (columnId: string): void => {
    setSort((current) =>
      current?.columnId === columnId
        ? current.direction === 'asc'
          ? { columnId, direction: 'desc' }
          : null
        : { columnId, direction: 'asc' },
    );
  };

  if (rows.length === 0) {
    return <p className="it-table__empty">{emptyMessage}</p>;
  }

  return (
    <div className="it-table__wrap">
      <table className={cx('it-table', compact && 'it-table--compact')}>
        <caption className="it-visually-hidden">{label}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.columnId === column.id;
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width !== undefined ? { width: column.width } : undefined}
                  className={cx(column.align !== undefined && `it-table__cell--${column.align}`)}
                  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {column.sortable === true ? (
                    <button type="button" className="it-table__sort" onClick={() => toggleSort(column.id)}>
                      {column.header}
                      <span className={cx('it-table__sort-icon', active && 'it-table__sort-icon--active')} aria-hidden="true">
                        {active ? (sort.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const tone = rowTone?.(row);
            return (
              <tr
                key={key}
                className={cx(
                  onSelect !== undefined && 'it-table__row--interactive',
                  key === selectedKey && 'it-table__row--selected',
                )}
                style={tone !== undefined ? { ['--it-row-tone' as string]: toneColor(tone) } : undefined}
                onClick={onSelect !== undefined ? () => onSelect(row) : undefined}
                tabIndex={onSelect !== undefined ? 0 : undefined}
                onKeyDown={
                  onSelect !== undefined
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cx(
                      column.align !== undefined && `it-table__cell--${column.align}`,
                      column.mono === true && 'it-table__cell--mono',
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tira de miniaturas (F13)
 * ------------------------------------------------------------------ */

export interface ThumbnailItem {
  readonly id: string;
  readonly title: string;
  /** URL de la miniatura. Ausente = marcador de posición. */
  readonly src?: string;
  readonly badge?: ReactNode;
}

export interface ThumbnailStripProps {
  readonly items: readonly ThumbnailItem[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly label: string;
  readonly orientation?: 'horizontal' | 'vertical';
  readonly size?: number;
  readonly showTitles?: boolean;
}

/**
 * Tira de miniaturas.
 *
 * Desplaza la miniatura activa hasta dejarla a la vista cuando cambia desde
 * fuera —al navegar por un hotspot, por ejemplo—. Sin eso, el recorrido avanza
 * y la tira se queda mostrando escenas que ya se pasaron.
 */
export function ThumbnailStrip({
  items,
  activeId,
  onSelect,
  label,
  orientation = 'horizontal',
  size = 96,
  showTitles = true,
}: ThumbnailStripProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId === null) return;
    const node = containerRef.current?.querySelector<HTMLElement>(`[data-thumb-id="${CSS.escape(activeId)}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <div
      ref={containerRef}
      className={cx('it-thumbs', `it-thumbs--${orientation}`)}
      role="listbox"
      aria-label={label}
      aria-orientation={orientation}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={active}
            data-thumb-id={item.id}
            className={cx('it-thumb', active && 'it-thumb--active')}
            style={{ width: size, flexBasis: size }}
            onClick={() => onSelect(item.id)}
            title={item.title}
          >
            <span className="it-thumb__frame" style={{ height: Math.round(size * 0.5625) }}>
              {item.src !== undefined ? (
                <img src={item.src} alt="" loading="lazy" />
              ) : (
                <span className="it-thumb__placeholder" aria-hidden="true" />
              )}
              {item.badge !== undefined && <span className="it-thumb__badge">{item.badge}</span>}
            </span>
            {showTitles && <span className="it-thumb__title">{item.title}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fila de propiedad clave-valor
 * ------------------------------------------------------------------ */

export function PropertyRow({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className="it-prop">
      <dt className="it-prop__label">{label}</dt>
      <dd className={cx('it-prop__value', mono && 'it-prop__value--mono')} style={tone !== undefined ? { color: toneColor(tone) } : undefined}>
        {value}
      </dd>
    </div>
  );
}

export function PropertyList({ children }: { children: ReactNode }): JSX.Element {
  return <dl className="it-props">{children}</dl>;
}

/* ------------------------------------------------------------------ *
 * Recuento con tono
 * ------------------------------------------------------------------ */

export function CountPill({ count, tone = 'neutral', label }: { count: number; tone?: Tone; label: string }): JSX.Element {
  return (
    <Badge tone={tone} mono aria-label={`${count} ${label}`}>
      {count}
    </Badge>
  );
}
