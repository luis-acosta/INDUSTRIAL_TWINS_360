/**
 * Capas flotantes: menús, diálogos, avisos y pistas.
 *
 * Todas comparten tres comportamientos que, omitidos, convierten una
 * interfaz en algo que «casi funciona»:
 *
 *  - **Escape cierra.** Siempre, y sólo la capa más alta.
 *  - **El foco vuelve a donde estaba.** Al cerrar un diálogo, el foco
 *    regresa al control que lo abrió; de lo contrario, un usuario de teclado
 *    aparece al principio de la página después de cada acción.
 *  - **El foco queda atrapado dentro del diálogo modal.** Tabular fuera de un
 *    modal lleva a controles que están visualmente tapados y no responden.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, cx, toneColor, toneSurface, type Tone } from './primitives';

/* ------------------------------------------------------------------ *
 * Utilidades de foco
 * ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** Atrapa el foco dentro del contenedor mientras esté activo. */
function useFocusTrap(active: boolean, container: React.RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!active) return undefined;

    const previous = document.activeElement as HTMLElement | null;
    // Un destino declarado tiene prioridad sobre el primer foco disponible:
    // en un diálogo destructivo, el primer control suele ser el aspa de
    // cerrar y el destino correcto es «Cancelar».
    const declared = container.current?.querySelector<HTMLElement>('[data-autofocus]') ?? null;
    const target = declared ?? focusableWithin(container.current)[0] ?? container.current;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusableWithin(container.current);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (firstItem === undefined || lastItem === undefined) return;

      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Devolver el foco al origen es lo que hace que el teclado sea usable:
      // sin esto, cada cierre de diálogo reinicia el recorrido de tabulación.
      previous?.focus?.();
    };
  }, [active, container]);
}

/** Cierra con Escape, respetando el orden de apilamiento. */
function useEscape(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onClose]);
}

/**
 * Portal a `document.body`.
 *
 * El nodo anfitrión se crea en el inicializador de estado y no en un efecto.
 * La diferencia importa: creándolo en un efecto, el primer render devuelve
 * `null`, el contenido se monta un ciclo más tarde y cualquier efecto del
 * componente padre que quiera enfocar algo de dentro —el foco inicial de un
 * diálogo, el de un menú recién abierto— se encuentra la referencia vacía y
 * no hace nada. El fallo es silencioso y deja el teclado inservible.
 */
function Portal({ children }: { children: ReactNode }): JSX.Element {
  const [host] = useState<HTMLElement>(() => {
    const node = document.createElement('div');
    node.className = 'it-portal';
    return node;
  });

  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host]);

  return createPortal(children, host) as JSX.Element;
}

/* ------------------------------------------------------------------ *
 * Diálogo
 * ------------------------------------------------------------------ */

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Impide cerrar pulsando fuera. Para operaciones en curso. */
  readonly dismissable?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissable = true,
}: DialogProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useFocusTrap(open, ref);
  useEscape(open && dismissable, onClose);

  useEffect(() => {
    if (!open) return undefined;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <Portal>
      <div
        className="it-overlay"
        onMouseDown={(event) => {
          if (dismissable && event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description !== undefined ? descriptionId : undefined}
          className={cx('it-dialog', `it-dialog--${size}`)}
        >
          <header className="it-dialog__head">
            <div>
              <h2 className="it-dialog__title" id={titleId}>
                {title}
              </h2>
              {description !== undefined && (
                <p className="it-dialog__description" id={descriptionId}>
                  {description}
                </p>
              )}
            </div>
            {dismissable && (
              <Button variant="ghost" size="sm" iconOnly aria-label="Cerrar" onClick={onClose} icon={<CloseIcon />} />
            )}
          </header>
          {children !== undefined && <div className="it-dialog__body">{children}</div>}
          {footer !== undefined && <footer className="it-dialog__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  );
}

/**
 * Diálogo de confirmación para acciones destructivas.
 *
 * El botón de confirmación nunca es el que recibe el foco inicial. Pulsar
 * Intro por inercia tras abrir un diálogo es un gesto demasiado frecuente
 * como para que acabe borrando una escena.
 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  destructive = false,
  busy = false,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="it-dialog__message">{message}</p>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Menú desplegable
 * ------------------------------------------------------------------ */

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onSelect?: () => void;
  /** Separador antes de este elemento. */
  readonly separatorBefore?: boolean;
  readonly submenu?: readonly MenuItem[];
}

export interface MenuProps {
  readonly trigger: (props: { onClick: () => void; 'aria-expanded': boolean; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  readonly items: readonly MenuItem[];
  readonly align?: 'start' | 'end';
  readonly label: string;
}

/**
 * Menú desplegable con navegación por teclado.
 *
 * Se posiciona midiendo el disparador y comprobando si cabe debajo; si no,
 * se abre hacia arriba. Un menú que se sale de la ventana en una pantalla de
 * 1366×768 —resolución que la etapa 03 exige soportar— deja opciones
 * inalcanzables.
 */
export function Menu({ trigger, items, align = 'start', label }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: 'below' | 'above' }>({
    top: 0,
    left: 0,
    placement: 'below',
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback(() => setOpen(false), []);
  useEscape(open, close);

  useLayoutEffect(() => {
    if (!open || triggerRef.current === null) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = Math.min(items.length * 30 + 12, 420);
    const fitsBelow = rect.bottom + estimatedHeight + 8 < window.innerHeight;
    setPosition({
      top: fitsBelow ? rect.bottom + 4 : Math.max(rect.top - estimatedHeight - 4, 8),
      left: align === 'end' ? Math.max(rect.right - 220, 8) : Math.min(rect.left, window.innerWidth - 240),
      placement: fitsBelow ? 'below' : 'above',
    });
    setActiveIndex(items.findIndex((i) => i.disabled !== true));
  }, [open, align, items]);

  // `autoFocus` no actúa sobre un contenedor genérico; el foco se traslada
  // explícitamente para que las flechas y Enter funcionen nada más abrir.
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  const selectable = items.filter((i) => i.disabled !== true);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      let next = activeIndex;
      for (let step = 0; step < items.length; step += 1) {
        next = (next + direction + items.length) % items.length;
        if (items[next]?.disabled !== true) break;
      }
      setActiveIndex(next);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(items.findIndex((i) => i.disabled !== true));
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.disabled !== true) {
          setActiveIndex(i);
          break;
        }
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[activeIndex];
      if (item !== undefined && item.disabled !== true) {
        item.onSelect?.();
        close();
      }
    }
  };

  return (
    <>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, ref: triggerRef })}
      {open && (
        <Portal>
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className={cx('it-menu', `it-menu--${position.placement}`)}
            style={{ top: position.top, left: position.left }}
            onKeyDown={onKeyDown}
          >
            {items.map((item, index) => (
              <div key={item.id}>
                {item.separatorBefore === true && <span className="it-menu__separator" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={cx(
                    'it-menu__item',
                    index === activeIndex && 'it-menu__item--active',
                    item.destructive === true && 'it-menu__item--destructive',
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    item.onSelect?.();
                    close();
                  }}
                >
                  <span className="it-menu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="it-menu__label">{item.label}</span>
                  {item.shortcut !== undefined && <kbd className="it-menu__shortcut">{item.shortcut}</kbd>}
                </button>
              </div>
            ))}
            {selectable.length === 0 && <p className="it-menu__empty">Sin opciones disponibles</p>}
          </div>
        </Portal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Avisos emergentes
 * ------------------------------------------------------------------ */

export interface Toast {
  readonly id: string;
  readonly tone: Tone;
  readonly title: string;
  readonly description?: string;
  /** Milisegundos antes de desaparecer. 0 = permanece hasta cerrarlo. */
  readonly durationMs?: number;
  readonly action?: { label: string; onSelect: () => void };
}

interface ToastContextValue {
  readonly toasts: readonly Toast[];
  readonly push: (toast: Omit<Toast, 'id'> & { id?: string }) => string;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: Omit<Toast, 'id'> & { id?: string }): string => {
    counter.current += 1;
    const id = toast.id ?? `toast-${counter.current}`;
    setToasts((current) => [...current.filter((t) => t.id !== id), { ...toast, id }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast debe usarse dentro de <ToastProvider>');
  return context;
}

/**
 * Región de avisos.
 *
 * Los errores no desaparecen solos. Un aviso de «no se pudo guardar» que se
 * esfuma a los cuatro segundos es peor que no mostrarlo: el usuario cree que
 * guardó.
 */
function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  useEffect(() => {
    const timers = toasts
      .filter((t) => t.tone !== 'alarm' && (t.durationMs ?? 5000) > 0)
      .map((t) => window.setTimeout(() => onDismiss(t.id), t.durationMs ?? 5000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <Portal>
      <div className="it-toasts" role="region" aria-label="Avisos">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="it-toast"
            role={toast.tone === 'alarm' ? 'alert' : 'status'}
            style={{ borderLeftColor: toneColor(toast.tone) }}
          >
            <div className="it-toast__body">
              <p className="it-toast__title">{toast.title}</p>
              {toast.description !== undefined && <p className="it-toast__description">{toast.description}</p>}
            </div>
            {toast.action !== undefined && (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  toast.action?.onSelect();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="Descartar aviso"
              icon={<CloseIcon />}
              onClick={() => onDismiss(toast.id)}
            />
          </div>
        ))}
      </div>
    </Portal>
  );
}

/* ------------------------------------------------------------------ *
 * Pista contextual
 * ------------------------------------------------------------------ */

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly placement?: 'top' | 'bottom';
  /** Retardo antes de mostrarse. Evita el parpadeo al cruzar la barra. */
  readonly delayMs?: number;
}

export function Tooltip({ content, children, placement = 'top', delayMs = 400 }: TooltipProps): JSX.Element {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const id = useId();

  const show = (): void => {
    timer.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setCoords({
        top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
        left: rect.left + rect.width / 2,
      });
      setVisible(true);
    }, delayMs);
  };

  const hide = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setVisible(false);
  };

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return (
    <>
      <span
        ref={anchorRef}
        className="it-tooltip__anchor"
        aria-describedby={visible ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        // El foco también muestra la pista: un usuario de teclado necesita la
        // misma información que quien usa el ratón.
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible && (
        <Portal>
          <div
            id={id}
            role="tooltip"
            className={cx('it-tooltip', `it-tooltip--${placement}`)}
            style={{ top: coords.top, left: coords.left }}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Banda informativa
 * ------------------------------------------------------------------ */

export interface CalloutProps {
  readonly tone?: Tone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: () => void;
}

export function Callout({ tone = 'info', title, children, action, onDismiss }: CalloutProps): JSX.Element {
  return (
    <div
      className="it-callout"
      role={tone === 'alarm' ? 'alert' : 'note'}
      style={{ background: toneSurface(tone), borderLeftColor: toneColor(tone) }}
    >
      <div className="it-callout__body">
        {title !== undefined && (
          <p className="it-callout__title" style={{ color: toneColor(tone) }}>
            {title}
          </p>
        )}
        <div className="it-callout__content">{children}</div>
      </div>
      {action}
      {onDismiss !== undefined && (
        <Button size="sm" variant="ghost" iconOnly aria-label="Descartar" icon={<CloseIcon />} onClick={onDismiss} />
      )}
    </div>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
