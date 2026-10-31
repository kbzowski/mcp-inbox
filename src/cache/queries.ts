import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { CacheDb } from './db';
import { createLogger } from '../utils/logger';
import { deleteVectorsByFolder, deleteVectorsByUids } from './vectors';
import {
  folders,
  emails,
  type AttachmentInfo,
  type Folder,
  type FolderInsert,
  type Email,
  type EmailInsert,
} from './schema';

const log = createLogger('mcp-inbox:cache');

// ─── Folders ─────────────────────────────────────────────────────────────

/**
 * Insert or update a folder row (matched on the primary-key `name`).
 * Used after every SELECT to record the current UIDVALIDITY / UIDNEXT /
 * HIGHESTMODSEQ + refresh `lastSyncedAt`.
 */
export function upsertFolder(db: CacheDb, row: FolderInsert): void {
  db.insert(folders)
    .values(row)
    .onConflictDoUpdate({
      target: folders.name,
      set: {
        delimiter: row.delimiter,
        specialUse: row.specialUse ?? null,
        uidValidity: row.uidValidity,
        uidNext: row.uidNext ?? null,
        highestModseq: row.highestModseq ?? null,
        lastSyncedAt: row.lastSyncedAt,
      },
    })
    .run();
}

export function getFolder(db: CacheDb, name: string): Folder | undefined {
  return db.select().from(folders).where(eq(folders.name, name)).get();
}

export function listFolders(db: CacheDb): Folder[] {
  return db.select().from(folders).all();
}

// ─── Emails ──────────────────────────────────────────────────────────────

/**
 * Insert or update an email envelope. Matched on (folder, uid) - IMAP UIDs
 * are folder-scoped, never global.
 */
export function upsertEmail(db: Pick<CacheDb, 'insert'>, row: EmailInsert): void {
  db.insert(emails)
    .values(row)
    .onConflictDoUpdate({
      target: [emails.folder, emails.uid],
      set: {
        messageId: row.messageId ?? null,
        subject: row.subject ?? null,
        fromAddr: row.fromAddr ?? null,
        toAddrs: row.toAddrs ?? null,
        ccAddrs: row.ccAddrs ?? null,
        date: row.date ?? null,
        flags: row.flags,
        hasAttachments: row.hasAttachments ?? false,
        envelopeJson: row.envelopeJson,
        modseq: row.modseq ?? null,
        cachedAt: row.cachedAt,
      },
    })
    .run();
}

/**
 * Upsert many envelopes in one transaction. Outside a transaction every
 * insert commits on its own, which on a cold sync of a large folder costs
 * far more than the inserts themselves.
 */
export function upsertEmails(db: CacheDb, rows: readonly EmailInsert[]): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) upsertEmail(tx, row);
  });
}

export function getEmail(db: CacheDb, folder: string, uid: number): Email | undefined {
  return db
    .select()
    .from(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .get();
}

/**
 * Fetch many envelopes by UID, keyed for lookup. Batched, so a UID list
 * over SQLite's parameter cap is safe. UIDs with no cached row are absent
 * from the map rather than present as undefined.
 */
export function getEmailsByUids(
  db: CacheDb,
  folder: string,
  uids: readonly number[],
): Map<number, Email> {
  const out = new Map<number, Email>();
  if (uids.length === 0) return out;
  inBatches(uids, (batch) => {
    const rows = db
      .select()
      .from(emails)
      .where(and(eq(emails.folder, folder), inArray(emails.uid, batch)))
      .all();
    for (const row of rows) out.set(row.uid, row);
  });
  return out;
}

export interface ListEmailsOptions {
  /** Max rows to return. */
  limit?: number;
  /** Rows to skip (for pagination). */
  offset?: number;
  /** If true, only messages without the \\Seen flag. */
  unseenOnly?: boolean;
  /** Only messages received at/after this epoch-ms timestamp. */
  sinceMs?: number;
  /** Only messages received strictly before this epoch-ms timestamp. */
  beforeMs?: number;
}

/**
 * Build the WHERE conditions shared by listEmailsByFolder and
 * countEmailsInFolder. Keeping them aligned is critical: if `total_count`
 * is computed without the same filters as the row list, paginated clients
 * see ever-growing `has_more` chains that return empty pages.
 *
 * The unseen filter uses SQLite's json_each() over the JSON-encoded
 * `flags` column. node:sqlite ships json1 by default.
 */
function buildFolderConditions(folder: string, opts: ListEmailsOptions): SQL[] {
  const conditions: SQL[] = [eq(emails.folder, folder)];
  if (opts.sinceMs !== undefined) conditions.push(gte(emails.date, opts.sinceMs));
  if (opts.beforeMs !== undefined) conditions.push(lt(emails.date, opts.beforeMs));
  if (opts.unseenOnly) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM json_each(${emails.flags}) WHERE value = ${'\\Seen'})`,
    );
  }
  return conditions;
}

/**
 * List cached emails in a folder, newest first by IMAP INTERNALDATE.
 * Messages with a null date sort last - preserves determinism when a
 * provider returns envelope-only rows without dates.
 */
export function listEmailsByFolder(
  db: CacheDb,
  folder: string,
  opts: ListEmailsOptions = {},
): Email[] {
  const conditions = buildFolderConditions(folder, opts);
  return db
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.date), desc(emails.uid))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0)
    .all();
}

export function countEmailsInFolder(
  db: CacheDb,
  folder: string,
  opts: ListEmailsOptions = {},
): number {
  const conditions = buildFolderConditions(folder, opts);
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(emails)
    .where(and(...conditions))
    .get();
  return row?.n ?? 0;
}

export interface IndexCandidateOptions {
  aboveUid?: number;
  belowUid?: number;
  limit: number;
  order: 'asc' | 'desc';
}

/**
 * Cached envelopes on one side of the embedded UID range, oldest- or
 * newest-first. Drives the semantic index backfill, which walks outward
 * from the contiguous range recorded in `vec_index_state`.
 */
export function listIndexCandidates(
  db: CacheDb,
  folder: string,
  opts: IndexCandidateOptions,
): Email[] {
  const conditions: SQL[] = [eq(emails.folder, folder)];
  if (opts.aboveUid !== undefined) conditions.push(gt(emails.uid, opts.aboveUid));
  if (opts.belowUid !== undefined) conditions.push(lt(emails.uid, opts.belowUid));

  return db
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(opts.order === 'asc' ? asc(emails.uid) : desc(emails.uid))
    .limit(opts.limit)
    .all();
}

/**
 * How many cached messages fall outside the embedded range. `fromUid === 0
 * && toUid === 0` means nothing is embedded yet - UIDs start at 1, so zero
 * is a safe empty sentinel.
 */
export function countEmailsOutsideUidRange(
  db: CacheDb,
  folder: string,
  fromUid: number,
  toUid: number,
): number {
  const outside =
    fromUid === 0 && toUid === 0 ? undefined : or(lt(emails.uid, fromUid), gt(emails.uid, toUid));

  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(emails)
    .where(
      outside === undefined ? eq(emails.folder, folder) : and(eq(emails.folder, folder), outside),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Return every cached UID for a folder. Used by the sync reconciliation
 * path to detect ghost entries (UIDs we have locally that are gone on
 * the server - e.g. messages deleted by another client while IDLE was
 * disconnected).
 */
export function listCachedUidsForFolder(db: CacheDb, folder: string): number[] {
  const rows = db.select({ uid: emails.uid }).from(emails).where(eq(emails.folder, folder)).all();
  return rows.map((r) => r.uid);
}

/**
 * Replace the flag set on a cached email. Used for write-through
 * invalidation after mark-read/mark-unread, and when IDLE delivers
 * a FLAGS update.
 */
export function setEmailFlags(db: CacheDb, folder: string, uid: number, flags: string[]): void {
  db.update(emails)
    .set({ flags })
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .run();
}

/**
 * SQLite rejects a statement with more than 32766 bound parameters, and an
 * `IN (...)` list binds one per UID. Folders routinely exceed that, so every
 * UID-list query is split into batches below the limit.
 */
const UID_BATCH = 10_000;

function inBatches<T>(items: readonly T[], run: (batch: T[]) => void): void {
  for (let i = 0; i < items.length; i += UID_BATCH) {
    run(items.slice(i, i + UID_BATCH));
  }
}

/** UIDs with no cached row are silently ignored. */
export function setFlagsForUids(db: CacheDb, folder: string, next: Map<number, string[]>): void {
  if (next.size === 0) return;
  const uids = [...next.keys()];
  db.transaction((tx) => {
    inBatches(uids, (batch) => {
      const rows = tx
        .select({ uid: emails.uid, flags: emails.flags })
        .from(emails)
        .where(and(eq(emails.folder, folder), inArray(emails.uid, batch)))
        .all();
      for (const row of rows) {
        const flags = next.get(row.uid);
        if (!flags || flagsEqual(row.flags, flags)) continue;
        tx.update(emails)
          .set({ flags })
          .where(and(eq(emails.folder, folder), eq(emails.uid, row.uid)))
          .run();
      }
    });
  });
}

/**
 * Apply a flag-set mutation to each of the given UIDs. `mutate` receives
 * the current flags and returns the new flags. Can't be a single SQL
 * UPDATE because existing flags vary per row (we're adding/removing
 * \Seen, not replacing). Wrapped in a transaction so either all rows
 * update or none do.
 *
 * No-ops on empty UID list.
 */
export function mutateEmailFlagsForUids(
  db: CacheDb,
  folder: string,
  uids: number[],
  mutate: (current: string[]) => string[],
): void {
  if (uids.length === 0) return;
  db.transaction((tx) => {
    inBatches(uids, (batch) => {
      const rows = tx
        .select({ uid: emails.uid, flags: emails.flags })
        .from(emails)
        .where(and(eq(emails.folder, folder), inArray(emails.uid, batch)))
        .all();
      for (const row of rows) {
        const next = mutate(row.flags);
        // Skip the UPDATE when the mutation was a no-op (e.g. \Seen already
        // present). Saves a write per row on the common case.
        if (flagsEqual(row.flags, next)) continue;
        tx.update(emails)
          .set({ flags: next })
          .where(and(eq(emails.folder, folder), eq(emails.uid, row.uid)))
          .run();
      }
    });
  });
}

function flagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const f of a) if (!setB.has(f)) return false;
  return true;
}

/**
 * Wipe every cached message in a folder. Invoked when UIDVALIDITY changes
 * on the server - all our UIDs have been invalidated at once.
 */
export function deleteEmailsByFolder(db: CacheDb, folder: string): void {
  db.delete(emails).where(eq(emails.folder, folder)).run();
  deleteVectorsByFolder(db, folder);
}

/**
 * Remove a single cached email. Invoked on EXPUNGE from IDLE, and after
 * destructive tools (delete_email, move_to_folder) succeed on the server.
 */
export function deleteEmail(db: CacheDb, folder: string, uid: number): void {
  db.delete(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .run();
  deleteVectorsByUids(db, folder, [uid]);
}

/**
 * Remove a batch of UIDs from the cache in one statement. Used by the
 * EXPUNGE-detection path of the UID-diff sync fallback.
 */
export function deleteEmailsByUids(db: CacheDb, folder: string, uids: number[]): void {
  if (uids.length === 0) return;
  inBatches(uids, (batch) => {
    db.delete(emails)
      .where(and(eq(emails.folder, folder), inArray(emails.uid, batch)))
      .run();
  });
  deleteVectorsByUids(db, folder, uids);
}

/**
 * Drop cached bodies last read before `cutoffMs`, keeping the envelope row.
 * Envelopes are small and drive list/search; bodies are the unbounded part.
 * Returns the number of rows cleared.
 */
export function pruneBodiesBefore(db: CacheDb, cutoffMs: number): number {
  const stale = db
    .select({ n: sql<number>`count(*)` })
    .from(emails)
    .where(lt(emails.bodyCachedAt, cutoffMs))
    .get();
  const count = stale?.n ?? 0;
  if (count === 0) return 0;

  db.update(emails)
    .set({ bodyText: null, bodyHtml: null, attachmentsJson: null, bodyCachedAt: null })
    .where(lt(emails.bodyCachedAt, cutoffMs))
    .run();
  return count;
}

export interface CachedBody {
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentInfo[] | null;
  bodyCachedAt: number | null;
}

export function getEmailBody(db: CacheDb, folder: string, uid: number): CachedBody | undefined {
  const row = db
    .select({
      bodyText: emails.bodyText,
      bodyHtml: emails.bodyHtml,
      attachments: emails.attachmentsJson,
      bodyCachedAt: emails.bodyCachedAt,
    })
    .from(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .get();
  return row;
}

export function setEmailBody(
  db: CacheDb,
  folder: string,
  uid: number,
  body: { text: string | null; html: string | null; attachments?: AttachmentInfo[] },
  nowMs: number,
): boolean {
  const existing = db
    .select({ uid: emails.uid })
    .from(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .get();

  // An UPDATE against a missing row is a silent no-op, which would make every
  // later read refetch the whole message with nothing to explain why.
  if (!existing) {
    log.warn('cannot cache body, envelope row missing', { folder, uid });
    return false;
  }

  db.update(emails)
    .set({
      bodyText: body.text,
      bodyHtml: body.html,
      attachmentsJson: body.attachments ?? [],
      bodyCachedAt: nowMs,
    })
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .run();
  return true;
}
