import { describe, it, expect } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import { changedSinceFor, diffUids, hasAttachments } from '../../../src/cache/sync';

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

describe('diffUids', () => {
  it('reports nothing to do for identical sets', () => {
    expect(diffUids([1, 2, 3], [1, 2, 3])).toEqual({ missing: [], ghosts: [] });
  });

  it('treats an empty cache as every UID missing', () => {
    expect(diffUids([], [4, 7, 9])).toEqual({ missing: [4, 7, 9], ghosts: [] });
  });

  it('fetches only the UIDs the cache has not seen', () => {
    expect(diffUids([1, 2], [1, 2, 3, 4]).missing).toEqual([3, 4]);
  });

  it('evicts cached UIDs the server no longer has', () => {
    expect(diffUids([1, 2, 3], [1, 3]).ghosts).toEqual([2]);
  });

  it('handles simultaneous additions and expunges', () => {
    expect(diffUids([1, 2, 5], [2, 5, 8])).toEqual({ missing: [8], ghosts: [1] });
  });

  it('evicts everything when the server folder is empty', () => {
    expect(diffUids([1, 2], [])).toEqual({ missing: [], ghosts: [1, 2] });
  });
});

describe('changedSinceFor', () => {
  it('narrows to the cached modseq when the server has CONDSTORE', () => {
    expect(changedSinceFor(500, 400)).toBe(400);
  });

  it('never sends CHANGEDSINCE when the server dropped CONDSTORE', () => {
    // Regression: a modseq cached from a CONDSTORE-capable server used to be
    // sent anyway, which is a BAD response and a failed sync with no recovery.
    expect(changedSinceFor(null, 400)).toBeNull();
  });

  it('returns null when neither side has a modseq', () => {
    expect(changedSinceFor(null, null)).toBeNull();
    expect(changedSinceFor(500, null)).toBeNull();
    expect(changedSinceFor(500, undefined)).toBeNull();
  });
});

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
