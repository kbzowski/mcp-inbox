import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
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
 * Backed by Node 24's built-in `node:sqlite` - zero native dependencies,
 * zero install scripts, no ABI mismatches. Drizzle exposes it via the
 * `drizzle-orm/node-sqlite` driver (added in drizzle-orm 1.0.0-beta.16).
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

  let sqlite: DatabaseSync;
  try {
    sqlite = new DatabaseSync(path);
  } catch (err) {
    throw new CacheError('CACHE_IO_FAILED', diagnoseOpenError(path, err), err);
  }

  // Durability + concurrency pragmas. WAL allows concurrent reads during
  // writes; foreign_keys enforces the references() constraints in schema.ts.
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA synchronous = NORMAL;');

  const db = drizzle({ client: sqlite, schema });

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
 * Turn whatever node:sqlite threw into an actionable message. Common causes:
 *  - the db file is locked by another mcp-inbox instance
 *  - permission denied on the cache dir
 *  - path missing / disk full
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
