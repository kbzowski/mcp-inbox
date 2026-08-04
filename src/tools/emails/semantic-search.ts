import { z } from 'zod';
import { defineTool } from '../define-tool';
import { projectEmailSummary, requireEmbeddings, syncIfStale } from './shared';
import { backfillFolder } from '../../cache/backfill';
import { ensureVecTable, knnSearch } from '../../cache/vectors';
import { embedTexts } from '../../embeddings/client';
import { getEmailsByUids } from '../../cache/queries';
import { formatSemanticResultsMarkdown } from '../../formatters/markdown';
import { EmbeddingError } from '../../errors/types';
import type { Email } from '../../cache/schema';

/**
 * Messages that arrived since the last index run are embedded inline before
 * searching, so fresh mail is findable without a manual step. Bounded so a
 * search after a long gap cannot turn into hundreds of HTTP round-trips.
 */
const SEARCH_BACKFILL_BUDGET = 500;

/**
 * A vector can outlive its cached envelope - the message is expunged while
 * another client holds the cache, or it was indexed by a build predating the
 * cleanup hooks. Those hits have no row to return and get dropped after the
 * join, so asking vec0 for exactly `limit` would silently return short.
 */
const OVERFETCH_FACTOR = 2;

const Input = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language description of the message you are looking for.'),
  folder: z.string().min(1).default('INBOX'),
  limit: z.number().int().min(1).max(50).default(10),
  since_date: z.string().date().optional(),
  before_date: z.string().date().optional(),
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Sync the folder first if its cache is older than this. Defaults to IMAP_CACHE_DEFAULT_STALENESS_SEC.',
    ),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const semanticSearchTool = defineTool({
  name: 'imap_semantic_search',
  description:
    'Find messages by meaning rather than by keyword - "the invoice from the hosting provider" can match a message titled "Payment receipt #4417". Ranks cached messages by embedding similarity over subject and sender, so it works across languages and paraphrases. Always returns the top `limit` matches, however weak: it never filters, so decide for yourself which of the returned messages actually answer the question and ignore the rest. Requires imap_index_folder to have been run on the folder first. For exact words, sender addresses, flags, or text inside message bodies, use imap_search_emails instead: it is faster and searches full bodies server-side.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const cfg = requireEmbeddings(ctx);

    ensureVecTable(ctx.db, cfg.model, cfg.dims);

    await syncIfStale(ctx, args.folder, args.max_staleness_seconds);

    const { remaining } = await backfillFolder(
      ctx.db,
      args.folder,
      cfg,
      SEARCH_BACKFILL_BUDGET,
      'newer',
      ctx.now,
    );

    const [queryVector] = await embedTexts([args.query], cfg);
    if (queryVector === undefined) {
      throw new EmbeddingError(
        'EMBEDDING_UNREACHABLE',
        'The embeddings endpoint returned no vector for the search query.',
      );
    }

    const hits = knnSearch(ctx.db, args.folder, queryVector, args.limit * OVERFETCH_FACTOR, {
      ...(args.since_date !== undefined && { sinceMs: Date.parse(args.since_date) }),
      ...(args.before_date !== undefined && { beforeMs: Date.parse(args.before_date) }),
    });

    const cached = getEmailsByUids(
      ctx.db,
      args.folder,
      hits.map((h) => h.uid),
    );
    const ranked = hits
      .map((hit) => ({ hit, email: cached.get(hit.uid) }))
      .filter((r): r is { hit: (typeof hits)[number]; email: Email } => r.email !== undefined)
      .slice(0, args.limit);

    const structured = {
      folder: args.folder,
      query: args.query,
      returned: ranked.length,
      pending_index: remaining,
      emails: ranked.map(({ hit, email }) =>
        Object.assign(projectEmailSummary(email), {
          score: Number((1 - hit.distance).toFixed(4)),
        }),
      ),
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : formatSemanticResultsMarkdown(structured.emails, remaining);

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});
