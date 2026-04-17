import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { mapImapError } from '../../errors/mapper.js';
import { ImapError } from '../../errors/types.js';
import { buildRawMessage } from '../../imap/mime-builder.js';
import { resolveSpecialFolder } from '../emails/shared.js';

const AddressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const Input = z.object({
  to: AddressList.describe('Recipient email address or array of addresses.'),
  subject: z.string(),
  body: z.string().optional().describe('Plain-text body.'),
  html: z.string().optional().describe('HTML body (combined with text via multipart/alternative).'),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  from: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Sender address. Defaults to IMAP_USER. Some providers reject mismatched From headers.',
    ),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit Drafts folder. Auto-resolves via SPECIAL-USE when omitted.'),
});

export const createDraftTool = defineTool({
  name: 'imap_create_draft',
  description:
    'Create a new draft email in the Drafts folder. The message is built with nodemailer (RFC 2822 compliant; handles non-ASCII subjects, long bodies, multipart) and appended to the folder via IMAP APPEND with the \\Draft flag.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const folder = await resolveSpecialFolder(ctx, '\\Drafts', args.folder);

    const raw = await buildRawMessage({
      from: args.from ?? ctx.defaults.fromAddress,
      to: args.to,
      subject: args.subject,
      ...(args.cc !== undefined && { cc: args.cc }),
      ...(args.bcc !== undefined && { bcc: args.bcc }),
      ...(args.body !== undefined && { text: args.body }),
      ...(args.html !== undefined && { html: args.html }),
    });

    const imap = await ctx.imap.connection();
    let uid: number | undefined;
    try {
      const result = await imap.append(folder, raw, ['\\Draft']);
      if (!result) {
        throw new ImapError('IMAP_UNKNOWN', `Server did not accept the draft APPEND to ${folder}.`);
      }
      uid = result.uid;
    } catch (err) {
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    }

    return {
      content: [
        {
          type: 'text',
          text:
            uid !== undefined
              ? `Draft created in ${folder} (UID ${String(uid)}).`
              : `Draft created in ${folder} (server did not return a UID - call imap_list_drafts to locate it).`,
        },
      ],
      structuredContent: {
        folder,
        uid: uid ?? null,
      },
    };
  },
});
