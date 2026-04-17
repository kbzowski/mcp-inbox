import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules', 'dist'],
    environment: 'node',
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    // Keep CI green during scaffolding phases before real tests exist.
    // Once the first test file lands, this becomes a no-op.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/index.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
