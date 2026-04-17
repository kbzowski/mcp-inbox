import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { isMcpInboxError } from './errors/mapper';
import { createLogger } from './utils/logger';
import type { ToolContext } from './tools/define-tool';
import { findTool, listToolEntries } from './tools/registry';

const log = createLogger('mcp-inbox:server');

/**
 * Create the MCP Server instance and wire its request handlers to the
 * tool registry. The `ctx` is captured in a closure so handlers can
 * resolve the live DB / IMAP / config without a hidden singleton.
 */
export function createMcpServer(ctx: ToolContext): Server {
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
    return { tools: listToolEntries() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = findTool(toolName);
    if (!tool) {
      log.warn('unknown tool', { tool: toolName });
      return errorResult(`Unknown tool: ${toolName}`);
    }

    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      log.warn('invalid tool args', { tool: toolName, issues });
      return errorResult(`Invalid arguments for ${toolName}: ${issues}`);
    }

    try {
      return (await tool.handler(parsed.data, ctx)) as CallToolResult;
    } catch (err) {
      if (isMcpInboxError(err)) {
        log.warn('tool returned mcp-inbox error', {
          tool: toolName,
          code: err.code,
          msg: err.userMessage,
        });
        return errorResult(err.userMessage);
      }
      log.error('tool handler threw', {
        tool: toolName,
        msg: err instanceof Error ? err.message : String(err),
      });
      return errorResult(`Internal error in ${toolName}. Check server logs for details.`);
    }
  });

  server.onerror = (err: unknown) => {
    const meta = isMcpInboxError(err)
      ? { code: err.code, msg: err.userMessage }
      : { msg: err instanceof Error ? err.message : String(err) };
    log.error('mcp server error', meta);
  };

  return server;
}

function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
