/**
 * Configuración de Vite para la aplicación de escritorio.
 *
 * Los alias apuntan al código fuente de los paquetes del monorepo en lugar de
 * a una compilación intermedia. Con una sola aplicación consumiéndolos, un
 * paso de compilación por paquete sólo añadiría latencia al ciclo de edición
 * y una fuente más de desincronización entre lo que se edita y lo que corre.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@it360/tokens/tokens.css': resolvePath('../../packages/tokens/src/tokens.css'),
      '@it360/tokens': resolvePath('../../packages/tokens/src/index.ts'),
      '@it360/domain/testing': resolvePath('../../packages/domain/src/testing.ts'),
      '@it360/domain': resolvePath('../../packages/domain/src/index.ts'),
      '@it360/persistence/hash': resolvePath('../../packages/persistence/src/hash.ts'),
      '@it360/persistence': resolvePath('../../packages/persistence/src/index.ts'),
      '@it360/ui/styles.css': resolvePath('../../packages/ui/src/styles.css'),
      '@it360/ui': resolvePath('../../packages/ui/src/index.ts'),
      '@it360/viewer/viewer.css': resolvePath('../../packages/viewer/src/viewer.css'),
      '@it360/viewer': resolvePath('../../packages/viewer/src/index.ts'),
      '@it360/tour/tour.css': resolvePath('../../packages/tour/src/tour.css'),
      '@it360/tour': resolvePath('../../packages/tour/src/index.ts'),
      '@it360/editor': resolvePath('../../packages/editor/src/index.ts'),
      '@it360/exporter': resolvePath('../../packages/exporter/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Tauri abre esta URL en su WebView; fijar el puerto evita que un puerto
    // ocupado haga arrancar el contenedor contra una página inexistente.
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    // El WebView de Windows es Chromium reciente: no hace falta transpilar a
    // una línea base antigua, y no hacerlo deja el paquete más pequeño.
    target: 'chrome110',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /**
         * Three.js y React en trozos propios.
         *
         * Son grandes y cambian poco entre versiones de la aplicación, así que
         * separarlos permite que el WebView los reutilice de su caché tras una
         * actualización en lugar de volver a leer un único paquete enorme.
         */
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
