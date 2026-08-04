import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
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

function buildEmail(folder: string, uid: number, subject: string): EmailInsert {
  return {
    folder,
    uid,
    messageId: `<m${folder}${String(uid)}@x>`,
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

describeIfVec('semantic search across folders', () => {
  let cache: CacheHandle;
  let ctx: ToolContext;

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    ensureVecTable(cache.db, fakeConfig.model, FAKE_DIMS);

    const seed = (folder: string, uid: number, subject: string) => {
      upsertFolder(cache.db, {
        name: folder,
        delimiter: '.',
        specialUse: null,
        uidValidity: 1,
        uidNext: 100,
        highestModseq: 1,
        lastSyncedAt: NOW,
      });
      upsertEmails(cache.db, [buildEmail(folder, uid, subject)]);
      insertVectors(cache.db, folder, [
        {
          uid,
          part: ENVELOPE_PART,
          date: uid * 1000,
          vector: fakeVector(`Subject: ${subject}\nFrom: sender@example.com`),
        },
      ]);
      upsertVecState(cache.db, {
        folder,
        model: fakeConfig.model,
        dims: FAKE_DIMS,
        fromUid: 1,
        toUid: 100,
        indexedAt: NOW,
      });
    };

    seed('INBOX', 1, 'faktura za hosting');
    seed('Archives.2019', 2, 'umowa licencyjna');
    seed('Dydaktyka', 3, 'plan wykladow');

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

  const search = async (args: Record<string, unknown>) => {
    const res = await semanticSearchTool.handler(
      semanticSearchTool.inputSchema.parse({ response_format: 'json', ...args }),
      ctx,
    );
    return res.structuredContent as {
      folders: string[];
      returned: number;
      emails: { uid: number; folder: string; subject: string | null }[];
    };
  };

  it('searches every indexed folder when none is given', async () => {
    const body = await search({ query: 'umowa licencyjna', limit: 5 });

    expect(body.folders).toEqual(['Archives.2019', 'Dydaktyka', 'INBOX']);
    expect(body.emails[0]?.folder).toBe('Archives.2019');
    expect(body.emails[0]?.subject).toBe('umowa licencyjna');
  });

  it('reports which folder each hit came from', async () => {
    const body = await search({ query: 'plan wykladow', limit: 5 });
    const found = body.emails.find((e) => e.subject === 'plan wykladow');
    expect(found?.folder).toBe('Dydaktyka');
  });

  it('stays inside one folder when it is named', async () => {
    const body = await search({ query: 'umowa licencyjna', folder: 'INBOX', limit: 5 });

    expect(body.folders).toEqual(['INBOX']);
    expect(body.emails.every((e) => e.folder === 'INBOX')).toBe(true);
  });

  it('never reaches the network to answer', async () => {
    await expect(search({ query: 'cokolwiek', limit: 3 })).resolves.toBeDefined();
  });

  it('refuses when nothing has been indexed at all', async () => {
    const empty = openCache(':memory:', MIGRATIONS);
    ensureVecTable(empty.db, fakeConfig.model, FAKE_DIMS);
    const emptyCtx: ToolContext = { ...ctx, db: empty.db };

    const err = await semanticSearchTool
      .handler(
        semanticSearchTool.inputSchema.parse({ query: 'x', response_format: 'json' }),
        emptyCtx,
      )
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'EMBEDDING_NOT_INDEXED' });
    empty.close();
  });
});
