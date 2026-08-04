import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { upsertEmails } from '@/cache/queries';
import { backfillFolder } from '@/cache/backfill';
import { countVectors, ensureVecTable, getVecState, upsertVecState } from '@/cache/vectors';
import type { EmailInsert } from '@/cache/schema';
import { fakeConfig, FAKE_DIMS, installFakeEmbeddings } from '../helpers/fake-embeddings';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');
const cfg = { ...fakeConfig, batchSize: 2 };
const now = () => 1_000;

const probe = openCache(':memory:', MIGRATIONS);
const available = probe.vectorsAvailable;
probe.close();

const describeIfVec = available ? describe : describe.skip;

function buildEmail(uid: number): EmailInsert {
  return {
    folder: 'INBOX',
    uid,
    messageId: `<m${String(uid)}@x>`,
    subject: `subject ${String(uid)}`,
    fromAddr: 'sender@example.com',
    toAddrs: null,
    ccAddrs: null,
    date: uid * 1000,
    flags: [],
    hasAttachments: false,
    envelopeJson: '{}',
    modseq: 1,
    cachedAt: 0,
  };
}

describeIfVec('backfillFolder', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    ensureVecTable(cache.db, cfg.model, FAKE_DIMS);
    upsertEmails(cache.db, [1, 2, 3, 4, 5].map(buildEmail));
    installFakeEmbeddings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.close();
  });

  const seedEmptyState = () => {
    upsertVecState(cache.db, {
      folder: 'INBOX',
      model: cfg.model,
      dims: FAKE_DIMS,
      fromUid: 0,
      toUid: 0,
      indexedAt: 0,
    });
  };

  it('refuses a folder that was never opted in', async () => {
    await expect(backfillFolder(cache.db, 'INBOX', cfg, 10, 'both', now)).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_INDEXED',
    });
  });

  it('indexes newest-first and honours the budget', async () => {
    seedEmptyState();

    const result = await backfillFolder(cache.db, 'INBOX', cfg, 2, 'both', now);

    expect(result).toEqual({ embedded: 2, remaining: 3 });
    expect(countVectors(cache.db, 'INBOX')).toBe(2);
    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 4, toUid: 5 });
  });

  it('resumes where the previous run stopped', async () => {
    seedEmptyState();
    await backfillFolder(cache.db, 'INBOX', cfg, 2, 'both', now);

    const result = await backfillFolder(cache.db, 'INBOX', cfg, 10, 'both', now);

    expect(result).toEqual({ embedded: 3, remaining: 0 });
    expect(countVectors(cache.db, 'INBOX')).toBe(5);
    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 1, toUid: 5 });
  });

  it('is a no-op once everything is indexed', async () => {
    seedEmptyState();
    await backfillFolder(cache.db, 'INBOX', cfg, 100, 'both', now);

    const result = await backfillFolder(cache.db, 'INBOX', cfg, 100, 'both', now);

    expect(result).toEqual({ embedded: 0, remaining: 0 });
  });

  it("spends the whole budget on an empty range even in 'newer' mode", async () => {
    seedEmptyState();

    const result = await backfillFolder(cache.db, 'INBOX', cfg, 100, 'newer', now);

    expect(result).toEqual({ embedded: 5, remaining: 0 });
    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 1, toUid: 5 });
  });

  it('picks up new mail above the watermark without touching older mail', async () => {
    upsertVecState(cache.db, {
      folder: 'INBOX',
      model: cfg.model,
      dims: FAKE_DIMS,
      fromUid: 3,
      toUid: 5,
      indexedAt: 0,
    });
    upsertEmails(cache.db, [buildEmail(6)]);

    const result = await backfillFolder(cache.db, 'INBOX', cfg, 100, 'newer', now);

    expect(result.embedded).toBe(1);
    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 3, toUid: 6 });
    expect(result.remaining).toBe(2);
  });

  it('leaves the watermark untouched when a batch fails', async () => {
    seedEmptyState();
    let calls = 0;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.reject(new Error('endpoint down'));
      const body = JSON.parse(init.body as string) as { input: string[] };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: body.input.map((_text, index) => ({
              index,
              embedding: Array.from({ length: FAKE_DIMS }, () => 0.1),
            })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    await expect(backfillFolder(cache.db, 'INBOX', cfg, 100, 'both', now)).rejects.toMatchObject({
      code: 'EMBEDDING_UNREACHABLE',
    });

    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 4, toUid: 5 });
    expect(countVectors(cache.db, 'INBOX')).toBe(2);
  });
});
