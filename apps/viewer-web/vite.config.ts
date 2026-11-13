/**
 * Configuración del visor publicado.
 *
 * Dos diferencias con la del editor, y las dos importan:
 *
 *  - `base: './'`: el paquete se sirve desde donde el cliente lo ponga, que
 *    casi nunca es la raíz del dominio. Con rutas absolutas, un recorrido en
 *    `intranet.cliente/recorridos/u200/` no carga ni un archivo.
 *  - Nombres de archivo sin huella: el exportador los referencia desde el HTML
 *    que genera, y un nombre con huella obligaría a leer el manifiesto de
 *    Vite para construir ese HTML. Con nombres estables, el exportador sólo
 *    tiene que copiar la carpeta.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@it360/tokens/tokens.css': resolvePath('../../packages/tokens/src/tokens.css'),
      '@it360/tokens': resolvePath('../../packages/tokens/src/index.ts'),
      '@it360/domain/testing': resolvePath('../../packages/domain/src/testing.ts'),
      '@it360/domain': resolvePath('../../packages/domain/src/index.ts'),
      '@it360/ui/styles.css': resolvePath('../../packages/ui/src/styles.css'),
      '@it360/ui': resolvePath('../../packages/ui/src/index.ts'),
      '@it360/viewer/viewer.css': resolvePath('../../packages/viewer/src/viewer.css'),
      '@it360/viewer': resolvePath('../../packages/viewer/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    target: 'chrome110',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'viewer/app.js',
        chunkFileNames: 'viewer/[name].js',
        assetFileNames: (info) =>
          info.name?.endsWith('.css') === true ? 'viewer/app.css' : 'viewer/[name][extname]',
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
