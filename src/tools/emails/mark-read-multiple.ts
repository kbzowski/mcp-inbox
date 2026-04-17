import { z } from 'zod';
import { defineTool, type ToolContext } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { mutateEmailFlagsForUids } from '../../cache/queries';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the messages.'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(500)
    .describe(
      'UIDs of messages to flip. Max 500 per call - chunk your own list for larger batches.',
    ),
});

async function updateSeenFlagBulk(
  ctx: ToolContext,
  folder: string,
  uids: number[],
  want: 'add' | 'remove',
): Promise<void> {
  const imap = await ctx.imap.connection();
  const lock = await imap.getMailboxLock(folder);
  try {
    if (want === 'add') {
      await imap.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    } else {
      await imap.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
    }
  } catch (err) {
    throw mapImapError(err);
  } finally {
    lock.release();
  }

  // Write-through cache: mutate \Seen in-place on each cached row.
  mutateEmailFlagsForUids(ctx.db, folder, uids, (flags) =>
    want === 'add'
      ? flags.includes('\\Seen')
        ? flags
        : [...flags, '\\Seen']
      : flags.filter((f) => f !== '\\Seen'),
  );
}

export const markReadMultipleTool = defineTool({
  name: 'imap_mark_read_multiple',
  description:
    'Mark multiple messages as read in a single IMAP round-trip. Idempotent - already-read UIDs are unchanged. Use this when you have a concrete list of UIDs (e.g. from a search) instead of calling imap_mark_read N times.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    await updateSeenFlagBulk(ctx, args.folder, args.uids, 'add');
    return {
      content: [
        {
          type: 'text',
          text: `Marked ${String(args.uids.length)} message(s) as read in ${args.folder}.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uids: args.uids,
        count: args.uids.length,
        seen: true,
      },
    };
  },
});

export const markUnreadMultipleTool = defineTool({
  name: 'imap_mark_unread_multiple',
  description: 'Mark multiple messages as unread in a single IMAP round-trip. Idempotent.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    await updateSeenFlagBulk(ctx, args.folder, args.uids, 'remove');
    return {
      content: [
        {
          type: 'text',
          text: `Marked ${String(args.uids.length)} message(s) as unread in ${args.folder}.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uids: args.uids,
        count: args.uids.length,
        seen: false,
      },
    };
  },
});
