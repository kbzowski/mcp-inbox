import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isMcpInboxError } from './errors/mapper.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('mcp-inbox:server');

/**
 * Creates the MCP Server instance and wires request handlers.
 *
 * The ListTools and CallTool handlers delegate to the tool registry (added in
 * Phase 5). This stub registers zero tools so the process can boot cleanly and
 * respond to the MCP handshake - useful for smoke-testing the scaffolding.
 */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'mcp-inbox',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: [] };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const toolName = request.params.name;
    log.warn('tool call with no tools registered', { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${toolName}. Tool registry is not yet initialized.`,
        },
      ],
    };
  });

  server.onerror = (err: unknown) => {
    const meta = isMcpInboxError(err)
      ? { code: err.code, msg: err.userMessage }
      : { msg: err instanceof Error ? err.message : String(err) };
    log.error('mcp server error', meta);
  };

  return server;
}
