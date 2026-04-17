import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/cache/schema.ts',
  out: './src/cache/migrations',
  // Migrations run at server startup via drizzle-orm/node-sqlite/migrator;
  // drizzle-kit here is used only for `generate`, not for push/pull.
  verbose: true,
  strict: true,
});
