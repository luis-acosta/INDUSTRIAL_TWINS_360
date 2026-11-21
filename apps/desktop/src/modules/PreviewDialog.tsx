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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  toManifest,
  type CameraView,
  type Project,
  type Scene,
} from '@it360/domain';
import { Button, Callout, Dialog, Tooltip, useToast } from '@it360/ui';
import { TourViewer, type LoadedTour } from '@it360/tour';
import {
  captureFileName,
  captureSupport,
  runSandboxed,
  startCapture,
  type CaptureHandle,
} from '@it360/viewer';
import {
  decideScriptExecution,
  scriptDigest,
  SCRIPTING_MODE_LABELS,
  type Action,
  type SkinNode,
} from '@it360/domain';
import { saveBinaryFile } from '../platform/save-file';

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

  /**
   * Grabación del recorrido en vídeo (S07).
   *
   * El lienzo se busca al empezar y no se guarda en una referencia del
   * componente: el visor lo monta y lo desmonta al cambiar entre una escena
   * panorámica y una de modelo, y una referencia vieja grabaría un lienzo que
   * ya no se dibuja —un vídeo en negro que sólo se descubre al abrirlo—.
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CaptureHandle | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const { push } = useToast();

  const support = useMemo(() => captureSupport(), []);

  /**
   * Guiones que el proyecto lleva, buscados en las acciones de sus puntos de
   * interés y de su piel (J09).
   *
   * Se buscan en lugar de guardarse en una lista aparte: una lista aparte se
   * desincroniza con las acciones reales, y entonces el autor probaría un
   * guion que ya no está en ninguna acción.
   */
  const scriptActions = useMemo(() => {
    const found: { readonly source: string; readonly purpose: string }[] = [];
    const visit = (actions: readonly Action[]): void => {
      for (const action of actions) {
        if (action.config.type === 'runScript') {
          found.push({ source: action.config.source, purpose: action.config.purpose });
        }
      }
    };

    for (const scene of project.scenes) {
      for (const hotspot of scene.hotspots) visit(hotspot.actions);
    }
    const walkSkin = (nodes: readonly SkinNode[]): void => {
      for (const node of nodes) {
        visit(node.actions);
        walkSkin(node.children);
      }
    };
    for (const skin of project.skins) walkSkin(skin.root);

    return found;
  }, [project.scenes, project.skins]);

  /**
   * Ejecución de guiones del autor en la previsualización (J09).
   *
   * Pasa por la política antes de ejecutar nada, y ése es el orden que importa:
   * la decisión está escrita en el dominio desde la etapa 02 y hasta ahora no
   * la usaba nadie, de modo que el ajuste de seguridad no gobernaba nada.
   *
   * Se ejecuta aquí y no en el recorrido publicado: la previsualización es
   * donde el autor prueba su guion, y un paquete publicado es de sólo lectura y
   * se sirve como archivos estáticos —añadirle código del autor amplía su
   * superficie sin que nadie vuelva a revisarlo—.
   */
  const runAuthorScript = useCallback(
    async (source: string): Promise<void> => {
      const sha256 = await scriptDigest(source, globalThis.crypto?.subtle);
      if (sha256 === null) {
        /* Sin SHA-256 no se puede distinguir un guion aprobado de uno que no
           lo está, y no hay reserva aceptable: una huella de los primeros
           bytes dejaría pasar cualquier guion que empezara igual que uno
           aprobado. */
        push({
          tone: 'alarm',
          title: 'Guion no ejecutado',
          description:
            'Este entorno no ofrece SHA-256, así que no se puede comprobar si el guion está aprobado.',
        });
        return;
      }

      const decision = decideScriptExecution(project.settings.scripting, sha256, {
        published: false,
        // En local, el administrador es quien usa el equipo: el modelo de
        // acceso del servicio no gobierna la aplicación de escritorio, y
        // fingir que sí lo hace daría una falsa sensación de control.
        isAdministrator: true,
      });

      if (!decision.allowed) {
        push({ tone: 'warning', title: 'Guion no ejecutado', description: decision.message });
        return;
      }

      const result = await runSandboxed(source, {
        timeoutMs: project.settings.scripting.timeoutMs,
        api: {
          getSceneId: () => sceneId,
          // Las variables del recorrido no se exponen a la previsualización
          // todavía: devolver `null` es decir «no hay», que es verdad, en lugar
          // de inventar un valor que el autor tomaría por real.
          getVariable: () => null,
          setVariable: () => undefined,
          goToScene: () => undefined,
          setNodeVisible: () => undefined,
          log: (message) => push({ tone: 'info', title: 'Guion', description: message }),
        },
      });

      if (!result.ok) {
        push({
          tone: 'alarm',
          title: 'El guion falló',
          description: `${result.error.message}${result.error.recovery === undefined ? '' : ` ${result.error.recovery}`}`,
        });
      }
    },
    [project.settings.scripting, sceneId, push],
  );


  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => setElapsedMs(handleRef.current?.elapsedMs() ?? 0), 500);
    return () => clearInterval(timer);
  }, [recording]);

  const toggleCapture = useCallback(async (): Promise<void> => {
    if (handleRef.current !== null) {
      setSaving(true);
      try {
        const blob = await handleRef.current.stop();
        handleRef.current = null;
        setRecording(false);
        setElapsedMs(0);

        if (blob.size === 0) {
          push({
            tone: 'alarm',
            title: 'La grabación salió vacía',
            description:
              'El navegador no entregó ningún fotograma. Pruebe a grabar con la vista en movimiento.',
          });
          return;
        }

        const name = captureFileName(
          project.title,
          support.mimeType ?? 'video/webm',
          new Date(),
        );
        const saved = await saveBinaryFile(name, new Uint8Array(await blob.arrayBuffer()));
        push(
          saved
            ? { tone: 'nominal', title: `Vídeo guardado como «${name}»` }
            : { tone: 'warning', title: 'No se guardó el vídeo' },
        );
      } finally {
        setSaving(false);
      }
      return;
    }

    const canvas = stageRef.current?.querySelector('canvas') ?? null;
    if (canvas === null) {
      push({
        tone: 'alarm',
        title: 'Todavía no hay nada que grabar',
        description: 'Espere a que la escena termine de cargarse y vuelva a intentarlo.',
      });
      return;
    }

    handleRef.current = startCapture(canvas);
    setRecording(true);
  }, [project.title, push, support.mimeType]);

  const capture = { support, recording, saving, elapsedMs, toggle: toggleCapture };

  return (
    <Dialog
      open
      size="xl"
      title="Previsualización del recorrido"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 'var(--it-space-2)', alignItems: 'center' }}>
          {/* Grabación del recorrido en vídeo (S07). Va aquí y no en
              Publicación porque lo que se graba es esto: lo que el autor está
              viendo, con la visita que acabe de arrancar. */}
          {capture.support.supported ? (
            <Button
              variant={capture.recording ? 'danger' : 'secondary'}
              onClick={() => void capture.toggle()}
              disabled={capture.saving}
            >
              {capture.recording
                ? `Detener y guardar (${Math.floor(capture.elapsedMs / 1000)} s)`
                : 'Grabar vídeo'}
            </Button>
          ) : (
            <Tooltip content={capture.support.reason ?? ''}>
              <span>
                <Button variant="secondary" disabled>
                  Grabar vídeo
                </Button>
              </span>
            </Tooltip>
          )}
          <Button variant="primary" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      }
    >
      <div className="preview">
        {/* Guiones del autor (J09). Se listan los que el proyecto tiene y se
            ejecutan aquí, que es donde el autor los prueba; el recorrido
            publicado no ejecuta código del autor salvo que se habilite
            expresamente. */}
        {scriptActions.length > 0 && (
          <div className="preview__scripts">
            <p className="preview__scripts-title">
              Guiones del proyecto ({SCRIPTING_MODE_LABELS[project.settings.scripting.mode]})
            </p>
            {scriptActions.map((entry, index) => (
              <div key={`${entry.purpose}-${index}`} className="preview__scripts-row">
                <code>{entry.purpose || 'sin descripción'}</code>
                <Button size="sm" variant="secondary" onClick={() => void runAuthorScript(entry.source)}>
                  Ejecutar
                </Button>
              </div>
            ))}
          </div>
        )}

        {capture.recording && (
          <Callout tone="info" title="Grabando la vista del recorrido">
            Se graba el lienzo: la panorámica o el modelo con sus marcadores. Los paneles de la
            interfaz son HTML encima del lienzo y no entran en el vídeo, y el audio de las
            narraciones tampoco. Arranque la visita guiada y deje que avance.
          </Callout>
        )}
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
          <div className="preview__stage" ref={stageRef}>
            <TourViewer key={entry} tour={tour} initialHash={entry} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
