import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { syncFolder } from '../../cache/sync.js';
import { countEmailsInFolder, getFolder, listEmailsByFolder } from '../../cache/queries.js';
import type { Email } from '../../cache/schema.js';
import { formatEmailListMarkdown } from '../../formatters/markdown.js';

const Input = z.object({
  folder: z
    .string()
    .min(1)
    .default('INBOX')
    .describe('Folder path to list. Use imap_list_folders to discover paths.'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  unseen_only: z.boolean().default(false),
  since_date: z
    .string()
    .date()
    .optional()
    .describe('YYYY-MM-DD. Only return emails received on or after this date.'),
  before_date: z
    .string()
    .date()
    .optional()
    .describe('YYYY-MM-DD. Only return emails received strictly before this date.'),
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .default(60)
    .describe(
      'Serve from cache if the folder was synced within this many seconds. Pass 0 to force a fresh sync.',
    ),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const listEmailsTool = defineTool({
  name: 'imap_list_emails',
  description:
    'List emails in a folder, newest first. Pagination via `limit` + `offset`; filter by unseen, since_date, before_date. Cache-aware: serves from local SQLite when the folder was synced recently, falls through to an incremental IMAP sync otherwise.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const cached = getFolder(ctx.db, args.folder);
    const ageMs = cached ? ctx.now() - cached.lastSyncedAt : Infinity;
    const stale = ageMs >= args.max_staleness_seconds * 1000;

    if (stale) {
      const imap = await ctx.imap.connection();
      await syncFolder({ db: ctx.db, imap }, args.folder);
    }

    const rows = listEmailsByFolder(ctx.db, args.folder, {
      limit: args.limit,
      offset: args.offset,
      unseenOnly: args.unseen_only,
      ...(args.since_date !== undefined && {
        sinceMs: new Date(args.since_date).getTime(),
      }),
      ...(args.before_date !== undefined && {
        beforeMs: new Date(args.before_date).getTime(),
      }),
    });
    const total = countEmailsInFolder(ctx.db, args.folder);
    const hasMore = args.offset + rows.length < total;

    const structured = {
      folder: args.folder,
      emails: rows.map(projectEmail),
      total_count: total,
      has_more: hasMore,
      next_offset: hasMore ? args.offset + args.limit : null,
      served_from: stale ? 'sync' : 'cache',
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : formatEmailListMarkdown(rows);

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});

/**
 * Project a cache row to the public tool response shape. Hides the
 * cache internals (envelopeJson blob, modseq, cachedAt timestamps).
 */
function projectEmail(e: Email) {
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
