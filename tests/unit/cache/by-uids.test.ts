import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmails, getEmailsByUids } from '@/cache/queries';
import type { EmailInsert } from '@/cache/schema';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

function buildEmail(uid: number, folder = 'INBOX'): EmailInsert {
  return {
    folder,
    uid,
    messageId: `<m${String(uid)}@x>`,
    subject: `s${String(uid)}`,
    fromAddr: 'a@b',
    toAddrs: null,
    ccAddrs: null,
    date: 0,
    flags: [],
    hasAttachments: false,
    envelopeJson: '{}',
    modseq: 1,
    cachedAt: 0,
  };
}

describe('getEmailsByUids', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    upsertEmails(cache.db, [buildEmail(1), buildEmail(2), buildEmail(3)]);
  });

  afterEach(() => {
    cache.close();
  });

  it('returns an empty map for an empty UID list', () => {
    expect(getEmailsByUids(cache.db, 'INBOX', []).size).toBe(0);
  });

  it('keys the rows it found by UID', () => {
    const out = getEmailsByUids(cache.db, 'INBOX', [1, 3]);
    expect([...out.keys()].toSorted((a, b) => a - b)).toEqual([1, 3]);
    expect(out.get(3)?.subject).toBe('s3');
  });

  it('omits UIDs with no cached row rather than mapping them to undefined', () => {
    const out = getEmailsByUids(cache.db, 'INBOX', [1, 999]);
    expect(out.has(999)).toBe(false);
    expect(out.size).toBe(1);
  });

  it('is folder-scoped - the same UID in another folder is not returned', () => {
    upsertEmails(cache.db, [buildEmail(1, 'Sent')]);
    const out = getEmailsByUids(cache.db, 'Sent', [1, 2, 3]);
    expect(out.size).toBe(1);
    expect(out.get(1)?.folder).toBe('Sent');
  });

  it('batches a UID list past SQLite’s bound-parameter cap', () => {
    const uids = Array.from({ length: 40_000 }, (_, i) => i + 1);
    let out!: Map<number, unknown>;
    expect(() => {
      out = getEmailsByUids(cache.db, 'INBOX', uids);
    }).not.toThrow();
    expect(out.size).toBe(3);
  });
});
