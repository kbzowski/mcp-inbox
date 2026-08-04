import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmail, upsertFolder } from '@/cache/queries';
import { replyTool } from '@/tools/send/reply';
import type { ToolContext } from '@/tools/define-tool';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');
const PARENT = '<parent@example.com>';

function contextWithHeaders(cache: CacheHandle, fetchOne: () => Promise<unknown>): ToolContext {
  return {
    db: cache.db,
    imap: {
      connection: () =>
        Promise.resolve({
          getMailboxLock: () => Promise.resolve({ release: () => undefined }),
          fetchOne,
          messageFlagsAdd: () => Promise.resolve(true),
          append: () => Promise.reject(new Error('no Sent folder in this fake')),
          list: () => Promise.resolve([]),
        }),
    },
    smtp: {
      sendRaw: () => Promise.resolve({ messageId: '<new@example.com>', response: 'ok' }),
    },
    cacheConfig: { dir: '/tmp', defaultStalenessSec: 60 },
    defaults: { fromAddress: 'me@example.com' },
    now: () => 1_000,
  } as unknown as ToolContext;
}

describe('imap_reply threading', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    // Fresh enough that syncIfStale short-circuits and never touches IMAP.
    upsertFolder(cache.db, {
      name: 'INBOX',
      delimiter: '/',
      specialUse: null,
      uidValidity: 1,
      uidNext: 8,
      highestModseq: null,
      lastSyncedAt: 1_000,
    });
    upsertEmail(cache.db, {
      folder: 'INBOX',
      uid: 7,
      messageId: PARENT,
      subject: 'Budget',
      fromAddr: 'alice@example.com',
      toAddrs: null,
      ccAddrs: null,
      date: 0,
      flags: [],
      hasAttachments: false,
      envelopeJson: JSON.stringify({ messageId: PARENT, subject: 'Budget' }),
      modseq: 1,
      cachedAt: 1_000,
    });
  });

  afterEach(() => {
    cache.close();
  });

  it('carries the full References chain from the original header', async () => {
    const ctx = contextWithHeaders(cache, () =>
      Promise.resolve({ headers: Buffer.from('References: <a@x> <b@x>\r\n') }),
    );

    const result = await replyTool.handler(
      { folder: 'INBOX', uid: 7, body: 'ok', reply_all: false, mark_answered: false },
      ctx,
    );

    expect((result.structuredContent as { references: string[] }).references).toEqual([
      '<a@x>',
      '<b@x>',
      PARENT,
    ]);
  });

  it('still sends when the header fetch fails, falling back to the parent alone', async () => {
    const ctx = contextWithHeaders(cache, () => Promise.reject(new Error('connection reset')));

    const result = await replyTool.handler(
      { folder: 'INBOX', uid: 7, body: 'ok', reply_all: false, mark_answered: false },
      ctx,
    );

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { references: string[] }).references).toEqual([PARENT]);
    expect((result.structuredContent as { message_id: string }).message_id).toBe(
      '<new@example.com>',
    );
  });
});
