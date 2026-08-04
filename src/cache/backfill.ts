import type { CacheDb } from './db';
import type { Email } from './schema';
import { countEmailsOutsideUidRange, listIndexCandidates } from './queries';
import {
  ENVELOPE_PART,
  getVecState,
  insertVectors,
  upsertVecState,
  type VectorRow,
} from './vectors';
import { embedTexts, envelopeText } from '../embeddings/client';
import type { EmbeddingsConfig } from '../config/env';
import { EmbeddingError } from '../errors/types';

export interface BackfillResult {
  embedded: number;
  remaining: number;
}

/**
 * Embed cached envelopes outside the folder's indexed UID range, newest
 * first, up to `budget` messages.
 *
 * Nothing writes vectors on the sync path - a network round-trip there would
 * block every list/search call. Instead the indexed set is the contiguous
 * range [fromUid, toUid] and this walks outward from it, so an interrupted
 * run is resumed by simply calling again.
 *
 * ponytail: new mail becomes searchable only once a call does this work,
 * so a search can lag one invocation behind. If that ever matters, drive
 * backfillFolder from a setInterval over vec_index_state rows.
 */
export async function backfillFolder(
  db: CacheDb,
  folder: string,
  cfg: EmbeddingsConfig,
  budget: number,
  direction: 'newer' | 'both',
  now: () => number,
): Promise<BackfillResult> {
  const state = getVecState(db, folder);
  if (state === undefined) {
    throw new EmbeddingError(
      'EMBEDDING_NOT_INDEXED',
      `Folder "${folder}" is not indexed for semantic search. Run imap_index_folder with folder="${folder}" first, or use imap_search_emails.`,
    );
  }

  let { fromUid, toUid } = state;
  let embedded = 0;
  let left = budget;

  const startedEmpty = fromUid === 0 && toUid === 0;

  const widenRange = (rows: Email[]) => {
    const uids = rows.map((r) => r.uid);
    fromUid = fromUid === 0 ? Math.min(...uids) : Math.min(fromUid, ...uids);
    toUid = Math.max(toUid, ...uids);
    upsertVecState(db, {
      folder,
      model: cfg.model,
      dims: cfg.dims,
      fromUid,
      toUid,
      indexedAt: now(),
    });
  };

  if (!startedEmpty) {
    while (left > 0) {
      const rows = listIndexCandidates(db, folder, {
        aboveUid: toUid,
        limit: Math.min(cfg.batchSize, left),
        order: 'asc',
      });
      if (rows.length === 0) break;
      await embedBatch(db, folder, rows, cfg);
      widenRange(rows);
      embedded += rows.length;
      left -= rows.length;
    }
  }

  // An empty range has no "newer" side to catch up, so the initial build runs
  // regardless of direction - otherwise a folder reset by a UIDVALIDITY change
  // would re-index only one batch per call.
  if (startedEmpty || direction === 'both') {
    while (left > 0) {
      const rows = listIndexCandidates(db, folder, {
        ...(fromUid > 0 && { belowUid: fromUid }),
        limit: Math.min(cfg.batchSize, left),
        order: 'desc',
      });
      if (rows.length === 0) break;
      await embedBatch(db, folder, rows, cfg);
      widenRange(rows);
      embedded += rows.length;
      left -= rows.length;
    }
  }

  return {
    embedded,
    remaining: countEmailsOutsideUidRange(db, folder, fromUid, toUid),
  };
}

/**
 * The watermark is advanced by the caller only after this resolves, so a
 * failed request leaves the range untouched and the next call retries
 * exactly the batch that failed.
 */
async function embedBatch(
  db: CacheDb,
  folder: string,
  rows: Email[],
  cfg: EmbeddingsConfig,
): Promise<void> {
  const vectors = await embedTexts(rows.map(envelopeText), cfg);

  const toInsert: VectorRow[] = [];
  for (const [i, row] of rows.entries()) {
    const vector = vectors[i];
    if (vector === undefined) {
      throw new EmbeddingError(
        'EMBEDDING_UNREACHABLE',
        `The embeddings endpoint returned ${vectors.length} vectors for ${rows.length} messages.`,
      );
    }
    toInsert.push({ uid: row.uid, part: ENVELOPE_PART, date: row.date, vector });
  }

  insertVectors(db, folder, toInsert);
}
