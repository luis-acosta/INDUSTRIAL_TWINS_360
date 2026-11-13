/**
 * Mandos del recorrido automático sobre la panorámica (J01, J03).
 *
 * Una barra, abajo, con el avance y los mandos. Nada más: lo que el visitante
 * necesita es saber dónde va, poder parar y poder salir.
 *
 * El botón de pausa sólo aparece si el recorrido lo permite. Un botón que no
 * hace nada es peor que ninguno: el visitante lo pulsa, no pasa nada y
 * concluye que la pantalla está colgada. En modo quiosco se dice en su lugar
 * que el recorrido no se puede interrumpir.
 */
import {
  Badge,
  Button,
  IconClose,
  IconPause,
  IconPlay,
  ProgressBar,
} from '@it360/ui';
import type { TourPlayback } from './useTourPlayback';

export interface TourPlayerBarProps {
  readonly playback: TourPlayback;
}

export function TourPlayerBar({ playback }: TourPlayerBarProps): JSX.Element | null {
  const { tour, runtime } = playback;
  if (tour === null || runtime.state === 'idle') return null;

  const interruptible = tour.allowInterrupt;
  const paused = runtime.state === 'interrupted';
  const finished = runtime.state === 'finished';

  return (
    <section className="autopilot" aria-label={`Recorrido automático: ${tour.name}`}>
      <div className="autopilot__bar">
        <div className="autopilot__info">
          <span className="autopilot__name">{tour.name}</span>
          <span className="autopilot__stop">
            {finished
              ? 'Recorrido terminado'
              : `Parada ${playback.stopIndex + 1} de ${playback.stopCount}`}
            {playback.narrating && ' · narración'}
          </span>
        </div>

        <ProgressBar
          value={playback.progress}
          label={`Avance del recorrido ${tour.name}`}
          tone={finished ? 'nominal' : 'accent'}
        />

        <div className="autopilot__controls">
          {finished ? (
            <Button size="sm" variant="secondary" onClick={() => playback.start(tour)}>
              Repetir
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label="Parada anterior"
                disabled={playback.stopIndex === 0}
                onClick={playback.skipPrevious}
                icon={<span aria-hidden>◀</span>}
              />
              {interruptible ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={paused ? <IconPlay size={14} /> : <IconPause size={14} />}
                  onClick={paused ? playback.resume : playback.interrupt}
                >
                  {paused ? 'Continuar' : 'Pausar'}
                </Button>
              ) : (
                <Badge tone="info">sin pausa</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label="Parada siguiente"
                onClick={playback.skipNext}
                icon={<span aria-hidden>▶</span>}
              />
            </>
          )}

          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label="Salir del recorrido"
            onClick={playback.stop}
            icon={<IconClose size={14} />}
          />
        </div>
      </div>

      {playback.caption !== '' && !finished && (
        <p className="autopilot__caption">{playback.caption}</p>
      )}

      {paused && (
        <p className="autopilot__caption autopilot__caption--muted">
          Recorrido en pausa. Puede mirar alrededor con libertad.
          {tour.autoResumeIdleS > 0 &&
            ` Continuará solo tras ${tour.autoResumeIdleS} s sin actividad.`}
        </p>
      )}
    </section>
  );
}
