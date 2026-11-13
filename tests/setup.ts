import '@testing-library/jest-dom/vitest';
/**
 * Arranque común de las pruebas.
 *
 * - Zona horaria y locale fijos: los timestamps de telemetría y auditoría se
 *   formatean en presentación, y una prueba no puede depender de la zona de
 *   la máquina que la ejecuta.
 * - `matchMedia` y `ResizeObserver` no existen en jsdom y los usan el tema y
 *   los paneles redimensionables.
 */
import { afterEach, beforeAll, vi } from 'vitest';

process.env.TZ = 'UTC';

beforeAll(() => {
  if (typeof globalThis.window === 'undefined') return;

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }

  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
    // jsdom no implementa CSS.escape, que el árbol y la tira de miniaturas
    // usan para localizar un nodo por su identificador.
    Object.defineProperty(globalThis, 'CSS', {
      value: {
        ...(globalThis.CSS ?? {}),
        escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
      },
      configurable: true,
      writable: true,
    });
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }

  if (!globalThis.crypto?.randomUUID) {
    // jsdom antiguo: UUID v4 determinista por contador para pruebas estables.
    let counter = 0;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        ...globalThis.crypto,
        randomUUID: () => {
          counter += 1;
          const hex = counter.toString(16).padStart(12, '0');
          return `00000000-0000-4000-8000-${hex}`;
        },
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 37 + 11) % 256;
          return arr;
        },
      },
      configurable: true,
    });
  }
});


/**
 * Canvas sin contexto 2D.
 *
 * jsdom no implementa `getContext` y, al llamarlo, escribe un error en la
 * consola virtual por cada invocación. El código de producción ya trata el
 * `null` como «este entorno no puede dibujar», así que se devuelve null
 * directamente: la alternativa —instalar el paquete `canvas` nativo— añadiría
 * una dependencia de compilación a todo el proyecto para no comprobar nada
 * que las pruebas miren.
 */
// Se instala al cargar el fichero de preparación, no en un `beforeEach`: los
// `beforeAll` de cada suite se ejecutan antes que esos ganchos, y una suite que
// prepara datos con canvas en `beforeAll` volvería a tropezar con jsdom.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});
