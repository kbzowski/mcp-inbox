import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    passWithNoTests: true,
    // globalSetup: ['./tests/integration/setup/greenmail.ts'],
    // ^ re-enabled in Phase 3 when the GreenMail bootstrap lands.
  },
});
