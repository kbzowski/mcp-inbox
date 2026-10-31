import type { CacheDb } from './db';
import type { ImapClient } from '../imap/client';
import type { EmbeddingsConfig } from '../config/env';
import { backfillFolder } from './backfill';
import { ensureVecTable, indexedFolders } from './vectors';
import { syncFolder } from './sync';
import { bodyFetcherFor } from '../imap/body-text';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:indexer');

export interface IndexSweeperOptions {
  db: CacheDb;
  imap: ImapClient;
  cfg: EmbeddingsConfig;
  intervalMs: number;
  /** Messages embedded per tick, across all folders. */
  budgetPerTick: number;
  now: () => number;
}

export interface SweepResult {
  folders: number;
  embedded: number;
}

/**
 * Keeps every opted-in folder's vector index current in the background.
 *
 * Without this, a folder is only topped up when someone searches it, so
 * folders you rarely search drift silently out of date. Search itself stays a
 * pure reader: freshness has exactly one owner.
 */
export class IndexSweeper {
  #opts: IndexSweeperOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #stopped = false;

  constructor(opts: IndexSweeperOptions) {
    this.#opts = opts;
  }

  start(): void {
    if (this.#timer !== null || this.#stopped || this.#opts.intervalMs <= 0) return;
    this.#timer = setInterval(() => {
      void this.sweepOnce();
    }, this.#opts.intervalMs);
    // Never hold the process open for a background refresh.
    this.#timer.unref();
    log.info('background index sweeper started', { everyMs: this.#opts.intervalMs });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * One pass over the indexed folders. Never rejects: this runs detached from
   * any request, so an escaping error would be an unhandled rejection.
   */
  async sweepOnce(): Promise<SweepResult> {
    if (this.#running || this.#stopped) return { folders: 0, embedded: 0 };
    this.#running = true;

    let embedded = 0;
    let visited = 0;
    let budget = this.#opts.budgetPerTick;

    try {
      // Without this, a model change would mix new vectors into the old
      // table and the watermark would then mark that mixture as current,
      // so no later rebuild would ever fire.
      ensureVecTable(this.#opts.db, this.#opts.cfg.model, this.#opts.cfg.dims);

      for (const folder of indexedFolders(this.#opts.db)) {
        if (budget <= 0 || this.#stopped) break;
        visited++;
        try {
          const imap = await this.#opts.imap.connection();
          await syncFolder({ db: this.#opts.db, imap }, folder);

          const result = await backfillFolder(
            this.#opts.db,
            folder,
            this.#opts.cfg,
            budget,
            'newer',
            this.#opts.now,
            bodyFetcherFor(this.#opts.imap, folder),
          );
          embedded += result.embedded;
          budget -= result.embedded;
        } catch (err) {
          log.warn('sweep failed for folder', {
            folder,
            msg: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn('sweep aborted', { msg: err instanceof Error ? err.message : String(err) });
    } finally {
      this.#running = false;
    }

    if (embedded > 0) log.info('background index sweep', { folders: visited, embedded });
    return { folders: visited, embedded };
  }
}
