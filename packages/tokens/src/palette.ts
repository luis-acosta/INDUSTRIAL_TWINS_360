/**
 * INDUSTRIAL TWINS 360 — Paleta primitiva.
 *
 * Capa 1 del sistema de diseño: valores crudos, sin significado semántico.
 * Nunca se usan directamente en componentes; se consumen a través de
 * `semantic.ts`, que les asigna un rol por tema (oscuro / claro).
 *
 * Criterios de la paleta:
 *  - Neutros fríos de base grafito: la referencia son salas de control y
 *    equipos de instrumentación, no interfaces de consumo.
 *  - Un único acento cromático (cian industrial) para acción e interacción.
 *    El color se reserva para el estado del proceso, no para decorar.
 *  - Estados operacionales con contraste suficiente sobre fondo oscuro y
 *    claro (verificado en `contrast.test.ts` contra WCAG 2.1 AA).
 */

/** Neutros fríos. 0 = casi negro, 1000 = blanco. */
export const neutral = {
  0: '#05070A',
  25: '#0B0E13',
  50: '#11151C',
  75: '#171C25',
  100: '#1E242F',
  150: '#262E3B',
  200: '#313B4C',
  250: '#3D4959',
  300: '#4B5768',
  400: '#6B7687',
  500: '#8A94A6',
  600: '#A3ADBF',
  700: '#C2CAD8',
  800: '#DCE2EC',
  850: '#E6EAF2',
  900: '#F1F4F9',
  950: '#F8FAFC',
  1000: '#FFFFFF',
} as const;

/** Cian industrial: acento primario de acción. */
export const cyan = {
  50: '#E6F7F9',
  100: '#C0EBF0',
  200: '#8ADAE3',
  300: '#4EC4D2',
  400: '#22AEBF',
  500: '#12A5B8',
  600: '#0E8A9A',
  700: '#0B6E7B',
  800: '#08525C',
  900: '#063A41',
  950: '#042429',
} as const;

/** Verde: condición nominal, dato fresco, prueba en verde. */
export const green = {
  50: '#E8F8EE',
  100: '#C6EDD6',
  200: '#94DCB2',
  300: '#5CC68B',
  400: '#2FAE6B',
  500: '#21A663',
  600: '#1A8751',
  700: '#156B40',
  800: '#0F4F2F',
  900: '#0A3620',
  950: '#062213',
} as const;

/** Ámbar: advertencia, dato obsoleto, revisión pendiente. */
export const amber = {
  50: '#FDF4E3',
  100: '#FAE6BE',
  200: '#F4CE80',
  300: '#EBB341',
  400: '#DFA017',
  500: '#D99A0B',
  600: '#B47F08',
  700: '#8E6406',
  800: '#684905',
  900: '#473203',
  950: '#2B1E02',
} as const;

/** Rojo: alarma, error de lectura, bloqueo de release. */
export const red = {
  50: '#FCECEC',
  100: '#F8D2D2',
  200: '#F0A8A8',
  300: '#E57878',
  400: '#DA5555',
  500: '#D64545',
  600: '#B63636',
  700: '#912A2A',
  800: '#6B1F1F',
  900: '#4A1515',
  950: '#2C0D0D',
} as const;

/** Azul: información, enlaces, selección en lienzo. */
export const blue = {
  50: '#EAF1FE',
  100: '#CFDEFC',
  200: '#A3C0F9',
  300: '#6E9CF5',
  400: '#4480F0',
  500: '#2F6FE4',
  600: '#2459BC',
  700: '#1C4694',
  800: '#15336C',
  900: '#0E2349',
  950: '#08162D',
} as const;

/** Violeta: datos derivados, caché, modo experimental. */
export const violet = {
  50: '#F1EDFB',
  100: '#DFD6F6',
  200: '#C2B1EC',
  300: '#A288E0',
  400: '#8867D4',
  500: '#7B57CC',
  600: '#6544AB',
  700: '#503589',
  800: '#3B2766',
  900: '#281A46',
  950: '#18102B',
} as const;

export const palette = { neutral, cyan, green, amber, red, blue, violet } as const;

export type PaletteFamily = keyof typeof palette;
export type PaletteRef = `${PaletteFamily}.${number}`;

/** Resuelve una referencia `familia.tono` a su valor hexadecimal. */
export function resolvePaletteRef(ref: PaletteRef): string {
  const [family, shade] = ref.split('.') as [PaletteFamily, string];
  const scale = palette[family] as Record<string, string | undefined>;
  const value = scale[shade];
  if (value === undefined) {
    throw new Error(`Referencia de paleta desconocida: ${ref}`);
  }
  return value;
}
