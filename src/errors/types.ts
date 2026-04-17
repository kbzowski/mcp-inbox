/**
 * Error hierarchy for mcp-inbox.
 *
 * - `McpInboxError` is the base; every error we throw should extend it.
 * - `code` is a stable machine identifier (never change).
 * - `userMessage` is the human-readable, actionable message returned to the
 *   MCP client. Never leak raw server output or credentials into this field.
 * - `cause` preserves the original error for logging/debugging.
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
  override readonly cause: unknown;

  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = 'McpInboxError';
    this.code = code;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

export class ImapError extends McpInboxError {
  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(code, userMessage, cause);
    this.name = 'ImapError';
  }
}

export class SmtpError extends McpInboxError {
  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(code, userMessage, cause);
    this.name = 'SmtpError';
  }
}

export class CacheError extends McpInboxError {
  constructor(code: ErrorCode, userMessage: string, cause?: unknown) {
    super(code, userMessage, cause);
    this.name = 'CacheError';
  }
}

export class ToolInputError extends McpInboxError {
  constructor(userMessage: string, cause?: unknown) {
    super('TOOL_INVALID_INPUT', userMessage, cause);
    this.name = 'ToolInputError';
  }
}
