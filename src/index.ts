import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { openCache } from './cache/db.js';
import { IdleManager } from './cache/idle.js';
import { ImapClient } from './imap/client.js';
import { createMcpServer } from './server.js';
import type { ToolContext } from './tools/define-tool.js';
import { configureLogger, rootLogger } from './utils/logger.js';

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

  const ctx: ToolContext = {
    db: cache.db,
    imap: imapClient,
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
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
}
