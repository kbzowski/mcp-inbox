import { z } from 'zod';
import { defineTool } from '../define-tool';
import { buildRawMessage } from '../../imap/mime-builder';
import { ensureBodyAndSource, ensureEnvelopeCached } from '../emails/shared';
import { flattenCompose, sendRawAndAppendSent } from './shared';
import { AddressList, AttachmentList, toMessageAttachments } from '../compose-schema';

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
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Serve from cache if the folder was synced within this many seconds. Defaults to IMAP_CACHE_DEFAULT_STALENESS_SEC.',
    ),
  attachments: AttachmentList.describe(
    'Extra files to add. The original message is always attached on top of these.',
  ),
});

export const forwardTool = defineTool({
  name: 'imap_forward',
  description:
    'Forward an existing message to new recipients. Subject gets a "Fwd: " prefix. The forwarded message is quoted inline with a standard "Begin forwarded message" header, and the untouched original is attached as a .eml file so attachments, signatures and DKIM survive. Optional `body` is prepended above the quote.',
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
    const { body, source } = await ensureBodyAndSource(ctx, args.folder, args.uid);

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
      attachments: [
        {
          filename: emlFilename(original.subject),
          content: source,
          contentType: 'message/rfc822',
          contentDisposition: 'attachment',
        },
        ...(toMessageAttachments(args.attachments) ?? []),
      ],
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
        original_attached: true,
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

export function emlFilename(subject: string | null): string {
  const safe = (subject ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return `${safe === '' ? 'forwarded-message' : safe}.eml`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
