/**
 * Punto de entrada de la aplicación de escritorio.
 *
 * El orden de las hojas de estilo importa: los tokens definen las variables
 * que el resto consume, así que van primero. Si se invierte, los componentes
 * se pintan con valores vacíos durante el primer renderizado.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readStoredTheme, ToastProvider } from '@it360/ui';
import '@it360/tokens/tokens.css';
import '@it360/ui/styles.css';
import '@it360/viewer/viewer.css';
import '@it360/tour/tour.css';
import './app.css';
import { AppRoot } from './App';

// El tema se aplica antes de montar para no mostrar un destello claro en una
// instalación configurada en oscuro, que es el caso habitual en sala de
// control.
applyTheme(readStoredTheme(), document.documentElement);

const host = document.getElementById('root');
if (host === null) {
  throw new Error('No se encontró el elemento raíz #root en index.html');
}

createRoot(host).render(
  <StrictMode>
    <ToastProvider>
      <AppRoot />
    </ToastProvider>
  </StrictMode>,
);
