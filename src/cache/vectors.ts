import { eq, ne, or, sql, type SQL } from 'drizzle-orm';
import type { CacheDb } from './db';
import { emails, vecIndexState, type VecIndexState } from './schema';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:vectors');

/** Envelope vectors. Body chunks take part 1..n. */
const ENVELOPE_PART = 0;

/**
 * Bumped when the meaning of an indexed row changes without the model
 * changing, so the existing rebuild path re-embeds everything. `b1` added
 * body chunks alongside the envelope.
 */
const INDEX_VERSION = 'b1';

/** What gets stored in `vec_index_state.model`; tool output shows plain `cfg.model`. */
export function indexModelId(model: string): string {
  return model.includes('#') ? model : `${model}#${INDEX_VERSION}`;
}

export interface VectorRow {
  uid: number;
  part: number;
  date: number | null;
  vector: Float32Array;
}

export interface KnnHit {
  folder: string;
  uid: number;
  distance: number;
}

/**
 * node:sqlite binds JS numbers as SQLite FLOAT, which vec0 rejects for its
 * INTEGER metadata columns ("Expected integer ... received FLOAT"). Every
 * integer bound into a vec0 statement must go through BigInt.
 */
const int = (value: number): bigint => BigInt(Math.trunc(value));

const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

/**
 * Create the vec0 table if absent, rebuilding it when the configured model
 * or dimensionality no longer matches what is indexed.
 *
 * This never runs as a migration: `CREATE VIRTUAL TABLE ... USING vec0`
 * throws where the extension is unavailable, and a failing migration is a
 * fatal startup error. Creating it lazily keeps those platforms bootable.
 */
export function ensureVecTable(db: CacheDb, model: string, dims: number): void {
  const wanted = indexModelId(model);
  const stale = db
    .select()
    .from(vecIndexState)
    .where(or(ne(vecIndexState.model, wanted), ne(vecIndexState.dims, dims)))
    .all();

  if (stale.length > 0) {
    log.warn(
      'embedding model or index format changed - dropping vector index, re-run imap_index_folder',
      {
        folders: stale.map((s) => s.folder),
        was: stale.map((s) => `${s.model}/${String(s.dims)}`),
        now: `${wanted}/${String(dims)}`,
      },
    );
    db.run(sql.raw('DROP TABLE IF EXISTS vec_emails'));
    db.delete(vecIndexState).run();
  }

  db.run(
    sql.raw(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_emails USING vec0(
         folder text partition key,
         uid integer,
         part integer,
         date integer,
         embedding float[${dims}] distance_metric=cosine
       )`,
    ),
  );
}

/** Folders opted in to semantic search, in a stable order. */
export function indexedFolders(db: CacheDb): string[] {
  return db
    .select({ folder: vecIndexState.folder })
    .from(vecIndexState)
    .all()
    .map((r) => r.folder)
    .toSorted((a, b) => a.localeCompare(b));
}

export function getVecState(db: CacheDb, folder: string): VecIndexState | undefined {
  return db.select().from(vecIndexState).where(eq(vecIndexState.folder, folder)).get();
}

export function upsertVecState(db: CacheDb, row: VecIndexState): void {
  const normalized = { ...row, model: indexModelId(row.model) };
  db.insert(vecIndexState)
    .values(normalized)
    .onConflictDoUpdate({
      target: vecIndexState.folder,
      set: {
        model: normalized.model,
        dims: row.dims,
        fromUid: row.fromUid,
        toUid: row.toUid,
        indexedAt: row.indexedAt,
      },
    })
    .run();
}

/**
 * vec0 has no unique constraint, so a plain INSERT would duplicate a message
 * whenever the same range is embedded twice - after a crash between writing
 * vectors and advancing the watermark, or when two clients index the same
 * cache concurrently.
 *
 * The delete is per uid rather than per (uid, part): re-indexing a message
 * into fewer chunks than last time must not leave the surplus parts behind,
 * pointing at text the message no longer contains.
 */
export function insertVectors(db: CacheDb, folder: string, rows: readonly VectorRow[]): void {
  if (rows.length === 0) return;
  const uids = [...new Set(rows.map((r) => r.uid))];
  db.transaction((tx) => {
    for (const uid of uids) {
      tx.run(sql`DELETE FROM vec_emails WHERE folder = ${folder} AND uid = ${int(uid)}`);
    }
    for (const row of rows) {
      tx.run(
        sql`INSERT INTO vec_emails(folder, uid, part, date, embedding)
            VALUES (${folder}, ${int(row.uid)}, ${int(row.part)}, ${int(row.date ?? 0)}, ${toBlob(row.vector)})`,
      );
    }
  });
}

/**
 * Both deletes are best-effort cleanup invoked from the cache-invalidation
 * path. A missing vec0 table (extension unavailable) or a failed delete must
 * never fail the sync that triggered it, so they no-op when the folder was
 * never indexed and warn rather than throw otherwise.
 */
export function deleteVectorsByFolder(db: CacheDb, folder: string): void {
  if (getVecState(db, folder) === undefined) return;
  try {
    db.run(sql`DELETE FROM vec_emails WHERE folder = ${folder}`);
    db.update(vecIndexState)
      .set({ fromUid: 0, toUid: 0 })
      .where(eq(vecIndexState.folder, folder))
      .run();
  } catch (err) {
    log.warn('could not drop vectors for folder', { folder, msg: messageOf(err) });
  }
}

export function deleteVectorsByUids(db: CacheDb, folder: string, uids: readonly number[]): void {
  if (uids.length === 0 || getVecState(db, folder) === undefined) return;
  try {
    db.transaction((tx) => {
      for (const uid of uids) {
        tx.run(sql`DELETE FROM vec_emails WHERE folder = ${folder} AND uid = ${int(uid)}`);
      }
    });
  } catch (err) {
    log.warn('could not drop vectors for uids', {
      folder,
      count: uids.length,
      msg: messageOf(err),
    });
  }
}

/**
 * `k = ?` is mandatory for a vec0 KNN query - a bare LIMIT is not equivalent.
 * The CTE is MATERIALIZED so the planner cannot inline the scan into an outer
 * query and lose that constraint. Folder and date are applied inside the scan,
 * so the k results come back already filtered rather than filtered afterwards.
 *
 * Grouping happens outside the CTE, leaving `k` untouched. A message is ranked
 * by its single best chunk, not by an average: one sharply relevant paragraph
 * in a long mail should beat a uniformly vague short one.
 *
 * Omitting `folders` searches every indexed folder in one pass - vec0 scans
 * all partitions when the partition key is unconstrained.
 */
export function knnSearch(
  db: CacheDb,
  query: Float32Array,
  k: number,
  opts: { folders?: readonly string[]; sinceMs?: number; beforeMs?: number } = {},
): KnnHit[] {
  // An empty list means "no folder qualifies", not "every folder" - and it
  // would compile to `folder IN ()`, which SQLite rejects outright.
  if (opts.folders?.length === 0) return [];

  const filters: SQL[] = [];
  if (opts.folders !== undefined) {
    const list = opts.folders.map((f) => sql`${f}`);
    filters.push(sql` AND folder IN (${sql.join(list, sql`, `)})`);
  }
  if (opts.sinceMs !== undefined) filters.push(sql` AND date >= ${int(opts.sinceMs)}`);
  if (opts.beforeMs !== undefined) filters.push(sql` AND date < ${int(opts.beforeMs)}`);

  return db.all<KnnHit>(sql`
    WITH knn AS MATERIALIZED (
      SELECT folder, uid, distance FROM vec_emails
      WHERE embedding MATCH ${toBlob(query)}
        AND k = ${int(k)}
        ${sql.join(filters, sql``)}
    )
    SELECT folder, uid, min(distance) AS distance
    FROM knn GROUP BY folder, uid ORDER BY distance
  `);
}

/**
 * Drop vectors whose cached envelope is gone. The delete hooks in queries.ts
 * cover every in-process removal, so this only catches what they could not:
 * rows written by a build predating those hooks, or by another client holding
 * the same cache file. Returns how many were reclaimed.
 */
export function pruneOrphanedVectors(db: CacheDb, folder: string): number {
  if (getVecState(db, folder) === undefined) return 0;
  try {
    const indexed = db.all<{ uid: number }>(
      sql`SELECT uid FROM vec_emails WHERE folder = ${folder}`,
    );
    const live = new Set(
      db
        .select({ uid: emails.uid })
        .from(emails)
        .where(eq(emails.folder, folder))
        .all()
        .map((r) => r.uid),
    );
    const orphans = [...new Set(indexed.map((r) => r.uid))].filter((uid) => !live.has(uid));
    if (orphans.length === 0) return 0;

    db.transaction((tx) => {
      for (const uid of orphans) {
        tx.run(sql`DELETE FROM vec_emails WHERE folder = ${folder} AND uid = ${int(uid)}`);
      }
    });
    log.info('pruned orphaned vectors', { folder, count: orphans.length });
    return orphans.length;
  } catch (err) {
    log.warn('could not prune orphaned vectors', { folder, msg: messageOf(err) });
    return 0;
  }
}

/** Messages, not rows - a message contributes an envelope plus its body chunks. */
export function countVectors(db: CacheDb, folder: string): number {
  const row = db.get<{ c: number }>(
    sql`SELECT count(DISTINCT uid) AS c FROM vec_emails WHERE folder = ${folder}`,
  );
  return row?.c ?? 0;
}

export { ENVELOPE_PART };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
