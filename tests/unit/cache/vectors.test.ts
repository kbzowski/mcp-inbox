import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { openCache, type CacheHandle } from '@/cache/db';
import { deleteEmail, deleteEmailsByFolder, upsertEmails } from '@/cache/queries';
import {
  ENVELOPE_PART,
  countVectors,
  ensureVecTable,
  getVecState,
  indexedFolders,
  insertVectors,
  knnSearch,
  pruneOrphanedVectors,
  upsertVecState,
} from '@/cache/vectors';
import type { EmailInsert } from '@/cache/schema';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');
const DIMS = 4;
const MODEL = 'test-model';

const probe = openCache(':memory:', MIGRATIONS);
const available = probe.vectorsAvailable;
probe.close();

const describeIfVec = available ? describe : describe.skip;

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

function buildEmail(uid: number, folder: string, date: number): EmailInsert {
  return {
    folder,
    uid,
    messageId: `<m${String(uid)}@x>`,
    subject: `s${String(uid)}`,
    fromAddr: 'a@b',
    toAddrs: null,
    ccAddrs: null,
    date,
    flags: [],
    hasAttachments: false,
    envelopeJson: '{}',
    modseq: 1,
    cachedAt: 0,
  };
}

describeIfVec('vec0 vector index', () => {
  let cache: CacheHandle;

  const rawRowCount = (folder: string) =>
    cache.db.get<{ c: number }>(sql`SELECT count(*) AS c FROM vec_emails WHERE folder = ${folder}`)
      ?.c ?? 0;

  const seedState = (folder: string) => {
    upsertVecState(cache.db, {
      folder,
      model: MODEL,
      dims: DIMS,
      fromUid: 1,
      toUid: 100,
      indexedAt: 0,
    });
  };

  beforeEach(() => {
    cache = openCache(':memory:', MIGRATIONS);
    ensureVecTable(cache.db, MODEL, DIMS);
  });

  afterEach(() => {
    cache.close();
  });

  it('is idempotent', () => {
    expect(() => {
      ensureVecTable(cache.db, MODEL, DIMS);
      ensureVecTable(cache.db, MODEL, DIMS);
    }).not.toThrow();
  });

  it('ranks nearest first', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 2, part: ENVELOPE_PART, date: 2000, vector: vec([0, 1, 0, 0]) },
      { uid: 3, part: ENVELOPE_PART, date: 3000, vector: vec([0.9, 0.1, 0, 0]) },
    ]);

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 3, { folders: ['INBOX'] });

    expect(hits.map((h) => h.uid)).toEqual([1, 3, 2]);
    expect(hits[0]?.distance).toBeCloseTo(0);
  });

  it('replaces rather than duplicates when the same message is embedded twice', () => {
    const row = { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) };
    insertVectors(cache.db, 'INBOX', [row]);
    insertVectors(cache.db, 'INBOX', [{ ...row, vector: vec([0, 1, 0, 0]) }]);

    expect(countVectors(cache.db, 'INBOX')).toBe(1);
    const hits = knnSearch(cache.db, vec([0, 1, 0, 0]), 10, { folders: ['INBOX'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.distance).toBeCloseTo(0);
  });

  it('keeps parts of the same message side by side but counts it once', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: 0, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 1, part: 1, date: 1000, vector: vec([0, 1, 0, 0]) },
    ]);

    expect(countVectors(cache.db, 'INBOX')).toBe(1);
    expect(rawRowCount('INBOX')).toBe(2);
    expect(knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX'] })).toHaveLength(1);
  });

  it('ranks a message by its best chunk, not its average', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: 0, date: 1000, vector: vec([0, 0, 1, 0]) },
      { uid: 1, part: 1, date: 1000, vector: vec([0, 0, 0, 1]) },
      { uid: 1, part: 2, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 2, part: 0, date: 2000, vector: vec([0.7, 0.7, 0, 0]) },
    ]);

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 20, { folders: ['INBOX'] });

    expect(hits.map((h) => h.uid)).toEqual([1, 2]);
    expect(hits[0]?.distance).toBeCloseTo(0);
  });

  it('replaces every part of a message when it is re-indexed into fewer chunks', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: 0, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 1, part: 1, date: 1000, vector: vec([0, 1, 0, 0]) },
      { uid: 1, part: 2, date: 1000, vector: vec([0, 0, 1, 0]) },
    ]);
    insertVectors(cache.db, 'INBOX', [{ uid: 1, part: 0, date: 1000, vector: vec([1, 0, 0, 0]) }]);

    expect(rawRowCount('INBOX')).toBe(1);
  });

  it('never returns a vector from another folder', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);
    insertVectors(cache.db, 'Sent', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    expect(knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX'] })).toHaveLength(1);
    expect(countVectors(cache.db, 'Sent')).toBe(1);
  });

  it('searches every folder when none is named', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([0, 1, 0, 0]) },
    ]);
    insertVectors(cache.db, 'Archives.2019', [
      { uid: 7, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 10);

    expect(hits.map((h) => `${h.folder}:${String(h.uid)}`)).toEqual(['Archives.2019:7', 'INBOX:1']);
  });

  it('restricts to a subset of folders when several are named', () => {
    for (const folder of ['INBOX', 'Sent', 'Dydaktyka']) {
      insertVectors(cache.db, folder, [
        { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
      ]);
    }

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX', 'Dydaktyka'] });

    expect(hits.map((h) => h.folder).toSorted()).toEqual(['Dydaktyka', 'INBOX']);
  });

  it('keeps the same uid in two folders apart', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 5, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);
    insertVectors(cache.db, 'Sent', [
      { uid: 5, part: ENVELOPE_PART, date: 1000, vector: vec([0.9, 0.1, 0, 0]) },
    ]);

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 10);

    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.folder))).toEqual(new Set(['INBOX', 'Sent']));
  });

  it('returns nothing for an empty folder list instead of malformed SQL', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    expect(() => knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: [] })).not.toThrow();
    expect(knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: [] })).toEqual([]);
  });

  it('lists indexed folders in a stable order', () => {
    for (const folder of ['Sent', 'INBOX', 'Archives.2019']) seedState(folder);
    expect(indexedFolders(cache.db)).toEqual(['Archives.2019', 'INBOX', 'Sent']);
  });

  it('applies the date window inside the scan', () => {
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 2, part: ENVELOPE_PART, date: 5000, vector: vec([1, 0, 0, 0]) },
    ]);

    const hits = knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX'], sinceMs: 2000 });

    expect(hits.map((h) => h.uid)).toEqual([2]);
  });

  it('treats a null date as 0 rather than failing the insert', () => {
    expect(() => {
      insertVectors(cache.db, 'INBOX', [
        { uid: 1, part: ENVELOPE_PART, date: null, vector: vec([1, 0, 0, 0]) },
      ]);
    }).not.toThrow();
    expect(knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX'] })).toHaveLength(1);
  });

  it('drops the vector when the cached email is deleted', () => {
    seedState('INBOX');
    upsertEmails(cache.db, [buildEmail(1, 'INBOX', 1000), buildEmail(2, 'INBOX', 2000)]);
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 2, part: ENVELOPE_PART, date: 2000, vector: vec([0, 1, 0, 0]) },
    ]);

    deleteEmail(cache.db, 'INBOX', 1);

    expect(
      knnSearch(cache.db, vec([1, 0, 0, 0]), 10, { folders: ['INBOX'] }).map((h) => h.uid),
    ).toEqual([2]);
  });

  it('wipes the partition and resets the range when the folder is invalidated', () => {
    seedState('INBOX');
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    deleteEmailsByFolder(cache.db, 'INBOX');

    expect(countVectors(cache.db, 'INBOX')).toBe(0);
    expect(getVecState(cache.db, 'INBOX')).toMatchObject({ fromUid: 0, toUid: 0 });
  });

  // sqlite-vec 0.1.9 fixes DELETE on vec0 rows whose text metadata exceeds
  // 12 characters (asg017/sqlite-vec#274). Real folder names hit that.
  it('deletes rows in a folder whose name exceeds 12 characters', () => {
    const folder = 'Trash.Elementy zainfekowane';
    seedState(folder);
    upsertEmails(cache.db, [buildEmail(1, folder, 1000)]);
    insertVectors(cache.db, folder, [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    deleteEmail(cache.db, folder, 1);

    expect(countVectors(cache.db, folder)).toBe(0);
  });

  it('prunes vectors whose cached envelope is gone', () => {
    seedState('INBOX');
    upsertEmails(cache.db, [buildEmail(1, 'INBOX', 1000)]);
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
      { uid: 2, part: ENVELOPE_PART, date: 2000, vector: vec([0, 1, 0, 0]) },
    ]);

    expect(pruneOrphanedVectors(cache.db, 'INBOX')).toBe(1);
    expect(countVectors(cache.db, 'INBOX')).toBe(1);
    expect(
      knnSearch(cache.db, vec([0, 1, 0, 0]), 10, { folders: ['INBOX'] }).map((h) => h.uid),
    ).toEqual([1]);
  });

  it('prunes nothing when the index is consistent', () => {
    seedState('INBOX');
    upsertEmails(cache.db, [buildEmail(1, 'INBOX', 1000)]);
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    expect(pruneOrphanedVectors(cache.db, 'INBOX')).toBe(0);
    expect(countVectors(cache.db, 'INBOX')).toBe(1);
  });

  it('prunes nothing for a folder that was never indexed', () => {
    expect(pruneOrphanedVectors(cache.db, 'Sent')).toBe(0);
  });

  it('rebuilds the index when the model changes', () => {
    seedState('INBOX');
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    ensureVecTable(cache.db, 'a-different-model', DIMS);

    expect(countVectors(cache.db, 'INBOX')).toBe(0);
    expect(getVecState(cache.db, 'INBOX')).toBeUndefined();
  });

  it('rebuilds the index when the dimensionality changes', () => {
    seedState('INBOX');
    insertVectors(cache.db, 'INBOX', [
      { uid: 1, part: ENVELOPE_PART, date: 1000, vector: vec([1, 0, 0, 0]) },
    ]);

    ensureVecTable(cache.db, MODEL, 8);

    expect(getVecState(cache.db, 'INBOX')).toBeUndefined();
    expect(() => {
      insertVectors(cache.db, 'INBOX', [
        { uid: 1, part: ENVELOPE_PART, date: 0, vector: vec([1, 0, 0, 0, 0, 0, 0, 0]) },
      ]);
    }).not.toThrow();
  });
});
