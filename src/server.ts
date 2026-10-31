import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from '../package.json' with { type: 'json' };
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
      version: pkg.version,
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

    const started = Date.now();
    try {
      return (await tool.handler(parsed.data, ctx)) as CallToolResult;
    } catch (err) {
      const meta = {
        tool: toolName,
        durationMs: Date.now() - started,
        ...failureContext(parsed.data),
        err,
      };
      if (isMcpInboxError(err)) {
        log.warn('tool returned mcp-inbox error', meta);
        return errorResult(err.userMessage);
      }
      log.error('tool handler threw', meta);
      return errorResult(`Internal error in ${toolName}. Check server logs for details.`);
    }
  });

  server.onerror = (err: unknown) => {
    log.error('mcp server error', { err });
  };

  return server;
}

// Only which messages were targeted: other arguments carry bodies, addresses and queries.
function failureContext(args: unknown): Record<string, unknown> {
  const { folder, uid, uids, destination } = args as Record<string, unknown>;
  return { folder, uid, uidCount: Array.isArray(uids) ? uids.length : undefined, destination };
}

function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
