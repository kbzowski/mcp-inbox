import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import {
  upsertEmails,
  deleteEmail,
  deleteEmailsByFolder,
  deleteEmailsByUids,
  countEmailsInFolder,
} from '@/cache/queries';
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

/**
 * The delete hooks are called from the sync path on every platform, including
 * ones where sqlite-vec never loaded and `vec_emails` therefore does not
 * exist. If they threw there, ordinary mail sync would break for users who
 * never opted into semantic search.
 */
describe('cache deletes when no vector index exists', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    upsertEmails(cache.db, [buildEmail(1), buildEmail(2), buildEmail(3)]);
  });

  afterEach(() => {
    cache.close();
  });

  it('deleteEmail succeeds', () => {
    expect(() => {
      deleteEmail(cache.db, 'INBOX', 1);
    }).not.toThrow();
    expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(2);
  });

  it('deleteEmailsByUids succeeds', () => {
    expect(() => {
      deleteEmailsByUids(cache.db, 'INBOX', [1, 2]);
    }).not.toThrow();
    expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(1);
  });

  it('deleteEmailsByFolder succeeds', () => {
    expect(() => {
      deleteEmailsByFolder(cache.db, 'INBOX');
    }).not.toThrow();
    expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(0);
  });

  it('deleteEmailsByUids is a no-op for an empty uid list', () => {
    expect(() => {
      deleteEmailsByUids(cache.db, 'INBOX', []);
    }).not.toThrow();
    expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(3);
  });
});
