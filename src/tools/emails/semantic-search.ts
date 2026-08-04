import { z } from 'zod';
import { defineTool } from '../define-tool';
import { projectEmailSummary, requireEmbeddings, syncIfStale } from './shared';
import { ensureVecTable, indexedFolders, knnSearch } from '../../cache/vectors';
import { pendingForFolders } from '../../cache/backfill';
import { embedTexts } from '../../embeddings/client';
import { getEmailsByUids } from '../../cache/queries';
import { formatSemanticResultsMarkdown } from '../../formatters/markdown';
import { EmbeddingError } from '../../errors/types';
import type { Email } from '../../cache/schema';

/**
 * A message occupies several rows in the index - one per body chunk plus its
 * envelope - and those collapse to a single result, so asking vec0 for exactly
 * `limit` rows would return far fewer messages than requested. Vectors that
 * outlived their cached envelope shrink the set further.
 */
const OVERFETCH_FACTOR = 5;

const Input = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language description of the message you are looking for.'),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict the search to one folder. Omit to search every indexed folder at once.'),
  limit: z.number().int().min(1).max(50).default(10),
  since_date: z.string().date().optional(),
  before_date: z.string().date().optional(),
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Sync the folder first if its cache is older than this. Ignored when no folder is given. Defaults to IMAP_CACHE_DEFAULT_STALENESS_SEC.',
    ),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const semanticSearchTool = defineTool({
  name: 'imap_semantic_search',
  description:
    'Find messages by meaning rather than by keyword - "the invoice from the hosting provider" can match a message titled "Payment receipt #4417". Ranks cached messages by embedding similarity over their subject, sender, and message text, so it finds a message by what it says even when the subject is useless ("Re: 4417"), and works across languages and paraphrases. Always returns the top `limit` matches, however weak: it never filters, so decide for yourself which of the returned messages actually answer the question and ignore the rest. Searches every indexed folder unless you name one, and each result says which folder it came from. Only folders that imap_index_folder has already covered are searched. A non-zero `pending_index` means some messages are still unindexed and the answer may be incomplete; the server catches up on its own within minutes. For exact words, sender addresses, flags, or text inside message bodies, use imap_search_emails instead: it is faster and searches full bodies server-side.',
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

    const folders = args.folder === undefined ? indexedFolders(ctx.db) : [args.folder];
    if (folders.length === 0) {
      throw new EmbeddingError(
        'EMBEDDING_NOT_INDEXED',
        'No folder has been indexed for semantic search yet. Run imap_index_folder first, or use imap_search_emails.',
      );
    }

    if (args.folder !== undefined) {
      await syncIfStale(ctx, args.folder, args.max_staleness_seconds);
    }

    const remaining = pendingForFolders(ctx.db, folders);

    const [queryVector] = await embedTexts([args.query], cfg);
    if (queryVector === undefined) {
      throw new EmbeddingError(
        'EMBEDDING_UNREACHABLE',
        'The embeddings endpoint returned no vector for the search query.',
      );
    }

    const hits = knnSearch(ctx.db, queryVector, args.limit * OVERFETCH_FACTOR, {
      ...(args.folder !== undefined && { folders }),
      ...(args.since_date !== undefined && { sinceMs: Date.parse(args.since_date) }),
      ...(args.before_date !== undefined && { beforeMs: Date.parse(args.before_date) }),
    });

    const byFolder = new Map<string, number[]>();
    for (const hit of hits) {
      const bucket = byFolder.get(hit.folder);
      if (bucket === undefined) byFolder.set(hit.folder, [hit.uid]);
      else bucket.push(hit.uid);
    }
    const cached = new Map<string, Map<number, Email>>();
    for (const [folder, uids] of byFolder) {
      cached.set(folder, getEmailsByUids(ctx.db, folder, uids));
    }

    const ranked = hits
      .map((hit) => ({ hit, email: cached.get(hit.folder)?.get(hit.uid) }))
      .filter((r): r is { hit: (typeof hits)[number]; email: Email } => r.email !== undefined)
      .slice(0, args.limit);

    const structured = {
      folders,
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
