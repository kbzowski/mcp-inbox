import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { ImapError } from '../../errors/types';
import { deleteEmailsByUids } from '../../cache/queries';

const Input = z.object({
  folder: z.string().min(1).describe('Current folder of the messages.'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(500)
    .describe('UIDs to move. Max 500 per call.'),
  destination: z.string().min(1).describe('Target folder. Must exist on the server.'),
});

export const moveMultipleTool = defineTool({
  name: 'imap_move_multiple',
  description:
    'Move multiple messages to another folder in a single IMAP round-trip. Uses IMAP MOVE when the server supports it, otherwise ImapFlow falls back to COPY + EXPUNGE transparently.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);
    try {
      const ok = await imap.messageMove(args.uids, args.destination, { uid: true });
      if (!ok) {
        throw new ImapError(
          'IMAP_UNKNOWN',
          `Server rejected the move from ${args.folder} to ${args.destination}. Verify the destination folder exists.`,
        );
      }
    } catch (err) {
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    } finally {
      lock.release();
    }

    // Write-through: source folder rows are gone.
    deleteEmailsByUids(ctx.db, args.folder, args.uids);

    return {
      content: [
        {
          type: 'text',
          text: `Moved ${String(args.uids.length)} message(s) from ${args.folder} to ${args.destination}.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uids: args.uids,
        count: args.uids.length,
        destination: args.destination,
      },
    };
  },
});
