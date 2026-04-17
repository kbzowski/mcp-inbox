import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { buildRawMessage } from '../../imap/mime-builder.js';
import { ensureBodyCached, ensureEnvelopeCached } from '../emails/shared.js';
import { flattenCompose, sendRawAndAppendSent } from './shared.js';

const AddressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const Input = z.object({
  folder: z.string().min(1).describe('Folder of the original message.'),
  uid: z.number().int().positive().describe('UID of the message to forward.'),
  to: AddressList.describe('Recipient(s) to forward to.'),
  body: z
    .string()
    .optional()
    .describe(
      'Optional prefix body (e.g. "FYI, thought you should see this."). Quoted original follows.',
    ),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  from: z.string().min(1).optional(),
  max_staleness_seconds: z.number().int().min(0).default(60),
});

export const forwardTool = defineTool({
  name: 'imap_forward',
  description:
    'Forward an existing message to new recipients. Subject gets a "Fwd: " prefix. The forwarded message is quoted inline with a standard "Begin forwarded message" header. Optional `body` is prepended above the quote.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const original = await ensureEnvelopeCached(
      ctx,
      args.folder,
      args.uid,
      args.max_staleness_seconds,
    );
    const body = await ensureBodyCached(ctx, args.folder, args.uid);

    const compose = flattenCompose({
      ...(args.from !== undefined && { from: args.from }),
      to: args.to,
      ...(args.cc !== undefined && { cc: args.cc }),
      ...(args.bcc !== undefined && { bcc: args.bcc }),
    });
    const from = compose.fromOrDefault(ctx.defaults.fromAddress);

    const subject = prefixSubject(original.subject ?? '', 'Fwd: ');

    const originalDate = original.date !== null ? new Date(original.date).toUTCString() : 'unknown';
    const originalFrom = original.fromAddr ?? '(unknown sender)';
    const originalTo = (original.toAddrs ?? []).join(', ');

    const quotedHeader =
      '---------- Forwarded message ----------\n' +
      `From: ${originalFrom}\n` +
      `Date: ${originalDate}\n` +
      `Subject: ${original.subject ?? ''}\n` +
      (originalTo ? `To: ${originalTo}\n` : '') +
      '\n';
    const forwardedText =
      (args.body ? `${args.body}\n\n` : '') + quotedHeader + (body.bodyText ?? '(no text body)');

    const raw = await buildRawMessage({
      from,
      to: args.to,
      ...(args.cc !== undefined && { cc: args.cc }),
      ...(args.bcc !== undefined && { bcc: args.bcc }),
      subject,
      text: forwardedText,
      ...(body.bodyHtml !== null && {
        html:
          (args.body ? `<p>${escapeHtml(args.body)}</p>` : '') +
          '<hr /><p><b>---------- Forwarded message ----------</b><br />' +
          `<b>From:</b> ${escapeHtml(originalFrom)}<br />` +
          `<b>Date:</b> ${escapeHtml(originalDate)}<br />` +
          `<b>Subject:</b> ${escapeHtml(original.subject ?? '')}<br />` +
          (originalTo ? `<b>To:</b> ${escapeHtml(originalTo)}<br />` : '') +
          '</p>' +
          body.bodyHtml,
      }),
    });

    const envelope: { from: string; to: string[]; cc?: string[]; bcc?: string[] } = {
      from,
      to: compose.to,
      ...(compose.cc.length > 0 && { cc: compose.cc }),
      ...(compose.bcc.length > 0 && { bcc: compose.bcc }),
    };
    const result = await sendRawAndAppendSent(ctx, raw, envelope);

    return {
      content: [
        {
          type: 'text',
          text: `Forwarded "${original.subject ?? '(no subject)'}" to ${compose.to.join(', ')}.`,
        },
      ],
      structuredContent: {
        from,
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject,
        forwarded_from_folder: args.folder,
        forwarded_uid: args.uid,
        message_id: result.messageId,
        sent_folder: result.sentFolder,
        sent_save_error: result.sentSaveError,
      },
    };
  },
});

function prefixSubject(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase().trim())
    ? trimmed
    : `${prefix}${trimmed}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
