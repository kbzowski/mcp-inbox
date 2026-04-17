import { resolve } from 'node:path';
import { openCache, type CacheHandle } from '@/cache/db';
import { ImapClient } from '@/imap/client';
import { SmtpClient } from '@/smtp/client';
import type { ToolContext } from '@/tools/define-tool';

const MIGRATIONS = resolve(process.cwd(), 'src/cache/migrations');

export interface IntegrationHarness {
  ctx: ToolContext;
  cache: CacheHandle;
  tearDown: () => Promise<void>;
}

/**
 * Build a ToolContext wired to the GreenMail container that globalSetup
 * spun up. Each test gets an isolated :memory: cache so the DB state
 * doesn't leak between tests.
 *
 * Call tearDown in the test's afterEach/afterAll to close the cache +
 * IMAP + SMTP connections - otherwise vitest hangs waiting for them.
 */
export function buildHarness(): IntegrationHarness {
  const host = requireEnv('GREENMAIL_HOST');
  const imapPort = Number(requireEnv('GREENMAIL_IMAP_PORT'));
  const smtpPort = Number(requireEnv('GREENMAIL_SMTP_PORT'));

  const imapConfig = {
    user: 'test',
    password: 'test',
    host,
    port: imapPort,
    tls: false,
    tlsRejectUnauthorized: false,
    authTimeoutMs: 5_000,
  };

  const smtpConfig = {
    host,
    port: smtpPort,
    secure: false,
    // GreenMail was configured with `-Dgreenmail.users=test:test@localhost`
    // which creates a user whose auth username is "test" (not the full
    // email address). SMTP AUTH PLAIN fails against the email-address
    // form with 535 5.7.8.
    user: 'test',
    password: 'test',
  };

  const cache = openCache(':memory:', MIGRATIONS);
  const imap = new ImapClient(imapConfig);
  const smtp = new SmtpClient(smtpConfig);

  const ctx: ToolContext = {
    db: cache.db,
    imap,
    smtp,
    cacheConfig: {
      enabled: true,
      dir: '/tmp/mcp-inbox-test',
      eagerBodyCache: false,
      defaultStalenessSec: 60,
      retainDays: 365,
    },
    defaults: {
      fromAddress: 'test@localhost',
    },
    now: () => Date.now(),
  };

  return {
    ctx,
    cache,
    tearDown: async () => {
      await imap.close();
      smtp.close();
      cache.close();
    },
  };
}

/**
 * True if the container is up and integration tests should run. False
 * when globalSetup skipped because Docker wasn't reachable - in that
 * case test suites can short-circuit with `it.skipIf` to keep CI green.
 */
/**
 * GreenMail creates only INBOX by default. Real providers expose
 * Drafts / Sent / Trash via SPECIAL-USE or a name-probe fallback, so
 * tests need those folders to exist before tools like delete_email
 * (which auto-resolves \Trash) can work. Idempotent - ALREADYEXISTS
 * responses are swallowed.
 */
export async function ensureTestFolders(harness: IntegrationHarness): Promise<void> {
  const imap = await harness.ctx.imap.connection();
  for (const folder of ['Drafts', 'Sent', 'Trash']) {
    try {
      await imap.mailboxCreate(folder);
    } catch {
      // Either the folder already exists or creation is not permitted -
      // both acceptable; the downstream tools will surface a clearer
      // error if the folder is genuinely missing.
    }
  }
}

export function greenmailAvailable(): boolean {
  return (
    typeof process.env.GREENMAIL_HOST === 'string' &&
    typeof process.env.GREENMAIL_IMAP_PORT === 'string'
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set - GreenMail setup did not run`);
  return v;
}
