import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { CacheDb } from './db';
import {
  folders,
  emails,
  attachments,
  emailAttachments,
  type Folder,
  type FolderInsert,
  type Email,
  type EmailInsert,
  type Attachment,
  type AttachmentInsert,
} from './schema';

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
export function upsertEmail(db: CacheDb, row: EmailInsert): void {
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

export function getEmail(db: CacheDb, folder: string, uid: number): Email | undefined {
  return db
    .select()
    .from(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .get();
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
 * List cached emails in a folder, newest first by IMAP INTERNALDATE.
 * Messages with a null date sort last - preserves determinism when a
 * provider returns envelope-only rows without dates.
 */
export function listEmailsByFolder(
  db: CacheDb,
  folder: string,
  opts: ListEmailsOptions = {},
): Email[] {
  const conditions = [eq(emails.folder, folder)];
  if (opts.sinceMs !== undefined) conditions.push(gte(emails.date, opts.sinceMs));
  if (opts.beforeMs !== undefined) conditions.push(lt(emails.date, opts.beforeMs));

  let rows = db
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.date), desc(emails.uid))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0)
    .all();

  // Unseen filter is JSON-encoded in the flags column - do it in JS rather
  // than SQL json_extract to keep the query portable across drivers.
  if (opts.unseenOnly) {
    rows = rows.filter((r) => !r.flags.includes('\\Seen'));
  }
  return rows;
}

export function countEmailsInFolder(db: CacheDb, folder: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(emails)
    .where(eq(emails.folder, folder))
    .get();
  return row?.n ?? 0;
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
 * Wipe every cached message in a folder. Invoked when UIDVALIDITY changes
 * on the server - all our UIDs have been invalidated at once.
 */
export function deleteEmailsByFolder(db: CacheDb, folder: string): void {
  db.delete(emails).where(eq(emails.folder, folder)).run();
}

/**
 * Remove a single cached email. Invoked on EXPUNGE from IDLE, and after
 * destructive tools (delete_email, move_to_folder) succeed on the server.
 */
export function deleteEmail(db: CacheDb, folder: string, uid: number): void {
  db.delete(emails)
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .run();
}

/**
 * Remove a batch of UIDs from the cache in one statement. Used by the
 * EXPUNGE-detection path of the UID-diff sync fallback.
 */
export function deleteEmailsByUids(db: CacheDb, folder: string, uids: number[]): void {
  if (uids.length === 0) return;
  db.delete(emails)
    .where(and(eq(emails.folder, folder), inArray(emails.uid, uids)))
    .run();
}

export interface CachedBody {
  bodyText: string | null;
  bodyHtml: string | null;
  bodyCachedAt: number | null;
}

export function getEmailBody(db: CacheDb, folder: string, uid: number): CachedBody | undefined {
  const row = db
    .select({
      bodyText: emails.bodyText,
      bodyHtml: emails.bodyHtml,
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
  body: { text: string | null; html: string | null },
  nowMs: number,
): void {
  db.update(emails)
    .set({
      bodyText: body.text,
      bodyHtml: body.html,
      bodyCachedAt: nowMs,
    })
    .where(and(eq(emails.folder, folder), eq(emails.uid, uid)))
    .run();
}

// ─── Attachments ─────────────────────────────────────────────────────────

/**
 * Register a new attachment blob in the content-addressed store.
 * No-op on conflict - the same SHA-256 is immutable by definition.
 */
export function upsertAttachment(db: CacheDb, row: AttachmentInsert): void {
  db.insert(attachments).values(row).onConflictDoNothing({ target: attachments.sha256 }).run();
}

export function getAttachment(db: CacheDb, sha256: string): Attachment | undefined {
  return db.select().from(attachments).where(eq(attachments.sha256, sha256)).get();
}

/**
 * Link a message's MIME part to its content-addressed attachment row.
 */
export function linkEmailAttachment(
  db: CacheDb,
  folder: string,
  uid: number,
  partId: string,
  sha256: string,
): void {
  db.insert(emailAttachments)
    .values({ folder, uid, partId, sha256 })
    .onConflictDoUpdate({
      target: [emailAttachments.folder, emailAttachments.uid, emailAttachments.partId],
      set: { sha256 },
    })
    .run();
}

export function listAttachmentsForEmail(db: CacheDb, folder: string, uid: number): Attachment[] {
  return db
    .select({
      sha256: attachments.sha256,
      filename: attachments.filename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      filePath: attachments.filePath,
      firstSeenAt: attachments.firstSeenAt,
    })
    .from(emailAttachments)
    .innerJoin(attachments, eq(emailAttachments.sha256, attachments.sha256))
    .where(and(eq(emailAttachments.folder, folder), eq(emailAttachments.uid, uid)))
    .all();
}
