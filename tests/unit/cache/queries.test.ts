import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '../../../src/cache/db';
import {
  upsertFolder,
  getFolder,
  listFolders,
  upsertEmail,
  getEmail,
  listEmailsByFolder,
  countEmailsInFolder,
  setEmailFlags,
  deleteEmail,
  deleteEmailsByFolder,
  deleteEmailsByUids,
  getEmailBody,
  setEmailBody,
  upsertAttachment,
  getAttachment,
  linkEmailAttachment,
  listAttachmentsForEmail,
} from '../../../src/cache/queries';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

function buildEmail(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    folder: 'INBOX',
    uid: 1,
    messageId: '<msg-1@example.com>',
    subject: 'Hello',
    fromAddr: 'alice@example.com',
    toAddrs: ['bob@example.com'],
    ccAddrs: null,
    date: new Date('2026-04-17T00:00:00Z').getTime(),
    flags: [] as string[],
    hasAttachments: false,
    envelopeJson: '{"subject":"Hello"}',
    modseq: 1,
    cachedAt: now,
    ...overrides,
  };
}

describe('cache queries', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
  });

  // ─── Folders ───────────────────────────────────────────────────────────

  describe('folders', () => {
    it('upsert inserts a new folder', () => {
      upsertFolder(cache.db, {
        name: 'INBOX',
        delimiter: '/',
        uidValidity: 12345,
        uidNext: 100,
        lastSyncedAt: 1_000,
      });

      const folder = getFolder(cache.db, 'INBOX');
      expect(folder).toMatchObject({
        name: 'INBOX',
        delimiter: '/',
        uidValidity: 12345,
        uidNext: 100,
        highestModseq: null,
        specialUse: null,
      });
    });

    it('upsert on existing name overwrites sync state', () => {
      upsertFolder(cache.db, {
        name: 'INBOX',
        delimiter: '/',
        uidValidity: 1,
        lastSyncedAt: 1_000,
      });
      upsertFolder(cache.db, {
        name: 'INBOX',
        delimiter: '/',
        uidValidity: 1,
        uidNext: 200,
        highestModseq: 42,
        lastSyncedAt: 2_000,
      });

      const folder = getFolder(cache.db, 'INBOX');
      expect(folder?.uidNext).toBe(200);
      expect(folder?.highestModseq).toBe(42);
      expect(folder?.lastSyncedAt).toBe(2_000);
    });

    it('listFolders returns all rows', () => {
      upsertFolder(cache.db, {
        name: 'INBOX',
        delimiter: '/',
        uidValidity: 1,
        lastSyncedAt: 1_000,
      });
      upsertFolder(cache.db, {
        name: '[Gmail]/Sent Mail',
        delimiter: '/',
        uidValidity: 2,
        specialUse: '\\Sent',
        lastSyncedAt: 1_001,
      });

      expect(listFolders(cache.db)).toHaveLength(2);
    });
  });

  // ─── Emails: upsert + get ──────────────────────────────────────────────

  describe('emails: upsert + get', () => {
    it('roundtrips a full envelope', () => {
      upsertEmail(cache.db, buildEmail());

      const row = getEmail(cache.db, 'INBOX', 1);
      expect(row).toMatchObject({
        folder: 'INBOX',
        uid: 1,
        subject: 'Hello',
        fromAddr: 'alice@example.com',
        toAddrs: ['bob@example.com'],
        flags: [],
      });
    });

    it('upsert on (folder, uid) conflict overwrites', () => {
      upsertEmail(cache.db, buildEmail({ subject: 'First' }));
      upsertEmail(cache.db, buildEmail({ subject: 'Second' }));

      const row = getEmail(cache.db, 'INBOX', 1);
      expect(row?.subject).toBe('Second');
    });

    it('treats (folder, uid) as composite key - same UID in different folders coexist', () => {
      upsertEmail(cache.db, buildEmail({ folder: 'INBOX', uid: 42, subject: 'in inbox' }));
      upsertEmail(cache.db, buildEmail({ folder: 'Sent', uid: 42, subject: 'in sent' }));

      expect(getEmail(cache.db, 'INBOX', 42)?.subject).toBe('in inbox');
      expect(getEmail(cache.db, 'Sent', 42)?.subject).toBe('in sent');
    });

    it('returns undefined for unknown email', () => {
      expect(getEmail(cache.db, 'INBOX', 999)).toBeUndefined();
    });
  });

  // ─── Emails: list + filters ────────────────────────────────────────────

  describe('emails: list', () => {
    beforeEach(() => {
      upsertEmail(
        cache.db,
        buildEmail({ uid: 1, subject: 'oldest', date: 1_000, flags: ['\\Seen'] }),
      );
      upsertEmail(cache.db, buildEmail({ uid: 2, subject: 'middle', date: 2_000, flags: [] }));
      upsertEmail(
        cache.db,
        buildEmail({ uid: 3, subject: 'newest', date: 3_000, flags: ['\\Seen'] }),
      );
    });

    it('orders newest first by date', () => {
      const rows = listEmailsByFolder(cache.db, 'INBOX');
      expect(rows.map((r) => r.subject)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('honors limit and offset', () => {
      const page1 = listEmailsByFolder(cache.db, 'INBOX', { limit: 2, offset: 0 });
      const page2 = listEmailsByFolder(cache.db, 'INBOX', { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page2[0]?.subject).toBe('oldest');
    });

    it('unseenOnly filters out messages with \\Seen', () => {
      const rows = listEmailsByFolder(cache.db, 'INBOX', { unseenOnly: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.subject).toBe('middle');
    });

    it('sinceMs / beforeMs form an [inclusive, exclusive) window', () => {
      // Covers the middle and newest (date >= 2000 && < 3001).
      const rows = listEmailsByFolder(cache.db, 'INBOX', { sinceMs: 2_000, beforeMs: 3_001 });
      expect(rows.map((r) => r.subject)).toEqual(['newest', 'middle']);
    });

    it('countEmailsInFolder returns the total', () => {
      expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(3);
      expect(countEmailsInFolder(cache.db, 'Nonexistent')).toBe(0);
    });
  });

  // ─── Emails: flags + body ──────────────────────────────────────────────

  describe('emails: flags + body', () => {
    beforeEach(() => {
      upsertEmail(cache.db, buildEmail({ uid: 1, flags: [] }));
    });

    it('setEmailFlags replaces the flag set', () => {
      setEmailFlags(cache.db, 'INBOX', 1, ['\\Seen', '\\Flagged']);
      expect(getEmail(cache.db, 'INBOX', 1)?.flags).toEqual(['\\Seen', '\\Flagged']);
    });

    it('body starts null, setEmailBody populates it', () => {
      expect(getEmailBody(cache.db, 'INBOX', 1)).toMatchObject({
        bodyText: null,
        bodyHtml: null,
        bodyCachedAt: null,
      });

      setEmailBody(cache.db, 'INBOX', 1, { text: 'hi', html: '<p>hi</p>' }, 5_000);

      expect(getEmailBody(cache.db, 'INBOX', 1)).toEqual({
        bodyText: 'hi',
        bodyHtml: '<p>hi</p>',
        bodyCachedAt: 5_000,
      });
    });
  });

  // ─── Emails: delete paths ──────────────────────────────────────────────

  describe('emails: delete', () => {
    beforeEach(() => {
      upsertEmail(cache.db, buildEmail({ folder: 'INBOX', uid: 1 }));
      upsertEmail(cache.db, buildEmail({ folder: 'INBOX', uid: 2 }));
      upsertEmail(cache.db, buildEmail({ folder: 'INBOX', uid: 3 }));
      upsertEmail(cache.db, buildEmail({ folder: 'Sent', uid: 1 }));
    });

    it('deleteEmail removes a single row', () => {
      deleteEmail(cache.db, 'INBOX', 2);
      expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(2);
      expect(getEmail(cache.db, 'INBOX', 2)).toBeUndefined();
    });

    it('deleteEmailsByFolder wipes only that folder (UIDVALIDITY path)', () => {
      deleteEmailsByFolder(cache.db, 'INBOX');
      expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(0);
      expect(countEmailsInFolder(cache.db, 'Sent')).toBe(1);
    });

    it('deleteEmailsByUids removes a batch', () => {
      deleteEmailsByUids(cache.db, 'INBOX', [1, 3]);
      expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(1);
      expect(getEmail(cache.db, 'INBOX', 2)).toBeDefined();
    });

    it('deleteEmailsByUids is a no-op on empty list', () => {
      deleteEmailsByUids(cache.db, 'INBOX', []);
      expect(countEmailsInFolder(cache.db, 'INBOX')).toBe(3);
    });
  });

  // ─── Attachments ───────────────────────────────────────────────────────

  describe('attachments', () => {
    beforeEach(() => {
      upsertEmail(cache.db, buildEmail({ uid: 1, hasAttachments: true }));
    });

    it('upsertAttachment is no-op on existing sha256 (content-addressed)', () => {
      upsertAttachment(cache.db, {
        sha256: 'abc123',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        filePath: '/tmp/abc123',
        firstSeenAt: 1_000,
      });
      upsertAttachment(cache.db, {
        sha256: 'abc123',
        // Different metadata, but same bytes - should not overwrite.
        filename: 'invoice-copy.pdf',
        contentType: 'application/octet-stream',
        sizeBytes: 1024,
        filePath: '/tmp/other-path',
        firstSeenAt: 9_999,
      });

      const row = getAttachment(cache.db, 'abc123');
      expect(row?.filename).toBe('invoice.pdf');
      expect(row?.filePath).toBe('/tmp/abc123');
      expect(row?.firstSeenAt).toBe(1_000);
    });

    it('linkEmailAttachment + listAttachmentsForEmail join correctly', () => {
      upsertAttachment(cache.db, {
        sha256: 'abc123',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        filePath: '/tmp/abc123',
        firstSeenAt: 1_000,
      });
      linkEmailAttachment(cache.db, 'INBOX', 1, '1.2', 'abc123');

      const list = listAttachmentsForEmail(cache.db, 'INBOX', 1);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ sha256: 'abc123', filename: 'invoice.pdf' });
    });

    it('FK prevents linking to unknown sha256', () => {
      expect(() => linkEmailAttachment(cache.db, 'INBOX', 1, '1.2', 'no-such-attachment')).toThrow(
        /FOREIGN KEY|foreign key/i,
      );
    });
  });
});
