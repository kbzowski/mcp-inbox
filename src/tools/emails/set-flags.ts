import { z } from 'zod';
import { defineTool } from '../define-tool';
import { applyFlags } from './flags';

const Flag = z.enum(['\\Flagged', '\\Answered']);

const Input = z
  .object({
    folder: z.string().min(1).describe('Folder containing the messages.'),
    uids: z
      .array(z.number().int().positive())
      .min(1)
      .max(500)
      .describe('UIDs to change. Max 500 per call - chunk your own list for larger batches.'),
    add: z
      .array(Flag)
      .optional()
      .describe('Flags to set. \\Flagged is the star / follow-up marker in mail clients.'),
    remove: z.array(Flag).optional().describe('Flags to clear.'),
  })
  .refine((v) => (v.add?.length ?? 0) > 0 || (v.remove?.length ?? 0) > 0, {
    message: 'Provide at least one flag in `add` or `remove`.',
  })
  .refine((v) => !v.add?.some((f) => v.remove?.includes(f)), {
    message: 'A flag cannot appear in both `add` and `remove`.',
  });

export const setFlagsTool = defineTool({
  name: 'imap_set_flags',
  description:
    'Star, unstar, or mark messages as answered. Use \\Flagged for "star this" and "flag for follow-up" - it is the same marker mail clients show as a star. Read the flags back with imap_list_emails, or find them with imap_search_emails using `flagged` / `answered`. Read/unread has its own tools (imap_mark_read); deleting has imap_delete_email.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const change = {
      ...(args.add !== undefined && { add: args.add }),
      ...(args.remove !== undefined && { remove: args.remove }),
    };
    const applied = await applyFlags(ctx, args.folder, args.uids, change);

    const parts = [
      args.add?.length ? `added ${args.add.join(', ')}` : null,
      args.remove?.length ? `removed ${args.remove.join(', ')}` : null,
    ].filter((p): p is string => p !== null);

    return {
      content: [
        {
          type: 'text',
          text: applied
            ? `Updated ${String(args.uids.length)} message(s) in ${args.folder}: ${parts.join(' and ')}.`
            : `Server reported no change for ${String(args.uids.length)} message(s) in ${args.folder}. The UIDs may no longer exist, or the mailbox is read-only.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uids: args.uids,
        count: args.uids.length,
        added: args.add ?? [],
        removed: args.remove ?? [],
        applied,
      },
    };
  },
});
