import { ImapError, SmtpError, McpInboxError, type ErrorCode } from './types.js';

/**
 * Convert raw IMAP/SMTP driver errors into actionable McpInboxError instances.
 * The returned `userMessage` is safe to surface to the MCP client — no host,
 * port, or credentials leak through.
 */
export function mapImapError(err: unknown): ImapError {
  if (err instanceof ImapError) return err;

  const message = errorMessage(err);
  const code = errorCode(err);
  const lower = message.toLowerCase();

  if (code === 'ENOTFOUND' || lower.includes('getaddrinfo')) {
    return new ImapError(
      'IMAP_HOST_UNREACHABLE',
      'Cannot resolve the IMAP host. Verify IMAP_HOST is spelled correctly.',
      err,
    );
  }

  if (code === 'ECONNREFUSED') {
    return new ImapError(
      'IMAP_CONNECTION_REFUSED',
      'Connection refused by the IMAP server. Check IMAP_PORT (993 for TLS, 143 for STARTTLS).',
      err,
    );
  }

  if (code === 'ETIMEDOUT' || lower.includes('timeout')) {
    return new ImapError(
      'IMAP_TIMEOUT',
      'The IMAP server did not respond in time. Check your network or increase IMAP_AUTH_TIMEOUT_MS.',
      err,
    );
  }

  if (
    code === 'AUTHENTICATIONFAILED' ||
    code === 'EAUTH' ||
    lower.includes('invalid credentials') ||
    lower.includes('authentication failed') ||
    lower.includes('auth failed') ||
    lower.includes('login failed')
  ) {
    return new ImapError(
      'IMAP_AUTH_FAILED',
      'IMAP authentication failed. For Gmail/Outlook use an app password, not your account password. Gmail app passwords: https://myaccount.google.com/apppasswords',
      err,
    );
  }

  if (lower.includes('mailbox does not exist') || lower.includes("doesn't exist")) {
    return new ImapError(
      'IMAP_FOLDER_NOT_FOUND',
      'Folder not found on the server. Run imap_list_folders to see available folders.',
      err,
    );
  }

  if (lower.includes('uidvalidity')) {
    return new ImapError(
      'IMAP_UIDVALIDITY_CHANGED',
      'The folder was rebuilt on the server; cached UIDs are no longer valid. The cache will resync automatically — retry the operation.',
      err,
    );
  }

  return new ImapError('IMAP_UNKNOWN', 'IMAP operation failed. See server logs for details.', err);
}

export function mapSmtpError(err: unknown): SmtpError {
  if (err instanceof SmtpError) return err;

  const message = errorMessage(err);
  const code = errorCode(err);
  const lower = message.toLowerCase();

  if (
    code === 'EAUTH' ||
    lower.includes('invalid login') ||
    lower.includes('authentication failed') ||
    lower.includes('auth failed')
  ) {
    return new SmtpError(
      'SMTP_AUTH_FAILED',
      'SMTP authentication failed. If you set SMTP_USER/SMTP_PASSWORD, verify them; otherwise the IMAP credentials are reused.',
      err,
    );
  }

  if (
    code === 'ECONNECTION' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EENVELOPE' ||
    lower.includes('cannot connect') ||
    lower.includes('could not connect') ||
    lower.includes('connection refused')
  ) {
    return new SmtpError(
      'SMTP_SEND_FAILED',
      'Could not connect to the SMTP server. Check SMTP_HOST / SMTP_PORT. Outlook requires SMTP_PORT=587 and SMTP_SECURE=false.',
      err,
    );
  }

  return new SmtpError('SMTP_UNKNOWN', 'SMTP send failed. See server logs for details.', err);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // Duck-type: some IMAP/SMTP drivers throw plain `{ message, code }` objects.
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

export function isMcpInboxError(err: unknown): err is McpInboxError {
  return err instanceof McpInboxError;
}

export function errorCodeOf(err: unknown): ErrorCode {
  return isMcpInboxError(err) ? err.code : 'INTERNAL';
}
