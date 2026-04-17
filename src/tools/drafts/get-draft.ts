import { z } from 'zod';
import { defineTool } from '../define-tool';
import {
  ensureBodyCached,
  ensureEnvelopeCached,
  projectEmailSummary,
  resolveSpecialFolder,
} from '../emails/shared';

const Input = z.object({
  uid: z
    .number()
    .int()
    .positive()
    .describe('IMAP UID of the draft in the Drafts folder. Use imap_list_drafts to discover UIDs.'),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe('Optional explicit Drafts folder path. Auto-detected from SPECIAL-USE when omitted.'),
  max_staleness_seconds: z.number().int().min(0).default(60),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const getDraftTool = defineTool({
  name: 'imap_get_draft',
  description:
    'Fetch the full content of a draft (headers, text, HTML, attachment metadata) by UID. Auto-resolves the Drafts folder via RFC 6154 SPECIAL-USE.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const folder = await resolveSpecialFolder(ctx, '\\Drafts', args.folder);
    const envelope = await ensureEnvelopeCached(ctx, folder, args.uid, args.max_staleness_seconds);
    const body = await ensureBodyCached(ctx, folder, args.uid);

    const structured = {
      ...projectEmailSummary(envelope),
      body_text: body.bodyText,
      body_html: body.bodyHtml,
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : formatDraftMarkdown(structured);

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});

function formatDraftMarkdown(d: {
  subject: string | null;
  to: string[] | null;
  cc: string[] | null;
  date: string | null;
  body_text: string | null;
  body_html: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`**Subject:** ${d.subject ?? '(no subject)'}`);
  lines.push(`**To:** ${(d.to ?? []).join(', ') || '(not set)'}`);
  if (d.cc && d.cc.length > 0) lines.push(`**Cc:** ${d.cc.join(', ')}`);
  if (d.date) lines.push(`**Last modified:** ${d.date}`);
  lines.push('', '---', '');
  if (d.body_text && d.body_text.trim().length > 0) {
    lines.push(d.body_text.trim());
  } else if (d.body_html) {
    lines.push('_(HTML-only draft; use response_format=json for the HTML.)_');
  } else {
    lines.push('_(empty body)_');
  }
  return lines.join('\n');
}
