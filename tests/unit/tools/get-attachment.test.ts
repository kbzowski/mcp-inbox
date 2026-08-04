import { describe, it, expect } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import { findAttachmentPart, getAttachmentTool } from '@/tools/attachments/get-attachment';

function part(over: Partial<MessageStructureObject>): MessageStructureObject {
  return { type: 'text/plain', ...over };
}

describe('findAttachmentPart walker', () => {
  const tree: MessageStructureObject = part({
    type: 'multipart/mixed',
    childNodes: [
      part({
        type: 'multipart/alternative',
        childNodes: [
          part({ type: 'text/plain', part: '1.1' }),
          part({ type: 'text/html', part: '1.2' }),
        ],
      }),
      part({
        type: 'application/pdf',
        part: '2',
        size: 1024,
        disposition: 'attachment',
        dispositionParameters: { filename: 'invoice.pdf' },
      }),
      part({
        type: 'image/png',
        part: '3',
        size: 4096,
        dispositionParameters: { filename: 'chart.png' },
      }),
    ],
  });

  it('finds by filename', () => {
    expect(findAttachmentPart(tree, { filename: 'invoice.pdf' })).toEqual({
      partId: '2',
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      size: 1024,
    });
  });

  it('finds by part_id', () => {
    const match = findAttachmentPart(tree, { part_id: '3' });
    expect(match?.partId).toBe('3');
    expect(match?.filename).toBe('chart.png');
  });

  it('returns null for an unknown filename', () => {
    expect(findAttachmentPart(tree, { filename: 'missing.pdf' })).toBeNull();
  });

  it('handles legacy Content-Type name parameter', () => {
    const legacy: MessageStructureObject = part({
      type: 'multipart/mixed',
      childNodes: [
        part({
          type: 'application/zip',
          part: '1',
          size: 2048,
          parameters: { name: 'legacy-attachment.zip' },
        }),
      ],
    });
    expect(findAttachmentPart(legacy, { filename: 'legacy-attachment.zip' })?.partId).toBe('1');
  });

  it('returns the first match in document order when filenames collide', () => {
    // The size guard and pickAttachment must agree on which part they mean.
    // A LIFO walk returned the last duplicate, so a small attachment could be
    // rejected for the size of a larger namesake later in the tree.
    const duplicates: MessageStructureObject = part({
      type: 'multipart/mixed',
      childNodes: [
        part({
          type: 'application/pdf',
          part: '2',
          size: 200,
          dispositionParameters: {
            filename: 'report.pdf',
          },
        }),
        part({
          type: 'application/pdf',
          part: '3',
          size: 20_000_000,
          dispositionParameters: {
            filename: 'report.pdf',
          },
        }),
      ],
    });

    const match = findAttachmentPart(duplicates, { filename: 'report.pdf' });
    expect(match?.partId).toBe('2');
    expect(match?.size).toBe(200);
  });

  it('matches a container part that is itself an attachment', () => {
    // message/rfc822 forwards carry both a filename and childNodes. Skipping
    // every node with children made them invisible to the size guard.
    const forwarded: MessageStructureObject = part({
      type: 'multipart/mixed',
      childNodes: [
        part({ type: 'text/plain', part: '1' }),
        part({
          type: 'message/rfc822',
          part: '2',
          size: 40_000_000,
          disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [part({ type: 'text/plain', part: '2.1' })],
        }),
      ],
    });

    const match = findAttachmentPart(forwarded, { filename: 'forwarded.eml' });
    expect(match?.partId).toBe('2');
    expect(match?.size).toBe(40_000_000);
  });
});

describe('imap_get_attachment input schema', () => {
  it('requires either filename or part_id', () => {
    expect(getAttachmentTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 }).success).toBe(
      false,
    );
  });

  it('accepts just filename', () => {
    expect(
      getAttachmentTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1, filename: 'x.pdf' })
        .success,
    ).toBe(true);
  });

  it('accepts just part_id', () => {
    expect(
      getAttachmentTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1, part_id: '2.1' }).success,
    ).toBe(true);
  });

  it('defaults max_inline_mb to 5', () => {
    const r = getAttachmentTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      filename: 'x.pdf',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.max_inline_mb).toBe(5);
  });

  it('caps max_inline_mb at 50', () => {
    expect(
      getAttachmentTool.inputSchema.safeParse({
        folder: 'INBOX',
        uid: 1,
        filename: 'x.pdf',
        max_inline_mb: 100,
      }).success,
    ).toBe(false);
  });

  it('is marked read-only (no state mutation, no disk writes)', () => {
    expect(getAttachmentTool.annotations.readOnlyHint).toBe(true);
    expect(getAttachmentTool.annotations.destructiveHint).toBe(false);
  });
});
