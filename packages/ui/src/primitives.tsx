/**
 * Componentes base del sistema de diseño.
 *
 * Tres reglas gobiernan toda la biblioteca:
 *
 *  1. **Ningún color literal.** Todo sale de las variables `--it-*`, de modo
 *     que el cambio de tema no toca ni una línea de componente y el contraste
 *     verificado en `@it360/tokens` sigue siendo cierto en pantalla.
 *  2. **El foco siempre es visible.** Una herramienta industrial se opera con
 *     teclado cuando se tienen guantes puestos o la mano en un plano; un
 *     `outline: none` sin sustituto deja al usuario sin saber dónde está.
 *  3. **Altura y retícula fijas.** Los controles miden 28 px (34 en tamaño
 *     grande) y se alinean a la retícula de 4 px. Un panel de propiedades con
 *     treinta filas de alturas dispares se lee como un formulario improvisado.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export type Tone = 'neutral' | 'accent' | 'nominal' | 'warning' | 'alarm' | 'info' | 'experimental';

const TONE_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--it-color-text-secondary)',
  accent: 'var(--it-color-accent-onSurface)',
  nominal: 'var(--it-color-status-nominal)',
  warning: 'var(--it-color-status-warning)',
  alarm: 'var(--it-color-status-alarm)',
  info: 'var(--it-color-status-info)',
  experimental: 'var(--it-color-status-experimental)',
};

const TONE_SURFACE: Readonly<Record<Tone, string>> = {
  neutral: 'var(--it-color-surface-overlay)',
  accent: 'var(--it-color-accent-subtle)',
  nominal: 'var(--it-color-status-nominalSurface)',
  warning: 'var(--it-color-status-warningSurface)',
  alarm: 'var(--it-color-status-alarmSurface)',
  info: 'var(--it-color-status-infoSurface)',
  experimental: 'var(--it-color-status-experimentalSurface)',
};

export const toneColor = (tone: Tone): string => TONE_VAR[tone];
export const toneSurface = (tone: Tone): string => TONE_SURFACE[tone];

/** Une nombres de clase descartando los vacíos. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');

/* ------------------------------------------------------------------ *
 * Botón
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
export type ControlSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ControlSize;
  readonly icon?: ReactNode;
  readonly iconEnd?: ReactNode;
  /** Botón cuadrado que sólo muestra icono. Exige `aria-label`. */
  readonly iconOnly?: boolean;
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  /**
   * Marca este botón como destino del foco inicial dentro de un diálogo.
   *
   * No se usa `autoFocus` porque React lo aplica en el montaje y la trampa de
   * foco del diálogo lo sobrescribe después; este atributo sobrevive en el
   * DOM y la trampa lo consulta.
   */
  readonly 'data-autofocus'?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconEnd,
    iconOnly = false,
    loading = false,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(
        'it-btn',
        `it-btn--${variant}`,
        `it-btn--${size}`,
        iconOnly && 'it-btn--icon',
        fullWidth && 'it-btn--full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 13} /> : icon}
      {!iconOnly && children !== undefined && <span className="it-btn__label">{children}</span>}
      {!iconOnly && iconEnd}
    </button>
  );
});

/* ------------------------------------------------------------------ *
 * Indicador de carga
 * ------------------------------------------------------------------ */

export function Spinner({ size = 14, label }: { size?: number; label?: string }): JSX.Element {
  return (
    <span
      className="it-spinner"
      style={{ width: size, height: size }}
      role={label !== undefined ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label === undefined || undefined}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Campos de formulario
 * ------------------------------------------------------------------ */

export interface FieldProps {
  readonly label: string;
  /** Texto de ayuda bajo el campo. */
  readonly hint?: string;
  /** Mensaje de error. Sustituye a la ayuda y marca el campo. */
  readonly error?: string;
  readonly required?: boolean;
  /** Dispone etiqueta y control en una fila, como en un inspector denso. */
  readonly inline?: boolean;
  readonly children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/**
 * Envoltorio de campo.
 *
 * Asocia la etiqueta, la ayuda y el error al control mediante `id` y
 * `aria-describedby` en lugar de dejarlo al criterio de cada pantalla. Un
 * mensaje de error que el lector de pantalla no anuncia es un mensaje que no
 * existe para quien lo necesita.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  inline = false,
  children,
}: FieldProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error.length > 0;
  const describedBy = invalid ? errorId : hint !== undefined ? hintId : undefined;

  return (
    <div className={cx('it-field', inline && 'it-field--inline', invalid && 'it-field--invalid')}>
      <label className="it-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="it-field__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className="it-field__control">
        {children({ id, describedBy, invalid })}
        {invalid ? (
          <p className="it-field__error" id={errorId} role="alert">
            {error}
          </p>
        ) : hint !== undefined ? (
          <p className="it-field__hint" id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  readonly invalid?: boolean;
  /**
   * Tamaño del control del sistema de diseño.
   *
   * Sustituye al atributo `size` nativo, que mide el campo en caracteres y es
   * una herencia de HTML que esta biblioteca no usa: la anchura la decide la
   * retícula, no el número de letras que quepan.
   */
  readonly size?: ControlSize;
  /** Usa la familia monoespaciada: TAG, rutas, identificadores. */
  readonly mono?: boolean;
  /**
   * Contenido fijo antes del campo: un icono de búsqueda, un prefijo de TAG.
   * Sustituye al atributo `prefix` del DOM, que es de HTML 4 y no se usa.
   */
  readonly prefix?: ReactNode;
  /** Contenido fijo tras el campo: la unidad de ingeniería, por ejemplo. */
  readonly suffix?: ReactNode;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid = false, size = 'md', mono = false, prefix, suffix, className, ...rest },
  ref,
) {
  return (
    <span className={cx('it-input', `it-input--${size}`, invalid && 'it-input--invalid', className)}>
      {prefix !== undefined && <span className="it-input__affix">{prefix}</span>}
      <input
        ref={ref}
        className={cx('it-input__el', mono && 'it-input__el--mono')}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {suffix !== undefined && <span className="it-input__affix">{suffix}</span>}
    </span>
  );
});

export interface NumberInputProps extends Omit<TextInputProps, 'type' | 'value' | 'onChange'> {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Unidad mostrada tras el valor: `°`, `bar`, `m³/h`. */
  readonly unit?: string;
  /** Decimales mostrados. El valor interno conserva su precisión. */
  readonly decimals?: number;
}

/**
 * Campo numérico.
 *
 * Mantiene el texto que el usuario está escribiendo separado del valor
 * numérico. Sin esa separación, escribir «-» o «0.» —estados intermedios
 * perfectamente normales— se convertiría en `NaN` y el campo se vaciaría solo
 * a mitad de la escritura.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, min, max, step = 1, unit, decimals, invalid = false, ...rest },
  ref,
) {
  const format = useCallback(
    (n: number): string => (decimals === undefined ? String(n) : n.toFixed(decimals)),
    [decimals],
  );
  const [draft, setDraft] = useState(() => format(value));
  const [editing, setEditing] = useState(false);
  /**
   * Marca que la edición se está cancelando con Escape.
   *
   * Escape desenfoca el campo, y el desenfoque confirma: sin esta marca, el
   * `blur` que provoca la propia cancelación lee el valor que hay todavía en
   * el DOM y lo confirma, de modo que Escape acabaría haciendo exactamente lo
   * contrario de lo que promete.
   */
  const cancelling = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(format(value));
  }, [value, editing, format]);

  const commit = (raw: string): void => {
    const parsed = Number(raw.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    let next = parsed;
    if (min !== undefined) next = Math.max(next, min);
    if (max !== undefined) next = Math.min(next, max);
    onValueChange(next);
    setDraft(format(next));
  };

  return (
    <TextInput
      ref={ref}
      inputMode="decimal"
      value={draft}
      invalid={invalid}
      mono
      suffix={unit}
      onFocus={(event) => {
        setEditing(true);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        setEditing(false);
        if (cancelling.current) {
          cancelling.current = false;
          setDraft(format(value));
          return;
        }
        commit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'Escape') {
          cancelling.current = true;
          setDraft(format(value));
          setEditing(false);
          event.currentTarget.blur();
          return;
        }
        // Las flechas ajustan el valor; con Mayús el paso es diez veces mayor,
        // que es la convención de cualquier editor y evita arrastrar el ratón
        // para un cambio grande.
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
          commit(String((Number(draft.replace(',', '.')) || value) + delta));
        }
      }}
      {...rest}
    />
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
  readonly autoGrow?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid = false, autoGrow = false, className, onChange, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx('it-textarea', invalid && 'it-textarea--invalid', className)}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        if (autoGrow) {
          const el = event.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${el.scrollHeight}px`;
        }
        onChange?.(event);
      }}
      {...rest}
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  readonly invalid?: boolean;
  /** Tamaño del sistema de diseño; sustituye al `size` nativo del elemento. */
  readonly size?: ControlSize;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <span className={cx('it-select', `it-select--${size}`, invalid && 'it-select--invalid', className)}>
      <select ref={ref} className="it-select__el" aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
      <svg className="it-select__chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5 6 8l3-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label?: ReactNode;
  /** Estado intermedio: algunos hijos marcados y otros no. */
  readonly indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, className, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inner.current !== null) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={cx('it-check', className)}>
      <input
        ref={(node) => {
          inner.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref !== null) ref.current = node;
        }}
        type="checkbox"
        className="it-check__input"
        {...rest}
      />
      <span className="it-check__box" aria-hidden="true">
        <svg viewBox="0 0 12 12">
          {indeterminate ? (
            <path d="M3 6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            <path d="m2.5 6.2 2.3 2.3L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </span>
      {label !== undefined && <span className="it-check__label">{label}</span>}
    </label>
  );
});

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label?: ReactNode;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, ...rest },
  ref,
) {
  return (
    <label className={cx('it-switch', className)}>
      <input ref={ref} type="checkbox" role="switch" className="it-switch__input" {...rest} />
      <span className="it-switch__track" aria-hidden="true">
        <span className="it-switch__thumb" />
      </span>
      {label !== undefined && <span className="it-switch__label">{label}</span>}
    </label>
  );
});

/* ------------------------------------------------------------------ *
 * Deslizador con valor numérico
 * ------------------------------------------------------------------ */

export interface SliderProps {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly decimals?: number;
  readonly disabled?: boolean;
  readonly 'aria-label'?: string;
}

/**
 * Deslizador acompañado de campo numérico.
 *
 * Los dos controles juntos y no uno u otro: el deslizador sirve para explorar
 * («¿cuánta inercia se siente bien?») y el campo para reproducir un valor
 * exacto («la otra escena tiene 0,82»). En un editor hacen falta ambos.
 */
export function Slider({
  value,
  onValueChange,
  min,
  max,
  step = 0.01,
  unit,
  decimals = 2,
  disabled = false,
  'aria-label': ariaLabel,
}: SliderProps): JSX.Element {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="it-slider">
      <input
        type="range"
        className="it-slider__range"
        style={{ ['--it-slider-fill' as string]: `${percent}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onValueChange(Number(event.currentTarget.value))}
      />
      <NumberInput
        value={value}
        onValueChange={onValueChange}
        min={min}
        max={max}
        step={step}
        decimals={decimals}
        {...(unit !== undefined ? { unit } : {})}
        disabled={disabled}
        size="sm"
        className="it-slider__number"
        aria-label={ariaLabel !== undefined ? `${ariaLabel} (valor exacto)` : undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Etiquetas y estado
 * ------------------------------------------------------------------ */

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: Tone;
  readonly mono?: boolean;
  readonly dot?: boolean;
}

export function Badge({ tone = 'neutral', mono = false, dot = false, className, children, ...rest }: BadgeProps): JSX.Element {
  return (
    <span
      className={cx('it-badge', mono && 'it-badge--mono', className)}
      style={{ color: toneColor(tone), background: toneSurface(tone) }}
      {...rest}
    >
      {dot && <span className="it-badge__dot" style={{ background: toneColor(tone) }} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** TAG industrial. Siempre monoespaciado y seleccionable de un clic. */
export function Tag({ children, onClick }: { children: ReactNode; onClick?: () => void }): JSX.Element {
  return onClick !== undefined ? (
    <button type="button" className="it-tag it-tag--button" onClick={onClick}>
      {children}
    </button>
  ) : (
    <span className="it-tag">{children}</span>
  );
}

/* ------------------------------------------------------------------ *
 * Superficies
 * ------------------------------------------------------------------ */

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Encabezado del panel. Admite nodos para incluir iconos o recuentos. */
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly level?: 'base' | 'raised' | 'overlay';
  readonly padded?: boolean;
  readonly scroll?: boolean;
}

export function Panel({
  title,
  actions,
  level = 'raised',
  padded = true,
  scroll = false,
  className,
  children,
  ...rest
}: PanelProps): JSX.Element {
  return (
    <section className={cx('it-panel', `it-panel--${level}`, className)} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <header className="it-panel__head">
          {title !== undefined && <h2 className="it-panel__title">{title}</h2>}
          {actions !== undefined && <div className="it-panel__actions">{actions}</div>}
        </header>
      )}
      <div className={cx('it-panel__body', padded && 'it-panel__body--padded', scroll && 'it-panel__body--scroll')}>
        {children}
      </div>
    </section>
  );
}

/** Rótulo de grupo en versalitas: separa secciones de un panel denso. */
export function SectionLabel({ children, actions }: { children: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className="it-section-label">
      <span>{children}</span>
      {actions}
      <span className="it-section-label__rule" aria-hidden="true" />
    </div>
  );
}

export function Divider({ vertical = false }: { vertical?: boolean }): JSX.Element {
  return <span className={cx('it-divider', vertical && 'it-divider--v')} role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} />;
}

/* ------------------------------------------------------------------ *
 * Estados vacío, de carga y de error
 * ------------------------------------------------------------------ */

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly tone?: Tone;
}

/**
 * Estado vacío.
 *
 * La etapa 00 exige estados de vacío, cargando, éxito, error y recuperación
 * en cada pantalla. Tenerlos como componente evita que cada vista invente el
 * suyo y que alguna se quede sin ninguno, que es el caso habitual: una lista
 * vacía sin explicación parece una lista rota.
 */
export function EmptyState({ icon, title, description, action, tone = 'neutral' }: EmptyStateProps): JSX.Element {
  return (
    <div className="it-empty">
      {icon !== undefined && (
        <span className="it-empty__icon" style={{ color: toneColor(tone) }} aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="it-empty__title">{title}</p>
      {description !== undefined && <p className="it-empty__description">{description}</p>}
      {action !== undefined && <div className="it-empty__action">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Cargando…' }: { label?: string }): JSX.Element {
  return (
    <div className="it-empty">
      <Spinner size={22} label={label} />
      <p className="it-empty__title">{label}</p>
    </div>
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly detail?: string;
  readonly recovery?: string;
  readonly action?: ReactNode;
}

/**
 * Estado de error.
 *
 * Muestra la recuperación junto al error porque un mensaje que dice qué ha
 * fallado y no qué hacer obliga al usuario a adivinar, y en un entorno
 * industrial adivinar significa llamar a soporte.
 */
export function ErrorState({ title, detail, recovery, action }: ErrorStateProps): JSX.Element {
  return (
    <div className="it-empty it-empty--error" role="alert">
      <span className="it-empty__icon" style={{ color: toneColor('alarm') }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.2v.6" strokeLinecap="round" />
        </svg>
      </span>
      <p className="it-empty__title">{title}</p>
      {detail !== undefined && <p className="it-empty__description">{detail}</p>}
      {recovery !== undefined && <p className="it-empty__recovery">{recovery}</p>}
      {action !== undefined && <div className="it-empty__action">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pestañas
 * ------------------------------------------------------------------ */

interface TabsContextValue {
  readonly active: string;
  readonly setActive: (id: string) => void;
  readonly baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Tabs({ value, onValueChange, children, className }: TabsProps): JSX.Element {
  const baseId = useId();
  const context = useMemo(
    () => ({ active: value, setActive: onValueChange, baseId }),
    [value, onValueChange, baseId],
  );
  return (
    <TabsContext.Provider value={context}>
      <div className={cx('it-tabs', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

/**
 * Lista de pestañas con navegación por teclado.
 *
 * Las flechas mueven entre pestañas y Inicio/Fin van a los extremos, que es
 * lo que el patrón ARIA de pestañas exige y lo que un usuario de teclado
 * espera. Sin esto, tabular recorre una a una las doce pestañas antes de
 * llegar al contenido.
 */
export function TabList({ children, label }: { children: ReactNode; label: string }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    if (tabs.length === 0) return;
    const index = tabs.findIndex((t) => t === document.activeElement);
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <div ref={ref} className="it-tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export function Tab({
  id,
  icon,
  badge,
  children,
  disabled = false,
}: {
  id: string;
  icon?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}): JSX.Element {
  const context = useContext(TabsContext);
  if (context === null) throw new Error('<Tab> debe usarse dentro de <Tabs>');
  const selected = context.active === id;
  return (
    <button
      type="button"
      role="tab"
      id={`${context.baseId}-tab-${id}`}
      aria-selected={selected}
      aria-controls={`${context.baseId}-panel-${id}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={cx('it-tab', selected && 'it-tab--active')}
      onClick={() => context.setActive(id)}
    >
      {icon}
      <span>{children}</span>
      {badge !== undefined && <span className="it-tab__badge">{badge}</span>}
    </button>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }): JSX.Element | null {
  const context = useContext(TabsContext);
  if (context === null) throw new Error('<TabPanel> debe usarse dentro de <Tabs>');
  if (context.active !== id) return null;
  return (
    <div
      role="tabpanel"
      id={`${context.baseId}-panel-${id}`}
      aria-labelledby={`${context.baseId}-tab-${id}`}
      className="it-tabs__panel"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
