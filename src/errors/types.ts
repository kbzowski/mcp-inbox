/**
 * Error hierarchy for mcp-inbox.
 *
 * - `McpInboxError` is the base; every error we throw should extend it.
 * - `code` is a stable machine identifier (never change).
 * - `userMessage` is the human-readable, actionable message returned to the
 *   MCP client. Never leak raw server output or credentials into this field.
 * - `cause` is propagated via `Error`'s ES2022 `{ cause }` options object and
 *   inherited from the base class - no need to redeclare on subclasses.
 */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'IMAP_AUTH_FAILED'
  | 'IMAP_HOST_UNREACHABLE'
  | 'IMAP_CONNECTION_REFUSED'
  | 'IMAP_TIMEOUT'
  | 'IMAP_FOLDER_NOT_FOUND'
  | 'IMAP_MESSAGE_NOT_FOUND'
  | 'IMAP_UIDVALIDITY_CHANGED'
  | 'IMAP_UNKNOWN'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_SEND_FAILED'
  | 'SMTP_UNKNOWN'
  | 'CACHE_IO_FAILED'
  | 'CACHE_SCHEMA_MISMATCH'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_NOT_FOUND'
  | 'TOOL_INVALID_INPUT'
  | 'INTERNAL';

export class McpInboxError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;

  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(userMessage, cause !== undefined ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage;
    // Strips the base constructor frames from the stack trace.
    // Always available on V8 (Node 24).
    Error.captureStackTrace(this, new.target);
  }
}

export class ImapError extends McpInboxError {}

export class SmtpError extends McpInboxError {}

export class CacheError extends McpInboxError {}

export class ToolInputError extends McpInboxError {
  constructor(userMessage: string, cause?: unknown) {
    super('TOOL_INVALID_INPUT', userMessage, cause);
  }
}
