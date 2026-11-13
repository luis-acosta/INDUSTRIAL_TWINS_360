/**
 * Sondeo de telemetría para la interfaz.
 *
 * Existe para que haya un solo sitio donde se decide cómo se consulta la
 * telemetría desde React. Antes el mismo efecto estaba copiado en la barra de
 * estado, el inspector, la ficha del activo y el módulo de telemetría; cuatro
 * copias de un bucle con temporizador y cancelación son cuatro oportunidades
 * de olvidar la cancelación en una de ellas, y el síntoma —actualizar un
 * componente desmontado, o seguir consultando tras cerrar el panel— aparece
 * mucho después del cambio que lo causó.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TelemetryMapping, TelemetrySample } from '@it360/domain';
import type { TelemetryClient } from './telemetry-client';

export interface TelemetryReadings {
  readonly samples: readonly TelemetrySample[];
  /**
   * Momento de la última consulta.
   *
   * Se devuelve junto a las muestras, y no se lee del reloj en cada
   * renderizado, porque la antigüedad que se muestra al operador debe
   * corresponder al instante en que se obtuvo el dato. Si se recalculara en
   * cada renderizado, un componente que se repinta por cualquier otro motivo
   * mostraría edades distintas para la misma lectura.
   */
  readonly now: Date;
  readonly error: string | null;
}

const NO_SAMPLES: readonly TelemetrySample[] = [];

/**
 * Consulta la última lectura de cada variable y repite cada `intervalMs`.
 *
 * Con la lista de mapeos vacía no se consulta nada: una petición que pide
 * cero variables sigue costando una ida y vuelta al servicio local.
 */
export function useLatestTelemetry(
  client: TelemetryClient,
  mappings: readonly TelemetryMapping[],
  intervalMs = 5000,
): TelemetryReadings {
  const [state, setState] = useState<{
    samples: readonly TelemetrySample[];
    now: Date;
    error: string | null;
  }>(() => ({ samples: NO_SAMPLES, now: new Date(), error: null }));

  // La clave evita reiniciar el sondeo cuando el llamante construye un array
  // nuevo con los mismos mapeos en cada renderizado, que es lo que ocurre al
  // filtrar con `.filter()` dentro del cuerpo del componente.
  const key = useMemo(() => mappings.map((m) => m.id).join('|'), [mappings]);

  // El sondeo lee los mapeos de una referencia viva, no del cierre del efecto:
  // si el usuario cambia la unidad o el umbral de frescura de una variable, la
  // siguiente consulta debe usar la configuración nueva sin reiniciar el
  // temporizador y perder el ritmo de refresco.
  const latestMappings = useRef(mappings);
  latestMappings.current = mappings;

  useEffect(() => {
    if (mappings.length === 0) {
      setState({ samples: NO_SAMPLES, now: new Date(), error: null });
      return undefined;
    }

    let cancelled = false;

    const poll = async (): Promise<void> => {
      const result = await client.latest(latestMappings.current);
      if (cancelled) return;
      setState(
        result.ok
          ? { samples: result.value, now: new Date(), error: null }
          : // Se conservan las muestras anteriores y se expone el error: dejar
            // el panel en blanco al primer fallo de red borraría la última
            // lectura conocida, que es información útil aunque esté vieja.
            // El propio `quality` de cada muestra ya dirá que está obsoleta.
            (current) => ({ ...current, error: result.error.message }),
      );
    };

    void poll();
    const timer = globalThis.setInterval(() => void poll(), intervalMs);

    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
    // `key` resume la identidad de los mapeos, que es lo que debe reiniciar el
    // sondeo; el contenido se lee de la referencia viva.
  }, [client, key, intervalMs, mappings.length]);

  return state;
}
