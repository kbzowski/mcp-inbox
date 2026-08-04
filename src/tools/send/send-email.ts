import { z } from 'zod';
import { defineTool } from '../define-tool';
import { buildRawMessage } from '../../imap/mime-builder';
import { flattenCompose, sendRawAndAppendSent } from './shared';
import { AddressList, AttachmentList, toMessageAttachments } from '../compose-schema';

const Input = z.object({
  to: AddressList.describe('Recipient email address or array of addresses.'),
  subject: z.string(),
  body: z.string().optional().describe('Plain-text body.'),
  html: z.string().optional().describe('HTML body (sent as multipart/alternative with text).'),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  from: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Sender address. Defaults to IMAP_USER. Providers like Gmail and Fastmail reject mismatched From unless the address is a verified alias.',
    ),
  attachments: AttachmentList,
});

export const sendEmailTool = defineTool({
  name: 'imap_send_email',
  description:
    "Send an email via SMTP and append a copy to the Sent folder so it appears in the user mail client. Non-ASCII subjects, multipart text+HTML bodies, international recipient lists, and base64 attachments all work through nodemailer's RFC 2822 builder.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const compose = flattenCompose({
      ...(args.from !== undefined && { from: args.from }),
      to: args.to,
      ...(args.cc !== undefined && { cc: args.cc }),
      ...(args.bcc !== undefined && { bcc: args.bcc }),
    });
    const fromAddress = compose.fromOrDefault(ctx.defaults.fromAddress);
    const attachments = toMessageAttachments(args.attachments);

    const raw = await buildRawMessage({
      from: fromAddress,
      to: args.to,
      subject: args.subject,
      ...(args.cc !== undefined && { cc: args.cc }),
      ...(args.bcc !== undefined && { bcc: args.bcc }),
      ...(args.body !== undefined && { text: args.body }),
      ...(args.html !== undefined && { html: args.html }),
      ...(attachments !== undefined && { attachments }),
    });

    const envelope: { from: string; to: string[]; cc?: string[]; bcc?: string[] } = {
      from: fromAddress,
      to: compose.to,
      ...(compose.cc.length > 0 && { cc: compose.cc }),
      ...(compose.bcc.length > 0 && { bcc: compose.bcc }),
    };
    const result = await sendRawAndAppendSent(ctx, raw, envelope);

    const summary = [
      `Sent to ${compose.to.join(', ')}${
        compose.cc.length > 0 ? ` (cc: ${compose.cc.join(', ')})` : ''
      }.`,
      result.messageId ? `Message-ID: ${result.messageId}` : null,
      result.sentFolder
        ? `Saved copy to ${result.sentFolder}.`
        : result.sentSaveError
          ? `Warning: could not save to Sent folder: ${result.sentSaveError}`
          : null,
    ]
      .filter((l): l is string => l !== null)
      .join(' ');

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        from: fromAddress,
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: args.subject,
        message_id: result.messageId,
        sent_folder: result.sentFolder,
        sent_save_error: result.sentSaveError,
      },
    };
  },
});
