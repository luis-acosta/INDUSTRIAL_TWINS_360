/**
 * Importación y exportación del catálogo en CSV (X06).
 *
 * El diálogo está construido alrededor de una idea: **el usuario ve lo que va
 * a pasar antes de que pase**. Se lee el archivo, se planifica, se muestra el
 * informe —altas, actualizaciones, rechazos con número de línea y motivo— y
 * sólo entonces aparece el botón de aplicar. Importar primero y explicar
 * después convierte la revisión en limpieza, y en un catálogo de cientos de
 * TAG la limpieza es más caro que la importación.
 *
 * Las filas rechazadas se muestran siempre, aunque el usuario decida seguir
 * adelante: que ciento noventa y siete activos entren bien no vuelve correctas
 * las tres filas que se quedaron fuera, y quien recibe la planta en marcha
 * necesita saber cuáles fueron.
 */
import { useMemo, useState } from 'react';
import {
  applyImport,
  describeImportPlan,
  exportCatalogCsv,
  HIERARCHY_LABELS,
  planImport,
  type ImportPlan,
} from '@it360/domain';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  IconDocument,
  SectionLabel,
} from '@it360/ui';
import type { ProjectStore } from '../state/project-store';

export interface CatalogCsvDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: ProjectStore;
}

type Phase = 'pick' | 'review' | 'done';

interface Applied {
  readonly created: number;
  readonly updated: number;
  readonly rejected: number;
}

export function CatalogCsvDialog({ open, onClose, store }: CatalogCsvDialogProps): JSX.Element {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [phase, setPhase] = useState<Phase>('pick');
  const [applied, setApplied] = useState<Applied | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const project = store.project;

  const plan = useMemo<ImportPlan | null>(() => {
    if (csv === null) return null;
    return planImport(csv, {
      existingAssets: project.assets,
      classes: project.assetClasses,
      updateExisting,
    });
  }, [csv, project.assets, project.assetClasses, updateExisting]);

  const reset = (): void => {
    setCsv(null);
    setFileName('');
    setUpdateExisting(false);
    setPhase('pick');
    setApplied(null);
    setReadError(null);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  /**
   * Lee el archivo elegido.
   *
   * Se usa `FileReader` y no `File.text()` porque es la única vía disponible
   * en todas las webviews que la aplicación soporta, sin ramas que sólo se
   * ejecutarían en unas y no en otras.
   *
   * Se descarta la marca de orden de bytes: Excel la escribe y, si se deja,
   * la primera cabecera pasa a llamarse «﻿TAG» y la columna del TAG deja
   * de reconocerse. Es el fallo más común al importar hojas de Windows.
   */
  const onPick = (file: File): void => {
    setReadError(null);
    const reader = new FileReader();

    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setCsv(text.replace(/^﻿/, ''));
      setFileName(file.name);
      setPhase('review');
    };
    reader.onerror = () => {
      setReadError(
        'No se pudo leer el archivo. Compruebe que sigue disponible y vuelva a elegirlo.',
      );
    };

    // Se declara UTF-8 explícitamente: sin ello, el navegador adivina y una
    // hoja con acentos puede llegar con la codificación equivocada.
    reader.readAsText(file, 'utf-8');
  };

  const onApply = (): void => {
    if (plan === null || !plan.applicable) return;

    const fallback = project.assetClasses[0];
    if (fallback === undefined) {
      setReadError(
        'El proyecto no tiene ninguna clase de activo definida. Cree al menos una clase antes de importar.',
      );
      return;
    }

    const result = applyImport(plan, {
      projectId: project.id,
      existingAssets: project.assets,
      classes: project.assetClasses,
      now: new Date().toISOString(),
      fallbackClassId: fallback.id,
    });

    // Pasa por el store para que la importación entre en el historial: una
    // importación de doscientas filas que no se puede deshacer es una decisión
    // irreversible tomada con un solo clic.
    store.updateProject(
      `Importar catálogo (${result.created} alta(s), ${result.updated} actualización(es))`,
      { assets: [...result.assets] },
    );

    setApplied({
      created: result.created,
      updated: result.updated,
      rejected: plan.rejected.length,
    });
    setPhase('done');
  };

  const onExport = (): void => {
    const content = exportCatalogCsv(project.assets, project.assetClasses);
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `catalogo-${project.title.replace(/[^\w-]+/g, '-').toLowerCase()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Catálogo en CSV"
      description="Importe la lista de equipos del cliente o exporte el catálogo para editarlo en una hoja de cálculo."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {phase === 'done' ? 'Cerrar' : 'Cancelar'}
          </Button>
          {phase === 'review' && plan !== null && (
            <Button variant="primary" onClick={onApply} disabled={!plan.applicable}>
              {plan.applicable
                ? `Importar ${plan.toCreate.length + plan.toUpdate.length} activo(s)`
                : 'Nada que importar'}
            </Button>
          )}
        </>
      }
    >
      {readError !== null && (
        <Callout tone="alarm" title="No se pudo continuar">
          {readError}
        </Callout>
      )}

      {phase === 'pick' && (
        <div className="csv-dialog">
          <section className="csv-dialog__section">
            <SectionLabel>Importar</SectionLabel>
            <p className="csv-dialog__hint">
              La primera fila debe ser la cabecera. Son obligatorias las columnas <b>TAG</b>,{' '}
              <b>nombre</b> y <b>nivel</b>; se reconocen además padre, clase, fabricante, modelo,
              número de serie, criticidad y observaciones. El separador se detecta solo.
            </p>
            <label className="csv-dialog__file">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                aria-label="Archivo CSV del catálogo"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file !== undefined) onPick(file);
                }}
              />
            </label>
          </section>

          <section className="csv-dialog__section">
            <SectionLabel>Exportar</SectionLabel>
            <p className="csv-dialog__hint">
              Se exporta el TAG del padre y no su identificador interno, de modo que el archivo se
              pueda editar y volver a importar sin romper la jerarquía.
            </p>
            <Button
              variant="secondary"
              icon={<IconDocument size={13} />}
              onClick={onExport}
              disabled={project.assets.length === 0}
            >
              Exportar {project.assets.length} activo(s)
            </Button>
          </section>
        </div>
      )}

      {phase === 'review' && plan !== null && (
        <div className="csv-dialog">
          <Callout tone={plan.applicable ? 'info' : 'warning'} title={fileName}>
            {describeImportPlan(plan)}
          </Callout>

          <Checkbox
            label="Actualizar los activos cuyo TAG ya existe en el proyecto"
            checked={updateExisting}
            onChange={(event) => setUpdateExisting(event.currentTarget.checked)}
          />
          <p className="csv-dialog__hint">
            Sin esa opción, las filas con un TAG ya registrado se rechazan en lugar de sobrescribir
            la ficha.
          </p>

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

          {plan.toCreate.length + plan.toUpdate.length > 0 && (
            <section className="csv-dialog__section">
              <SectionLabel>
                Se importará{' '}
                <Badge tone="nominal">{plan.toCreate.length + plan.toUpdate.length}</Badge>
              </SectionLabel>
              <DataTable
                label="Activos que se importarán"
                compact
                rowKey={(row) => `${row.line}`}
                rows={[...plan.toCreate, ...plan.toUpdate].slice(0, 200)}
                columns={[
                  { id: 'tag', header: 'TAG', mono: true, render: (row) => row.tag },
                  { id: 'name', header: 'Nombre', render: (row) => row.name },
                  {
                    id: 'level',
                    header: 'Nivel',
                    render: (row) => HIERARCHY_LABELS[row.level],
                  },
                  {
                    id: 'parent',
                    header: 'Padre',
                    mono: true,
                    render: (row) => row.parentTag ?? '—',
                  },
                  {
                    id: 'action',
                    header: 'Acción',
                    render: (row) =>
                      row.existingId === null ? (
                        <Badge tone="nominal">Alta</Badge>
                      ) : (
                        <Badge tone="warning">Actualiza</Badge>
                      ),
                  },
                ]}
              />
              {plan.toCreate.length + plan.toUpdate.length > 200 && (
                <p className="csv-dialog__hint">
                  Se muestran las primeras 200 filas; se importarán todas.
                </p>
              )}
            </section>
          )}

          {plan.rejected.length > 0 && (
            <section className="csv-dialog__section">
              <SectionLabel>
                Rechazadas <Badge tone="alarm">{plan.rejected.length}</Badge>
              </SectionLabel>
              <DataTable
                label="Filas rechazadas"
                compact
                rowKey={(problem) => `${problem.line}-${problem.tag}`}
                rows={plan.rejected.slice(0, 200)}
                columns={[
                  {
                    id: 'line',
                    header: 'Línea',
                    width: '4rem',
                    align: 'end',
                    render: (problem) => problem.line,
                  },
                  {
                    id: 'tag',
                    header: 'TAG',
                    mono: true,
                    render: (problem) => (problem.tag.length > 0 ? problem.tag : '—'),
                  },
                  { id: 'message', header: 'Motivo', render: (problem) => problem.message },
                ]}
              />
              <p className="csv-dialog__hint">
                Estas filas no se importan. Corríjalas en el archivo de origen y vuelva a
                importarlo: las que ya entraron se actualizarán en lugar de duplicarse.
              </p>
            </section>
          )}
        </div>
      )}

      {phase === 'done' && applied !== null && (
        <div className="csv-dialog">
          <Callout tone="nominal" title="Importación aplicada">
            {applied.created} activo(s) nuevo(s) y {applied.updated} actualización(es).
            {applied.rejected > 0
              ? ` ${applied.rejected} fila(s) quedaron fuera y siguen pendientes de corregir.`
              : ''}{' '}
            La operación está en el historial: se puede deshacer con Ctrl+Z.
          </Callout>
          {applied.created + applied.updated === 0 && (
            <EmptyState
              title="No se modificó nada"
              description="Ninguna fila del archivo resultó aplicable."
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
