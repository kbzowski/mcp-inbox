import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/env.js';
import { createMcpServer } from './server.js';
import { configureLogger, rootLogger } from './utils/logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  configureLogger({ debug: config.debug, level: 'info' });
  rootLogger.info('booting mcp-inbox', {
    imapHost: config.imap.host,
    cacheEnabled: config.cache.enabled,
    idleFolders: config.idle.folders,
  });

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
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

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(transport);
  rootLogger.info('mcp-inbox ready');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
