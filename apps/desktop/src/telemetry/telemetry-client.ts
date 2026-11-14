/**
 * Cliente de telemetría del editor.
 *
 * Dos implementaciones detrás de la misma interfaz:
 *
 *  - `BackendTelemetryClient` habla con el servicio local, que es quien tiene
 *    el token y consulta InfluxDB. El editor **nunca** ve la credencial; eso
 *    es un límite de confianza de la arquitectura, no una preferencia.
 *  - `SimulatedTelemetryClient` genera series sintéticas con los cuatro
 *    estados de calidad que la etapa 07 obliga a distinguir, incluida una
 *    variable que falla. Existe porque el panel de instrumentos hay que poder
 *    construirlo, revisarlo y probarlo sin un InfluxDB delante, y porque los
 *    casos de prueba exigen provocar «obsoleto», «ausente» y «error» a
 *    voluntad: contra un servidor real, esperar a que una variable se quede
 *    obsoleta no es una prueba, es una espera.
 *
 * El simulador se marca siempre como tal en la interfaz. Un panel que muestra
 * números inventados sin decirlo es peor que un panel vacío.
 */
import {
  assessQuality,
  domainError,
  err,
  ok,
  recommendedWindowSeconds,
  type DataQuality,
  type Result,
  type TelemetryMapping,
  type TelemetrySample,
  type TimeRange,
} from '@it360/domain';

export interface HistoryPoint {
  readonly timestamp: string;
  readonly value: number | null;
}

export interface TelemetryHistory {
  readonly mappingId: string;
  readonly points: readonly HistoryPoint[];
  readonly windowSeconds: number;
  readonly fromCache: boolean;
}

/**
 * Serie tal como la devuelve el servicio local.
 *
 * Se declara aparte de `TelemetryHistory` porque son contratos distintos: el
 * del servicio admite puntos sin marca de tiempo y valores no numéricos, y
 * traduce los fallos del historiador en una bandera en lugar de en un código
 * HTTP. El cliente es quien normaliza eso a lo que la gráfica puede dibujar.
 */
interface BackendHistory {
  readonly mappingId: string;
  readonly points: readonly { readonly timestamp: string | null; readonly value: unknown }[];
  readonly windowSeconds: number;
  readonly fromCache: boolean;
  readonly failed: boolean;
  readonly errorMessage: string | null;
}

export interface TelemetryClient {
  readonly kind: 'backend' | 'simulated';
  /** Última lectura de cada variable solicitada. */
  latest(mappings: readonly TelemetryMapping[]): Promise<Result<readonly TelemetrySample[]>>;
  history(mapping: TelemetryMapping, range: TimeRange): Promise<Result<TelemetryHistory>>;
  ping(): Promise<Result<{ reachable: boolean; latencyMs: number }>>;
}

/* ------------------------------------------------------------------ *
 * Cliente contra el servicio local
 * ------------------------------------------------------------------ */

export class BackendTelemetryClient implements TelemetryClient {
  readonly kind = 'backend' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...init?.headers },
      });

      if (response.status === 401 || response.status === 403) {
        return err(
          domainError('TELEMETRY_UNAUTHORIZED', 'El servicio rechazó la consulta de telemetría', {
            recovery:
              'Revise el token de lectura configurado en el servicio. El editor no almacena credenciales.',
          }),
        );
      }

      if (!response.ok) {
        return err(
          domainError('TELEMETRY_UNAVAILABLE', `El servicio de telemetría respondió ${response.status}`, {
            detail: { status: response.status },
          }),
        );
      }

      return ok((await response.json()) as T);
    } catch (cause) {
      const aborted = controller.signal.aborted;
      return err(
        domainError(aborted ? 'TELEMETRY_UNAVAILABLE' : 'NETWORK_UNAVAILABLE',
          aborted
            ? 'La consulta de telemetría agotó el tiempo de espera'
            : 'No se pudo contactar con el servicio de telemetría',
          {
            detail: { cause: String(cause) },
            recovery:
              'Compruebe que el servicio local está en marcha y que el equipo tiene acceso a la red de planta.',
          },
        ),
      );
    } finally {
      // Sin esto, cada consulta deja un temporizador pendiente: con un sondeo
      // cada cinco segundos y un plazo de ocho, una jornada de sala de control
      // acumula miles de despertares inútiles del WebView.
      clearTimeout(timer);
    }
  }

  async latest(mappings: readonly TelemetryMapping[]): Promise<Result<readonly TelemetrySample[]>> {
    return this.request<readonly TelemetrySample[]>('/api/v1/telemetry/latest', {
      method: 'POST',
      body: JSON.stringify({ mappingIds: mappings.map((m) => m.id) }),
    });
  }

  async history(mapping: TelemetryMapping, range: TimeRange): Promise<Result<TelemetryHistory>> {
    const windowSeconds = recommendedWindowSeconds(range);
    const params = new URLSearchParams({
      from: range.from,
      to: range.to,
      window: String(windowSeconds),
    });
    const result = await this.request<BackendHistory>(
      `/api/v1/telemetry/${encodeURIComponent(mapping.id)}/history?${params.toString()}`,
    );
    if (!result.ok) return result;

    // El servicio contesta 200 con `failed` cuando el historiador falló: la
    // consulta al servicio funcionó, la consulta al historiador no. Sin esta
    // rama la gráfica mostraría un lienzo vacío, que se lee como «no hay
    // datos» y no como «no se pudieron recuperar».
    if (result.value.failed) {
      return err(
        domainError(
          'TELEMETRY_UNAVAILABLE',
          result.value.errorMessage ?? 'No se pudo recuperar el histórico de esta variable',
          {
            detail: { variable: mapping.variable },
            recovery: 'Compruebe que el historiador responde y vuelva a pedir el intervalo.',
          },
        ),
      );
    }

    return ok({
      mappingId: result.value.mappingId,
      // La ventana que manda es la que el servicio aplicó, no la que el
      // editor pidió: el servicio no baja de la recomendada, y el eje de la
      // gráfica tiene que decir la verdad sobre la agregación.
      windowSeconds: result.value.windowSeconds,
      fromCache: result.value.fromCache,
      points: result.value.points.map((point) => ({
        timestamp: point.timestamp ?? '',
        value: typeof point.value === 'number' ? point.value : null,
      })),
    });
  }

  async ping(): Promise<Result<{ reachable: boolean; latencyMs: number }>> {
    const started = performance.now();
    const result = await this.request<{ reachable?: boolean; latencyMs?: number }>(
      '/api/v1/telemetry/ping',
    );
    if (!result.ok) return result;
    // El servicio responde 200 aunque el historiador no conteste: lo que se
    // comprobó entonces es que el servicio está en marcha. Dar por alcanzable
    // el historiador en ese caso sería afirmar algo que nadie midió.
    return ok({
      reachable: result.value.reachable ?? false,
      latencyMs: Math.round(result.value.latencyMs ?? performance.now() - started),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Simulador
 * ------------------------------------------------------------------ */

export interface SimulationProfile {
  /** Valor central de la señal. */
  readonly center: number;
  /** Amplitud de la oscilación. */
  readonly amplitude: number;
  /** Periodo de la oscilación en segundos. */
  readonly periodS: number;
  /** Ruido como fracción de la amplitud. */
  readonly noise: number;
  /** Comportamiento forzado, para cubrir los cuatro estados de X12. */
  readonly behaviour: 'normal' | 'stale' | 'missing' | 'error' | 'nonNumeric' | 'drifting';
}

/**
 * Perfiles por posición en la lista de variables.
 *
 * El reparto es deliberado: la primera variable deriva hacia la alarma para
 * que el indicador de condición y la histéresis se vean en funcionamiento, y
 * las tres últimas reproducen obsoleto, ausente y error. Así el panel muestra
 * los cinco casos sin tocar nada.
 */
const DEFAULT_PROFILES: readonly SimulationProfile[] = [
  { center: 13.8, amplitude: 4.6, periodS: 95, noise: 0.05, behaviour: 'drifting' },
  { center: 62, amplitude: 9, periodS: 240, noise: 0.03, behaviour: 'normal' },
  { center: 142, amplitude: 14, periodS: 70, noise: 0.08, behaviour: 'stale' },
  { center: 3.4, amplitude: 1.6, periodS: 40, noise: 0.12, behaviour: 'normal' },
  { center: 0, amplitude: 0, periodS: 1, noise: 0, behaviour: 'missing' },
  { center: 0, amplitude: 0, periodS: 1, noise: 0, behaviour: 'error' },
];

/** Ruido determinista: la misma variable produce la misma serie. */
function hashNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453;
  return x - Math.floor(x) - 0.5;
}

export class SimulatedTelemetryClient implements TelemetryClient {
  readonly kind = 'simulated' as const;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly profiles: readonly SimulationProfile[] = DEFAULT_PROFILES,
  ) {}

  private profileFor(mapping: TelemetryMapping, index: number): SimulationProfile {
    const explicit = this.profiles[index % this.profiles.length];
    if (explicit === undefined) {
      return { center: 50, amplitude: 10, periodS: 60, noise: 0.05, behaviour: 'normal' };
    }
    // Si el mapeo declara límites de presentación, la señal se centra en
    // ellos para que la escala del indicador tenga sentido.
    if (mapping.displayMin !== null && mapping.displayMax !== null) {
      const span = mapping.displayMax - mapping.displayMin;
      return {
        ...explicit,
        center: mapping.displayMin + span * 0.55,
        amplitude: span * 0.22,
      };
    }
    return explicit;
  }

  private signal(profile: SimulationProfile, mappingId: string, atMs: number): number {
    const seedBase = mappingId.charCodeAt(0) + mappingId.charCodeAt(mappingId.length - 1);
    const phase = (atMs / 1000 / profile.periodS) * Math.PI * 2;
    const drift =
      profile.behaviour === 'drifting'
        ? // Deriva lenta ascendente: cruza el umbral de atención y el de
          // alarma al cabo de unos minutos, que es lo que permite ver la
          // histéresis en acción sin esperar un turno.
          (Math.sin(atMs / 1000 / 420) + 1) * profile.amplitude * 0.6
        : 0;
    const noise = hashNoise(atMs / 1000 + seedBase) * profile.amplitude * profile.noise * 2;
    return profile.center + Math.sin(phase) * profile.amplitude + drift + noise;
  }

  async latest(mappings: readonly TelemetryMapping[]): Promise<Result<readonly TelemetrySample[]>> {
    const now = this.now();
    const samples = mappings.map((mapping, index) => {
      const profile = this.profileFor(mapping, index);
      const fetchedAt = now.toISOString();

      if (profile.behaviour === 'error') {
        return {
          mappingId: mapping.id,
          value: null,
          rawValue: null,
          sourceTimestamp: null,
          fetchedAt,
          quality: 'error' as DataQuality,
          errorMessage: 'Tiempo de espera agotado al consultar el bucket «proceso»',
          fromCache: false,
        };
      }

      if (profile.behaviour === 'missing') {
        return {
          mappingId: mapping.id,
          value: null,
          rawValue: null,
          sourceTimestamp: null,
          fetchedAt,
          quality: 'missing' as DataQuality,
          errorMessage: null,
          fromCache: false,
        };
      }

      if (profile.behaviour === 'nonNumeric') {
        return {
          mappingId: mapping.id,
          value: null,
          rawValue: 'FAULT',
          sourceTimestamp: now.toISOString(),
          fetchedAt,
          quality: 'nonNumeric' as DataQuality,
          errorMessage: null,
          fromCache: false,
        };
      }

      // Para «obsoleto» se devuelve un valor real con marca de tiempo
      // antigua: es exactamente lo que ocurre cuando un instrumento deja de
      // publicar y el histórico conserva su última lectura.
      const ageSeconds = profile.behaviour === 'stale' ? mapping.freshnessSeconds * 3.5 : 2;
      const sourceMs = now.getTime() - ageSeconds * 1000;
      const value = Number(
        this.signal(profile, mapping.id, sourceMs).toFixed(Math.max(mapping.decimals, 0)),
      );

      return {
        mappingId: mapping.id,
        value,
        rawValue: null,
        sourceTimestamp: new Date(sourceMs).toISOString(),
        fetchedAt,
        quality: assessQuality({
          value,
          rawValue: null,
          sourceTimestamp: new Date(sourceMs).toISOString(),
          freshnessSeconds: mapping.freshnessSeconds,
          now,
        }),
        errorMessage: null,
        fromCache: false,
      };
    });

    return ok(samples);
  }

  async history(mapping: TelemetryMapping, range: TimeRange): Promise<Result<TelemetryHistory>> {
    const index = Math.abs(mapping.id.charCodeAt(0)) % this.profiles.length;
    const profile = this.profileFor(mapping, index);

    if (profile.behaviour === 'error') {
      return err(
        domainError('TELEMETRY_UNAVAILABLE', 'No se pudo recuperar el histórico de esta variable', {
          detail: { variable: mapping.variable },
        }),
      );
    }

    const windowSeconds = recommendedWindowSeconds(range);
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);
    const points: HistoryPoint[] = [];

    for (let t = fromMs; t <= toMs; t += windowSeconds * 1000) {
      const value =
        profile.behaviour === 'missing'
          ? null
          : Number(this.signal(profile, mapping.id, t).toFixed(Math.max(mapping.decimals, 0)));
      points.push({ timestamp: new Date(t).toISOString(), value });
    }

    return ok({ mappingId: mapping.id, points, windowSeconds, fromCache: false });
  }

  async ping(): Promise<Result<{ reachable: boolean; latencyMs: number }>> {
    return ok({ reachable: true, latencyMs: 3 });
  }
}

/* ------------------------------------------------------------------ *
 * Caché local
 * ------------------------------------------------------------------ */

/**
 * Envoltura que conserva la última lectura buena.
 *
 * Al perder la conexión, el panel sigue mostrando el último valor conocido
 * **marcado como caché**. La arquitectura lo exige con estas palabras: «datos
 * offline se etiquetan como caché, no como telemetría actual». La diferencia
 * no es cosmética: un operador que ve un número sin marca asume que es de
 * ahora.
 */
export class CachingTelemetryClient implements TelemetryClient {
  private readonly cache = new Map<string, TelemetrySample>();

  constructor(private readonly inner: TelemetryClient) {}

  get kind(): 'backend' | 'simulated' {
    return this.inner.kind;
  }

  async latest(mappings: readonly TelemetryMapping[]): Promise<Result<readonly TelemetrySample[]>> {
    const result = await this.inner.latest(mappings);

    if (result.ok) {
      for (const sample of result.value) {
        if (sample.quality === 'fresh' || sample.quality === 'stale') {
          this.cache.set(sample.mappingId, sample);
        }
      }
      return result;
    }

    const cached = mappings
      .map((m) => this.cache.get(m.id))
      .filter((s): s is TelemetrySample => s !== undefined)
      .map((s) => ({ ...s, fromCache: true, quality: 'stale' as DataQuality }));

    // Sin nada en caché, el error se propaga: inventar un valor sería peor.
    if (cached.length === 0) return result;
    return ok(cached);
  }

  history(mapping: TelemetryMapping, range: TimeRange): Promise<Result<TelemetryHistory>> {
    return this.inner.history(mapping, range);
  }

  ping(): Promise<Result<{ reachable: boolean; latencyMs: number }>> {
    return this.inner.ping();
  }

  get cachedCount(): number {
    return this.cache.size;
  }
}
