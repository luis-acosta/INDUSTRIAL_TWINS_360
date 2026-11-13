/**
 * Panel de respaldo y restauración (X18).
 *
 * Es la pantalla de una función que sólo se usa dos veces: el día que se
 * configura y el día que algo sale mal. Por eso todo lo que dice está escrito
 * para el segundo día, cuando quien la abre no recuerda nada de la primera vez
 * y además tiene prisa.
 *
 * Tres cosas que el panel deja claras antes de que haga falta:
 *
 * - **Qué se respalda y qué no.** Un respaldo lleva el proyecto y sus medios.
 *   No lleva las credenciales de telemetría, que nunca salen del equipo.
 * - **Dónde queda.** Una copia en el mismo disco que el original no protege de
 *   que el disco falle, y eso se dice aquí y no en un manual.
 * - **Que restaurar no machaca nada.** Se escribe un archivo nuevo al lado, y
 *   el usuario abre el que quiera.
 */
import { useState } from 'react';
import {
  BACKUP_REASON_LABELS,
  bytesFreedBy,
  canRestore,
  createBackup,
  DEFAULT_ROTATION,
  describeBackup,
  planRestore,
  planRotation,
  verifyBackup,
  type BackupCheck,
  type BackupInfo,
} from '@it360/persistence';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  Panel,
  PropertyList,
  PropertyRow,
  useToast,
} from '@it360/ui';
import { APP_VERSION } from '../version';
import { buildPackageBytes } from '../platform/project-files';
import type { ProjectStore } from '../state/project-store';

export interface BackupPanelProps {
  readonly store: ProjectStore;
  readonly mediaUrls: ReadonlyMap<string, string>;
  readonly mediaFiles: ReadonlyMap<string, Uint8Array>;
  /** Ruta del proyecto abierto, si se abrió de un archivo. */
  readonly projectPath: string | null;
}

/** Tamaño en unidades legibles. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BackupPanel({
  store,
  mediaUrls,
  mediaFiles,
  projectPath,
}: BackupPanelProps): JSX.Element {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState<{ name: string; bytes: number } | null>(null);
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [checkFile, setCheckFile] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  /** Respaldos conocidos de esta sesión, para poder enseñar la rotación. */
  const [known, setKnown] = useState<readonly BackupInfo[]>([]);

  const project = store.project;

  /**
   * Crea un respaldo y lo descarga.
   *
   * Se descarga en lugar de escribirse en una carpeta fija porque el usuario
   * debe poder ponerlo en otro disco: una copia junto al original no protege
   * de que el disco falle, que es el caso del que un respaldo protege.
   */
  const onCreate = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);

    try {
      const packaged = await buildPackageBytes(project, mediaUrls, mediaFiles);
      if (!packaged.ok) {
        setProblem(packaged.error.message);
        return;
      }

      const result = await createBackup({
        packageBytes: packaged.value,
        reason: 'manual',
        appVersion: APP_VERSION,
        now: new Date().toISOString(),
      });

      if (!result.ok) {
        setProblem(result.error.message);
        push({
          tone: 'alarm',
          title: 'El respaldo no se guardó',
          ...(result.error.recovery !== undefined
            ? { description: result.error.recovery }
            : {}),
        });
        return;
      }

      // El paquete y su ficha: dos descargas, para que la ficha quede al lado.
      download(packaged.value, result.value.fileName, 'application/zip');
      download(
        new TextEncoder().encode(result.value.sidecarJson),
        `${result.value.fileName}.respaldo.json`,
        'application/json',
      );

      setLastBackup({ name: result.value.fileName, bytes: packaged.value.byteLength });
      setKnown((current) => [
        { path: result.value.fileName, sidecar: result.value.sidecar },
        ...current,
      ]);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? `No se pudo crear el respaldo: ${error.message}`
          : 'No se pudo crear el respaldo.',
      );
    } finally {
      setBusy(false);
    }
  };

  /** Lee un respaldo del disco y dice qué tiene dentro. */
  const onVerify = (file: File): void => {
    setProblem(null);
    setCheck(null);
    setBusy(true);

    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        const buffer = reader.result instanceof ArrayBuffer ? reader.result : new ArrayBuffer(0);
        const result = await verifyBackup(new Uint8Array(buffer));
        setBusy(false);

        if (!result.ok) {
          setProblem(result.error.message);
          return;
        }
        setCheck(result.value);
        setCheckFile(file.name);
      })();
    };
    reader.onerror = () => {
      setBusy(false);
      setProblem('No se pudo leer el archivo. Compruebe que sigue disponible.');
    };
    reader.readAsArrayBuffer(file);
  };

  const rotation = planRotation(known, DEFAULT_ROTATION);
  const restorePlan =
    check === null ? null : planRestore(check, projectPath ?? 'proyecto.ivp', project.schemaVersion);

  return (
    <>
      <Panel title="Respaldo y restauración">
        <p className="backup__intro">
          Un respaldo lleva el proyecto y sus medios. <b>No lleva las credenciales de
          telemetría</b>, que nunca salen de este equipo. Guárdelo en un disco distinto del que
          tiene el proyecto: una copia en el mismo disco no protege de que ese disco falle, que es
          justo de lo que protege un respaldo.
        </p>

        {problem !== null && (
          <Callout tone="alarm" title="No se pudo completar">
            {problem}
          </Callout>
        )}

        <PropertyList>
          <PropertyRow label="Proyecto" value={project.title} />
          <PropertyRow
            label="Contenido"
            value={`${project.scenes.length} escena(s), ${project.assets.length} activo(s), ${project.media.length} archivo(s)`}
          />
          <PropertyRow
            label="Copias automáticas al guardar"
            value={`${project.settings.backupCount} (junto al archivo del proyecto)`}
          />
        </PropertyList>

        <div className="backup__actions">
          <Button variant="primary" disabled={busy} onClick={() => void onCreate()}>
            {busy ? 'Trabajando…' : 'Crear respaldo ahora'}
          </Button>
        </div>

        {lastBackup !== null && (
          <Callout tone="nominal" title="Respaldo creado y verificado">
            {lastBackup.name} ({formatBytes(lastBackup.bytes)}). Se comprobó leyéndolo de vuelta
            antes de darlo por bueno. Junto a él se descargó su ficha .json: guárdelos en la misma
            carpeta.
          </Callout>
        )}
      </Panel>

      <Panel title="Comprobar o restaurar un respaldo">
        <p className="backup__intro">
          Antes de restaurar se lee el respaldo y se dice qué trae. <b>Restaurar no sobrescribe el
          proyecto actual</b>: se crea un archivo nuevo al lado y usted decide cuál abrir.
        </p>

        <label className="csv-dialog__file">
          <input
            type="file"
            accept=".ivp"
            aria-label="Archivo de respaldo"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) onVerify(file);
            }}
          />
        </label>

        {check !== null && restorePlan !== null && (
          <>
            <Callout
              tone={canRestore(check, project.schemaVersion) ? 'info' : 'warning'}
              title={checkFile}
            >
              {describeBackup(check)} Proyecto: «{check.projectTitle}».
            </Callout>

            {restorePlan.warnings.length > 0 && (
              <ul className="csv-dialog__warnings">
                {restorePlan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}

            {check.projectId !== project.id && (
              <Callout tone="warning" title="Es otro proyecto">
                Este respaldo es de «{check.projectTitle}», que no es el proyecto abierto. Puede
                restaurarlo igualmente: se escribirá como un proyecto aparte.
              </Callout>
            )}

            <div className="backup__actions">
              <Button
                variant="primary"
                disabled={!canRestore(check, project.schemaVersion)}
                onClick={() => setRestoring(true)}
              >
                Restaurar
              </Button>
            </div>
          </>
        )}
      </Panel>

      {known.length > 0 && (
        <Panel title="Respaldos de esta sesión">
          <p className="backup__intro">
            La limpieza conserva por antigüedad y no por número: doce copias de la última hora no
            protegen de un error que se arrastra desde ayer, porque todas lo llevan dentro.
          </p>

          <DataTable
            label="Respaldos conocidos"
            compact
            rowKey={(row) => row.path}
            rows={[...rotation.keep, ...rotation.remove]}
            columns={[
              { id: 'file', header: 'Archivo', mono: true, render: (row) => row.path },
              {
                id: 'when',
                header: 'Creado',
                mono: true,
                render: (row) => row.sidecar.createdAt.slice(0, 16).replace('T', ' '),
              },
              {
                id: 'reason',
                header: 'Motivo',
                render: (row) => BACKUP_REASON_LABELS[row.sidecar.reason],
              },
              {
                id: 'size',
                header: 'Tamaño',
                align: 'end',
                render: (row) => formatBytes(row.sidecar.byteLength),
              },
              {
                id: 'keep',
                header: 'Limpieza',
                render: (row) => {
                  const reason = rotation.reasons.get(row.path);
                  return reason === undefined ? (
                    <Badge tone="warning">se puede borrar</Badge>
                  ) : (
                    <Badge tone="nominal">se conserva: {reason}</Badge>
                  );
                },
              },
            ]}
          />

          {rotation.remove.length > 0 && (
            <p className="backup__intro">
              Borrar los {rotation.remove.length} marcados liberaría{' '}
              {formatBytes(bytesFreedBy(rotation))}. Bórrelos usted en la carpeta: la aplicación no
              toca archivos que no ha abierto.
            </p>
          )}
        </Panel>
      )}

      {known.length === 0 && lastBackup === null && (
        <EmptyState
          title="Sin respaldos en esta sesión"
          description="Los respaldos creados aquí aparecerán en esta lista mientras la aplicación esté abierta, con el motivo por el que la limpieza los conservaría."
        />
      )}

      <Dialog
        open={restoring}
        onClose={() => setRestoring(false)}
        title="Restaurar el respaldo"
        description="Se creará un archivo de proyecto nuevo. El proyecto abierto no se toca."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoring(false)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setRestoring(false);
                push({
                  tone: 'info',
                  title: 'Abra el respaldo como proyecto',
                  description:
                    'Use «Abrir» y elija el archivo del respaldo. Se abrirá como un proyecto más, sin tocar el actual; guárdelo con otro nombre si va a seguir trabajando sobre él.',
                });
              }}
            >
              Entendido
            </Button>
          </>
        }
      >
        <p className="backup__intro">
          Un respaldo <b>es</b> un proyecto: se abre con «Abrir» igual que cualquier otro. No hace
          falta un paso de restauración aparte, y por eso no hay ninguno que pueda escribir encima
          del proyecto que tiene abierto.
        </p>
        {restorePlan !== null && (
          <PropertyList>
            <PropertyRow label="Proyecto del respaldo" value={restorePlan.check.projectTitle} />
            <PropertyRow
              label="Contenido"
              value={`${restorePlan.check.sceneCount} escena(s), ${restorePlan.check.assetCount} activo(s)`}
            />
            {restorePlan.check.missingFiles.length > 0 && (
              <PropertyRow
                label="Medios ausentes"
                value={`${restorePlan.check.missingFiles.length} archivo(s)`}
              />
            )}
          </PropertyList>
        )}
      </Dialog>
    </>
  );
}

/** Descarga unos bytes como archivo. */
function download(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
