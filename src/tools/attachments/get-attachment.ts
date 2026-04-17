import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { MessageStructureObject } from 'imapflow';
import { defineTool } from '../define-tool';
import { ImapError, CacheError } from '../../errors/types';
import { mapImapError } from '../../errors/mapper';
import { hashBytes, writeAttachment } from '../../cache/attachments';
import {
  linkEmailAttachment,
  upsertAttachment,
  listAttachmentsForEmail,
} from '../../cache/queries';

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
      .describe(
        'MIME part ID (e.g. "1.2"). Preferred over filename when you already know the specific part.',
      ),
    return_mode: z
      .enum(['file_path', 'base64', 'metadata_only'])
      .default('file_path')
      .describe(
        'file_path: write bytes to the content-addressed cache and return the local path. base64: return bytes inline (hard-capped at max_inline_mb). metadata_only: do not download, return filename/size/content-type from the body structure.',
      ),
    max_inline_mb: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        'Cap for return_mode=base64. Requests exceeding this limit are rejected rather than blowing up the response size.',
      ),
  })
  .refine((v) => v.filename !== undefined || v.part_id !== undefined, {
    message: 'Either filename or part_id must be provided.',
  });

export const getAttachmentTool = defineTool({
  name: 'imap_get_attachment',
  description:
    'Download an attachment from a message. Three return modes: file_path (default) writes bytes to a local content-addressed cache and returns the path; base64 returns the bytes inline for small files; metadata_only skips the download and just describes the attachment. Bytes are deduplicated by SHA-256 across messages, so the same PDF forwarded through many threads lives on disk once.',
  annotations: {
    readOnlyHint: false, // Writes to the on-disk attachment cache.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(args.folder);

    // Fetch body structure - we need the MIME tree to locate the part.
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

    const filename = match.filename ?? args.filename ?? `part-${match.partId}.bin`;
    const contentType = match.contentType ?? 'application/octet-stream';
    const expectedSize = match.size ?? 0;

    if (args.return_mode === 'metadata_only') {
      lock.release();
      return {
        content: [
          {
            type: 'text',
            text: `${filename} (${contentType}, ${String(expectedSize)} bytes, part ${match.partId}). Not downloaded.`,
          },
        ],
        structuredContent: {
          folder: args.folder,
          uid: args.uid,
          part_id: match.partId,
          filename,
          content_type: contentType,
          size_bytes: expectedSize,
        },
      };
    }

    // Download the part's bytes.
    let bytes: Buffer;
    try {
      const dl = await imap.download(String(args.uid), match.partId, { uid: true });
      bytes = await streamToBuffer(dl.content);
    } catch (err) {
      lock.release();
      throw mapImapError(err);
    }
    lock.release();

    // Enforce the base64 cap before writing to disk or building a response.
    if (args.return_mode === 'base64' && bytes.length > args.max_inline_mb * 1024 * 1024) {
      throw new CacheError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment is ${String(bytes.length)} bytes; max_inline_mb=${String(args.max_inline_mb)} allows up to ${String(args.max_inline_mb * 1024 * 1024)} bytes. Use return_mode=file_path for larger attachments.`,
      );
    }

    const sha256 = hashBytes(bytes);
    const write = writeAttachment(ctx.cacheConfig.dir, bytes);
    const now = ctx.now();

    upsertAttachment(ctx.db, {
      sha256,
      filename,
      contentType,
      sizeBytes: bytes.length,
      filePath: write.filePath,
      firstSeenAt: now,
    });
    linkEmailAttachment(ctx.db, args.folder, args.uid, match.partId, sha256);

    if (args.return_mode === 'base64') {
      return {
        content: [
          {
            type: 'text',
            text: `${filename} (${contentType}, ${String(bytes.length)} bytes) - returned inline as base64.`,
          },
        ],
        structuredContent: {
          folder: args.folder,
          uid: args.uid,
          part_id: match.partId,
          filename,
          content_type: contentType,
          size_bytes: bytes.length,
          sha256,
          content_base64: bytes.toString('base64'),
        },
      };
    }

    // file_path mode
    return {
      content: [
        {
          type: 'text',
          text: `${filename} (${contentType}, ${String(bytes.length)} bytes) saved to ${write.filePath}.`,
        },
      ],
      structuredContent: {
        folder: args.folder,
        uid: args.uid,
        part_id: match.partId,
        filename,
        content_type: contentType,
        size_bytes: bytes.length,
        sha256,
        file_path: write.filePath,
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
 * Walk a MessageStructureObject tree, returning the first part that
 * matches the caller's selector (filename or part_id). Multipart
 * containers and non-attachment parts (text/*, inline images without
 * a filename) are skipped.
 */
function findAttachmentPart(
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

    // filename match (first hit wins)
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

// Used by unit tests.
export { findAttachmentPart, listAttachmentsForEmail };
