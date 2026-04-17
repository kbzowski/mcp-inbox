import { describe, it, expect } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import { hasAttachments } from '../../../src/cache/sync';

/**
 * Build a minimal MessageStructureObject for tests. Only the fields the
 * walker reads need to be set.
 */
function part(over: Partial<MessageStructureObject> = {}): MessageStructureObject {
  return {
    type: 'text/plain',
    ...over,
  };
}

describe('hasAttachments', () => {
  it('returns false for undefined structure', () => {
    expect(hasAttachments(undefined)).toBe(false);
  });

  it('returns false for a lone text/plain part', () => {
    expect(hasAttachments(part({ type: 'text/plain' }))).toBe(false);
  });

  it('detects an explicit "attachment" disposition', () => {
    expect(hasAttachments(part({ type: 'application/pdf', disposition: 'attachment' }))).toBe(true);
  });

  it('disposition match is case-insensitive', () => {
    expect(hasAttachments(part({ type: 'application/pdf', disposition: 'ATTACHMENT' }))).toBe(true);
  });

  it('detects a filename parameter even without explicit disposition', () => {
    // Some clients omit disposition but still include a filename - treat
    // those as attachments too.
    expect(
      hasAttachments(
        part({
          type: 'application/pdf',
          dispositionParameters: { filename: 'invoice.pdf' },
        }),
      ),
    ).toBe(true);
  });

  it('recurses into childNodes', () => {
    const structure = part({
      type: 'multipart/mixed',
      childNodes: [
        part({ type: 'text/plain' }),
        part({ type: 'application/pdf', disposition: 'attachment' }),
      ],
    });
    expect(hasAttachments(structure)).toBe(true);
  });

  it('returns false when a multipart contains only inline parts', () => {
    const structure = part({
      type: 'multipart/alternative',
      childNodes: [part({ type: 'text/plain' }), part({ type: 'text/html' })],
    });
    expect(hasAttachments(structure)).toBe(false);
  });

  it('handles deeply nested multipart trees', () => {
    // multipart/mixed → multipart/alternative (text + html) + attachment
    const structure = part({
      type: 'multipart/mixed',
      childNodes: [
        part({
          type: 'multipart/alternative',
          childNodes: [part({ type: 'text/plain' }), part({ type: 'text/html' })],
        }),
        part({
          type: 'image/png',
          dispositionParameters: { filename: 'photo.png' },
        }),
      ],
    });
    expect(hasAttachments(structure)).toBe(true);
  });
});
