/**
 * Importación de notas de campo al proyecto (P01).
 *
 * El operador recorrió la planta con una tableta, tomó doce observaciones
 * ancladas a puntos del recorrido publicado y entregó un archivo. Esta pantalla
 * lo lee, dice qué entraría y espera.
 *
 * Mismo contrato que el catálogo CSV, y por la misma razón: nada se escribe en
 * el proyecto sin que el autor haya visto qué se va a escribir. Con un
 * agravante propio: estas notas **no se pueden volver a tomar**. Se tomaron una
 * vez, delante del equipo. Por eso el informe distingue tres cosas que un
 * «importadas 9 de 12» mezclaría: las que entran, las que ya estaban —el
 * operador puede entregar el mismo archivo dos veces— y las que se rechazan,
 * con el motivo de cada una.
 */
import { useMemo, useState } from 'react';
import {
  applyFieldNoteImport,
  describeFieldNotePlan,
  planFieldNoteImport,
  type FieldNoteImportPlan,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  SectionLabel,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface FieldNoteImportProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: ProjectStore;
}

type Phase = 'pick' | 'review' | 'done';

export function FieldNoteImport({ open, onClose, store }: FieldNoteImportProps): JSX.Element {
  const [parsed, setParsed] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [phase, setPhase] = useState<Phase>('pick');
  const [imported, setImported] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const project = store.project;

  const plan = useMemo<FieldNoteImportPlan | null>(() => {
    if (parsed === null) return null;
    return planFieldNoteImport(parsed, {
      projectId: project.id,
      scenes: project.scenes,
      categories: project.noteCategories,
      existingNotes: project.notes,
    });
  }, [parsed, project.id, project.scenes, project.noteCategories, project.notes]);

  const close = (): void => {
    setParsed(null);
    setFileName('');
    setPhase('pick');
    setImported(null);
    setReadError(null);
    onClose();
  };

  /**
   * Lee el archivo elegido.
   *
   * `FileReader` y no `File.text()`, igual que en la importación del catálogo:
   * es la única vía disponible en todas las webviews que la aplicación soporta.
   */
  const onPick = (file: File): void => {
    setReadError(null);
    const reader = new FileReader();

    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      try {
        setParsed(JSON.parse(text.replace(/^﻿/, '')));
      } catch {
        // Se distingue del «no es un paquete válido» del dominio: aquí el
        // archivo no es ni JSON, y decir por qué ahorra al autor buscar el
        // fallo en el contenido.
        setParsed({});
        setReadError(
          'El archivo no contiene JSON válido. Compruebe que es el que descargó el recorrido y que no se editó a mano.',
        );
      }
      setFileName(file.name);
      setPhase('review');
    };
    reader.onerror = () => {
      setReadError('No se pudo leer el archivo. Compruebe que sigue disponible.');
    };

    reader.readAsText(file, 'utf-8');
  };

  const onApply = (): void => {
    if (plan === null || !plan.applicable) return;

    const result = applyFieldNoteImport(plan, {
      projectId: project.id,
      categories: project.noteCategories,
      existingNotes: project.notes,
      now: new Date().toISOString(),
    });

    store.updateProject(`Importar ${result.imported} nota(s) de campo`, {
      notes: [...result.notes],
    });

    setImported(result.imported);
    setPhase('done');
  };

  const sceneTitleOf = (sceneId: string): string =>
    project.scenes.find((scene) => scene.id === sceneId)?.title ?? 'panorámica retirada';

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Importar notas de campo"
      description="El archivo que descarga el recorrido publicado, con las observaciones tomadas en planta."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {phase === 'done' ? 'Cerrar' : 'Cancelar'}
          </Button>
          {phase === 'review' && plan !== null && (
            <Button variant="primary" onClick={onApply} disabled={!plan.applicable}>
              {plan.applicable ? `Importar ${plan.toImport.length} nota(s)` : 'Nada que importar'}
            </Button>
          )}
        </>
      }
    >
      <div className="csv-dialog">
        {readError !== null && (
          <Callout tone="alarm" title="No se pudo leer el archivo">
            {readError}
          </Callout>
        )}

        {phase === 'pick' && (
          <section className="csv-dialog__section">
            <p className="csv-dialog__hint">
              Las notas entran <b>abiertas y sin responsable</b>: quien las tomó describió lo que
              vio, y decidir quién lo atiende es suyo. El nombre del autor se guarda como{' '}
              <b>declarado</b>, porque el recorrido publicado no verifica identidades.
            </p>
            <label className="csv-dialog__file">
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Archivo de notas de campo"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file !== undefined) onPick(file);
                }}
              />
            </label>
          </section>
        )}

        {phase === 'review' && plan !== null && (
          <>
            <Callout tone={plan.applicable ? 'info' : 'warning'} title={fileName}>
              {describeFieldNotePlan(plan)}
            </Callout>

            {plan.applicable && plan.warnings.length > 0 && (
              <section className="csv-dialog__section">
                <SectionLabel>Avisos</SectionLabel>
                <ul className="csv-dialog__warnings">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}

            {plan.toImport.length > 0 && (
              <section className="csv-dialog__section">
                <SectionLabel>
                  Se importará <Badge tone="nominal">{plan.toImport.length}</Badge>
                </SectionLabel>
                <DataTable
                  label="Notas que se importarán"
                  compact
                  rowKey={(row) => row.id}
                  rows={plan.toImport}
                  columns={[
                    { id: 'title', header: 'Asunto', render: (row) => row.title },
                    {
                      id: 'scene',
                      header: 'Panorámica',
                      render: (row) => sceneTitleOf(row.sceneId),
                    },
                    { id: 'author', header: 'Declarada por', render: (row) => row.authorName },
                    {
                      id: 'when',
                      header: 'Tomada',
                      mono: true,
                      render: (row) => row.createdAt.slice(0, 16).replace('T', ' '),
                    },
                  ]}
                />
              </section>
            )}

            {plan.rejected.length > 0 && (
              <section className="csv-dialog__section">
                <SectionLabel>
                  Rechazadas <Badge tone="alarm">{plan.rejected.length}</Badge>
                </SectionLabel>
                <DataTable
                  label="Notas rechazadas"
                  compact
                  rowKey={(row) => `${row.label}:${row.message}`}
                  rows={plan.rejected}
                  columns={[
                    { id: 'label', header: 'Asunto', render: (row) => row.label },
                    { id: 'message', header: 'Motivo', render: (row) => row.message },
                  ]}
                />
                <p className="csv-dialog__hint">
                  Estas observaciones se tomaron una sola vez y no se pueden repetir. Si la
                  panorámica a la que apuntaban sigue siendo necesaria, recupérela y vuelva a
                  importar el mismo archivo: las que ya entraron no se duplicarán.
                </p>
              </section>
            )}
          </>
        )}

        {phase === 'done' && imported !== null && (
          <Callout tone="nominal" title="Importación aplicada">
            {imported} nota(s) añadidas al proyecto, abiertas y sin responsable. La operación está
            en el historial: se puede deshacer con Ctrl+Z.
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
