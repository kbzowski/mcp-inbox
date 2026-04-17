import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { CacheError } from '../errors/types.js';
import { createLogger } from '../utils/logger.js';

/**
 * Default migrations folder resolved relative to this module.
 *
 *  - Dev (tsx / vitest): `src/cache/migrations/`
 *  - Built binary (dist/index.js): `dist/migrations/` (build script
 *    copies the migrations there so the shipped tarball is self-contained)
 */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

const log = createLogger('mcp-inbox:cache');

export type CacheDb = ReturnType<typeof drizzle<typeof schema>>;

export interface CacheHandle {
  db: CacheDb;
  /** Release the underlying SQLite connection. Safe to call more than once. */
  close: () => void;
}

/**
 * Open (or create) the cache database, run pending migrations, and return
 * a Drizzle-wrapped handle.
 *
 * Why better-sqlite3 and not node:sqlite: Drizzle 0.45.x does not yet
 * ship a node:sqlite driver (tracking issue: drizzle-team/drizzle-orm#2648).
 * better-sqlite3 is Drizzle's first-class SQLite driver, synchronous
 * (matches our call-graph assumptions), and ships prebuilt binaries for
 * Windows/macOS/Linux on Node 24 so end users don't need a build toolchain.
 *
 * @param path Absolute file path, or `:memory:` for an in-process database
 *             (used by unit tests).
 * @param migrationsFolder Directory containing drizzle-kit output
 *             (e.g. src/cache/migrations). When omitted, migrations are
 *             skipped - typical only for :memory: unit tests that don't
 *             need a migration history.
 */
export function openCache(path: string, migrationsFolder?: string): CacheHandle {
  if (path !== ':memory:') {
    // Ensure the parent directory exists before SQLite tries to create the
    // file. mkdir is a no-op if the directory already exists.
    mkdirSync(dirname(path), { recursive: true });
  }

  let sqlite: DatabaseType;
  try {
    sqlite = new Database(path);
  } catch (err) {
    throw new CacheError(
      'CACHE_IO_FAILED',
      `Could not open cache database at ${path}. Check IMAP_CACHE_DIR permissions.`,
      err,
    );
  }

  // Durability + concurrency pragmas. WAL allows concurrent reads during
  // writes; foreign_keys enforces the references() constraints in schema.ts.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  if (migrationsFolder) {
    try {
      migrate(db, { migrationsFolder });
      log.info('cache migrations applied', { migrationsFolder });
    } catch (err) {
      sqlite.close();
      throw new CacheError(
        'CACHE_SCHEMA_MISMATCH',
        'Failed to apply cache migrations. If the cache was created by a newer version, remove it and let mcp-inbox rebuild.',
        err,
      );
    }
  }

  return {
    db,
    close: () => {
      try {
        sqlite.close();
      } catch (err) {
        log.warn('error closing cache db', {
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
