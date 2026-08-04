import { z } from 'zod';
import { defineTool, type ToolContext } from '../define-tool';
import { applyFlags } from './flags';

const Input = z.object({
  folder: z.string().min(1).describe('Folder containing the message.'),
  uid: z.number().int().positive().describe('IMAP UID of the message. UIDs are folder-scoped.'),
});

function updateSeenFlag(
  ctx: ToolContext,
  folder: string,
  uid: number,
  want: 'add' | 'remove',
): Promise<boolean> {
  return applyFlags(
    ctx,
    folder,
    [uid],
    want === 'add' ? { add: ['\\Seen'] } : { remove: ['\\Seen'] },
  );
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
