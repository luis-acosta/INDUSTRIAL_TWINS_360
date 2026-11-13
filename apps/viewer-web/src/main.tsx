/**
 * Arranque del visor publicado.
 *
 * Carga el manifiesto, lo valida y monta el recorrido. Si algo falla, muestra
 * el motivo y la vía de solución en lugar de una pantalla en blanco: este
 * código se ejecuta en el equipo de un cliente, muchas veces sin nadie a quien
 * preguntar y sin consola abierta.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorState, LoadingState, ToastProvider } from '@it360/ui';
import type { DomainError } from '@it360/domain';
import '@it360/tokens/tokens.css';
import '@it360/ui/styles.css';
import '@it360/viewer/viewer.css';
import './viewer-app.css';
import { loadTour, type LoadedTour } from './manifest';
import { TourViewer } from './TourViewer';

function Root(): JSX.Element {
  const [tour, setTour] = useState<LoadedTour | null>(null);
  const [failure, setFailure] = useState<DomainError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadTour().then((result) => {
      if (cancelled) return;
      if (result.ok) setTour(result.value);
      else setFailure(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failure !== null) {
    return (
      <div className="tour tour--boot">
        <ErrorState
          title="No se pudo abrir el recorrido"
          detail={failure.message}
          {...(failure.recovery !== undefined ? { recovery: failure.recovery } : {})}
        />
      </div>
    );
  }

  if (tour === null) {
    return (
      <div className="tour tour--boot">
        <LoadingState label="Cargando el recorrido" />
      </div>
    );
  }

  // El color de acento de la marca del cliente se aplica al documento, no a un
  // contenedor: los menús y diálogos se montan en un portal fuera del árbol.
  if (tour.manifest.branding.accentColor !== null) {
    document.documentElement.style.setProperty(
      '--it-color-accent-default',
      tour.manifest.branding.accentColor,
    );
  }
  document.title = tour.manifest.branding.title || tour.manifest.title;

  return <TourViewer tour={tour} />;
}

const host = document.getElementById('recorrido');
if (host === null) {
  throw new Error('No se encontró el elemento #recorrido en index.html');
}

createRoot(host).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
);
