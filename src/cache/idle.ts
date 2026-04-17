import type { ImapFlow, ExistsEvent, ExpungeEvent, FlagsEvent } from 'imapflow';
import type { AppConfig } from '../config/env';
import type { CacheDb } from './db';
import { createImapConnection } from '../imap/client';
import { syncFolder } from './sync';
import { deleteEmail, setEmailFlags } from './queries';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:idle');

/**
 * One held-open IMAP connection per watched folder. IMAP's SELECT is
 * single-mailbox, so watching N folders needs N connections.
 *
 * Server-side events drive cache updates:
 *  - `exists` triggers an incremental sync (CONDSTORE makes this cheap).
 *  - `flags` updates the cached row directly if we got a UID, otherwise
 *    re-syncs the folder.
 *  - `expunge` deletes the cached row if we got a UID, otherwise re-syncs.
 *
 * ImapFlow handles the auto-re-IDLE loop internally; callers only need
 * to `mailboxOpen(path)` and subscribe to events.
 */
export interface IdleSubscription {
  folder: string;
  stop: () => Promise<void>;
}

export interface IdleManagerOptions {
  imap: AppConfig['imap'];
  db: CacheDb;
  folders: readonly string[];
}

export class IdleManager {
  #opts: IdleManagerOptions;
  #subscriptions: IdleSubscription[] = [];
  #stopped = false;

  constructor(opts: IdleManagerOptions) {
    this.#opts = opts;
  }

  /** Open a watching connection per configured folder. Idempotent. */
  async start(): Promise<void> {
    if (this.#subscriptions.length > 0 || this.#stopped) return;

    for (const folder of this.#opts.folders) {
      try {
        const sub = await this.#watchFolder(folder);
        this.#subscriptions.push(sub);
      } catch (err) {
        // Failing to watch one folder must not kill the whole process -
        // the cache still works, just without push updates for that folder.
        log.error('failed to open IDLE for folder', {
          folder,
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Release every watching connection. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const subs = this.#subscriptions;
    this.#subscriptions = [];
    await Promise.all(subs.map((s) => s.stop()));
  }

  async #watchFolder(folder: string): Promise<IdleSubscription> {
    const imap = await createImapConnection(this.#opts.imap);
    await imap.mailboxOpen(folder);
    log.info('watching folder', { folder });

    const onExists = (e: ExistsEvent): void => {
      log.debug('exists event', { folder: e.path, count: e.count, prevCount: e.prevCount });
      void this.#handleExists(folder, imap);
    };

    const onFlags = (e: FlagsEvent): void => {
      log.debug('flags event', { folder: e.path, uid: e.uid, flags: Array.from(e.flags) });
      if (e.uid !== undefined) {
        setEmailFlags(this.#opts.db, folder, e.uid, Array.from(e.flags));
      } else {
        void this.#resyncFolder(folder, imap);
      }
    };

    const onExpunge = (e: ExpungeEvent): void => {
      log.debug('expunge event', { folder: e.path, uid: e.uid, seq: e.seq });
      if (e.uid !== undefined) {
        deleteEmail(this.#opts.db, folder, e.uid);
      } else {
        // Without a UID we can't delete precisely - trigger a resync so
        // the sync algorithm reconciles against the server.
        void this.#resyncFolder(folder, imap);
      }
    };

    imap.on('exists', onExists);
    imap.on('flags', onFlags);
    imap.on('expunge', onExpunge);

    return {
      folder,
      stop: async () => {
        imap.off('exists', onExists);
        imap.off('flags', onFlags);
        imap.off('expunge', onExpunge);
        try {
          await imap.logout();
        } catch (err) {
          log.warn('error closing IDLE connection', {
            folder,
            msg: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
  }

  async #handleExists(folder: string, imap: ImapFlow): Promise<void> {
    try {
      await syncFolder({ db: this.#opts.db, imap }, folder);
    } catch (err) {
      log.error('exists sync failed', {
        folder,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #resyncFolder(folder: string, imap: ImapFlow): Promise<void> {
    try {
      await syncFolder({ db: this.#opts.db, imap }, folder);
    } catch (err) {
      log.error('resync failed', {
        folder,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
