import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmail, setEmailBody, getEmailBody } from '@/cache/queries';
import { ensureBodyCached } from '@/tools/emails/shared';
import type { ToolContext } from '@/tools/define-tool';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

/**
 * A context whose IMAP client refuses to connect. Any code path that
 * reaches the network fails the test by construction.
 */
function offlineContext(cache: CacheHandle): ToolContext {
  return {
    db: cache.db,
    imap: {
      connection: () => Promise.reject(new Error('network access attempted')),
    },
    smtp: {},
    cacheConfig: { dir: '/tmp', defaultStalenessSec: 60 },
    defaults: { fromAddress: 'me@example.com' },
    now: () => 1_000,
  } as unknown as ToolContext;
}

describe('ensureBodyCached', () => {
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
      flags: [],
      hasAttachments: true,
      envelopeJson: '{}',
      modseq: 1,
      cachedAt: 0,
    });
  });

  afterEach(() => {
    cache.close();
  });

  it('serves a cached body without touching the network', async () => {
    const attachments = [{ filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 12 }];
    setEmailBody(cache.db, 'INBOX', 7, { text: 'hello', html: '<p>hello</p>', attachments }, 500);

    await expect(ensureBodyCached(offlineContext(cache), 'INBOX', 7)).resolves.toEqual({
      bodyText: 'hello',
      bodyHtml: '<p>hello</p>',
      attachments,
    });
  });

  it('reports an empty attachment list when none were stored', async () => {
    setEmailBody(cache.db, 'INBOX', 7, { text: 'hello', html: null }, 500);

    const result = await ensureBodyCached(offlineContext(cache), 'INBOX', 7);
    expect(result.attachments).toEqual([]);
  });

  it('goes to the network when no body has been cached yet', async () => {
    expect(getEmailBody(cache.db, 'INBOX', 7)?.bodyCachedAt).toBeNull();

    await expect(ensureBodyCached(offlineContext(cache), 'INBOX', 7)).rejects.toThrow();
  });
});
