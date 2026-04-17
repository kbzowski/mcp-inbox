import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { buildImapSearch, type EmailSearchCriteria } from '../../imap/search';
import { getEmail, upsertEmail } from '../../cache/queries';
import { messageToInsert } from '../../cache/sync';
import type { Email } from '../../cache/schema';
import { formatEmailListMarkdown } from '../../formatters/markdown';
import { projectEmailSummary, syncIfStale } from './shared';

/**
 * Recursive Zod schema for sub-criteria (the shape that lives inside
 * top-level `or` arrays and `not` wrappers). Same fields as the top-
 * level input but without folder/limit/pagination - those only make
 * sense once.
 */
const Criteria: z.ZodType<EmailSearchCriteria> = z.lazy(() =>
  z.object({
    subject: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    unseen: z.boolean().optional(),
    since: z.coerce.date().optional(),
    before: z.coerce.date().optional(),
    larger_than_bytes: z.number().int().positive().optional(),
    smaller_than_bytes: z.number().int().positive().optional(),
    or: z.array(Criteria).min(2).optional(),
    not: Criteria.optional(),
  }),
);

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
    larger_than_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only match messages larger than this many bytes.'),
    smaller_than_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only match messages smaller than this many bytes.'),
    or: z
      .array(Criteria)
      .min(2)
      .optional()
      .describe(
        'Array of >=2 sub-criteria; at least one must match. Combines as AND with top-level fields: ' +
          '`{subject: "X", or: [{from: "a"}, {from: "b"}]}` means `subject=X AND (from=a OR from=b)`.',
      ),
    not: Criteria.optional().describe(
      'Sub-criteria that must NOT match. Useful for excluding auto-generated mail, e.g. `{not: {from: "noreply"}}`.',
    ),
    limit: z.number().int().min(1).max(100).default(20),
    max_staleness_seconds: z.number().int().min(0).default(60),
    response_format: z.enum(['markdown', 'json']).default('markdown'),
  })
  .refine(
    (v) =>
      v.subject ??
      v.from ??
      v.to ??
      v.body ??
      v.unseen ??
      v.since_date ??
      v.before_date ??
      v.larger_than_bytes ??
      v.smaller_than_bytes ??
      v.or ??
      v.not,
    { message: 'At least one search criterion must be provided.' },
  );

export const searchEmailsTool = defineTool({
  name: 'imap_search_emails',
  description:
    'Search a folder for messages matching subject/from/to/body text, flag, date window, or size. Supports boolean combinators: `or: [...]` for "any of these match", `not: {...}` for exclusion. Runs IMAP SEARCH on the server (body text search is server-side), then returns cached envelopes for the matching UIDs. Results are newest-first.',
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
      ...(args.larger_than_bytes !== undefined && { larger_than_bytes: args.larger_than_bytes }),
      ...(args.smaller_than_bytes !== undefined && {
        smaller_than_bytes: args.smaller_than_bytes,
      }),
      ...(args.or !== undefined && { or: args.or }),
      ...(args.not !== undefined && { not: args.not }),
    });

    let matchingUids: number[];
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);
    let topUids: number[];
    try {
      const result = await imap.search(criteria, { uid: true });
      matchingUids = Array.isArray(result) ? result : [];

      // IMAP returns UIDs ascending; newest first = reverse, then trim.
      topUids = [...matchingUids].reverse().slice(0, args.limit);

      // Auto-fill cache: any UID in the server result that we don't have
      // locally gets its envelope fetched now. Prevents the silent-drop
      // where `returned` would be smaller than `total_matches` just
      // because the cache hadn't seen those UIDs yet.
      const missingUids = topUids.filter((uid) => getEmail(ctx.db, args.folder, uid) === undefined);
      if (missingUids.length > 0) {
        const cachedAt = ctx.now();
        for await (const msg of imap.fetch(
          missingUids,
          { envelope: true, flags: true, internalDate: true, bodyStructure: true },
          { uid: true },
        )) {
          const insert = messageToInsert(args.folder, msg, cachedAt);
          if (insert) upsertEmail(ctx.db, insert);
        }
      }
    } catch (err) {
      lock.release();
      throw mapImapError(err);
    }
    lock.release();

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
