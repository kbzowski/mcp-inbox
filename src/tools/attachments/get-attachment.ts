import { z } from 'zod';
import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { defineTool } from '../define-tool';
import { ImapError, CacheError } from '../../errors/types';
import { mapImapError } from '../../errors/mapper';

const Input = z
  .object({
    folder: z.string().min(1).describe('Folder containing the message.'),
    uid: z.number().int().positive().describe('IMAP UID of the message.'),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Filename of the attachment to fetch. First match wins if the message has multiple attachments with the same name - use part_id to disambiguate.',
      ),
    part_id: z
      .string()
      .min(1)
      .optional()
      .describe('MIME part ID (e.g. "1.2"). Use when multiple parts share a filename.'),
    max_inline_mb: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        'Maximum attachment size to return inline, in MB. Attachments larger than this are rejected with a clear error. Cap exists to avoid blowing up MCP response size.',
      ),
  })
  .refine((v) => v.filename !== undefined || v.part_id !== undefined, {
    message: 'Either filename or part_id must be provided.',
  });

/**
 * Transient attachment download.
 *
 * Explicit non-goals:
 *  - No persistent on-disk cache. Bytes live in memory for the
 *    duration of the response and nowhere else.
 *  - No reuse across calls. Re-requesting the same attachment refetches
 *    from the server. This is the honest tradeoff for privacy; the
 *    cost is one IMAP round-trip per access, which is fine for the
 *    actual use case (agent processes the attachment once, done).
 *
 * Implementation note: we fetch the whole raw source and let mailparser
 * walk the MIME tree. Part-by-part IMAP fetches (BODY[n]) sound cheaper
 * but are flakier in practice - different servers number multipart
 * containers differently, and some (including GreenMail) return empty
 * downloads for certain part shapes. One round-trip + trusted parser
 * beats two round-trips and server-specific edge cases.
 */
export const getAttachmentTool = defineTool({
  name: 'imap_get_attachment',
  description:
    'Download an attachment as base64 bytes, inline in the response. Nothing is written to disk - bytes live in memory for one response and are gone afterward. Meant for ad-hoc "read the content of this attachment" workflows; the cap (max_inline_mb, default 5 MB) prevents runaway response sizes. For just "does this email have an attachment", use imap_get_email - it surfaces filename / content-type / size without any download.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);

    let source: Buffer;
    let structure: MessageStructureObject | undefined;
    try {
      const msg = await imap.fetchOne(
        String(args.uid),
        { source: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg || msg.source === undefined) {
        throw new ImapError(
          'IMAP_MESSAGE_NOT_FOUND',
          `No message with UID ${String(args.uid)} in ${args.folder}.`,
        );
      }
      source = msg.source;
      structure = msg.bodyStructure;
    } catch (err) {
      lock.release();
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    }
    lock.release();

    // Early reject: if bodyStructure reports a size well over the cap,
    // don't bother parsing. The 1.5x fudge factor is because transfer
    // encoding overhead (base64 inflates ~33%) isn't consistently
    // included in the server-reported size.
    const capBytes = args.max_inline_mb * 1024 * 1024;
    if (structure) {
      const selector: { filename?: string; part_id?: string } = {
        ...(args.filename !== undefined && { filename: args.filename }),
        ...(args.part_id !== undefined && { part_id: args.part_id }),
      };
      const structMatch = findAttachmentPart(structure, selector);
      if (structMatch?.size !== undefined && structMatch.size > capBytes * 1.5) {
        throw new CacheError(
          'ATTACHMENT_TOO_LARGE',
          `Attachment "${structMatch.filename ?? structMatch.partId}" is ~${String(structMatch.size)} bytes; max_inline_mb=${String(args.max_inline_mb)} allows up to ${String(capBytes)} bytes. Raise max_inline_mb (up to 50) or open in your mail client.`,
        );
      }
    }

    const parsed = await simpleParser(source);
    const attachment = pickAttachment(parsed.attachments ?? [], {
      ...(args.filename !== undefined && { filename: args.filename }),
      ...(args.part_id !== undefined && { partId: args.part_id }),
    });
    if (!attachment) {
      throw new ImapError(
        'ATTACHMENT_NOT_FOUND',
        args.part_id !== undefined
          ? `No attachment at part ${args.part_id} in UID ${String(args.uid)}.`
          : `No attachment named "${String(args.filename)}" in UID ${String(args.uid)}.`,
      );
    }

    const bytes = attachment.content;
    if (bytes.length > capBytes) {
      throw new CacheError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment "${attachment.filename ?? 'unnamed'}" is ${String(bytes.length)} bytes after decode; max_inline_mb=${String(args.max_inline_mb)} allows up to ${String(capBytes)} bytes.`,
      );
    }

    const filename = attachment.filename ?? args.filename ?? 'attachment.bin';
    const contentType = attachment.contentType ?? 'application/octet-stream';
    const partId = attachment.partId ?? args.part_id ?? '?';

    return {
      content: [
        {
          type: 'text',
          text: `${filename} (${contentType}, ${String(bytes.length)} bytes) - bytes returned inline as base64. Not cached anywhere.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uid: args.uid,
        part_id: partId,
        filename,
        content_type: contentType,
        size_bytes: bytes.length,
        content_base64: bytes.toString('base64'),
      },
    };
  },
});

interface AttachmentMatch {
  partId: string;
  filename: string | undefined;
  contentType: string | undefined;
  size: number | undefined;
}

/**
 * Walk a MessageStructureObject tree to find the first part matching
 * the caller's selector. Used to decide whether to even bother with
 * the download, based on the server-reported size.
 */
export function findAttachmentPart(
  structure: MessageStructureObject,
  selector: { filename?: string; part_id?: string },
): AttachmentMatch | null {
  const stack: MessageStructureObject[] = [structure];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.childNodes) {
      for (const child of node.childNodes) stack.push(child);
      continue;
    }

    const partId = node.part;
    if (!partId) continue;

    const nodeFilename = node.dispositionParameters?.filename ?? node.parameters?.name;

    if (selector.part_id !== undefined) {
      if (partId === selector.part_id) {
        return {
          partId,
          filename: nodeFilename,
          contentType: node.type,
          size: node.size,
        };
      }
      continue;
    }

    if (selector.filename !== undefined && nodeFilename === selector.filename) {
      return {
        partId,
        filename: nodeFilename,
        contentType: node.type,
        size: node.size,
      };
    }
  }

  return null;
}

interface MailparserAttachmentLike {
  filename?: string | undefined;
  contentType?: string | undefined;
  content: Buffer;
  partId?: string | undefined;
}

/**
 * Select one of mailparser's decoded attachments by filename or partId.
 * First match wins when multiple attachments share a filename.
 */
function pickAttachment(
  attachments: MailparserAttachmentLike[],
  selector: { filename?: string; partId?: string },
): MailparserAttachmentLike | null {
  if (selector.partId !== undefined) {
    const byPart = attachments.find((a) => a.partId === selector.partId);
    if (byPart) return byPart;
  }
  if (selector.filename !== undefined) {
    const byFilename = attachments.find((a) => a.filename === selector.filename);
    if (byFilename) return byFilename;
  }
  return null;
}
