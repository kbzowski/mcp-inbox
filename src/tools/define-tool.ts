import type { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { CacheDb } from '../cache/db.js';
import type { ImapClient } from '../imap/client.js';

/**
 * Runtime context passed to every tool handler. Tools receive the live
 * DB handle, the shared IMAP client, and the cache config. They must
 * not hold onto these references past the call - the server owns
 * their lifetime.
 */
export interface ToolContext {
  db: CacheDb;
  imap: ImapClient;
  cacheConfig: AppConfig['cache'];
  /** Default sender + smtp config for tools that compose messages. */
  defaults: {
    fromAddress: string;
  };
  /** Injectable clock so tests can pin the time. */
  now: () => number;
}

/**
 * MCP annotation hints. These drive client-side behavior like
 * destructive-action confirmation dialogs. `openWorldHint: true` is
 * a constant for this server because every tool hits the network.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: true;
}

/**
 * Shape returned by a tool handler. Mirrors the MCP SDK's CallToolResult
 * but narrowed to text content plus optional structured data.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  /** Typed payload for clients that can consume it. Mirrors the text. */
  structuredContent?: unknown;
  /** Set when the tool returned an expected error (auth failure, etc). */
  isError?: boolean;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: TInput;
  handler: (args: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Identity helper that preserves the generic `TInput` through the
 * tool definition, so `handler` sees the correctly-typed args without
 * needing an explicit annotation at every call site.
 */
export function defineTool<TInput extends z.ZodTypeAny>(
  def: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  return def;
}
