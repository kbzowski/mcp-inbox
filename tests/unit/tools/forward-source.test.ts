import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmail, setEmailBody, getEmailBody } from '@/cache/queries';
import { ensureBodyAndSource } from '@/tools/emails/shared';
import { emlFilename } from '@/tools/send/forward';
import { buildRawMessage } from '@/imap/mime-builder';
import type { ToolContext } from '@/tools/define-tool';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

function countingContext(
  cache: CacheHandle,
  source: Buffer,
): ToolContext & { fetches: () => number } {
  let fetches = 0;
  const ctx = {
    db: cache.db,
    imap: {
      connection: () =>
        Promise.resolve({
          getMailboxLock: () => Promise.resolve({ release: () => undefined }),
          fetchOne: () => {
            fetches += 1;
            return Promise.resolve({ source });
          },
        }),
    },
    smtp: {},
    cacheConfig: { dir: '/tmp', defaultStalenessSec: 60 },
    defaults: { fromAddress: 'me@example.com' },
    now: () => 1_000,
  } as unknown as ToolContext;
  return Object.assign(ctx, { fetches: () => fetches });
}

describe('ensureBodyAndSource', () => {
  let cache: CacheHandle;
  let source: Buffer;

  beforeEach(async () => {
    cache = openCache(':memory:', MIGRATIONS);
    upsertEmail(cache.db, {
      folder: 'INBOX',
      uid: 7,
      messageId: '<m@example.com>',
      subject: 'Hi',
      fromAddr: 'alice@example.com',
      toAddrs: null,
      ccAddrs: null,
      date: 0,
      flags: [],
      hasAttachments: false,
      envelopeJson: '{}',
      modseq: 1,
      cachedAt: 0,
    });
    source = await buildRawMessage({
      from: 'alice@example.com',
      to: 'me@example.com',
      subject: 'Hi',
      text: 'hello',
    });
  });

  afterEach(() => {
    cache.close();
  });

  it('issues exactly one fetch on the cold path and caches the body', async () => {
    const ctx = countingContext(cache, source);

    const result = await ensureBodyAndSource(ctx, 'INBOX', 7);

    expect(ctx.fetches()).toBe(1);
    expect(result.source).toBe(source);
    expect(result.body.bodyText?.trim()).toBe('hello');
    expect(getEmailBody(cache.db, 'INBOX', 7)?.bodyCachedAt).toBe(1_000);
  });

  it('issues exactly one fetch on the warm path and reuses the cached body', async () => {
    setEmailBody(cache.db, 'INBOX', 7, { text: 'cached', html: null }, 500);
    const ctx = countingContext(cache, source);

    const result = await ensureBodyAndSource(ctx, 'INBOX', 7);

    expect(ctx.fetches()).toBe(1);
    expect(result.body.bodyText).toBe('cached');
    expect(getEmailBody(cache.db, 'INBOX', 7)?.bodyCachedAt).toBe(500);
  });
});

describe('emlFilename', () => {
  it('falls back when the subject is empty or null', () => {
    expect(emlFilename(null)).toBe('forwarded-message.eml');
    expect(emlFilename('   ')).toBe('forwarded-message.eml');
  });

  it('strips control characters and path-hostile characters', () => {
    expect(emlFilename('Re: a/b\\c:d*?"<>|e')).toBe('Re abcde.eml');
    expect(emlFilename('one\r\ntwo')).toBe('one two.eml');
  });

  it('keeps non-ASCII intact', () => {
    expect(emlFilename('Faktura za kwiecień 🧾')).toBe('Faktura za kwiecień 🧾.eml');
  });

  it('truncates very long subjects', () => {
    expect(emlFilename('x'.repeat(200))).toBe(`${'x'.repeat(80)}.eml`);
  });
});
