import { z } from 'zod';
import { defineTool, type ToolContext } from '../define-tool.js';
import { mapImapError } from '../../errors/mapper.js';
import { getEmail, setEmailFlags } from '../../cache/queries.js';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the message.'),
  uid: z.number().int().positive().describe('IMAP UID of the message. UIDs are folder-scoped.'),
});

/**
 * Add or remove the \Seen flag. Idempotent on both sides: marking an
 * already-read message read again is a no-op on the server, same for
 * marking unread. The cache mirrors the server state through a
 * write-through update.
 */
async function updateSeenFlag(
  ctx: ToolContext,
  folder: string,
  uid: number,
  want: 'add' | 'remove',
): Promise<void> {
  const imap = await ctx.imap.connection();
  const lock = await imap.getMailboxLock(folder);
  try {
    if (want === 'add') {
      await imap.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } else {
      await imap.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    }
  } catch (err) {
    throw mapImapError(err);
  } finally {
    lock.release();
  }

  // Write-through: mirror the server state without waiting for the next sync.
  const cached = getEmail(ctx.db, folder, uid);
  if (!cached) return;
  const next =
    want === 'add'
      ? cached.flags.includes('\\Seen')
        ? cached.flags
        : [...cached.flags, '\\Seen']
      : cached.flags.filter((f) => f !== '\\Seen');
  if (next !== cached.flags) {
    setEmailFlags(ctx.db, folder, uid, next);
  }
}

export const markReadTool = defineTool({
  name: 'imap_mark_read',
  description:
    'Mark a message as read by adding the IMAP \\Seen flag. Idempotent - already-read messages are unchanged.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    await updateSeenFlag(ctx, args.folder, args.uid, 'add');
    return {
      content: [
        {
          type: 'text',
          text: `Marked UID ${String(args.uid)} in ${args.folder} as read.`,
        },
      ],
      structuredContent: { folder: args.folder, uid: args.uid, seen: true },
    };
  },
});

export const markUnreadTool = defineTool({
  name: 'imap_mark_unread',
  description:
    'Mark a message as unread by removing the IMAP \\Seen flag. Idempotent - already-unread messages are unchanged.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    await updateSeenFlag(ctx, args.folder, args.uid, 'remove');
    return {
      content: [
        {
          type: 'text',
          text: `Marked UID ${String(args.uid)} in ${args.folder} as unread.`,
        },
      ],
      structuredContent: { folder: args.folder, uid: args.uid, seen: false },
    };
  },
});
