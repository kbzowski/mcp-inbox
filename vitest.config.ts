import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules', 'dist'],
    environment: 'node',
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/index.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
