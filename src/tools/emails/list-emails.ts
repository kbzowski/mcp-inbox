import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatEmailListMarkdown } from '../../formatters/markdown.js';
import { projectEmailSummary, readEnvelopes, syncIfStale } from './shared.js';

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
    const didSync = await syncIfStale(ctx, args.folder, args.max_staleness_seconds);

    const { rows, total, hasMore, nextOffset } = readEnvelopes(ctx, args.folder, {
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

    const structured = {
      folder: args.folder,
      emails: rows.map(projectEmailSummary),
      total_count: total,
      has_more: hasMore,
      next_offset: nextOffset,
      served_from: didSync ? 'sync' : 'cache',
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
