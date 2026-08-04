import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmail, getEmail } from '@/cache/queries';
import { applyFlags } from '@/tools/emails/flags';
import { ImapError } from '@/errors/types';
import type { ToolContext } from '@/tools/define-tool';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

interface FakeImap {
  ctx: ToolContext;
  added: { uids: number[]; flags: string[] }[];
  removed: { uids: number[]; flags: string[] }[];
  released: number;
}

function fakeContext(
  cache: CacheHandle,
  opts: { result?: boolean; throws?: Error } = {},
): FakeImap {
  const added: FakeImap['added'] = [];
  const removed: FakeImap['removed'] = [];
  let released = 0;

  const ctx = {
    db: cache.db,
    imap: {
      connection: () =>
        Promise.resolve({
          getMailboxLock: () =>
            Promise.resolve({
              release: () => {
                released += 1;
              },
            }),
          messageFlagsAdd: (uids: number[], flags: string[]) => {
            if (opts.throws) return Promise.reject(opts.throws);
            added.push({ uids, flags });
            return Promise.resolve(opts.result ?? true);
          },
          messageFlagsRemove: (uids: number[], flags: string[]) => {
            if (opts.throws) return Promise.reject(opts.throws);
            removed.push({ uids, flags });
            return Promise.resolve(opts.result ?? true);
          },
        }),
    },
    smtp: {},
    cacheConfig: { dir: '/tmp', defaultStalenessSec: 60 },
    defaults: { fromAddress: 'me@example.com' },
    now: () => 1_000,
  } as unknown as ToolContext;

  return {
    ctx,
    added,
    removed,
    get released() {
      return released;
    },
  };
}

describe('applyFlags', () => {
  let cache: CacheHandle;

  beforeEach(() => {
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
      flags: ['\\Seen'],
      hasAttachments: false,
      envelopeJson: '{}',
      modseq: 1,
      cachedAt: 0,
    });
  });

  afterEach(() => {
    cache.close();
  });

  it('issues both IMAP calls when add and remove are combined', async () => {
    const fake = fakeContext(cache);

    await applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Flagged'], remove: ['\\Seen'] });

    expect(fake.added).toEqual([{ uids: [7], flags: ['\\Flagged'] }]);
    expect(fake.removed).toEqual([{ uids: [7], flags: ['\\Seen'] }]);
  });

  it('skips the IMAP call for an empty side', async () => {
    const fake = fakeContext(cache);

    await applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Answered'] });

    expect(fake.added).toHaveLength(1);
    expect(fake.removed).toHaveLength(0);
  });

  it('writes the union minus the removals through to the cache', async () => {
    const fake = fakeContext(cache);

    await applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Flagged'], remove: ['\\Seen'] });

    expect(getEmail(cache.db, 'INBOX', 7)?.flags).toEqual(['\\Flagged']);
  });

  it('is idempotent - re-adding a held flag does not duplicate it', async () => {
    const fake = fakeContext(cache);

    await applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Seen'] });

    expect(getEmail(cache.db, 'INBOX', 7)?.flags).toEqual(['\\Seen']);
  });

  it('returns false and leaves the cache untouched when the server reports no change', async () => {
    const fake = fakeContext(cache, { result: false });

    await expect(applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Flagged'] })).resolves.toBe(false);
    expect(getEmail(cache.db, 'INBOX', 7)?.flags).toEqual(['\\Seen']);
  });

  it('maps a raw IMAP failure and still releases the lock', async () => {
    const fake = fakeContext(cache, { throws: new Error('ETIMEDOUT') });

    await expect(applyFlags(fake.ctx, 'INBOX', [7], { add: ['\\Flagged'] })).rejects.toBeInstanceOf(
      ImapError,
    );
    expect(fake.released).toBe(1);
    expect(getEmail(cache.db, 'INBOX', 7)?.flags).toEqual(['\\Seen']);
  });

  it('ignores UIDs that are not cached', async () => {
    const fake = fakeContext(cache);

    await expect(applyFlags(fake.ctx, 'INBOX', [7, 999], { add: ['\\Flagged'] })).resolves.toBe(
      true,
    );
    expect(getEmail(cache.db, 'INBOX', 999)).toBeUndefined();
  });
});
