import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type AppConfig } from './config/env';
import { openCache } from './cache/db';
import { IdleManager } from './cache/idle';
import { ImapClient } from './imap/client';
import { SmtpClient } from './smtp/client';
import { createMcpServer } from './server';
import type { ToolContext } from './tools/define-tool';
import { configureLogger, rootLogger } from './utils/logger';

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

try {
  const config = loadConfigOrExit();

  configureLogger({ debug: config.debug, level: 'info' });
  rootLogger.info('booting mcp-inbox', {
    imapHost: config.imap.host,
    cacheEnabled: config.cache.enabled,
    cacheDir: config.cache.dir,
    idleEnabled: config.idle.enabled,
    idleFolders: config.idle.folders,
  });

  const cache = openCache(join(config.cache.dir, 'cache.db'));
  const imapClient = new ImapClient(config.imap);
  const smtpClient = new SmtpClient(config.smtp);

  const ctx: ToolContext = {
    db: cache.db,
    imap: imapClient,
    smtp: smtpClient,
    cacheConfig: config.cache,
    defaults: {
      fromAddress: config.imap.user,
    },
    now: () => Date.now(),
  };

  const idleManager =
    config.idle.enabled && config.idle.folders.length > 0
      ? new IdleManager({
          imap: config.imap,
          db: cache.db,
          folders: config.idle.folders,
        })
      : null;

  // IDLE startup is deliberately fire-and-forget. The manager handles its
  // own errors (one failing folder doesn't block the others), and the MCP
  // server should accept requests even if every IDLE connection is down.
  if (idleManager) {
    void idleManager.start();
  }

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info('shutting down', { signal });
    try {
      await server.close();
    } catch (err) {
      rootLogger.error('error closing MCP server', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      if (idleManager) await idleManager.stop();
    } catch (err) {
      rootLogger.error('error stopping IDLE manager', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await imapClient.close();
    } catch (err) {
      rootLogger.error('error closing IMAP client', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    smtpClient.close();
    cache.close();
    process.exit(0);
  };

  const onSignal = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`shutdown failed: ${msg}\n`);
      process.exit(1);
    });
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await server.connect(transport);
  rootLogger.info('mcp-inbox ready');
} catch (err) {
  // Print the top-level message + stack, then walk and print the `cause`
  // chain. The immediate message is the actionable hint we produce (e.g.
  // "better-sqlite3 native binding failed to load"); the cause chain
  // shows the raw driver error underneath it so debugging is possible
  // without having to re-run under DEBUG=mcp-inbox:*.
  const top = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${top}\n`);
  let cause: unknown = err instanceof Error ? err.cause : undefined;
  let depth = 0;
  while (cause instanceof Error && depth < 5) {
    process.stderr.write(`caused by: ${cause.stack ?? cause.message}\n`);
    cause = cause.cause;
    depth++;
  }
  process.exit(1);
}
