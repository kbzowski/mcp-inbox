import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

/**
 * Cache schema for mcp-inbox.
 *
 * Single source of truth - `drizzle-kit generate` produces SQL migrations
 * from this file into src/cache/migrations/, and `drizzle-orm/node-sqlite`
 * infers the query types (InferSelectModel / InferInsertModel) directly.
 *
 * Column naming: camelCase in JS, snake_case in SQL. Drizzle handles the
 * translation, so queries written against this schema stay idiomatic on
 * both sides.
 */

/**
 * One row per IMAP folder/mailbox path we've observed. `uidValidity`
 * and `highestModseq` drive the incremental-sync algorithm; a change
 * in uidValidity invalidates every cached email in the folder.
 */
export const folders = sqliteTable('folders', {
  /** Full mailbox path as returned by IMAP LIST (e.g. "INBOX", "[Gmail]/Sent Mail"). */
  name: text('name').primaryKey(),
  /** Delimiter the server uses - usually "." (Dovecot) or "/" (Gmail). */
  delimiter: text('delimiter').notNull(),
  /** RFC 6154 attribute ("\\Drafts", "\\Sent", etc.) or null. */
  specialUse: text('special_use'),
  /** UIDVALIDITY from SELECT response. If this changes, wipe the cache. */
  uidValidity: integer('uid_validity').notNull(),
  /** Next UID the server will assign. Used for new-message detection. */
  uidNext: integer('uid_next'),
  /** HIGHESTMODSEQ from CONDSTORE. NULL if the server doesn't support it. */
  highestModseq: integer('highest_modseq'),
  /** Epoch milliseconds of the last successful sync completion. */
  lastSyncedAt: integer('last_synced_at').notNull(),
});

/** Metadata only - attachment bytes are never persisted. */
export interface AttachmentInfo {
  filename: string | null;
  content_type: string;
  size_bytes: number;
}

/**
 * Cached envelope + optional body for each message, keyed by folder + UID.
 * IMAP UIDs are folder-scoped (and reset when UIDVALIDITY changes), so the
 * composite primary key is mandatory - never use UID alone.
 */
export const emails = sqliteTable(
  'emails',
  {
    folder: text('folder').notNull(),
    uid: integer('uid').notNull(),
    /** RFC 5322 Message-ID header (with angle brackets). Enables cross-folder dedup. */
    messageId: text('message_id'),
    subject: text('subject'),
    fromAddr: text('from_addr'),
    /** JSON array of recipient email strings. */
    toAddrs: text('to_addrs', { mode: 'json' }).$type<string[]>(),
    ccAddrs: text('cc_addrs', { mode: 'json' }).$type<string[]>(),
    /** INTERNALDATE in epoch ms. */
    date: integer('date'),
    /** JSON array of IMAP flags ("\\Seen", "\\Flagged", etc.). */
    flags: text('flags', { mode: 'json' }).$type<string[]>().notNull(),
    /** Whether any MIME part is an attachment. Indexed for "has-attachment" filters. */
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    /** Full parsed envelope as JSON, for detail-view tools. */
    envelopeJson: text('envelope_json').notNull(),
    /** Plain-text body, nullable - fetched on first read of the message. */
    bodyText: text('body_text'),
    /** HTML body, nullable. Can be large; keep lazy by default. */
    bodyHtml: text('body_html'),
    /** Attachment metadata, written with the body in the same fetch. */
    attachmentsJson: text('attachments_json', { mode: 'json' }).$type<AttachmentInfo[]>(),
    /** Per-message MODSEQ (RFC 7162). Used for CONDSTORE incremental sync. */
    modseq: integer('modseq'),
    /** Epoch ms of envelope cache write. */
    cachedAt: integer('cached_at').notNull(),
    /** Epoch ms of body cache write (NULL if body not yet fetched). */
    bodyCachedAt: integer('body_cached_at'),
  },
  (t) => [
    primaryKey({ columns: [t.folder, t.uid] }),
    index('idx_emails_date').on(t.folder, t.date),
    index('idx_emails_message_id').on(t.messageId),
  ],
);

/**
 * Which folders are opted in to semantic search, and how much of each is
 * embedded. IMAP UIDs increase monotonically within a UIDVALIDITY, so the
 * indexed set is always the contiguous range [fromUid, toUid] - which means
 * "what still needs embedding" is derivable from these two integers plus a
 * query over `emails`, without ever reading back from the vec0 table.
 *
 * `model`/`dims` are recorded per folder because the vec0 table bakes its
 * dimensionality in at creation: a change to either forces a rebuild.
 */
export const vecIndexState = sqliteTable('vec_index_state', {
  folder: text('folder').primaryKey(),
  model: text('model').notNull(),
  dims: integer('dims').notNull(),
  fromUid: integer('from_uid').notNull(),
  toUid: integer('to_uid').notNull(),
  indexedAt: integer('indexed_at').notNull(),
});

// Inferred types - consumed by queries.ts and downstream tool handlers.
export type Folder = typeof folders.$inferSelect;
export type FolderInsert = typeof folders.$inferInsert;
export type Email = typeof emails.$inferSelect;
export type EmailInsert = typeof emails.$inferInsert;
export type VecIndexState = typeof vecIndexState.$inferSelect;
