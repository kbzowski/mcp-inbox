import type { FetchMessageObject, ImapFlow, MailboxObject, MessageStructureObject } from 'imapflow';
import type { CacheDb } from './db.js';
import { mapImapError } from '../errors/mapper.js';
import { createLogger } from '../utils/logger.js';
import { deleteEmailsByFolder, getFolder, upsertEmail, upsertFolder } from './queries.js';
import type { EmailInsert } from './schema.js';

const log = createLogger('mcp-inbox:sync');

export interface SyncContext {
  db: CacheDb;
  imap: ImapFlow;
}

export type SyncType = 'full' | 'incremental' | 'skipped';

export interface SyncResult {
  folder: string;
  syncType: SyncType;
  fetched: number;
  /** Time in ms spent inside syncFolder - useful for telemetry / tests. */
  durationMs: number;
}

/**
 * Synchronise a single folder's cache with the server.
 *
 * Algorithm:
 *  1. SELECT the mailbox; read UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ.
 *  2. If cached UIDVALIDITY differs from server's → wipe folder cache
 *     and do a full envelope fetch.
 *  3. If server supports CONDSTORE and we have a cached HIGHESTMODSEQ →
 *     fetch only messages with MODSEQ > cached.
 *  4. Otherwise fall back to a full fetch (Phase 3b defers the
 *     UID-diff fallback for CONDSTORE-less servers).
 *  5. Persist the new folder sync state.
 */
export async function syncFolder(ctx: SyncContext, folderPath: string): Promise<SyncResult> {
  const started = Date.now();
  const lock = await ctx.imap.getMailboxLock(folderPath);
  try {
    const box = ctx.imap.mailbox;
    if (!box || typeof box === 'boolean') {
      throw new Error('mailbox unexpectedly closed after getMailboxLock');
    }

    const cached = getFolder(ctx.db, folderPath);
    const uidValidityChanged =
      cached !== undefined && cached.uidValidity !== Number(box.uidValidity);

    if (uidValidityChanged) {
      log.warn('UIDVALIDITY changed - wiping folder cache', {
        folder: folderPath,
        cached: cached?.uidValidity,
        server: Number(box.uidValidity),
      });
      deleteEmailsByFolder(ctx.db, folderPath);
    }

    const { syncType, fetched } = await runSync(ctx, folderPath, box, cached, uidValidityChanged);

    upsertFolder(ctx.db, {
      name: folderPath,
      delimiter: box.delimiter ?? '/',
      specialUse: box.specialUse ?? null,
      uidValidity: Number(box.uidValidity),
      uidNext: box.uidNext !== undefined ? Number(box.uidNext) : null,
      highestModseq: box.highestModseq !== undefined ? Number(box.highestModseq) : null,
      lastSyncedAt: Date.now(),
    });

    const durationMs = Date.now() - started;
    log.info('folder synced', { folder: folderPath, syncType, fetched, durationMs });
    return { folder: folderPath, syncType, fetched, durationMs };
  } catch (err) {
    throw mapImapError(err);
  } finally {
    lock.release();
  }
}

async function runSync(
  ctx: SyncContext,
  folderPath: string,
  box: MailboxObject,
  cached: ReturnType<typeof getFolder>,
  uidValidityChanged: boolean,
): Promise<{ syncType: SyncType; fetched: number }> {
  // Full fetch when we have no cache, or when UIDVALIDITY invalidated it.
  if (!cached || uidValidityChanged) {
    const fetched = await fetchAndStoreRange(ctx, folderPath, '1:*');
    return { syncType: 'full', fetched };
  }

  // CONDSTORE incremental path: fetch only messages whose MODSEQ advanced.
  const serverModseq = box.highestModseq !== undefined ? Number(box.highestModseq) : null;
  if (
    serverModseq !== null &&
    cached.highestModseq !== null &&
    cached.highestModseq !== undefined
  ) {
    if (serverModseq === cached.highestModseq) {
      return { syncType: 'skipped', fetched: 0 };
    }
    const fetched = await fetchAndStoreRange(ctx, folderPath, '1:*', BigInt(cached.highestModseq));
    return { syncType: 'incremental', fetched };
  }

  // No CONDSTORE - fall back to full fetch. A UID-diff fallback is
  // tracked for a later iteration (see IMPROVEMENT-PLAN notes).
  const fetched = await fetchAndStoreRange(ctx, folderPath, '1:*');
  return { syncType: 'full', fetched };
}

/**
 * Fetch envelopes/flags for a UID range, optionally gated by CONDSTORE
 * `changedSince`, and upsert each into the cache.
 */
async function fetchAndStoreRange(
  ctx: SyncContext,
  folderPath: string,
  range: string,
  changedSince?: bigint,
): Promise<number> {
  const now = Date.now();
  let count = 0;

  const options = changedSince !== undefined ? { uid: true, changedSince } : { uid: true };
  const iterator = ctx.imap.fetch(
    range,
    {
      envelope: true,
      flags: true,
      internalDate: true,
      bodyStructure: true,
    },
    options,
  );

  for await (const msg of iterator) {
    const insert = messageToInsert(folderPath, msg, now);
    if (insert) {
      upsertEmail(ctx.db, insert);
      count++;
    }
  }

  return count;
}

function messageToInsert(
  folderPath: string,
  msg: FetchMessageObject,
  cachedAt: number,
): EmailInsert | null {
  if (typeof msg.uid !== 'number') return null;

  const env = msg.envelope;
  const date = env?.date ?? msg.internalDate;
  const flags = msg.flags ? Array.from(msg.flags) : [];

  return {
    folder: folderPath,
    uid: msg.uid,
    messageId: env?.messageId ?? null,
    subject: env?.subject ?? null,
    fromAddr: env?.from?.[0]?.address ?? null,
    toAddrs: env?.to?.map((a) => a.address ?? '').filter((a) => a.length > 0) ?? null,
    ccAddrs: env?.cc?.map((a) => a.address ?? '').filter((a) => a.length > 0) ?? null,
    date: date instanceof Date ? date.getTime() : null,
    flags,
    hasAttachments: hasAttachments(msg.bodyStructure),
    envelopeJson: JSON.stringify(env ?? {}),
    modseq: msg.modseq !== undefined ? Number(msg.modseq) : null,
    cachedAt,
  };
}

/**
 * Walk an IMAP body structure tree, returning true if any part looks like
 * a real attachment. A part counts when:
 *  - its Content-Disposition is "attachment", or
 *  - its dispositionParameters include a filename (even if disposition
 *    is missing or "inline" - some clients misclassify).
 *
 * Exported for unit testing - consumers outside sync.ts shouldn't need it.
 */
export function hasAttachments(structure: MessageStructureObject | undefined): boolean {
  if (!structure) return false;
  if (structure.disposition?.toLowerCase() === 'attachment') return true;
  if (structure.dispositionParameters?.filename) return true;
  if (structure.childNodes) {
    return structure.childNodes.some(hasAttachments);
  }
  return false;
}
