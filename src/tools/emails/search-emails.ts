import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { mapImapError } from '../../errors/mapper.js';
import { buildImapSearch } from '../../imap/search.js';
import { getEmail } from '../../cache/queries.js';
import type { Email } from '../../cache/schema.js';
import { formatEmailListMarkdown } from '../../formatters/markdown.js';
import { projectEmailSummary, syncIfStale } from './shared.js';

const Input = z
  .object({
    folder: z.string().min(1).default('INBOX'),
    subject: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    unseen: z.boolean().optional(),
    since_date: z.string().date().optional(),
    before_date: z.string().date().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    max_staleness_seconds: z.number().int().min(0).default(60),
    response_format: z.enum(['markdown', 'json']).default('markdown'),
  })
  .refine(
    (v) => v.subject ?? v.from ?? v.to ?? v.body ?? v.unseen ?? v.since_date ?? v.before_date,
    { message: 'At least one search criterion must be provided.' },
  );

export const searchEmailsTool = defineTool({
  name: 'imap_search_emails',
  description:
    'Search a folder for messages matching subject/from/to/body text, flag, or date window. Runs IMAP SEARCH on the server (handles body text search), then returns cached envelopes for the matching UIDs. Results are newest-first, newest determined by IMAP UID.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    await syncIfStale(ctx, args.folder, args.max_staleness_seconds);

    const criteria = buildImapSearch({
      ...(args.subject !== undefined && { subject: args.subject }),
      ...(args.from !== undefined && { from: args.from }),
      ...(args.to !== undefined && { to: args.to }),
      ...(args.body !== undefined && { body: args.body }),
      ...(args.unseen !== undefined && { unseen: args.unseen }),
      ...(args.since_date !== undefined && { since: new Date(args.since_date) }),
      ...(args.before_date !== undefined && { before: new Date(args.before_date) }),
    });

    let matchingUids: number[];
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);
    try {
      const result = await imap.search(criteria, { uid: true });
      matchingUids = Array.isArray(result) ? result : [];
    } catch (err) {
      lock.release();
      throw mapImapError(err);
    }
    lock.release();

    // IMAP returns UIDs ascending; newest first = reverse, then trim.
    const topUids = [...matchingUids].reverse().slice(0, args.limit);
    const rows: Email[] = [];
    for (const uid of topUids) {
      const row = getEmail(ctx.db, args.folder, uid);
      if (row) rows.push(row);
    }

    const structured = {
      folder: args.folder,
      total_matches: matchingUids.length,
      returned: rows.length,
      emails: rows.map(projectEmailSummary),
      criteria: {
        subject: args.subject ?? null,
        from: args.from ?? null,
        to: args.to ?? null,
        body: args.body ?? null,
        unseen: args.unseen ?? null,
        since_date: args.since_date ?? null,
        before_date: args.before_date ?? null,
      },
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
