import { z } from 'zod';
import type { ToolDefinition } from './define-tool.js';
import { listFoldersTool } from './folders/list-folders.js';
import { listEmailsTool } from './emails/list-emails.js';
import { getEmailTool } from './emails/get-email.js';
import { searchEmailsTool } from './emails/search-emails.js';
import { markReadTool, markUnreadTool } from './emails/mark-read.js';
import { moveToFolderTool } from './emails/move-to-folder.js';
import { deleteEmailTool } from './emails/delete-email.js';
import { listDraftsTool } from './drafts/list-drafts.js';
import { getDraftTool } from './drafts/get-draft.js';
import { createDraftTool } from './drafts/create-draft.js';
import { updateDraftTool } from './drafts/update-draft.js';
import { sendEmailTool } from './send/send-email.js';
import { sendDraftTool } from './send/send-draft.js';
import { replyTool } from './send/reply.js';
import { forwardTool } from './send/forward.js';

/**
 * Every tool that exists. Adding a tool means importing it here and
 * appending the reference. The MCP dispatcher iterates this array to
 * populate ListTools responses and to route CallTool requests - no
 * other wiring needed.
 */
export const tools: readonly ToolDefinition[] = [
  // Read
  listFoldersTool,
  listEmailsTool,
  getEmailTool,
  searchEmailsTool,
  listDraftsTool,
  getDraftTool,
  // Write (flag + move + delete)
  markReadTool,
  markUnreadTool,
  moveToFolderTool,
  deleteEmailTool,
  // Drafts (compose)
  createDraftTool,
  updateDraftTool,
  // Send (SMTP)
  sendEmailTool,
  sendDraftTool,
  replyTool,
  forwardTool,
];

export function findTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Shape each tool for the MCP ListTools response. `inputSchema` is a
 * JSON Schema derived from the tool's Zod schema - single source of
 * truth, no hand-written JSON Schema duplication.
 */
export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolDefinition['annotations'];
}

export function listToolEntries(): McpToolEntry[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, { target: 'draft-7' }) as Record<string, unknown>,
    annotations: t.annotations,
  }));
}
