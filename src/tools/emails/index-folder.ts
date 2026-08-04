import { z } from 'zod';
import { defineTool } from '../define-tool';
import { bodyFetcherFor, requireEmbeddings, syncIfStale } from './shared';
import { backfillFolder } from '../../cache/backfill';
import {
  countVectors,
  ensureVecTable,
  getVecState,
  pruneOrphanedVectors,
  upsertVecState,
} from '../../cache/vectors';

const Input = z.object({
  folder: z.string().min(1).default('INBOX'),
  max_messages: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(500)
    .describe(
      'Cap on how many messages are embedded in this call, newest-first. Measured at roughly four messages per second, so 500 takes about two minutes; raise it only if your client tolerates a longer tool call. Re-run the tool to continue where it left off.',
    ),
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

export const indexFolderTool = defineTool({
  name: 'imap_index_folder',
  description:
    "Build the local semantic-search index for a folder by embedding each message's subject, sender, and body text through the configured embeddings API. Attachments are never downloaded. Opt-in per folder and safe to re-run: already-indexed messages are skipped, so a large folder can be indexed across several calls. Required before imap_semantic_search can be used on that folder.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const cfg = requireEmbeddings(ctx);

    await syncIfStale(ctx, args.folder, args.max_staleness_seconds);

    ensureVecTable(ctx.db, cfg.model, cfg.dims);

    // Seeded before backfilling so a concurrent EXPUNGE's cleanup hook can
    // see that this folder is indexed and drop the vector it just wrote.
    if (getVecState(ctx.db, args.folder) === undefined) {
      upsertVecState(ctx.db, {
        folder: args.folder,
        model: cfg.model,
        dims: cfg.dims,
        fromUid: 0,
        toUid: 0,
        indexedAt: ctx.now(),
      });
    }

    const pruned = pruneOrphanedVectors(ctx.db, args.folder);

    const result = await backfillFolder(
      ctx.db,
      args.folder,
      cfg,
      args.max_messages,
      'both',
      ctx.now,
      bodyFetcherFor(ctx, args.folder),
    );

    const structured = {
      folder: args.folder,
      model: cfg.model,
      dims: cfg.dims,
      embedded: result.embedded,
      bodies_indexed: result.bodiesIndexed,
      pruned,
      indexed_total: countVectors(ctx.db, args.folder),
      remaining: result.remaining,
      complete: result.remaining === 0,
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : formatIndexMarkdown(structured);

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});

function formatIndexMarkdown(s: {
  folder: string;
  model: string;
  embedded: number;
  bodies_indexed: number;
  pruned: number;
  indexed_total: number;
  remaining: number;
  complete: boolean;
}): string {
  const lines = [
    `Indexed **${s.folder}** for semantic search using \`${s.model}\`.`,
    '',
    `- Embedded this run: ${s.embedded} (${s.bodies_indexed} with message text)`,
    `- Indexed in total: ${s.indexed_total}`,
    `- Still unindexed: ${s.remaining}`,
  ];
  if (s.embedded > 0 && s.bodies_indexed === 0) {
    lines.push(
      '- This server did not return message text, so only subjects and senders were indexed.',
    );
  }
  if (s.pruned > 0) {
    lines.push(`- Dropped for deleted messages: ${s.pruned}`);
  }
  lines.push(
    '',
    s.complete
      ? 'The folder is fully indexed. `imap_semantic_search` is ready to use.'
      : 'Re-run `imap_index_folder` on this folder to continue indexing the rest.',
  );
  return lines.join('\n');
}
