import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { ImapError } from '../../errors/types';
import { deleteEmailsByUids } from '../../cache/queries';
import { resolveSpecialFolder } from './shared';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the messages to delete.'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(500)
    .describe('UIDs to delete. Max 500 per call.'),
  hard_delete: z
    .boolean()
    .default(false)
    .describe(
      'When false (default), messages move to the server Trash and can be recovered. When true, they are permanently expunged.',
    ),
});

export const deleteMultipleTool = defineTool({
  name: 'imap_delete_multiple',
  description:
    "Delete multiple messages in a single IMAP round-trip. Default soft-deletes (moves to \\Trash); `hard_delete=true` permanently expunges. Mirrors imap_delete_email's per-UID semantics but handles a whole batch at once.",
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
        await imap.messageDelete(args.uids, { uid: true });
      } catch (err) {
        throw mapImapError(err);
      } finally {
        lock.release();
      }
      deleteEmailsByUids(ctx.db, args.folder, args.uids);
      return {
        content: [
          {
            type: 'text',
            text: `Permanently deleted ${String(args.uids.length)} message(s) from ${args.folder}.`,
          },
        ],
        structuredContent: {
          folder: args.folder,
          uids: args.uids,
          count: args.uids.length,
          action: 'hard_delete',
        },
      };
    }

    // Soft delete: move to Trash.
    const trashFolder = await resolveSpecialFolder(ctx, '\\Trash');
    if (trashFolder === args.folder) {
      throw new ImapError(
        'IMAP_UNKNOWN',
        `Messages are already in the Trash folder (${args.folder}). Use hard_delete=true to permanently expunge.`,
      );
    }

    const lock = await imap.getMailboxLock(args.folder);
    try {
      const ok = await imap.messageMove(args.uids, trashFolder, { uid: true });
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

    deleteEmailsByUids(ctx.db, args.folder, args.uids);

    return {
      content: [
        {
          type: 'text',
          text: `Moved ${String(args.uids.length)} message(s) from ${args.folder} to ${trashFolder} (Trash).`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uids: args.uids,
        count: args.uids.length,
        action: 'moved_to_trash',
        trash_folder: trashFolder,
      },
    };
  },
});
