/**
 * Pruebas de la carga progresiva de panorámicas (S08).
 *
 * Las tres reglas que esto fija son las que se pueden equivocar sin que se note
 * en una red rápida y que en la red de una planta arruinan la función. Están
 * fuera del componente precisamente para poder probarlas: jsdom no tiene WebGL
 * y el visor no llega a montar un contexto, así que dentro del componente estas
 * reglas no se podrían ejercitar.
 */
import { describe, expect, it } from 'vitest';
import { domainError, err, ok, type DomainError, type Result } from '@it360/domain';

import { loadProgressive } from './texture-loader';

/** Promesa que se resuelve cuando se le dice. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type R = Result<string, DomainError>;

function recorder() {
  const events: string[] = [];
  return {
    events,
    handlers: {
      onPreview: (value: string) => events.push(`preview:${value}`),
      onFull: (value: string) => events.push(`full:${value}`),
      onFullFailed: (_error: DomainError, withPreview: boolean) =>
        events.push(`failed:${withPreview ? 'conVistaPrevia' : 'sinVistaPrevia'}`),
      onProgress: (fraction: number, withPreview: boolean) =>
        events.push(`progress:${fraction}:${withPreview ? 'conVistaPrevia' : 'sinVistaPrevia'}`),
    },
  };
}

describe('loadProgressive', () => {
  it('lanza las dos cargas a la vez y no en cadena', async () => {
    // TEST-PGL-001: encadenarlas retrasaría la imagen completa exactamente lo
    // que tarde la vista previa. La escena entraría antes y acabaría de cargar
    // después, que es cambiar un problema por otro.
    let previewStarted = false;
    let fullStartedBeforePreviewResolved = false;

    const preview = deferred<R>();
    const { handlers } = recorder();

    const done = loadProgressive<string>(
      () => {
        previewStarted = true;
        return preview.promise;
      },
      async () => {
        fullStartedBeforePreviewResolved = previewStarted;
        return ok('completa');
      },
      handlers,
    );

    preview.resolve(ok('previa'));
    await done;

    expect(fullStartedBeforePreviewResolved).toBe(true);
  });

  it('muestra la vista previa y después la imagen completa', async () => {
    // TEST-PGL-002: el caso normal.
    const full = deferred<R>();
    const { events, handlers } = recorder();

    const done = loadProgressive<string>(
      async () => ok('previa'),
      () => full.promise,
      handlers,
    );

    // Se deja llegar primero la vista previa, como en una red real.
    await Promise.resolve();
    full.resolve(ok('completa'));
    await done;

    expect(events).toEqual(['preview:previa', 'full:completa']);
  });

  it('una vista previa que llega tarde no pisa la imagen completa', async () => {
    // TEST-PGL-003: es el fallo que no se ve en una red rápida y que deja la
    // escena borrosa para siempre. Ocurre de verdad: con la vista previa en
    // caché del navegador y la imagen completa ya descargada, el orden de
    // llegada se invierte.
    const preview = deferred<R>();
    const { events, handlers } = recorder();

    const done = loadProgressive<string>(
      () => preview.promise,
      async () => ok('completa'),
      handlers,
    );

    await Promise.resolve();
    preview.resolve(ok('previa'));
    await done;

    expect(events).toEqual(['full:completa']);
  });

  it('si la completa falla con la vista previa puesta, la escena sigue viva', async () => {
    // TEST-PGL-004: pasar a la pantalla de error se llevaría por delante lo
    // que sí funciona. El visitante puede seguir mirando la escena, y el aviso
    // le dice por qué está borrosa.
    const full = deferred<R>();
    const { events, handlers } = recorder();

    const done = loadProgressive<string>(
      async () => ok('previa'),
      () => full.promise,
      handlers,
    );

    await Promise.resolve();
    full.resolve(err(domainError('NETWORK_UNAVAILABLE', 'sin red')));
    await done;

    expect(events).toEqual(['preview:previa', 'failed:conVistaPrevia']);
  });

  it('sin vista previa, un fallo de la completa es un fallo de la escena', async () => {
    // TEST-PGL-005: aquí no hay nada mirable y la pantalla de error es la
    // respuesta correcta.
    const { events, handlers } = recorder();

    await loadProgressive<string>(
      null,
      async () => err(domainError('NETWORK_UNAVAILABLE', 'sin red')),
      handlers,
    );

    expect(events).toEqual(['failed:sinVistaPrevia']);
  });

  it('una vista previa que falla no impide la imagen completa', async () => {
    // TEST-PGL-006: la vista previa es una mejora. Si su archivo falta
    // —paquete viejo, copia corrupta—, la escena tiene que cargar como siempre
    // y no quedarse esperando.
    const { events, handlers } = recorder();

    await loadProgressive<string>(
      async () => err(domainError('NOT_FOUND', 'no está')),
      async () => ok('completa'),
      handlers,
    );

    expect(events).toEqual(['full:completa']);
  });

  it('el progreso dice si ya hay algo mirable', async () => {
    // TEST-PGL-007: de eso depende que el visor no tape con una pantalla de
    // carga una escena que el visitante ya puede girar.
    const full = deferred<R>();
    const { events, handlers } = recorder();

    const done = loadProgressive<string>(
      async () => ok('previa'),
      (onProgress) => {
        onProgress(0.1);
        return full.promise;
      },
      handlers,
    );

    await Promise.resolve();
    full.resolve(ok('completa'));
    await done;

    // El primer progreso llega antes que la vista previa: todavía no hay nada
    // mirable, y el visor debe seguir mostrando la carga.
    expect(events[0]).toBe('progress:0.1:sinVistaPrevia');
  });

  it('espera a las dos cargas antes de terminar', async () => {
    // TEST-PGL-008: si sólo se esperara a la completa, una vista previa que
    // resolviese después quedaría viva fuera de este alcance y pisaría la
    // imagen buena —el fallo de la regla 2, pero donde ya nadie lo vigila—.
    const preview = deferred<R>();
    let finished = false;

    const done = loadProgressive<string>(
      () => preview.promise,
      async () => ok('completa'),
      recorder().handlers,
    ).then(() => {
      finished = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);

    preview.resolve(ok('previa'));
    await done;
    expect(finished).toBe(true);
  });
});
