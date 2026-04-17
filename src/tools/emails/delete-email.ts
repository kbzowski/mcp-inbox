import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { ImapError } from '../../errors/types';
import { deleteEmail } from '../../cache/queries';
import { resolveSpecialFolder } from './shared';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the message to delete.'),
  uid: z.number().int().positive().describe('IMAP UID of the message to delete.'),
  hard_delete: z
    .boolean()
    .default(false)
    .describe(
      'When false (default), the message is moved to the Trash folder and can be recovered by the user. When true, the message is permanently expunged from the server.',
    ),
});

export const deleteEmailTool = defineTool({
  name: 'imap_delete_email',
  description:
    'Delete a message. Default behavior (`hard_delete=false`) moves the message to the server-side Trash (\\Trash SPECIAL-USE) so the user can recover it. Set `hard_delete=true` to permanently expunge - this cannot be undone.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const imap = await ctx.imap.connection();

    if (args.hard_delete) {
      const lock = await imap.getMailboxLock(args.folder);
      try {
        await imap.messageDelete(String(args.uid), { uid: true });
      } catch (err) {
        throw mapImapError(err);
      } finally {
        lock.release();
      }
      deleteEmail(ctx.db, args.folder, args.uid);
      return {
        content: [
          {
            type: 'text',
            text: `Permanently deleted UID ${String(args.uid)} from ${args.folder}.`,
          },
        ],
        structuredContent: {
          folder: args.folder,
          uid: args.uid,
          action: 'hard_delete',
        },
      };
    }

    // Soft delete: move to Trash.
    const trashFolder = await resolveSpecialFolder(ctx, '\\Trash');
    if (trashFolder === args.folder) {
      // Already in Trash - caller probably meant hard_delete=true.
      throw new ImapError(
        'IMAP_UNKNOWN',
        `Message is already in the Trash folder (${args.folder}). Use hard_delete=true to permanently expunge.`,
      );
    }

    const lock = await imap.getMailboxLock(args.folder);
    try {
      const ok = await imap.messageMove(String(args.uid), trashFolder, { uid: true });
      if (!ok) {
        throw new ImapError(
          'IMAP_UNKNOWN',
          `Server rejected the move from ${args.folder} to ${trashFolder}.`,
        );
      }
    } catch (err) {
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    } finally {
      lock.release();
    }

    deleteEmail(ctx.db, args.folder, args.uid);

    return {
      content: [
        {
          type: 'text',
          text: `Moved UID ${String(args.uid)} from ${args.folder} to ${trashFolder} (Trash).`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uid: args.uid,
        action: 'moved_to_trash',
        trash_folder: trashFolder,
      },
    };
  },
});
