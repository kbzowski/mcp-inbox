import { z } from 'zod';
import { defineTool } from '../define-tool';
import { formatEmailListMarkdown } from '../../formatters/markdown';
import {
  projectEmailSummary,
  readEnvelopes,
  resolveSpecialFolder,
  syncIfStale,
} from '../emails/shared';

const Input = z.object({
  folder: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional explicit Drafts folder path. If omitted, mcp-inbox auto-detects via RFC 6154 SPECIAL-USE.',
    ),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  max_staleness_seconds: z.number().int().min(0).default(60),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const listDraftsTool = defineTool({
  name: 'imap_list_drafts',
  description:
    'List drafts from the server-advertised Drafts folder (\\Drafts SPECIAL-USE). Auto-detects the folder path across Gmail ([Gmail]/Drafts), Outlook, Fastmail, and others. Pass an explicit `folder` only if the server does not advertise SPECIAL-USE.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const folder = await resolveSpecialFolder(ctx, '\\Drafts', args.folder);
    const didSync = await syncIfStale(ctx, folder, args.max_staleness_seconds);

    const { rows, total, hasMore, nextOffset } = readEnvelopes(ctx, folder, {
      limit: args.limit,
      offset: args.offset,
    });

    const structured = {
      folder,
      drafts: rows.map(projectEmailSummary),
      total_count: total,
      has_more: hasMore,
      next_offset: nextOffset,
      served_from: didSync ? 'sync' : 'cache',
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : `**Drafts folder:** \`${folder}\`\n\n${formatEmailListMarkdown(rows)}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});
