import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Container startup dominates total runtime - give it room.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    globalSetup: ['./tests/integration/setup/greenmail.ts'],
  },
});
