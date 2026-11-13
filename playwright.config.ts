/**
 * Pruebas de extremo a extremo.
 *
 * Comprueban lo que ninguna prueba unitaria puede: que el paquete que produce
 * el exportador sea el que el visor sabe abrir. El contrato entre los dos son
 * nombres de archivo, el identificador del elemento raíz del HTML y la forma
 * del manifiesto, y los tres se pueden romper sin que falle una sola prueba
 * unitaria —cada mitad seguiría siendo coherente consigo misma—.
 *
 * El navegador es el Chrome del sistema y no el que descarga Playwright: en un
 * contenedor sin acceso a la descarga de binarios, obligar a descargarlo deja
 * la suite sin ejecutar. `channel: 'chrome'` usa el instalado.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4399;

export default defineConfig({
  testDir: './tests/e2e',
  // Un fallo de extremo a extremo suele ser un desajuste de contrato, no una
  // intermitencia: repetir lo esconde.
  retries: 0,
  fullyParallel: false,
  reporter: process.env['CI'] === 'true' ? [['list'], ['json', { outputFile: 'test-results/e2e.json' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'recorrido-publicado',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        launchOptions: {
          // El contenedor no tiene espacio de nombres de usuario; sin estos
          // indicadores Chrome no arranca. Son los habituales en integración
          // continua y no afectan a lo que se prueba.
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        },
      },
    },
  ],

  /**
   * El paquete se genera y se sirve antes de las pruebas.
   *
   * Se sirve con un servidor estático de verdad, no con `file://`: el paquete
   * publicado vive en el servidor web del cliente, y abrirlo como archivo
   * local tiene restricciones distintas que harían pasar o fallar pruebas por
   * motivos que no son el producto.
   */
  webServer: {
    // Se sirve con el servidor de la biblioteca estándar de Python en lugar de
    // añadir una dependencia de npm sólo para esto: el paquete publicado son
    // archivos estáticos y cualquier servidor sirve.
    command:
      `npm run build:viewer && npx vite-node tools/make-sample-package.ts -- dist/sample-package && ` +
      `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory dist/sample-package`,
    url: `http://127.0.0.1:${PORT}/manifiesto.json`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
