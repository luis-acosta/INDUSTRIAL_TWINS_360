/**
 * Selector de tema.
 *
 * Tres opciones y no dos: en una sala de control con turno de día y de noche
 * la preferencia del sistema operativo ya recoge la decisión, y obligar a
 * cambiarla en dos sitios es trabajo que nadie hace.
 */
import { useEffect, useState } from 'react';
import {
  applyTheme,
  Menu,
  readStoredTheme,
  storeTheme,
  THEME_LABELS,
  Button,
  IconCheck,
  IconEye,
  type ThemePreference,
} from '@it360/ui';

export function ThemeToggle(): JSX.Element {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(preference, document.documentElement);
    storeTheme(preference);
  }, [preference]);

  return (
    <Menu
      label="Tema de la interfaz"
      align="end"
      trigger={(props) => (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<IconEye size={15} />}
          aria-label={`Tema: ${THEME_LABELS[preference]}`}
          {...props}
        />
      )}
      items={(Object.keys(THEME_LABELS) as readonly ThemePreference[]).map((option) => ({
        id: option,
        label: THEME_LABELS[option],
        // La marca sustituye a un estado «activo» en el propio elemento: el
        // menú no lo tiene, y un icono de verificación se lee igual de bien.
        ...(option === preference ? { icon: <IconCheck size={13} /> } : {}),
        onSelect: () => setPreference(option),
      }))}
    />
  );
}
