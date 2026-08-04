import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { toMessageAttachments } from '@/tools/compose-schema';
import { buildRawMessage } from '@/imap/mime-builder';

describe('toMessageAttachments', () => {
  it('passes undefined through so callers can spread conditionally', () => {
    expect(toMessageAttachments(undefined)).toBeUndefined();
  });

  it('decodes base64 into the exact bytes', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f]);
    const out = toMessageAttachments([
      { filename: 'raw.bin', content_base64: bytes.toString('base64') },
    ]);
    expect(out?.[0]?.content.equals(bytes)).toBe(true);
  });

  it('omits contentType so nodemailer sniffs it from the filename', async () => {
    const out = toMessageAttachments([
      { filename: 'report.pdf', content_base64: Buffer.from('%PDF-').toString('base64') },
    ]);
    expect(out?.[0]).not.toHaveProperty('contentType');

    const raw = await buildRawMessage({
      from: 'a@b',
      to: 'c@d',
      subject: 's',
      text: 't',
      attachments: out ?? [],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments[0]?.contentType).toBe('application/pdf');
  });

  it('honours an explicit content_type', () => {
    const out = toMessageAttachments([
      {
        filename: 'data.bin',
        content_base64: Buffer.from('x').toString('base64'),
        content_type: 'application/x-custom',
      },
    ]);
    expect(out?.[0]?.contentType).toBe('application/x-custom');
  });
});
