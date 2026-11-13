/**
 * Estado del editor.
 *
 * Un `useReducer` con historial de comandos en lugar de una biblioteca de
 * estado. El motivo es el requisito Y04: deshacer y rehacer tienen que cubrir
 * **todas** las ediciones del proyecto, y eso sólo es cierto si no hay forma
 * de modificar el proyecto sin pasar por un comando. Una tienda con
 * actualizaciones libres permite escribir código que edita el proyecto por un
 * lado y no aparece en el historial, y ese fallo sólo se descubre cuando un
 * usuario pulsa deshacer y no pasa nada.
 *
 * La regla, por tanto: el proyecto es inmutable y sólo cambia aplicando un
 * `Command<Project>`. Todo lo demás —selección, paneles abiertos, filtros— es
 * estado de interfaz y vive aparte, porque deshacer un cambio de pestaña no
 * es lo que nadie espera.
 */
import { useCallback, useMemo, useReducer } from 'react';
import {
  canRedo,
  canUndo,
  checkIntegrity,
  compositeCommand,
  createHistory,
  fieldCommand,
  isDirty,
  markSaved,
  newUuid,
  projectStats,
  pushCommand,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type Command,
  type HistoryState,
  type Hotspot,
  type IntegrityProblem,
  type Project,
  type ProjectStats,
  type Scene,
} from '@it360/domain';

export interface EditorState {
  readonly project: Project;
  readonly history: HistoryState<Project>;
  /** Ruta del archivo en disco. `null` si no se ha guardado nunca. */
  readonly filePath: string | null;
}

type EditorAction =
  | { readonly type: 'apply'; readonly command: Command<Project> }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'markSaved'; readonly filePath: string }
  | { readonly type: 'load'; readonly project: Project; readonly filePath: string | null };

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'apply': {
      const result = pushCommand(state.project, state.history, action.command);
      return { ...state, project: result.state, history: result.history };
    }
    case 'undo': {
      const result = undo(state.project, state.history);
      return { ...state, project: result.state, history: result.history };
    }
    case 'redo': {
      const result = redo(state.project, state.history);
      return { ...state, project: result.state, history: result.history };
    }
    case 'markSaved':
      return { ...state, history: markSaved(state.history), filePath: action.filePath };
    case 'load':
      return {
        project: action.project,
        history: createHistory<Project>(),
        filePath: action.filePath,
      };
    default: {
      const exhaustive: never = action;
      throw new Error(`Acción de editor no contemplada: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface ProjectStore {
  readonly project: Project;
  readonly filePath: string | null;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly integrity: readonly IntegrityProblem[];
  readonly stats: ProjectStats;

  apply(command: Command<Project>): void;
  undo(): void;
  redo(): void;
  markSaved(filePath: string): void;
  load(project: Project, filePath: string | null): void;

  /* Operaciones de edición de alto nivel, todas como comandos. */
  updateProject(label: string, patch: Partial<Project>, coalesceKey?: string): void;
  addScene(scene: Scene): void;
  updateScene(sceneId: string, label: string, patch: Partial<Scene>, coalesceKey?: string): void;
  removeScene(sceneId: string): void;
  reorderScenes(orderedIds: readonly string[]): void;
  addHotspot(sceneId: string, hotspot: Hotspot): void;
  updateHotspot(
    sceneId: string,
    hotspotId: string,
    label: string,
    patch: Partial<Hotspot>,
    coalesceKey?: string,
  ): void;
  removeHotspots(sceneId: string, hotspotIds: readonly string[]): void;
  pasteHotspots(sceneId: string, hotspots: readonly Hotspot[]): void;
}

export function useProjectStore(initial: Project, initialPath: string | null = null): ProjectStore {
  const [state, dispatch] = useReducer(reducer, {
    project: initial,
    history: createHistory<Project>(),
    filePath: initialPath,
  });

  const apply = useCallback((command: Command<Project>) => {
    dispatch({ type: 'apply', command });
  }, []);

  /**
   * Comando que reemplaza el proyecto entero por el resultado de una función.
   *
   * La inversión guarda el proyecto anterior por referencia. Como el proyecto
   * es inmutable, eso no copia nada: es un puntero al objeto que ya existía.
   * Es lo que permite que el historial sea barato aunque cada comando
   * «reemplace» el proyecto completo.
   */
  const transform = useCallback(
    (kind: string, label: string, fn: (project: Project) => Project, coalesceKey?: string) => {
      const previous = state.project;
      const next = fn(previous);
      if (next === previous) return;

      apply({
        kind,
        label,
        apply: () => ({ ...next, updatedAt: new Date().toISOString() }),
        invert: () => previous,
        coalesceKey: coalesceKey ?? null,
        timestampMs: Date.now(),
      });
    },
    [state.project, apply],
  );

  const integrity = useMemo(() => checkIntegrity(state.project), [state.project]);
  const stats = useMemo(() => projectStats(state.project), [state.project]);

  return useMemo<ProjectStore>(
    () => ({
      project: state.project,
      filePath: state.filePath,
      dirty: isDirty(state.history),
      canUndo: canUndo(state.history),
      canRedo: canRedo(state.history),
      undoLabel: undoLabel(state.history),
      redoLabel: redoLabel(state.history),
      integrity,
      stats,

      apply,
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      markSaved: (filePath) => dispatch({ type: 'markSaved', filePath }),
      load: (project, filePath) => dispatch({ type: 'load', project, filePath }),

      updateProject: (label, patch, coalesceKey) => {
        transform('project.update', label, (p) => ({ ...p, ...patch }), coalesceKey);
      },

      addScene: (scene) => {
        transform('scene.add', 'Añadir escena', (p) => ({ ...p, scenes: [...p.scenes, scene] }));
      },

      updateScene: (sceneId, label, patch, coalesceKey) => {
        transform(
          'scene.update',
          label,
          (p) => ({
            ...p,
            scenes: p.scenes.map((s) =>
              s.id === sceneId ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s,
            ),
          }),
          coalesceKey,
        );
      },

      removeScene: (sceneId) => {
        transform('scene.remove', 'Eliminar escena', (p) => ({
          ...p,
          scenes: p.scenes.filter((s) => s.id !== sceneId),
          // Las ubicaciones y puntos de plano que apuntaban a la escena se
          // eliminan a la vez: dejarlos produciría errores de integridad que
          // el usuario no ha causado y no sabe corregir.
          assetLocations: p.assetLocations.filter((l) => l.sceneId !== sceneId),
          planMarkers: p.planMarkers.filter((m) => m.sceneId !== sceneId),
          settings:
            p.settings.entrySceneId === sceneId
              ? { ...p.settings, entrySceneId: null }
              : p.settings,
        }));
      },

      reorderScenes: (orderedIds) => {
        transform('scene.reorder', 'Reordenar escenas', (p) => {
          const position = new Map(orderedIds.map((id, index) => [id, index]));
          return {
            ...p,
            scenes: [...p.scenes]
              .map((s) => ({ ...s, order: position.get(s.id) ?? s.order }))
              .sort((a, b) => a.order - b.order),
          };
        });
      },

      addHotspot: (sceneId, hotspot) => {
        transform('hotspot.add', 'Añadir marcador', (p) => ({
          ...p,
          scenes: p.scenes.map((s) =>
            s.id === sceneId ? { ...s, hotspots: [...s.hotspots, hotspot] } : s,
          ),
        }));
      },

      updateHotspot: (sceneId, hotspotId, label, patch, coalesceKey) => {
        transform(
          'hotspot.update',
          label,
          (p) => ({
            ...p,
            scenes: p.scenes.map((s) =>
              s.id === sceneId
                ? {
                    ...s,
                    hotspots: s.hotspots.map((h) =>
                      h.id === hotspotId
                        ? { ...h, ...patch, updatedAt: new Date().toISOString() }
                        : h,
                    ),
                  }
                : s,
            ),
          }),
          coalesceKey,
        );
      },

      removeHotspots: (sceneId, hotspotIds) => {
        const ids = new Set(hotspotIds);
        transform(
          'hotspot.remove',
          ids.size === 1 ? 'Eliminar marcador' : `Eliminar ${ids.size} marcadores`,
          (p) => ({
            ...p,
            scenes: p.scenes.map((s) =>
              s.id === sceneId ? { ...s, hotspots: s.hotspots.filter((h) => !ids.has(h.id)) } : s,
            ),
            assetLocations: p.assetLocations.map((l) =>
              l.hotspotId !== null && ids.has(l.hotspotId) ? { ...l, hotspotId: null } : l,
            ),
          }),
        );
      },

      /**
       * Pega marcadores con identificadores nuevos (Y05).
       *
       * Reutilizar los identificadores haría que pegar en la misma escena
       * produjera duplicados que se editan a la vez, que es el fallo clásico
       * de un copiar-pegar implementado a la ligera.
       */
      pasteHotspots: (sceneId, hotspots) => {
        const now = new Date().toISOString();
        const copies = hotspots.map((h, index) => ({
          ...h,
          id: newUuid(),
          sceneId,
          name: `${h.name} (copia)`,
          order: h.order + index + 1,
          createdAt: now,
          updatedAt: now,
        })) as Hotspot[];

        transform(
          'hotspot.paste',
          copies.length === 1 ? 'Pegar marcador' : `Pegar ${copies.length} marcadores`,
          (p) => ({
            ...p,
            scenes: p.scenes.map((s) =>
              s.id === sceneId ? { ...s, hotspots: [...s.hotspots, ...copies] } : s,
            ),
          }),
        );
      },
    }),
    [state, integrity, stats, apply, transform],
  );
}

/* ------------------------------------------------------------------ *
 * Ayudas para construir comandos
 * ------------------------------------------------------------------ */

/**
 * Comando para un campo del proyecto con fusión por clave.
 *
 * Se usa en el inspector: arrastrar un deslizador produce decenas de cambios
 * y el usuario espera deshacerlos de una vez.
 */
export function projectFieldCommand<V>(options: {
  readonly kind: string;
  readonly label: string;
  readonly previous: V;
  readonly next: V;
  readonly write: (project: Project, value: V) => Project;
  readonly coalesceKey: string;
}): Command<Project> {
  return fieldCommand<Project, V>({
    kind: options.kind,
    label: options.label,
    previous: options.previous,
    next: options.next,
    write: options.write,
    coalesceKey: options.coalesceKey,
    timestampMs: Date.now(),
  });
}

export { compositeCommand };
