/**
 * Previsualización del recorrido desde la escena que se edita (Y07).
 *
 * Monta **el mismo componente** que ejecuta el visitante, con el proyecto que
 * está en memoria. Es la razón de que el recorrido viva en su propio paquete:
 * una previsualización escrita aparte sería una segunda implementación del
 * visor, y lo que el autor aprobara mirándola no sería lo que se publica.
 *
 * Tres cosas que esta ventana hace y conviene no perder:
 *
 * **Entra por la escena que se está editando**, con la orientación que el
 * autor tiene en el lienzo. Previsualizar desde el principio del recorrido
 * obligaría a volver a navegar hasta donde se estaba cada vez.
 *
 * **Avisa de lo que no se va a publicar.** El manifiesto es una proyección con
 * pérdida: las escenas en borrador, los marcadores automáticos sin revisar y
 * las ventanas que no abre nadie se quedan fuera. Si la escena que se edita es
 * una de ellas, verla aquí sería engañoso, así que se dice.
 *
 * **No toca el disco.** Las direcciones de los medios son las que el editor ya
 * tiene; no se escribe ningún paquete temporal. Aparte de ser más rápido, un
 * paquete temporal exigiría un servidor local: el visor pide su manifiesto con
 * `fetch`, y desde `file://` el navegador lo bloquea.
 */
import { useMemo } from 'react';
import {
  toManifest,
  type CameraView,
  type Project,
  type Scene,
} from '@it360/domain';
import { Button, Callout, Dialog } from '@it360/ui';
import { TourViewer, type LoadedTour } from '@it360/tour';

export interface PreviewDialogProps {
  readonly project: Project;
  readonly mediaUrls: ReadonlyMap<string, string>;
  /** Escena que el autor está editando. */
  readonly sceneId: string | null;
  /** Orientación actual del lienzo, para entrar mirando a lo mismo. */
  readonly view: CameraView | null;
  readonly appVersion: string;
  readonly onClose: () => void;
}

export function PreviewDialog({
  project,
  mediaUrls,
  sceneId,
  view,
  appVersion,
  onClose,
}: PreviewDialogProps): JSX.Element {
  const tour = useMemo<LoadedTour>(() => {
    const manifest = toManifest(project, {
      publishedAt: new Date().toISOString(),
      appVersion,
      // Sin conexión: la previsualización no debe salir a pedir telemetría a
      // la planta. El autor está probando la interfaz, no el proceso.
      offlineCapable: true,
    });

    return {
      manifest,
      // Vacío: nada de lo que el visor pide por red tiene sentido aquí, y una
      // base inventada haría peticiones a direcciones que no existen.
      baseUrl: '',
      mediaUrls,
    };
  }, [project, mediaUrls, appVersion]);

  /* Escena por la que entrar: la que se edita, si de verdad se publica. */
  const target = useMemo<Scene | null>(() => {
    if (sceneId === null) return null;
    return tour.manifest.scenes.find((candidate) => candidate.id === sceneId) ?? null;
  }, [tour.manifest.scenes, sceneId]);

  const editing = project.scenes.find((candidate) => candidate.id === sceneId) ?? null;
  const excluded = editing !== null && target === null;

  /* El enlace profundo es la vía por la que el visor acepta una escena y una
     orientación de entrada: la misma que usa un enlace compartido, así que no
     hay un segundo camino de entrada que pueda comportarse distinto. */
  const entry = useMemo(() => {
    if (target === null) return '';
    const parts = [`escena=${encodeURIComponent(target.id)}`];
    if (view !== null) {
      parts.push(
        `yaw=${((view.yaw * 180) / Math.PI).toFixed(1)}`,
        `pitch=${((view.pitch * 180) / Math.PI).toFixed(1)}`,
        `fov=${view.fov.toFixed(1)}`,
      );
    }
    return `#${parts.join('&')}`;
  }, [target, view]);

  return (
    <Dialog
      open
      size="xl"
      title="Previsualización del recorrido"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="preview">
        {excluded && (
          <Callout tone="warning" title="La escena que está editando no se publicaría">
            «{editing?.title ?? ''}» está en borrador o excluida, así que no entra en el paquete y
            la previsualización empieza por otra. Publíquela para verla aquí.
          </Callout>
        )}

        {tour.manifest.scenes.length === 0 ? (
          <Callout tone="alarm" title="No hay ninguna escena publicable">
            Un recorrido necesita al menos una escena publicada. Revise el estado de las escenas.
          </Callout>
        ) : (
          <div className="preview__stage">
            <TourViewer key={entry} tour={tour} initialHash={entry} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
