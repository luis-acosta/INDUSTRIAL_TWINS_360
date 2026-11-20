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
import '@it360/tour/tour.css';
import {
  NotesClient,
  loadTour,
  notesBaseUrl,
  TourViewer,
  type LoadedTour,
  type NotesIdentity,
} from '@it360/tour';
import { textOnAccent } from '@it360/domain';

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
  //
  // Con el acento va su color de texto (S10): el sistema de diseño trae uno
  // fijo por tema, y con un acento claro del cliente la etiqueta de un botón
  // queda ilegible. El paquete lo escribe en su HTML, pero esta ruta vuelve a
  // poner el acento en tiempo de ejecución, y poner uno sin el otro deshacía
  // justamente el arreglo.
  if (tour.manifest.branding.accentColor !== null) {
    document.documentElement.style.setProperty(
      '--it-color-accent-default',
      tour.manifest.branding.accentColor,
    );
    document.documentElement.style.setProperty(
      '--it-color-text-onAccent',
      textOnAccent(tour.manifest.branding.accentColor),
    );
  }
  document.title = tour.manifest.branding.title || tour.manifest.title;

  /* Notas del proyecto, si hay servicio y alguien se ha identificado en este
     dispositivo (P09). Sin una de las dos cosas no se ofrece el botón: uno que
     llevara a una lista vacía haría creer que el proyecto no tiene notas. */
  const notesBase = notesBaseUrl(
    tour.manifest.telemetryMappings[0]?.serviceEndpoint,
    tour.baseUrl,
  );
  const notesClient =
    notesBase === null
      ? null
      : (identity: NotesIdentity) => new NotesClient(notesBase, identity);

  return (
    <TourViewer
      tour={tour}
      notesClient={notesClient}
      projectId={tour.manifest.projectId}
    />
  );
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
