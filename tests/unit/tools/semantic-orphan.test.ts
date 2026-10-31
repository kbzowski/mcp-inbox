import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmails, upsertFolder } from '@/cache/queries';
import { ENVELOPE_PART, ensureVecTable, insertVectors, upsertVecState } from '@/cache/vectors';
import { semanticSearchTool } from '@/tools/emails/semantic-search';
import type { ToolContext } from '@/tools/define-tool';
import type { EmailInsert } from '@/cache/schema';
import {
  fakeConfig,
  FAKE_DIMS,
  fakeVector,
  installFakeEmbeddings,
} from '../helpers/fake-embeddings';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');
const NOW = 1_000_000;

const probe = openCache(':memory:', MIGRATIONS);
const available = probe.vectorsAvailable;
probe.close();

const describeIfVec = available ? describe : describe.skip;

function buildEmail(uid: number, subject: string): EmailInsert {
  return {
    folder: 'INBOX',
    uid,
    messageId: `<m${String(uid)}@x>`,
    subject,
    fromAddr: 'sender@example.com',
    toAddrs: null,
    ccAddrs: null,
    date: uid * 1000,
    flags: ['\\Seen'],
    hasAttachments: false,
    envelopeJson: '{}',
    modseq: 1,
    cachedAt: 0,
  };
}

/**
 * A vector whose cached envelope is gone must not consume one of the caller's
 * result slots. Reproduces the state observed in a real cache: more rows in
 * vec_emails than in emails.
 */
describeIfVec('semantic search with orphaned vectors', () => {
  let cache: CacheHandle;
  let ctx: ToolContext;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    ensureVecTable(cache.db, fakeConfig.model, FAKE_DIMS);

    upsertFolder(cache.db, {
      name: 'INBOX',
      delimiter: '.',
      specialUse: null,
      uidValidity: 1,
      uidNext: 100,
      highestModseq: 1,
      lastSyncedAt: NOW,
    });

    const subjects = ['alpha alpha', 'alpha beta', 'beta gamma', 'gamma delta'];
    upsertEmails(
      cache.db,
      subjects.map((s, i) => buildEmail(i + 1, s)),
    );

    insertVectors(
      cache.db,
      'INBOX',
      subjects.map((s, i) => ({
        uid: i + 1,
        part: ENVELOPE_PART,
        date: (i + 1) * 1000,
        vector: fakeVector(`Subject: ${s}\nFrom: sender@example.com`),
      })),
    );

    upsertVecState(cache.db, {
      folder: 'INBOX',
      model: fakeConfig.model,
      dims: FAKE_DIMS,
      fromUid: 1,
      toUid: 4,
      indexedAt: NOW,
    });

    ctx = {
      db: cache.db,
      imap: { connection: () => Promise.reject(new Error('network access attempted')) },
      smtp: {},
      cacheConfig: { dir: '/tmp', defaultStalenessSec: 60, bodyRetainDays: 180 },
      embeddings: fakeConfig,
      vectorsAvailable: true,
      defaults: { fromAddress: 'me@example.com' },
      now: () => NOW,
    } as unknown as ToolContext;

    installFakeEmbeddings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.close();
  });

  const search = async (limit: number) => {
    const res = await semanticSearchTool.handler(
      {
        query: 'alpha',
        folder: 'INBOX',
        limit,
        max_staleness_seconds: 3600,
        response_format: 'json',
      },
      ctx,
    );
    return res.structuredContent as { returned: number; emails: { uid: number }[] };
  };

  it('returns the requested count when every vector has its envelope', async () => {
    const body = await search(3);
    expect(body.returned).toBe(3);
  });

  it('still fills the result set when a vector outlived its envelope', async () => {
    // Deleted directly, bypassing the cleanup hooks, so the vector is left
    // behind exactly as a pre-hook build or another client would leave it.
    cache.db.run(sql`DELETE FROM emails WHERE folder = 'INBOX' AND uid = 1`);

    const body = await search(3);

    expect(body.returned).toBe(3);
    expect(body.emails.map((e) => e.uid)).not.toContain(1);
  });

  it('never returns more than the requested limit despite over-fetching', async () => {
    const body = await search(2);
    expect(body.returned).toBe(2);
  });
});
