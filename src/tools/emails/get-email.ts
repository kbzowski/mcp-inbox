import { z } from 'zod';
import { defineTool } from '../define-tool';
import { ensureBodyCached, ensureEnvelopeCached, projectEmailSummary } from './shared';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the message.'),
  uid: z
    .number()
    .int()
    .positive()
    .describe(
      'IMAP UID of the message. UIDs are folder-scoped - a UID from INBOX cannot be reused with the Sent folder.',
    ),
  max_staleness_seconds: z.number().int().min(0).default(60),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const getEmailTool = defineTool({
  name: 'imap_get_email',
  description:
    'Fetch the full content of a single email: headers, plain-text body, HTML body, and attachment metadata (filename, content type, size). Attachment bytes are NOT downloaded or stored locally - the user can open them in their mail client. Use imap_list_emails or imap_search_emails to discover UIDs first.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const envelope = await ensureEnvelopeCached(
      ctx,
      args.folder,
      args.uid,
      args.max_staleness_seconds,
    );
    const body = await ensureBodyCached(ctx, args.folder, args.uid);

    const structured = {
      ...projectEmailSummary(envelope),
      body_text: body.bodyText,
      body_html: body.bodyHtml,
      attachments: body.attachments,
    };

    const text =
      args.response_format === 'json'
        ? JSON.stringify(structured, null, 2)
        : formatEmailDetail(structured);

    return {
      content: [{ type: 'text', text }],
      structuredContent: structured,
    };
  },
});

function formatEmailDetail(e: {
  subject: string | null;
  from: string | null;
  to: string[] | null;
  cc: string[] | null;
  date: string | null;
  flags: string[];
  has_attachments: boolean;
  body_text: string | null;
  body_html: string | null;
  attachments: { filename: string | null; content_type: string; size_bytes: number }[];
}): string {
  const lines: string[] = [];
  lines.push(`**Subject:** ${e.subject ?? '(no subject)'}`);
  lines.push(`**From:** ${e.from ?? '(unknown)'}`);
  lines.push(`**To:** ${(e.to ?? []).join(', ')}`);
  if (e.cc && e.cc.length > 0) lines.push(`**Cc:** ${e.cc.join(', ')}`);
  if (e.date) lines.push(`**Date:** ${e.date}`);
  lines.push(`**Flags:** ${e.flags.length > 0 ? e.flags.join(', ') : '(none)'}`);
  if (e.attachments.length > 0) {
    lines.push(`**Attachments (${String(e.attachments.length)}):**`);
    for (const a of e.attachments) {
      lines.push(
        `  - ${a.filename ?? '(unnamed)'} (${a.content_type}, ${String(a.size_bytes)} bytes)`,
      );
    }
  }
  lines.push('', '---', '');
  if (e.body_text && e.body_text.trim().length > 0) {
    lines.push(e.body_text.trim());
  } else if (e.body_html) {
    lines.push('_(HTML-only message; fetch with response_format=json to read the HTML.)_');
  } else {
    lines.push('_(no body)_');
  }
  return lines.join('\n');
}
