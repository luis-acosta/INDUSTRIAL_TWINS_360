/**
 * Iconografía.
 *
 * Trazo de 1.5 px sobre una rejilla de 24, sin relleno, con terminaciones y
 * uniones redondeadas. Un único estilo para todo el producto: mezclar iconos
 * de relleno con iconos de contorno es lo que hace que una interfaz parezca
 * ensamblada con piezas de sitios distintos.
 *
 * Son dibujos propios, no una familia de terceros: evita arrastrar una
 * dependencia que haya que servir sin conexión (S05) y permite ajustar los
 * glifos industriales —panorama, instrumento, plano— que ninguna familia
 * genérica trae.
 */
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly size?: number;
  readonly title?: string;
}

function Icon({ size = 16, title, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title !== undefined ? 'img' : undefined}
      aria-hidden={title === undefined || undefined}
      focusable="false"
      {...rest}
    >
      {title !== undefined && <title>{title}</title>}
      {children}
    </svg>
  );
}

/* --- Navegación y estructura --- */

export const IconPanorama = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M21 6.2v11.6c-3 .9-6 1.4-9 1.4s-6-.5-9-1.4V6.2c3-.9 6-1.4 9-1.4s6 .5 9 1.4Z" />
    <path d="m6 14 3.2-3.6 2.6 2.6 2.4-3L18 14" />
  </Icon>
);

export const IconScene = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 4.5v3.3M12 16.2v3.3M3 12h3.3M17.7 12H21" />
  </Icon>
);

export const IconModel3d = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </Icon>
);

export const IconPlan = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M3 10h7V4M10 10v10M14 20v-6h7" />
  </Icon>
);

export const IconHotspot = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="7.5" strokeDasharray="2.5 2.5" />
  </Icon>
);

export const IconPolygon = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m12 3.5 7.5 5.2-2.9 8.8H7.4L4.5 8.7 12 3.5Z" />
    <circle cx="12" cy="3.5" r="1.4" />
    <circle cx="19.5" cy="8.7" r="1.4" />
    <circle cx="4.5" cy="8.7" r="1.4" />
  </Icon>
);

/* --- Catálogo industrial --- */

export const IconPlant = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3 20h18M4.5 20V9l5 3V9l5 3V6l5 3v11" />
    <path d="M8 20v-3.5h3V20" />
  </Icon>
);

export const IconEquipment = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4.2v2.3M12 17.5v2.3M19.8 12h-2.3M6.5 12H4.2M17.5 6.5l-1.6 1.6M8.1 15.9l-1.6 1.6M17.5 17.5l-1.6-1.6M8.1 8.1 6.5 6.5" />
  </Icon>
);

export const IconInstrument = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 12 15.5 8.8" />
    <path d="M6.6 15.5A6.5 6.5 0 0 1 12 5.5a6.5 6.5 0 0 1 5.4 10" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconDocument = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 16.5h4" />
  </Icon>
);

/* --- Notas y colaboración --- */

export const IconNote = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3.5V6a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6v8.5Z" />
    <path d="M8.5 8h7M8.5 11.5h4.5" />
  </Icon>
);

export const IconTask = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="4" y="4.5" width="16" height="15" rx="2" />
    <path d="m8 12 2.6 2.6L16 9.2" />
  </Icon>
);

export const IconUsers = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.8a3.2 3.2 0 0 1 0 5.6M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
  </Icon>
);

/* --- Telemetría --- */

export const IconTelemetry = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3 16.5h3l2.5-7 3 11 2.6-9 2 5H21" />
  </Icon>
);

export const IconHistory = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.2 4.8v3.9h3.9M12 7.8V12l3 1.8" />
  </Icon>
);

export const IconAlarm = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M12 3.5 21 19.5H3L12 3.5Z" />
    <path d="M12 9.5v4.2M12 16.6v.6" />
  </Icon>
);

/* --- Edición --- */

export const IconUndo = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 9h10a5 5 0 0 1 0 10h-4" />
    <path d="M7.5 5.5 4 9l3.5 3.5" />
  </Icon>
);

export const IconRedo = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M20 9H10a5 5 0 0 0 0 10h4" />
    <path d="M16.5 5.5 20 9l-3.5 3.5" />
  </Icon>
);

export const IconSave = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M5 4.5h11L19.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V6a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M8 4.5v5h7M8 20v-5.5h8V20" />
  </Icon>
);

export const IconAdd = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconTrash = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
    <path d="M10.5 10v6.5M13.5 10v6.5" />
  </Icon>
);

export const IconCopy = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8" />
    <path d="M15.5 8.5V5.8A1.8 1.8 0 0 0 13.7 4H5.8A1.8 1.8 0 0 0 4 5.8v7.9A1.8 1.8 0 0 0 5.8 15.5h2.7" />
  </Icon>
);

export const IconLock = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" />
  </Icon>
);

export const IconEye = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);

export const IconEyeOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M9.6 6.1A8.9 8.9 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a16 16 0 0 1-3 3.8M6.2 8.2A16 16 0 0 0 2.5 12s3.5 6.2 9.5 6.2a8.6 8.6 0 0 0 3.2-.6" />
    <path d="M10.2 10.2a2.8 2.8 0 0 0 3.7 3.7M4 4l16 16" />
  </Icon>
);

export const IconSearch = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.4 15.4 4.6 4.6" />
  </Icon>
);

export const IconFilter = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 5.5h16l-6.2 7.3v5.6l-3.6 2v-7.6L4 5.5Z" />
  </Icon>
);

export const IconSettings = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.8" />
    <path d="M19.2 14.4a1.4 1.4 0 0 0 .3 1.6l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.4 1.4 0 0 0-1.6-.3 1.4 1.4 0 0 0-.8 1.3v.2a1.7 1.7 0 1 1-3.4 0v-.1a1.4 1.4 0 0 0-.9-1.3 1.4 1.4 0 0 0-1.6.3l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.4 1.4 0 0 0 .3-1.6 1.4 1.4 0 0 0-1.3-.8h-.2a1.7 1.7 0 0 1 0-3.4h.1a1.4 1.4 0 0 0 1.3-.9 1.4 1.4 0 0 0-.3-1.6l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.4 1.4 0 0 0 1.6.3h.1a1.4 1.4 0 0 0 .8-1.3v-.2a1.7 1.7 0 0 1 3.4 0v.1a1.4 1.4 0 0 0 .8 1.3 1.4 1.4 0 0 0 1.6-.3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.4 1.4 0 0 0-.3 1.6v.1a1.4 1.4 0 0 0 1.3.8h.2a1.7 1.7 0 0 1 0 3.4h-.1a1.4 1.4 0 0 0-1.3.8Z" />
  </Icon>
);

/* --- Visor y recorrido --- */

export const IconPlay = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M7.5 5.2 19 12 7.5 18.8V5.2Z" />
  </Icon>
);

export const IconPause = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M9 5.5v13M15 5.5v13" />
  </Icon>
);

export const IconTour = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M8.3 16.4C10.8 13.4 13.4 10.8 16.4 8.3" strokeDasharray="2.5 2.5" />
  </Icon>
);

export const IconQuiz = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M9.6 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.4M12 16.6v.6" />
  </Icon>
);

export const IconVr = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 9.5A2 2 0 0 1 5.5 7.5h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-3.3a1.6 1.6 0 0 1-1.3-.7l-.9-1.3a1.2 1.2 0 0 0-2 0l-.9 1.3a1.6 1.6 0 0 1-1.3.7H5.5a2 2 0 0 1-2-2v-4Z" />
  </Icon>
);

export const IconPublish = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M12 16.5V4.5M8.2 8.3 12 4.5l3.8 3.8" />
    <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
  </Icon>
);

export const IconDownload = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M12 4.5v12M8.2 12.7 12 16.5l3.8-3.8" />
    <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
  </Icon>
);

export const IconExternal = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Icon>
);

export const IconWeb = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17Z" />
  </Icon>
);

export const IconImage = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="8.8" cy="9.8" r="1.5" />
    <path d="m4.5 17 4.8-4.8 3.4 3.4 2.6-2.6 4.2 4.2" />
  </Icon>
);

export const IconFolder = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h3.8l2 2.5h7.7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" />
  </Icon>
);

export const IconLayers = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m12 3.5 8.5 4.3L12 12 3.5 7.8 12 3.5Z" />
    <path d="m3.5 12 8.5 4.3 8.5-4.3M3.5 16.2l8.5 4.3 8.5-4.3" />
  </Icon>
);

export const IconCheck = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const IconClose = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconChevronRight = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Icon>
);

export const IconMore = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="5.5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="1.2" fill="currentColor" />
  </Icon>
);

export const IconExperimental = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M9.5 3.5h5M10.5 3.5v6L5.2 18a1.6 1.6 0 0 0 1.4 2.5h10.8a1.6 1.6 0 0 0 1.4-2.5l-5.3-8.5v-6" />
    <path d="M8 14.5h8" />
  </Icon>
);
