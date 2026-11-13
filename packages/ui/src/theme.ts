/**
 * Gestión del tema.
 *
 * El tema se guarda como preferencia del usuario y se aplica en el atributo
 * `data-theme` del elemento raíz, que es lo que leen las variables de
 * `@it360/tokens`. Se expone `system` como tercera opción porque en una sala
 * de control con turno de día y de noche la preferencia del sistema operativo
 * ya recoge la decisión, y obligar a cambiarla dos veces en dos sitios es
 * trabajo que nadie hace.
 */

export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'it360.theme';

export const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  dark: 'Oscuro',
  light: 'Claro',
  system: 'Según el sistema',
};

/** Aplica la preferencia al documento. */
export function applyTheme(preference: ThemePreference, root: HTMLElement): void {
  root.setAttribute('data-theme', preference);
  root.style.colorScheme = preference === 'system' ? 'light dark' : preference;
}

/** Lee la preferencia guardada. Devuelve `dark` si no hay ninguna o falla. */
export function readStoredTheme(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  } catch {
    // Un WebView con almacenamiento restringido no debe impedir arrancar.
  }
  return 'dark';
}

export function storeTheme(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // La preferencia se pierde al cerrar; la aplicación sigue funcionando.
  }
}

/** Tema efectivo tras resolver `system` contra la preferencia del sistema. */
export function resolveTheme(preference: ThemePreference): 'dark' | 'light' {
  if (preference !== 'system') return preference;
  const prefersLight = globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches === true;
  return prefersLight ? 'light' : 'dark';
}
