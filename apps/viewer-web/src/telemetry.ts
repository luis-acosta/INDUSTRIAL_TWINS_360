/**
 * Telemetría del recorrido publicado.
 *
 * Esta clase es la única vía por la que el recorrido publicado obtiene datos
 * de proceso, y está escrita para que no pueda hacer nada más. Tres
 * propiedades la definen:
 *
 *  1. No conoce la URL del historiador, ni la organización, ni el token. Pide
 *     lecturas por identificador de mapeo a un servicio cuyo endpoint viene en
 *     el manifiesto. El manifiesto, por construcción, no lleva credenciales.
 *  2. Sólo tiene un método de lectura. No hay escritura, ni la habrá por
 *     accidente: no existe la función.
 *  3. Si el paquete se publicó para funcionar sin conexión, no consulta nada y
 *     lo dice. Un paquete de USB que intentara consultar un historiador al que
 *     no llega devolvería errores que el visitante interpretaría como una
 *     planta en fallo.
 */
import {
  assessQuality,
  domainError,
  err,
  ok,
  telemetrySampleSchema,
  type Manifest,
  type Result,
  type TelemetrySample,
} from '@it360/domain';

export class PublishedTelemetry {
  constructor(
    private readonly manifest: Manifest,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {}

  /** `true` si este paquete puede consultar datos de proceso. */
  get available(): boolean {
    return !this.manifest.offlineCapable && this.manifest.telemetryMappings.length > 0;
  }

  /** Endpoint del servicio, resuelto contra la ubicación del paquete. */
  private endpoint(): string {
    const declared = this.manifest.telemetryMappings[0]?.serviceEndpoint ?? '/api/v1/telemetry';
    if (declared.startsWith('http://') || declared.startsWith('https://')) return declared;
    return `${this.baseUrl.replace(/\/$/, '')}${declared.startsWith('/') ? '' : '/'}${declared}`;
  }

  /**
   * Última lectura de los mapeos indicados, o de todos.
   *
   * La calidad del dato se vuelve a evaluar aquí con el umbral de frescura de
   * cada variable, en lugar de confiar en la etiqueta que traiga el servicio.
   * El motivo es simple: el servicio no sabe cuánto tarda la respuesta en
   * llegar al navegador ni si el reloj del visitante va atrasado, y «actual»
   * es una afirmación sobre el momento en que alguien mira la pantalla.
   */
  async latest(mappingIds?: readonly string[]): Promise<Result<readonly TelemetrySample[]>> {
    if (this.manifest.offlineCapable) {
      return err(
        domainError('TELEMETRY_UNAVAILABLE', 'Este paquete se publicó sin acceso a datos de proceso', {
          recovery:
            'Los valores que muestre el recorrido corresponden al momento de la publicación y no son lecturas actuales.',
        }),
      );
    }

    const ids =
      mappingIds ?? this.manifest.telemetryMappings.filter((m) => m.enabled).map((m) => m.id);
    if (ids.length === 0) return ok([]);

    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.endpoint()}/latest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mappingIds: ids }),
        signal: controller.signal,
        // Sin credenciales: el visor publicado no tiene sesión y no debe
        // arrastrar cookies de la intranet del cliente a esta petición.
        credentials: 'omit',
        cache: 'no-store',
      });

      if (!response.ok) {
        return err(
          domainError('TELEMETRY_UNAVAILABLE', `El servicio de proceso respondió ${response.status}`, {
            detail: { status: response.status },
          }),
        );
      }

      const raw: unknown = await response.json();
      if (!Array.isArray(raw)) {
        return err(
          domainError('VALIDATION_FAILED', 'El servicio de proceso devolvió una respuesta inesperada'),
        );
      }

      const now = new Date();
      const samples: TelemetrySample[] = [];

      for (const item of raw) {
        const parsed = telemetrySampleSchema.safeParse(item);
        // Una muestra inválida se descarta en silencio y las demás se
        // muestran: perder una variable es mejor que dejar el panel entero en
        // blanco, y la que falta aparecerá como «sin dato», que es la verdad.
        if (!parsed.success) continue;

        const mapping = this.manifest.telemetryMappings.find((m) => m.id === parsed.data.mappingId);
        if (mapping === undefined) continue;

        samples.push({
          ...parsed.data,
          quality: assessQuality({
            value: parsed.data.value,
            rawValue: parsed.data.rawValue,
            sourceTimestamp: parsed.data.sourceTimestamp,
            now,
            freshnessSeconds: mapping.freshnessSeconds,
            failed: parsed.data.quality === 'error',
          }),
        });
      }

      return ok(samples);
    } catch (cause) {
      const aborted = controller.signal.aborted;
      return err(
        domainError(
          aborted ? 'TELEMETRY_UNAVAILABLE' : 'NETWORK_UNAVAILABLE',
          aborted
            ? 'La consulta de datos de proceso agotó el tiempo de espera'
            : 'No se pudo contactar con el servicio de datos de proceso',
          { detail: { cause: String(cause) } },
        ),
      );
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}
