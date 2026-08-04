import { z } from 'zod';
import type { MessageAttachment } from '../imap/mime-builder';

export const AddressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const AttachmentInput = z.object({
  filename: z.string().min(1).describe('Name the recipient sees, e.g. "invoice.pdf".'),
  content_base64: z
    .base64()
    .describe(
      'Base64-encoded file bytes. These pass through the model context, so a 2 MB PDF costs roughly 2.7M characters - prefer imap_forward when relaying a file you did not create.',
    ),
  content_type: z
    .string()
    .min(1)
    .optional()
    .describe('MIME type. Omit to let the type be derived from `filename`.'),
});

export const AttachmentList = z.array(AttachmentInput).optional();

export function toMessageAttachments(
  input: z.infer<typeof AttachmentInput>[] | undefined,
): MessageAttachment[] | undefined {
  if (input === undefined) return undefined;
  return input.map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content_base64, 'base64'),
    ...(a.content_type !== undefined && { contentType: a.content_type }),
  }));
}
