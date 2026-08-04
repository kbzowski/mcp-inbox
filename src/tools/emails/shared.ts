import { simpleParser } from 'mailparser';
import type { ToolContext } from '../define-tool';
import { ImapError } from '../../errors/types';
import { mapImapError } from '../../errors/mapper';
import { syncFolder } from '../../cache/sync';
import {
  countEmailsInFolder,
  getEmail,
  getEmailBody,
  getFolder,
  listEmailsByFolder,
  setEmailBody,
  type ListEmailsOptions,
} from '../../cache/queries';
import type { AttachmentInfo, Email } from '../../cache/schema';
import { findSpecialFolder, type SpecialUseAttr } from '../../imap/folders';

/**
 * Sync a folder if its cache is older than `maxStalenessSec`, which falls
 * back to IMAP_CACHE_DEFAULT_STALENESS_SEC when the caller omits it.
 * Returns true iff a sync actually ran, so callers can decorate their
 * response with `served_from: "cache" | "sync"`.
 */
export async function syncIfStale(
  ctx: ToolContext,
  folder: string,
  maxStalenessSec: number = ctx.cacheConfig.defaultStalenessSec,
): Promise<boolean> {
  const cached = getFolder(ctx.db, folder);
  const ageMs = cached ? ctx.now() - cached.lastSyncedAt : Infinity;
  const stale = ageMs >= maxStalenessSec * 1000;
  if (stale) {
    const imap = await ctx.imap.connection();
    await syncFolder({ db: ctx.db, imap }, folder);
  }
  return stale;
}

/**
 * Read envelopes from the cache with pagination. `syncIfStale` should
 * be called first if the caller wants fresh data.
 */
export function readEnvelopes(
  ctx: ToolContext,
  folder: string,
  opts: ListEmailsOptions,
): { rows: Email[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const rows = listEmailsByFolder(ctx.db, folder, opts);
  // Count must apply the SAME filters as the list, otherwise paginated
  // clients walk off into empty pages because `total` overcounts.
  const total = countEmailsInFolder(ctx.db, folder, opts);
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  const hasMore = offset + rows.length < total;
  return { rows, total, hasMore, nextOffset: hasMore ? offset + limit : null };
}

/**
 * Resolve a special-use folder to its mailbox path, falling back to an
 * explicit override when the server lacks RFC 6154 SPECIAL-USE.
 */
export async function resolveSpecialFolder(
  ctx: ToolContext,
  attr: SpecialUseAttr,
  explicitOverride?: string,
): Promise<string> {
  if (explicitOverride) return explicitOverride;

  try {
    const imap = await ctx.imap.connection();
    const list = await imap.list();
    const path = findSpecialFolder(list, attr);
    if (!path) {
      throw new ImapError(
        'IMAP_FOLDER_NOT_FOUND',
        `No folder matches ${attr} on this server. Pass an explicit \`folder\` to override, or run imap_list_folders to find the right name.`,
      );
    }
    return path;
  } catch (err) {
    if (err instanceof ImapError) throw err;
    throw mapImapError(err);
  }
}

export type { AttachmentInfo };

/**
 * Fetch a message's body and attachment metadata, caching both on first
 * access. Message bodies are immutable, so a cached entry is served
 * without touching the network - no staleness window applies.
 */
export async function ensureBodyCached(
  ctx: ToolContext,
  folder: string,
  uid: number,
): Promise<{
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentInfo[];
}> {
  const cached = getEmailBody(ctx.db, folder, uid);
  if (cached?.bodyCachedAt != null) {
    return {
      bodyText: cached.bodyText,
      bodyHtml: cached.bodyHtml,
      attachments: cached.attachments ?? [],
    };
  }

  const imap = await ctx.imap.connection();
  const lock = await imap.getMailboxLock(folder);
  try {
    const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || msg.source === undefined) {
      throw new ImapError(
        'IMAP_MESSAGE_NOT_FOUND',
        `Message with UID ${String(uid)} was not found in ${folder}. It may have been moved or deleted.`,
      );
    }
    const parsed = await simpleParser(msg.source);
    const bodyText = parsed.text ?? null;
    const bodyHtml = typeof parsed.html === 'string' ? parsed.html : null;

    const attachments: AttachmentInfo[] = (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      content_type: a.contentType ?? 'application/octet-stream',
      size_bytes: typeof a.size === 'number' ? a.size : 0,
    }));

    setEmailBody(ctx.db, folder, uid, { text: bodyText, html: bodyHtml, attachments }, ctx.now());

    return { bodyText, bodyHtml, attachments };
  } catch (err) {
    if (err instanceof ImapError) throw err;
    throw mapImapError(err);
  } finally {
    lock.release();
  }
}

/**
 * Ensure an envelope is cached for (folder, uid). If missing - or if
 * the folder cache is stale per `maxStalenessSec` - triggers a sync
 * first. Returns the cached Email or throws IMAP_MESSAGE_NOT_FOUND.
 */
export async function ensureEnvelopeCached(
  ctx: ToolContext,
  folder: string,
  uid: number,
  maxStalenessSec?: number,
): Promise<Email> {
  const existing = getEmail(ctx.db, folder, uid);
  if (existing !== undefined) {
    await syncIfStale(ctx, folder, maxStalenessSec);
  } else {
    await syncIfStale(ctx, folder, 0); // force fresh sync
  }
  const row = getEmail(ctx.db, folder, uid);
  if (!row) {
    throw new ImapError(
      'IMAP_MESSAGE_NOT_FOUND',
      `No message with UID ${String(uid)} in folder ${folder}.`,
    );
  }
  return row;
}

/**
 * Project an Email row to the public tool response shape.
 * Hides internal fields (envelope_json blob, modseq, cache timestamps).
 */
export function projectEmailSummary(e: Email) {
  return {
    uid: e.uid,
    folder: e.folder,
    message_id: e.messageId,
    subject: e.subject,
    from: e.fromAddr,
    to: e.toAddrs,
    cc: e.ccAddrs,
    date: e.date !== null ? new Date(e.date).toISOString() : null,
    flags: e.flags,
    has_attachments: e.hasAttachments,
    unseen: !e.flags.includes('\\Seen'),
  };
}
