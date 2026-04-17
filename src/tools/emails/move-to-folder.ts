import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { mapImapError } from '../../errors/mapper.js';
import { deleteEmail } from '../../cache/queries.js';

const Input = z.object({
  folder: z.string().min(1).describe('Current folder of the message.'),
  uid: z.number().int().positive().describe('IMAP UID of the message to move.'),
  destination: z
    .string()
    .min(1)
    .describe(
      'Target folder path. Use imap_list_folders to discover valid destinations. Must exist on the server.',
    ),
});

export const moveToFolderTool = defineTool({
  name: 'imap_move_to_folder',
  description:
    'Move a message from one folder to another. Uses IMAP MOVE (RFC 6851) when the server supports it, falling back to COPY + EXPUNGE. The cached row in the source folder is removed on success; the destination folder will pick up the moved message on its next sync.',
  annotations: {
    readOnlyHint: false,
    // Destructive: changes where the message lives. Reversible by moving back.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);
    try {
      const result = await imap.messageMove(String(args.uid), args.destination, {
        uid: true,
      });
      if (!result) {
        throw mapImapError(
          new Error(
            `Server rejected the move from ${args.folder} to ${args.destination}. Verify the destination folder exists.`,
          ),
        );
      }
    } catch (err) {
      throw mapImapError(err);
    } finally {
      lock.release();
    }

    // Write-through: the UID no longer exists in the source folder.
    deleteEmail(ctx.db, args.folder, args.uid);

    return {
      content: [
        {
          type: 'text',
          text: `Moved UID ${String(args.uid)} from ${args.folder} to ${args.destination}.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uid: args.uid,
        destination: args.destination,
      },
    };
  },
});
