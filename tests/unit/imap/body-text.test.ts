import { describe, it, expect } from 'vitest';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { pickTextPart, decodeTextPart, fetchTextBodies } from '@/imap/body-text';

function node(over: Partial<MessageStructureObject>): MessageStructureObject {
  return { type: 'text/plain', ...over };
}

describe('pickTextPart', () => {
  it('uses part 1 for a single-part message', () => {
    const picked = pickTextPart(node({ type: 'text/plain', encoding: '7bit', size: 100 }));
    expect(picked).toMatchObject({ part: '1', isHtml: false, charset: 'utf-8' });
  });

  it('prefers the plain alternative over html', () => {
    const structure = node({
      type: 'multipart/alternative',
      childNodes: [node({ part: '2', type: 'text/html' }), node({ part: '1', type: 'text/plain' })],
    });
    expect(pickTextPart(structure)?.part).toBe('1');
  });

  it('falls back to html when there is no plain part', () => {
    const structure = node({
      type: 'multipart/alternative',
      childNodes: [node({ part: '1', type: 'text/html' })],
    });
    expect(pickTextPart(structure)).toMatchObject({ part: '1', isHtml: true });
  });

  it('descends into a nested container rather than fetching it', () => {
    const structure = node({
      type: 'multipart/mixed',
      childNodes: [
        node({
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            node({ part: '1.1', type: 'text/plain' }),
            node({ part: '1.2', type: 'text/html' }),
          ],
        }),
        node({ part: '2', type: 'application/pdf', disposition: 'attachment' }),
      ],
    });
    expect(pickTextPart(structure)?.part).toBe('1.1');
  });

  it('ignores a text part that is an attachment', () => {
    const structure = node({
      type: 'multipart/mixed',
      childNodes: [
        node({
          part: '1',
          type: 'text/plain',
          disposition: 'attachment',
          dispositionParameters: { filename: 'notes.txt' },
        }),
      ],
    });
    expect(pickTextPart(structure)).toBeNull();
  });

  it('returns null when there is no text at all', () => {
    const structure = node({
      type: 'multipart/mixed',
      childNodes: [node({ part: '1', type: 'application/pdf' })],
    });
    expect(pickTextPart(structure)).toBeNull();
  });

  it('refuses a pathologically large text part', () => {
    expect(pickTextPart(node({ type: 'text/plain', size: 5_000_000 }))).toBeNull();
  });

  it('carries charset and encoding through', () => {
    const picked = pickTextPart(
      node({ type: 'text/plain', encoding: 'base64', parameters: { charset: 'iso-8859-2' } }),
    );
    expect(picked).toMatchObject({ charset: 'iso-8859-2', encoding: 'base64' });
  });
});

const plain = { part: '1', charset: 'utf-8', encoding: '7bit', isHtml: false };

describe('decodeTextPart', () => {
  it('decodes base64', () => {
    const raw = Buffer.from(Buffer.from('Zażółć gęślą', 'utf8').toString('base64'), 'ascii');
    expect(decodeTextPart(raw, { ...plain, encoding: 'base64' })).toBe('Zażółć gęślą');
  });

  it('decodes quoted-printable including soft line breaks', () => {
    const raw = Buffer.from('Za=C5=BC=C3=B3=C5=82=C4=87 g=C4=99=\r\n=C5=9Bl=C4=85', 'latin1');
    expect(decodeTextPart(raw, { ...plain, encoding: 'quoted-printable' })).toBe('Zażółć gęślą');
  });

  it('honours a non-utf8 charset', () => {
    const raw = Buffer.from([0xbc, 0xf3, 0xb6]);
    expect(decodeTextPart(raw, { ...plain, charset: 'iso-8859-2' })).toBe('źóś');
  });

  it('falls back instead of throwing on an unknown charset', () => {
    const raw = Buffer.from('hello', 'utf8');
    expect(() => decodeTextPart(raw, { ...plain, charset: 'x-nonsense' })).not.toThrow();
  });

  it('flattens html into readable text', () => {
    const raw = Buffer.from(
      '<style>p{}</style><p>Pierwszy&nbsp;akapit</p><p>Drugi &amp; ostatni</p>',
      'utf8',
    );
    const out = decodeTextPart(raw, { ...plain, isHtml: true });
    expect(out).toContain('Pierwszy akapit');
    expect(out).toContain('Drugi & ostatni');
    expect(out).not.toContain('<p>');
  });

  it('skips transfer decoding when the server already decoded it', () => {
    const raw = Buffer.from('already text', 'utf8');
    expect(decodeTextPart(raw, { ...plain, encoding: 'base64' }, true)).toBe('already text');
  });
});

interface FakeMessage {
  structure?: MessageStructureObject;
  body?: Buffer;
}

/** Keys the response map in lower case only, exactly as ImapFlow does. */
function fakeImap(
  messages: Record<number, FakeMessage>,
  opts: { throwOnParts?: string[] } = {},
): { imap: ImapFlow; calls: { query: string; uids: number[] }[] } {
  const calls: { query: string; uids: number[] }[] = [];
  const imap = {
    fetch(uids: number[], query: Record<string, unknown>) {
      const partIds = query['bodyParts'] as string[] | undefined;
      calls.push({ query: partIds ? `parts:${partIds.join(',')}` : 'structure', uids: [...uids] });
      if (partIds && opts.throwOnParts?.includes(partIds[0] ?? '')) {
        return (async function* () {
          yield await Promise.reject(new Error('NO UID failed'));
        })();
      }
      return (async function* () {
        await Promise.resolve();
        for (const uid of uids) {
          const msg = messages[uid];
          if (msg === undefined) continue;
          if (partIds === undefined) {
            yield { uid, bodyStructure: msg.structure };
          } else {
            const key = (partIds[0] ?? '').toLowerCase();
            yield {
              uid,
              bodyParts: msg.body ? new Map([[key, msg.body]]) : new Map<string, Buffer>(),
            };
          }
        }
      })();
    },
  } as unknown as ImapFlow;
  return { imap, calls };
}

describe('fetchTextBodies', () => {
  it('returns nothing for an empty uid list without touching the server', async () => {
    const { imap, calls } = fakeImap({});
    await expect(fetchTextBodies(imap, [])).resolves.toEqual({ texts: new Map(), expected: 0 });
    expect(calls).toHaveLength(0);
  });

  it('fetches one part group per distinct part id, not one per message', async () => {
    const { imap, calls } = fetchFixture();
    const { texts, expected } = await fetchTextBodies(imap, [1, 2, 3]);

    expect(expected).toBe(3);
    expect(texts.get(1)).toBe('single part body');
    expect(texts.get(2)).toBe('nested body');
    expect(texts.get(3)).toBe('another single');
    expect(calls.filter((c) => c.query === 'structure')).toHaveLength(1);
    expect(calls.filter((c) => c.query.startsWith('parts:'))).toHaveLength(2);
  });

  it('counts messages that have a text part even when the fetch returns nothing', async () => {
    const { imap } = fakeImap({
      1: { structure: node({ type: 'text/plain', encoding: '7bit' }) },
    });
    const { texts, expected } = await fetchTextBodies(imap, [1]);
    expect(expected).toBe(1);
    expect(texts.size).toBe(0);
  });

  it('keeps other groups when one part group is rejected by the server', async () => {
    const { imap } = fetchFixture({ throwOnParts: ['1.1'] });
    const { texts } = await fetchTextBodies(imap, [1, 2, 3]);
    expect(texts.has(2)).toBe(false);
    expect(texts.get(1)).toBe('single part body');
    expect(texts.get(3)).toBe('another single');
  });

  it('skips messages with no text part at all', async () => {
    const { imap } = fakeImap({
      1: {
        structure: node({
          type: 'multipart/mixed',
          childNodes: [node({ part: '1', type: 'image/png' })],
        }),
      },
    });
    const { texts, expected } = await fetchTextBodies(imap, [1]);
    expect(expected).toBe(0);
    expect(texts.size).toBe(0);
  });
});

function fetchFixture(opts: { throwOnParts?: string[] } = {}) {
  return fakeImap(
    {
      1: {
        structure: node({ type: 'text/plain', encoding: '7bit' }),
        body: Buffer.from('single part body', 'utf8'),
      },
      2: {
        structure: node({
          type: 'multipart/mixed',
          childNodes: [
            node({
              part: '1',
              type: 'multipart/alternative',
              childNodes: [node({ part: '1.1', type: 'text/plain' })],
            }),
          ],
        }),
        body: Buffer.from('nested body', 'utf8'),
      },
      3: {
        structure: node({ type: 'text/plain', encoding: '7bit' }),
        body: Buffer.from('another single', 'utf8'),
      },
    },
    opts,
  );
}
