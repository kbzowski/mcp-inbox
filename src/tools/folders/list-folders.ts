import { z } from 'zod';
import { defineTool } from '../define-tool';
import { mapImapError } from '../../errors/mapper';
import { formatFoldersMarkdown, type FolderSummary } from '../../formatters/markdown';

const Input = z.object({
  response_format: z.enum(['markdown', 'json']).default('markdown'),
});

export const listFoldersTool = defineTool({
  name: 'imap_list_folders',
  description:
    "List every folder/mailbox in the account. Returns each folder's path, path delimiter, and RFC 6154 special-use attribute (\\Drafts, \\Sent, \\Trash, \\Junk) where the server advertises one. Use this to discover folder names for other tools that accept a `folder` argument.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    let folders;
    try {
      const imap = await ctx.imap.connection();
      folders = await imap.list();
    } catch (err) {
      throw mapImapError(err);
    }

    const summaries: FolderSummary[] = folders.map((f) => ({
      path: f.path,
      delimiter: f.delimiter,
      specialUse: f.specialUse ?? null,
      flags: Array.from(f.flags),
    }));

    const text =
      args.response_format === 'json'
        ? JSON.stringify({ folders: summaries }, null, 2)
        : formatFoldersMarkdown(summaries);

    return {
      content: [{ type: 'text', text }],
      structuredContent: { folders: summaries },
    };
  },
});
