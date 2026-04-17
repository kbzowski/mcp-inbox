import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { MessageStructureObject } from 'imapflow';
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
 * The typical workflow: agent wants to search inside an attachment
 * (find a number in a PDF receipt, extract table data from a CSV,
 * read through an EML forward), calls this tool, feeds the bytes
 * into whatever processor it has, produces an answer, moves on.
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

    // Fetch body structure to locate the part.
    let structure: MessageStructureObject | undefined;
    try {
      const msg = await imap.fetchOne(String(args.uid), { bodyStructure: true }, { uid: true });
      if (!msg) {
        throw new ImapError(
          'IMAP_MESSAGE_NOT_FOUND',
          `No message with UID ${String(args.uid)} in ${args.folder}.`,
        );
      }
      structure = msg.bodyStructure;
    } catch (err) {
      lock.release();
      if (err instanceof ImapError) throw err;
      throw mapImapError(err);
    }

    if (!structure) {
      lock.release();
      throw new ImapError(
        'IMAP_UNKNOWN',
        `Server returned no body structure for UID ${String(args.uid)}.`,
      );
    }

    const selector: { filename?: string; part_id?: string } = {
      ...(args.filename !== undefined && { filename: args.filename }),
      ...(args.part_id !== undefined && { part_id: args.part_id }),
    };
    const match = findAttachmentPart(structure, selector);
    if (!match) {
      lock.release();
      throw new ImapError(
        'ATTACHMENT_NOT_FOUND',
        args.part_id !== undefined
          ? `No attachment at part ${args.part_id} in UID ${String(args.uid)}.`
          : `No attachment named "${String(args.filename)}" in UID ${String(args.uid)}.`,
      );
    }

    // Early-reject oversized attachments based on the body-structure size
    // (which is an expected-size, usually accurate within encoding overhead).
    // This catches the obvious "don't even fetch this" case. We also enforce
    // the cap against actual bytes after download - see below.
    const capBytes = args.max_inline_mb * 1024 * 1024;
    if (match.size !== undefined && match.size > capBytes * 1.5) {
      lock.release();
      throw new CacheError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment "${match.filename ?? match.partId}" is ~${String(match.size)} bytes; max_inline_mb=${String(args.max_inline_mb)} allows up to ${String(capBytes)} bytes. Lower the attachment size, raise max_inline_mb (up to 50), or open the message in your mail client.`,
      );
    }

    // Download the part.
    let bytes: Buffer;
    try {
      const dl = await imap.download(String(args.uid), match.partId, { uid: true });
      bytes = await streamToBuffer(dl.content);
    } catch (err) {
      lock.release();
      throw mapImapError(err);
    }
    lock.release();

    if (bytes.length > capBytes) {
      throw new CacheError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment "${match.filename ?? match.partId}" is ${String(bytes.length)} bytes after download; max_inline_mb=${String(args.max_inline_mb)} allows up to ${String(capBytes)} bytes.`,
      );
    }

    const filename = match.filename ?? args.filename ?? `part-${match.partId}.bin`;
    const contentType = match.contentType ?? 'application/octet-stream';

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
        part_id: match.partId,
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
 * the caller's selector. Covers:
 *  - explicit `Content-Disposition: attachment` dispositions
 *  - `dispositionParameters.filename`
 *  - the legacy `Content-Type` `name=` parameter (some older clients
 *    emit that instead of disposition parameters)
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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
