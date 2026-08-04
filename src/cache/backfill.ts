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
import { bodyChunks } from '../embeddings/chunk';
import type { TextBodies } from '../imap/body-text';
import type { EmbeddingsConfig } from '../config/env';
import { EmbeddingError } from '../errors/types';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:backfill');

/**
 * Supplies plain body text for a batch of UIDs. Injected rather than imported
 * so this module never depends on ImapFlow, and so the caller owns the mailbox
 * lock - which must never be held across an embeddings round-trip.
 */
export type BodyTextFetcher = (uids: readonly number[]) => Promise<TextBodies>;

export interface BackfillResult {
  embedded: number;
  remaining: number;
  /** Messages that contributed body chunks, not just an envelope. */
  bodiesIndexed: number;
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
  fetchBodies?: BodyTextFetcher,
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
  let bodiesIndexed = 0;
  let left = budget;
  let bodiesAvailable = fetchBodies !== undefined;

  const startedEmpty = fromUid === 0 && toUid === 0;

  /**
   * Give up on bodies for the rest of the run once the server proves it will
   * not serve parts. Retrying per batch would cost a failed round-trip for
   * every batch; falling back to full RFC822 would restore the 80x transfer
   * this whole path exists to avoid. Envelopes still index, so search
   * degrades to its previous behaviour rather than failing.
   */
  const runBatch = async (rows: Email[]): Promise<void> => {
    let bodies: TextBodies = { texts: new Map(), expected: 0 };
    if (bodiesAvailable && fetchBodies) {
      bodies = await fetchBodies(rows.map((r) => r.uid));
      if (bodies.expected > 0 && bodies.texts.size === 0) {
        bodiesAvailable = false;
        log.warn('server returned no body parts - indexing envelopes only', { folder });
      }
    }
    bodiesIndexed += bodies.texts.size;
    await embedBatch(db, folder, rows, cfg, bodies.texts);
  };

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
      await runBatch(rows);
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
      await runBatch(rows);
      widenRange(rows);
      embedded += rows.length;
      left -= rows.length;
    }
  }

  return {
    embedded,
    bodiesIndexed,
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
  bodies: Map<number, string>,
): Promise<void> {
  const texts: string[] = [];
  const owners: Omit<VectorRow, 'vector'>[] = [];

  for (const row of rows) {
    texts.push(envelopeText(row));
    owners.push({ uid: row.uid, part: ENVELOPE_PART, date: row.date });

    const body = bodies.get(row.uid);
    if (body === undefined) continue;
    for (const [i, chunk] of bodyChunks(body, row.subject).entries()) {
      texts.push(chunk);
      owners.push({ uid: row.uid, part: i + 1, date: row.date });
    }
  }

  const vectors = await embedTexts(texts, cfg);

  const toInsert: VectorRow[] = [];
  for (const [i, owner] of owners.entries()) {
    const vector = vectors[i];
    if (vector === undefined) {
      throw new EmbeddingError(
        'EMBEDDING_UNREACHABLE',
        `The embeddings endpoint returned ${vectors.length} vectors for ${owners.length} texts.`,
      );
    }
    toInsert.push({ ...owner, vector });
  }

  insertVectors(db, folder, toInsert);
}
