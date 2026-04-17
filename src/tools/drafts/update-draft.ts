import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { ImapError } from '../../errors/types';
import { buildRawMessage } from '../../imap/mime-builder';
import { deleteEmail } from '../../cache/queries';
import { resolveSpecialFolder } from '../emails/shared';

const AddressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const Input = z.object({
  uid: z
    .number()
    .int()
    .positive()
    .describe('UID of the existing draft to replace. Use imap_list_drafts to find it.'),
  to: AddressList,
  subject: z.string(),
  body: z.string().optional(),
  html: z.string().optional(),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  from: z.string().min(1).optional(),
  folder: z.string().min(1).optional(),
});

export const updateDraftTool = defineTool({
  name: 'imap_update_draft',
  description:
    "Replace an existing draft. Implemented as append-then-delete: the new draft is written to the server first, and only on success is the old UID deleted. A failure in the middle leaves the user's draft intact rather than destroying it.",
  annotations: {
    readOnlyHint: false,
    // Replaces user-visible state but never loses it - leaning non-destructive.
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

    // Step 1: append the new draft. If this throws, the old UID is untouched
    // and the user loses nothing - they can retry.
    let newUid: number | undefined;
    try {
      const appended = await imap.append(folder, raw, ['\\Draft']);
      if (!appended) {
        throw new ImapError(
          'IMAP_UNKNOWN',
          `Server did not accept the new draft APPEND to ${folder}. Old draft untouched.`,
        );
      }
      newUid = appended.uid;
    } catch (err) {
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    }

    // Step 2: now (and only now) delete the old UID. If this fails, the user
    // ends up with two drafts temporarily - annoying but not data-loss. The
    // next list_drafts call will show both until resolved.
    const lock = await imap.getMailboxLock(folder);
    let deletedOld = true;
    try {
      await imap.messageDelete(String(args.uid), { uid: true });
    } catch (err) {
      deletedOld = false;
      // Don't throw - the new draft exists, which is the important thing.
      // Surface the partial state in the response so the caller knows.
      return {
        content: [
          {
            type: 'text',
            text: `Warning: created new draft UID ${String(newUid ?? 'unknown')} in ${folder}, but failed to delete old UID ${String(args.uid)}: ${err instanceof Error ? err.message : String(err)}. Both drafts currently exist; you may want to clean up manually.`,
          },
        ],
        structuredContent: {
          folder,
          new_uid: newUid ?? null,
          old_uid: args.uid,
          old_deleted: false,
        },
        isError: false,
      };
    } finally {
      lock.release();
    }

    if (deletedOld) {
      deleteEmail(ctx.db, folder, args.uid);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Replaced draft UID ${String(args.uid)} with new UID ${String(newUid ?? 'unknown')} in ${folder}.`,
        },
      ],
      structuredContent: {
        folder,
        new_uid: newUid ?? null,
        old_uid: args.uid,
        old_deleted: true,
      },
    };
  },
});
