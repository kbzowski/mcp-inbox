import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { CacheError } from '../errors/types';
import { createLogger } from '../utils/logger';

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
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      throw new CacheError('CACHE_IO_FAILED', diagnoseOpenError(path, err), err);
    }
  }

  let sqlite: DatabaseType;
  try {
    sqlite = new Database(path);
  } catch (err) {
    throw new CacheError('CACHE_IO_FAILED', diagnoseOpenError(path, err), err);
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

/**
 * Turn whatever better-sqlite3 threw into an actionable message. The old
 * version of this code always said "Check IMAP_CACHE_DIR permissions",
 * which is almost never the real cause - the common ones are:
 *  - the native binding failed to load (bad prebuild / wrong Node ABI)
 *  - the db file is locked by another mcp-inbox instance
 *  - actual permission denied (rare, but covered)
 *
 * Exported for unit tests.
 */
export function diagnoseOpenError(path: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined;

  let hint: string;
  if (
    /cannot find module|invalid elf|was compiled against|node_modules[\\/]better-sqlite3/i.test(msg)
  ) {
    hint =
      'The better-sqlite3 native binding failed to load. Try:\n' +
      '  npm rebuild better-sqlite3\n' +
      'or reinstall: npm install -g @kbzowski/mcp-inbox --force';
  } else if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    /permission denied|operation not permitted/i.test(msg)
  ) {
    hint = 'Permission denied. Check that IMAP_CACHE_DIR is writable by the current user.';
  } else if (code === 'EBUSY' || /database is locked|SQLITE_BUSY|locked/i.test(msg)) {
    hint =
      'The cache file is locked, probably by another mcp-inbox instance ' +
      '(Claude Desktop + Claude Code both launching the server, for example). ' +
      'Close the other client or point this one at a different IMAP_CACHE_DIR.';
  } else if (code === 'ENOENT') {
    hint =
      'Path not found. IMAP_CACHE_DIR or one of its parents may not exist and could not be created.';
  } else if (/disk i\/o|disk full|ENOSPC/i.test(msg) || code === 'ENOSPC') {
    hint = 'Disk I/O error (out of space, or the volume was disconnected).';
  } else {
    hint = `Underlying error: ${msg}`;
  }

  return `Could not open cache database at ${path}. ${hint}`;
}
