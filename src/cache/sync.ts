import type { FetchMessageObject, ImapFlow, MailboxObject, MessageStructureObject } from 'imapflow';
import type { CacheDb } from './db';
import { mapImapError } from '../errors/mapper';
import { createLogger } from '../utils/logger';
import {
  deleteEmailsByFolder,
  deleteEmailsByUids,
  getFolder,
  listCachedUidsForFolder,
  setFlagsForUids,
  upsertEmail,
  upsertFolder,
} from './queries';
import type { EmailInsert } from './schema';

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
 *  2. If cached UIDVALIDITY differs from server's → wipe folder cache.
 *  3. SEARCH ALL for the server's UID set, and diff it against the cache:
 *     evict what the server no longer has, fetch envelopes for what we
 *     don't have yet.
 *  4. Refresh flags over the rest, narrowed by CONDSTORE when available.
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

export function diffUids(
  cached: readonly number[],
  server: readonly number[],
): { missing: number[]; ghosts: number[] } {
  const cachedSet = new Set(cached);
  const serverSet = new Set(server);
  return {
    missing: server.filter((uid) => !cachedSet.has(uid)),
    ghosts: cached.filter((uid) => !serverSet.has(uid)),
  };
}

async function runSync(
  ctx: SyncContext,
  folderPath: string,
  box: MailboxObject,
  cached: ReturnType<typeof getFolder>,
  uidValidityChanged: boolean,
): Promise<{ syncType: SyncType; fetched: number }> {
  const coldStart = !cached || uidValidityChanged;

  const searchResult = await ctx.imap.search({ all: true }, { uid: true });
  const serverUids = Array.isArray(searchResult) ? searchResult : [];
  const { missing, ghosts } = diffUids(listCachedUidsForFolder(ctx.db, folderPath), serverUids);

  if (ghosts.length > 0) {
    deleteEmailsByUids(ctx.db, folderPath, ghosts);
    log.info('evicted ghost UIDs', { folder: folderPath, removed: ghosts.length });
  }

  const fetched = missing.length > 0 ? await fetchEnvelopes(ctx, folderPath, missing) : 0;

  const serverModseq = box.highestModseq !== undefined ? Number(box.highestModseq) : null;
  const flagsUnchanged =
    serverModseq !== null && cached?.highestModseq != null && serverModseq === cached.highestModseq;
  if (!flagsUnchanged && serverUids.length > missing.length) {
    await refreshFlags(ctx, folderPath, cached?.highestModseq ?? null);
  }

  if (coldStart) return { syncType: 'full', fetched };
  if (fetched === 0 && ghosts.length === 0 && flagsUnchanged) {
    return { syncType: 'skipped', fetched: 0 };
  }
  return { syncType: 'incremental', fetched };
}

/**
 * Envelopes are immutable, so only UIDs absent from the cache are fetched.
 */
async function fetchEnvelopes(
  ctx: SyncContext,
  folderPath: string,
  uids: number[],
): Promise<number> {
  const now = Date.now();
  let count = 0;

  const iterator = ctx.imap.fetch(
    uids,
    { envelope: true, flags: true, internalDate: true, bodyStructure: true },
    { uid: true },
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

/**
 * Flags are the only mutable part of a cached envelope. CONDSTORE narrows
 * this to rows whose MODSEQ advanced; without it a flags-only FETCH over
 * the folder is still a fraction of an envelope + bodyStructure fetch.
 */
async function refreshFlags(
  ctx: SyncContext,
  folderPath: string,
  cachedModseq: number | null,
): Promise<void> {
  const options =
    cachedModseq !== null
      ? { uid: true, changedSince: BigInt(cachedModseq) }
      : { uid: true as const };

  const next = new Map<number, string[]>();
  for await (const msg of ctx.imap.fetch('1:*', { flags: true }, options)) {
    if (typeof msg.uid === 'number' && msg.flags) {
      next.set(msg.uid, Array.from(msg.flags));
    }
  }

  setFlagsForUids(ctx.db, folderPath, next);
}

/**
 * Map an ImapFlow message into the EmailInsert shape. Exported so tools
 * that fetch envelopes outside the main sync path (e.g. search auto-fill)
 * can reuse exactly the same projection.
 */
export function messageToInsert(
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
