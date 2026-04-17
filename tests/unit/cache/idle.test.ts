import { describe, it, expect } from 'vitest';
import { IdleManager } from '../../../src/cache/idle';
import { openCache } from '../../../src/cache/db';
import { resolve } from 'node:path';

/**
 * Integration behavior of IDLE needs a real IMAP server and lives with
 * the Phase 5 GreenMail tests. What can be unit-tested here is the
 * lifecycle surface: the manager must not connect when given zero
 * folders, and stop() must be idempotent and safe to call even when
 * start() was never invoked.
 */
const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

const dummyImapConfig = {
  user: 'test',
  password: 'unused',
  host: 'example.invalid',
  port: 993,
  tls: true,
  tlsRejectUnauthorized: true,
  authTimeoutMs: 1_000,
};

describe('IdleManager lifecycle', () => {
  it('start() with zero folders never opens a connection', async () => {
    const cache = openCache(':memory:', MIGRATIONS);
    try {
      const manager = new IdleManager({
        imap: dummyImapConfig,
        db: cache.db,
        folders: [],
      });

      // No folders means no network activity - this should not even
      // attempt to reach `example.invalid`. If it did, the test would
      // time out or fail DNS resolution long before this assertion.
      await manager.start();
      await manager.stop();
    } finally {
      cache.close();
    }
  });

  it('stop() is idempotent without start()', async () => {
    const cache = openCache(':memory:', MIGRATIONS);
    try {
      const manager = new IdleManager({
        imap: dummyImapConfig,
        db: cache.db,
        folders: ['INBOX'],
      });

      // start() was never called - stop() must still be safe.
      await manager.stop();
      // And calling stop() again must also be safe.
      await manager.stop();

      // A subsequent start() on a stopped manager is also a no-op.
      await manager.start();
      expect(true).toBe(true);
    } finally {
      cache.close();
    }
  });
});
