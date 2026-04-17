import { z } from 'zod';
import { defineTool } from '../define-tool';
import { ImapError, ToolInputError } from '../../errors/types';
import { mapImapError } from '../../errors/mapper';
import { deleteEmail } from '../../cache/queries';
import { resolveSpecialFolder } from '../emails/shared';
import { sendRawAndAppendSent } from './shared';
import { simpleParser } from 'mailparser';

const Input = z.object({
  uid: z.number().int().positive().describe('UID of the draft to send.'),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit Drafts folder. Auto-resolves via SPECIAL-USE when omitted.'),
});

export const sendDraftTool = defineTool({
  name: 'imap_send_draft',
  description:
    'Send an existing draft as-is. Fetches the raw RFC 2822 source from the Drafts folder, pushes it through SMTP, appends a copy to the Sent folder, then deletes the draft. Any attachments and non-ASCII content are preserved exactly because the original source is used.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const folder = await resolveSpecialFolder(ctx, '\\Drafts', args.folder);

    // Fetch raw source from IMAP - we need the exact bytes to send, not
    // a reconstruction from cached fields.
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(folder);
    let rawSource: Buffer;
    let envelopeFrom: string;
    let envelopeTo: string[];
    try {
      const msg = await imap.fetchOne(
        String(args.uid),
        { source: true, envelope: true },
        { uid: true },
      );
      if (!msg || msg.source === undefined) {
        throw new ImapError(
          'IMAP_MESSAGE_NOT_FOUND',
          `Draft with UID ${String(args.uid)} not found in ${folder}.`,
        );
      }
      rawSource = msg.source;

      // Extract envelope for SMTP routing. Parse the raw to be sure we
      // honor whatever addresses the draft actually has, rather than
      // trusting cached fields that might be stale.
      const parsed = await simpleParser(rawSource);
      envelopeFrom = firstAddress(parsed.from) ?? ctx.defaults.fromAddress;
      envelopeTo = [
        ...addressList(parsed.to),
        ...addressList(parsed.cc),
        ...addressList(parsed.bcc),
      ];
      if (envelopeTo.length === 0) {
        throw new ToolInputError(
          `Draft UID ${String(args.uid)} has no recipients. Update the draft before sending.`,
        );
      }
    } catch (err) {
      lock.release();
      if (err instanceof ImapError || err instanceof ToolInputError) throw err;
      throw mapImapError(err);
    }
    lock.release();

    // Send + save to Sent. If this throws, the draft is untouched - user
    // can retry without losing their work.
    const result = await sendRawAndAppendSent(ctx, rawSource, {
      from: envelopeFrom,
      to: envelopeTo,
    });

    // Delete the draft. If this fails after a successful send, the user
    // has a sent copy + leftover draft, which is recoverable.
    let draftDeleted = true;
    let draftDeleteError: string | null = null;
    const imap2 = await ctx.imap.connection();
    const lock2 = await imap2.getMailboxLock(folder);
    try {
      await imap2.messageDelete(String(args.uid), { uid: true });
      deleteEmail(ctx.db, folder, args.uid);
    } catch (err) {
      draftDeleted = false;
      draftDeleteError = err instanceof Error ? err.message : String(err);
    } finally {
      lock2.release();
    }

    const summary = [
      `Sent draft (UID ${String(args.uid)}) to ${envelopeTo.join(', ')}.`,
      result.messageId ? `Message-ID: ${result.messageId}` : null,
      result.sentFolder
        ? `Saved to ${result.sentFolder}.`
        : `Warning: Sent-folder save failed: ${result.sentSaveError ?? 'unknown error'}.`,
      draftDeleted
        ? `Removed draft from ${folder}.`
        : `Warning: draft still in ${folder}: ${draftDeleteError ?? 'unknown error'}.`,
    ]
      .filter((l): l is string => l !== null)
      .join(' ');

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        drafts_folder: folder,
        sent_uid: args.uid,
        message_id: result.messageId,
        sent_folder: result.sentFolder,
        sent_save_error: result.sentSaveError,
        draft_deleted: draftDeleted,
        draft_delete_error: draftDeleteError,
      },
    };
  },
});

interface MailparserAddressLike {
  address?: string;
  value?: { address?: string }[];
}

function firstAddress(field: unknown): string | null {
  if (!field) return null;
  const obj = field as MailparserAddressLike | MailparserAddressLike[];
  const single = Array.isArray(obj) ? obj[0] : obj;
  if (!single) return null;
  if (typeof single.address === 'string') return single.address;
  const fromValue = single.value?.[0]?.address;
  return typeof fromValue === 'string' ? fromValue : null;
}

function addressList(field: unknown): string[] {
  if (!field) return [];
  const obj = field as MailparserAddressLike | MailparserAddressLike[];
  const arr = Array.isArray(obj) ? obj : [obj];
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry.address === 'string') {
      out.push(entry.address);
    }
    for (const v of entry.value ?? []) {
      if (typeof v.address === 'string') out.push(v.address);
    }
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}
