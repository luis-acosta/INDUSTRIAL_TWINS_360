import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@it360/tokens/tokens.css': r('./packages/tokens/src/tokens.css'),
      '@it360/tokens': r('./packages/tokens/src/index.ts'),
      '@it360/domain/testing': r('./packages/domain/src/testing.ts'),
      '@it360/domain': r('./packages/domain/src/index.ts'),
      '@it360/persistence/hash': r('./packages/persistence/src/hash.ts'),
      '@it360/persistence': r('./packages/persistence/src/index.ts'),
      '@it360/ui/styles.css': r('./packages/ui/src/styles.css'),
      '@it360/ui': r('./packages/ui/src/index.ts'),
      '@it360/viewer/viewer.css': r('./packages/viewer/src/viewer.css'),
      '@it360/viewer': r('./packages/viewer/src/index.ts'),
      '@it360/editor': r('./packages/editor/src/index.ts'),
      '@it360/exporter': r('./packages/exporter/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['packages/ui/**', 'jsdom'],
      ['packages/editor/**', 'jsdom'],
      ['packages/viewer/**', 'jsdom'],
      ['apps/**', 'jsdom'],
    ],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
    },
    testTimeout: 30_000,
  },
});
