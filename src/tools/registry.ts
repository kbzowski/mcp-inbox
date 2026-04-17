import { z } from 'zod';
import type { ToolDefinition } from './define-tool';
import { listFoldersTool } from './folders/list-folders';
import { listEmailsTool } from './emails/list-emails';
import { getEmailTool } from './emails/get-email';
import { searchEmailsTool } from './emails/search-emails';
import { markReadTool, markUnreadTool } from './emails/mark-read';
import { moveToFolderTool } from './emails/move-to-folder';
import { deleteEmailTool } from './emails/delete-email';
import { listDraftsTool } from './drafts/list-drafts';
import { getDraftTool } from './drafts/get-draft';
import { createDraftTool } from './drafts/create-draft';
import { updateDraftTool } from './drafts/update-draft';
import { sendEmailTool } from './send/send-email';
import { sendDraftTool } from './send/send-draft';
import { replyTool } from './send/reply';
import { forwardTool } from './send/forward';
import { getAttachmentTool } from './attachments/get-attachment';

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
  // Attachments
  getAttachmentTool,
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
