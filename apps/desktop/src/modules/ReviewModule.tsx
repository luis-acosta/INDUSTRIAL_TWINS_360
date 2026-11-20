/**
 * Revisión y publicación controlada (X16, X17).
 *
 * Un recorrido de planta no se publica porque alguien pulse un botón: lo edita
 * un técnico, lo revisa quien responde del área y se publica cuando está
 * aprobado. El servicio implementa ese control; este módulo es por donde se
 * usa.
 *
 * Tres cosas que esta pantalla tiene que dejar claras, porque son las que
 * hacen que el control sirva de algo:
 *
 * 1. **Qué se puede hacer ahora.** Se ofrecen las acciones del estado actual y
 *    ninguna más. Un botón que el servicio va a rechazar enseña a desconfiar
 *    de la pantalla.
 * 2. **Por qué no se puede.** Cuando el servicio rechaza por separación de
 *    funciones, el mensaje dice que lo tiene que aprobar otra persona, no un
 *    «403».
 * 3. **Qué está en conflicto.** Por nombre de escena o de activo, no por
 *    identificador: «ambos tocasteis la sala de bombas» se puede resolver.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';

import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Panel,
  PropertyList,
  PropertyRow,
  SectionLabel,
  Spinner,
  TextInput,
  useToast,
} from '@it360/ui';
import { sectionLabel, type Project } from '@it360/domain';

import {
  ACTIONS_BY_STATE,
  REVISION_ACTION_LABELS,
  REVISION_STATE_LABELS,
  type ReviewClient,
  type RevisionAction,
  type RevisionInfo,
} from '../review/review-client';

export interface ReviewModuleProps {
  readonly project: Project;
  /**
   * Cliente del servicio, o `null` si no hay servicio configurado.
   *
   * Sin servicio no hay revisión: la edición local sigue funcionando y la
   * pantalla lo explica en lugar de mostrar una lista vacía, que se leería
   * como «no hay revisiones» y no como «no hay servicio».
   */
  readonly client: ReviewClient | null;
  /** Identificador del usuario actual, para saber qué es suyo. */
  readonly currentUserId: string;
}

/** Mensaje completo de un error: el motivo y la salida. */
function explain(error: { readonly message: string; readonly recovery?: string }): string {
  return error.recovery === undefined ? error.message : `${error.message} ${error.recovery}`;
}

/** Tono del distintivo por estado. */
const STATE_TONE: Record<RevisionInfo['state'], 'neutral' | 'info' | 'warning' | 'nominal' | 'alarm'> = {
  draft: 'neutral',
  in_review: 'info',
  changes_requested: 'warning',
  approved: 'nominal',
  published: 'nominal',
  withdrawn: 'neutral',
};

export function ReviewModule({ project, client, currentUserId }: ReviewModuleProps): JSX.Element {
  const toast = useToast();
  const [revisions, setRevisions] = useState<readonly RevisionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * Dos problemas distintos y por eso dos estados.
   *
   * El de la consulta lo borra una consulta que sale bien; el de la última
   * acción, no. Con un solo estado ocurría esto: una acción rechazada ponía el
   * motivo, la recarga que viene detrás salía bien y lo borraba, y el usuario
   * no llegaba a leer por qué no se había podido.
   */
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    const result = await client.list(project.id);
    setLoading(false);
    if (result.ok) {
      setRevisions(result.value);
      setListProblem(null);
    } else {
      setRevisions([]);
      setListProblem(explain(result.error));
    }
  }, [client, project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (client === null) {
    return (
      <Panel title="Revisión y publicación" level="base">
        <EmptyState
          title="No hay servicio de revisión configurado"
          description="La revisión controlada la coordina el servicio local. Mientras no haya uno configurado, el proyecto se edita y se publica desde este equipo sin flujo de aprobación."
        />
      </Panel>
    );
  }

  const openDraft = async (): Promise<void> => {
    if (summary.trim() === '') {
      // El resumen es lo que lee el revisor para saber qué aprueba. El
      // servicio también lo exige; comprobarlo aquí evita el viaje.
      setActionProblem('Escriba un resumen de los cambios: es lo que leerá quien revise.');
      return;
    }
    setActionProblem(null);
    setBusyId('nueva');
    const result = await client.create(project, summary.trim());
    setBusyId(null);
    if (!result.ok) {
      setActionProblem(explain(result.error));
      return;
    }
    setSummary('');
    toast.push({ tone: 'nominal', title: 'Revisión abierta', description: result.value.summary });
    await reload();
  };

  const act = async (revision: RevisionInfo, action: RevisionAction): Promise<void> => {
    setActionProblem(null);
    setBusyId(revision.revisionId);
    const result = await client.act(revision.revisionId, action);
    setBusyId(null);
    if (!result.ok) {
      setActionProblem(explain(result.error));
      // Y se recarga: un rechazo por transición inválida significa que el
      // estado que muestra la pantalla ya no es el real.
      await reload();
      return;
    }
    toast.push({
      tone: 'nominal',
      title: REVISION_ACTION_LABELS[action],
      description: REVISION_STATE_LABELS[result.value.state],
    });
    await reload();
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--it-space-4)' }}>
      <Panel title="Abrir una revisión" level="raised">
        <Field
          label="Resumen de los cambios"
          hint="Lo lee quien revisa para saber qué aprueba. Sin resumen, aprobar es firmar en blanco."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              size="sm"
              value={summary}
              placeholder="Rótulos nuevos en la sala de bombas"
              onChange={(event) => setSummary(event.currentTarget.value)}
            />
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={busyId === 'nueva'}
          onClick={() => void openDraft()}
        >
          Abrir borrador
        </Button>
        <p className="muted" style={{ marginTop: 'var(--it-space-2)' }}>
          Se envía un resumen por sección del proyecto, no el proyecto: el servicio sólo necesita
          eso para detectar ediciones simultáneas, y el trabajo se queda en este equipo.
        </p>
      </Panel>

      {actionProblem !== null && (
        <Callout tone="warning" title="No se pudo completar" onDismiss={() => setActionProblem(null)}>
          {actionProblem}
        </Callout>
      )}

      {listProblem !== null && (
        <Callout tone="warning" title="No se pudo consultar el servicio" onDismiss={() => setListProblem(null)}>
          {listProblem}
        </Callout>
      )}

      <Panel title="Cola de revisión" level="raised">
        {loading && <Spinner label="Consultando el servicio" />}
        {!loading && revisions.length === 0 && (
          <EmptyState
            title="No hay revisiones de este proyecto"
            description="Al abrir un borrador aparecerá aquí con su estado."
          />
        )}

        <div style={{ display: 'grid', gap: 'var(--it-space-3)' }}>
          {revisions.map((revision) => (
            <Panel key={revision.revisionId} title={revision.summary} level="base">
              <PropertyList>
                <PropertyRow
                  label="Estado"
                  value={<Badge tone={STATE_TONE[revision.state]} dot>{REVISION_STATE_LABELS[revision.state]}</Badge>}
                />
                <PropertyRow
                  label="Autor"
                  value={revision.authorId === currentUserId ? `${revision.authorId} (usted)` : revision.authorId}
                />
                {revision.approvedBy !== null && (
                  <PropertyRow label="Aprobada por" value={revision.approvedBy} />
                )}
                <PropertyRow label="Actualizada" value={revision.updatedAt.slice(0, 16).replace('T', ' ')} />
              </PropertyList>

              {revision.comments.length > 0 && (
                <>
                  <SectionLabel>Observaciones</SectionLabel>
                  <ul>
                    {revision.comments.map((comment, index) => (
                      <li key={`${revision.revisionId}-${index}`}>{comment}</li>
                    ))}
                  </ul>
                </>
              )}

              {revision.conflicts.length > 0 && (
                <Callout tone="warning" title="Secciones en conflicto">
                  {/* Por nombre y no por identificador: «ambos tocasteis la
                      sala de bombas» se puede resolver; «scene:7f3a…» no. */}
                  <ul>
                    {revision.conflicts.map((conflict) => (
                      <li key={conflict.section}>{sectionLabel(conflict.section, project)}</li>
                    ))}
                  </ul>
                  Alguien publicó cambios en estas mismas secciones después de abrirse esta
                  revisión. Publicarla sobrescribiría ese trabajo, de modo que el servicio no lo
                  permite hasta resolverlo.
                </Callout>
              )}

              <div style={{ display: 'flex', gap: 'var(--it-space-2)', flexWrap: 'wrap' }}>
                {ACTIONS_BY_STATE[revision.state].map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'publish' ? 'primary' : 'secondary'}
                    disabled={busyId === revision.revisionId}
                    onClick={() => void act(revision, action)}
                  >
                    {REVISION_ACTION_LABELS[action]}
                  </Button>
                ))}
                {ACTIONS_BY_STATE[revision.state].length === 0 && (
                  <span className="muted">Esta revisión ya está cerrada.</span>
                )}
              </div>

              {/* La separación de funciones se avisa antes de pulsar: el
                  servicio la aplica igualmente, pero descubrirla con un
                  rechazo hace pensar que la pantalla está rota. */}
              {revision.authorId === currentUserId &&
                (revision.state === 'in_review' || revision.state === 'approved') && (
                  <p className="muted">
                    Usted redactó esta revisión, de modo que tiene que aprobarla y publicarla otra
                    persona con permiso.
                  </p>
                )}
            </Panel>
          ))}
        </div>
      </Panel>
    </div>
  );
}
