import { describe, it, expect } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import {
  findAttachmentPart,
  getAttachmentTool,
} from '../../../src/tools/attachments/get-attachment';

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
    const match = findAttachmentPart(tree, { filename: 'invoice.pdf' });
    expect(match).toEqual({
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

  it('returns null for an unknown part_id', () => {
    expect(findAttachmentPart(tree, { part_id: '99' })).toBeNull();
  });

  it('ignores inline text parts (they have no filename)', () => {
    // part 1.1 is text/plain - should not match without a filename
    // on its disposition, even if selector asks for it by part_id.
    // We actually DO return it by part_id - that's intentional, since
    // the caller asked explicitly. This test documents that.
    const match = findAttachmentPart(tree, { part_id: '1.1' });
    expect(match?.partId).toBe('1.1');
  });

  it('handles legacy Content-Type name parameter (no Content-Disposition)', () => {
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
    const match = findAttachmentPart(legacy, { filename: 'legacy-attachment.zip' });
    expect(match?.partId).toBe('1');
  });
});

describe('imap_get_attachment input schema', () => {
  it('requires either filename or part_id', () => {
    const r = getAttachmentTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 });
    expect(r.success).toBe(false);
  });

  it('accepts just filename', () => {
    const r = getAttachmentTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      filename: 'x.pdf',
    });
    expect(r.success).toBe(true);
  });

  it('accepts just part_id', () => {
    const r = getAttachmentTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      part_id: '2.1',
    });
    expect(r.success).toBe(true);
  });

  it('defaults return_mode to file_path', () => {
    const r = getAttachmentTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      filename: 'x.pdf',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.return_mode).toBe('file_path');
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
    const r = getAttachmentTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      filename: 'x.pdf',
      max_inline_mb: 100,
    });
    expect(r.success).toBe(false);
  });
});
