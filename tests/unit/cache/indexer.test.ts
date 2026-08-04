import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { IndexSweeper } from '@/cache/indexer';
import { ensureVecTable, upsertVecState } from '@/cache/vectors';
import type { ImapClient } from '@/imap/client';
import { fakeConfig, FAKE_DIMS } from '../helpers/fake-embeddings';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');
const now = () => 1_000;

const probe = openCache(':memory:', MIGRATIONS);
const available = probe.vectorsAvailable;
probe.close();

const describeIfVec = available ? describe : describe.skip;

function deferred(): { promise: Promise<never>; reject: (reason: Error) => void } {
  let reject!: (reason: Error) => void;
  const promise = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  return { promise, reject };
}

/** Every connection attempt fails, so a sweep must survive on the error path. */
function failingImap(): { client: ImapClient; attempts: () => number } {
  let attempts = 0;
  const client = {
    connection: () => {
      attempts++;
      return Promise.reject(new Error('imap down'));
    },
  } as unknown as ImapClient;
  return { client, attempts: () => attempts };
}

describeIfVec('IndexSweeper', () => {
  let cache: CacheHandle;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    ensureVecTable(cache.db, fakeConfig.model, FAKE_DIMS);
  });

  afterEach(() => {
    cache.close();
    vi.useRealTimers();
  });

  const seedFolders = (...folders: string[]) => {
    for (const folder of folders) {
      upsertVecState(cache.db, {
        folder,
        model: fakeConfig.model,
        dims: FAKE_DIMS,
        fromUid: 1,
        toUid: 10,
        indexedAt: 0,
      });
    }
  };

  const build = (client: ImapClient, over: Partial<{ intervalMs: number; budget: number }> = {}) =>
    new IndexSweeper({
      db: cache.db,
      imap: client,
      cfg: fakeConfig,
      intervalMs: over.intervalMs ?? 60_000,
      budgetPerTick: over.budget ?? 200,
      now,
    });

  it('does nothing when no folder is indexed', async () => {
    const { client, attempts } = failingImap();
    await expect(build(client).sweepOnce()).resolves.toEqual({ folders: 0, embedded: 0 });
    expect(attempts()).toBe(0);
  });

  it('visits every indexed folder', async () => {
    seedFolders('INBOX', 'Sent', 'Dydaktyka');
    const { client, attempts } = failingImap();

    const result = await build(client).sweepOnce();

    expect(result.folders).toBe(3);
    expect(attempts()).toBe(3);
  });

  it('keeps going when one folder fails', async () => {
    seedFolders('INBOX', 'Sent');
    const { client } = failingImap();

    await expect(build(client).sweepOnce()).resolves.toMatchObject({ folders: 2, embedded: 0 });
  });

  it('never rejects, however badly the connection misbehaves', async () => {
    seedFolders('INBOX');
    const client = {
      connection: () => {
        throw new Error('synchronous explosion');
      },
    } as unknown as ImapClient;

    await expect(build(client).sweepOnce()).resolves.toBeDefined();
  });

  it('does not start a second pass while one is running', async () => {
    seedFolders('INBOX', 'Sent');
    const gate = deferred();
    const client = { connection: () => gate.promise } as unknown as ImapClient;
    const sweeper = build(client);

    const first = sweeper.sweepOnce();
    const second = await sweeper.sweepOnce();
    expect(second).toEqual({ folders: 0, embedded: 0 });

    gate.reject(new Error('imap down'));
    await expect(first).resolves.toMatchObject({ embedded: 0 });
  });

  it('stops sweeping after stop()', async () => {
    seedFolders('INBOX');
    const { client, attempts } = failingImap();
    const sweeper = build(client);

    sweeper.stop();
    await sweeper.sweepOnce();

    expect(attempts()).toBe(0);
  });

  it('never schedules a timer when the interval is zero', () => {
    vi.useFakeTimers();
    const { client } = failingImap();
    const sweeper = build(client, { intervalMs: 0 });

    sweeper.start();

    expect(vi.getTimerCount()).toBe(0);
    sweeper.stop();
  });

  it('schedules a repeating timer when enabled', () => {
    vi.useFakeTimers();
    const { client } = failingImap();
    const sweeper = build(client, { intervalMs: 60_000 });

    sweeper.start();
    expect(vi.getTimerCount()).toBe(1);

    sweeper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
