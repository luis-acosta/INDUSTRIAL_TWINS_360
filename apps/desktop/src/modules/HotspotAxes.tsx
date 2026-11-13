/**
 * Transformación del marcador en tres ejes (D08, D09).
 *
 * La decisión que hace esto útil en lugar de confuso: **un eje que no se va a
 * notar se dice, no se esconde**. Un marcador «de frente» siempre mira al
 * observador, así que inclinarlo o girarlo sobre su eje vertical no cambia
 * nada de lo que se ve. Ofrecer esos mandos sin más deja al autor moviéndolos
 * y concluyendo que la aplicación está rota; esconderlos le haría creer que la
 * función no existe. Se muestran, deshabilitados, con el motivo al lado y el
 * camino para activarlos: cambiar la proyección a adherido o flotante.
 *
 * El autor trabaja en grados; el modelo guarda radianes. La conversión es la
 * del dominio, no una copia local.
 */
import {
  AXIS_LABELS,
  axisAffectsRender,
  degToRad,
  radToDeg,
  type Axis,
  type ProjectionMode,
  type Transform3d,
} from '@it360/domain';
import { Badge, Button, Field, NumberInput, SectionLabel, Slider } from '@it360/ui';

export interface HotspotAxesProps {
  readonly projection: ProjectionMode;
  readonly transform: Transform3d;
  readonly onChange: (transform: Transform3d, label: string) => void;
}

const AXES: readonly Axis[] = ['roll', 'tilt', 'spin'];

const AXIS_HINTS: Readonly<Record<Axis, string>> = {
  roll: 'Gira el marcador sin sacarlo del plano de la vista.',
  tilt: 'Lo tumba hacia delante o hacia atrás.',
  spin: 'Lo gira como una puerta sobre su eje vertical.',
};

export function HotspotAxes({ projection, transform, onChange }: HotspotAxesProps): JSX.Element {
  const set = (axis: Axis, degrees: number): void => {
    onChange({ ...transform, [axis]: degToRad(degrees) }, `Girar marcador (${AXIS_LABELS[axis].toLowerCase()})`);
  };

  const inactive = AXES.filter((axis) => !axisAffectsRender(axis, projection));
  const anyRotation = AXES.some((axis) => Math.abs(transform[axis]) > 1e-6);

  return (
    <>
      <div className="axes__head">
        <SectionLabel>Rotación y profundidad</SectionLabel>
        {anyRotation && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({ ...transform, roll: 0, tilt: 0, spin: 0 }, 'Restablecer rotación')
            }
          >
            Restablecer
          </Button>
        )}
      </div>

      {inactive.length > 0 && (
        <p className="inspector__hint">
          Con el marcador de frente{inactive.length === 2 ? ', la inclinación y el giro vertical' : ', ese eje'}{' '}
          no se nota: siempre mira al observador. Cámbielo a adherido o flotante para usarlos.
        </p>
      )}

      {AXES.map((axis) => {
        const active = axisAffectsRender(axis, projection);
        const degrees = Number(radToDeg(transform[axis]).toFixed(1));

        return (
          <Field
            key={axis}
            label={AXIS_LABELS[axis]}
            inline
            hint={active ? AXIS_HINTS[axis] : 'Sin efecto con el marcador de frente.'}
          >
            {({ id, describedBy }) => (
              <NumberInput
                id={id}
                size="sm"
                aria-describedby={describedBy}
                value={degrees}
                min={-180}
                max={180}
                step={1}
                unit="°"
                disabled={!active}
                onValueChange={(value) => set(axis, value)}
              />
            )}
          </Field>
        );
      })}

      <Field
        label="Profundidad"
        inline
        hint="Acerca o aleja el marcador del observador sin moverlo de sitio."
      >
        {({ describedBy }) => (
          <div className="axes__depth">
            <Slider
              value={transform.depth}
              onValueChange={(value) => onChange({ ...transform, depth: value }, 'Cambiar profundidad')}
              min={0.1}
              max={10}
              step={0.1}
              aria-label="Profundidad del marcador"
              aria-describedby={describedBy}
            />
            <Badge tone="neutral" mono>
              {transform.depth.toFixed(1)}×
            </Badge>
          </div>
        )}
      </Field>
    </>
  );
}
