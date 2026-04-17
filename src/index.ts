import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { createMcpServer } from './server.js';
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
    idleFolders: config.idle.folders,
  });

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info('shutting down', { signal });
    try {
      await server.close();
    } catch (err) {
      rootLogger.error('error during shutdown', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  const onSignal = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      // shutdown() has its own try/catch; this handles anything that escapes.
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
