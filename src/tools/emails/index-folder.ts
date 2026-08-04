import { z } from 'zod';
import { defineTool, type ToolContext } from '../define-tool';
import { requireEmbeddings, syncIfStale } from './shared';
import { bodyFetcherFor } from '../../imap/body-text';
import { backfillFolder } from '../../cache/backfill';
import {
  countVectors,
  ensureVecTable,
  getVecState,
  pruneOrphanedVectors,
  upsertVecState,
} from '../../cache/vectors';
import type { EmbeddingsConfig } from '../../config/env';

const Input = z.object({
  folders: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .default(['INBOX'])
    .describe('Folders to index. They share the max_messages budget for this call.'),
  max_messages: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(500)
    .describe(
      'Cap on how many messages are embedded in this call, shared across all listed folders and spent newest-first. Measured at roughly four messages per second, so 500 takes about two minutes; raise it only if your client tolerates a longer tool call. Re-run the tool to continue where it left off.',
    ),
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Sync each folder first if its cache is older than this. Defaults to IMAP_CACHE_DEFAULT_STALENESS_SEC.',
    ),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

interface FolderReport {
  folder: string;
  embedded: number;
  bodies_indexed: number;
  pruned: number;
  indexed_total: number;
  remaining: number;
  complete: boolean;
}

export const indexFolderTool = defineTool({
  name: 'imap_index_folder',
  description:
    "Build the local semantic-search index for one or more folders by embedding each message's subject, sender, and body text through the configured embeddings API. Attachments are never downloaded. Opt-in per folder and safe to re-run: already-indexed messages are skipped, so a large mailbox can be indexed across several calls, and `remaining > 0` means you should call it again. Required before imap_semantic_search can use a folder. Changing the embedding model, or upgrading to a release whose index format changed, discards the index and re-embeds it on the next call.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const cfg = requireEmbeddings(ctx);
    ensureVecTable(ctx.db, cfg.model, cfg.dims);

    const reports: FolderReport[] = [];
    let budget = args.max_messages;

    for (const folder of args.folders) {
      const report = await indexOne(ctx, cfg, folder, budget, args.max_staleness_seconds);
      reports.push(report);
      budget -= report.embedded;
      if (budget <= 0) break;
    }

    const structured = {
      model: cfg.model,
      dims: cfg.dims,
      embedded: sum(reports, (r) => r.embedded),
      bodies_indexed: sum(reports, (r) => r.bodies_indexed),
      indexed_total: sum(reports, (r) => r.indexed_total),
      remaining: sum(reports, (r) => r.remaining),
      complete: reports.length === args.folders.length && reports.every((r) => r.complete),
      folders: reports,
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

async function indexOne(
  ctx: ToolContext,
  cfg: EmbeddingsConfig,
  folder: string,
  budget: number,
  maxStalenessSeconds: number | undefined,
): Promise<FolderReport> {
  await syncIfStale(ctx, folder, maxStalenessSeconds);

  // Seeded before backfilling so a concurrent EXPUNGE's cleanup hook can
  // see that this folder is indexed and drop the vector it just wrote.
  if (getVecState(ctx.db, folder) === undefined) {
    upsertVecState(ctx.db, {
      folder,
      model: cfg.model,
      dims: cfg.dims,
      fromUid: 0,
      toUid: 0,
      indexedAt: ctx.now(),
    });
  }

  const pruned = pruneOrphanedVectors(ctx.db, folder);
  const result = await backfillFolder(
    ctx.db,
    folder,
    cfg,
    budget,
    'both',
    ctx.now,
    bodyFetcherFor(ctx.imap, folder),
  );

  return {
    folder,
    embedded: result.embedded,
    bodies_indexed: result.bodiesIndexed,
    pruned,
    indexed_total: countVectors(ctx.db, folder),
    remaining: result.remaining,
    complete: result.remaining === 0,
  };
}

function sum(reports: readonly FolderReport[], pick: (r: FolderReport) => number): number {
  return reports.reduce((total, r) => total + pick(r), 0);
}

function formatIndexMarkdown(s: {
  model: string;
  embedded: number;
  bodies_indexed: number;
  remaining: number;
  complete: boolean;
  folders: readonly FolderReport[];
}): string {
  const lines: string[] = [
    `Indexed ${String(s.folders.length)} folder(s) for semantic search using \`${s.model}\`.`,
    '',
    '| Folder | Embedded | With text | Indexed | Pending |',
    '|---|---|---|---|---|',
  ];
  for (const r of s.folders) {
    lines.push(
      `| ${r.folder} | ${r.embedded} | ${r.bodies_indexed} | ${r.indexed_total} | ${r.remaining} |`,
    );
  }

  lines.push('');
  if (s.embedded > 0 && s.bodies_indexed === 0) {
    lines.push(
      'This server did not return message text, so only subjects and senders were indexed.',
      '',
    );
  }
  lines.push(
    s.complete
      ? 'Everything listed is fully indexed. `imap_semantic_search` is ready to use.'
      : 'The budget ran out before finishing. Re-run `imap_index_folder` to continue.',
  );
  return lines.join('\n');
}
