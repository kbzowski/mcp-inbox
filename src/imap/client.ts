import { ImapFlow, type ListResponse } from 'imapflow';
import type { AppConfig } from '../config/env';
import { mapImapError } from '../errors/mapper';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:imap');

/**
 * Build and connect an ImapFlow instance from the env-level IMAP config.
 * Callers decide whether to hold it long-lived (via ImapClient below) or
 * dedicate it to a single purpose such as IDLE watching a folder.
 *
 * Driver errors are mapped to ImapError so auth and DNS failures surface
 * with actionable messages instead of raw driver output.
 */
export async function createImapConnection(config: AppConfig['imap']): Promise<ImapFlow> {
  log.info('opening IMAP connection', {
    host: config.host,
    port: config.port,
    tls: config.tls,
  });

  const flow = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: {
      user: config.user,
      pass: config.password,
    },
    ...(config.tls && !config.tlsRejectUnauthorized ? { tls: { rejectUnauthorized: false } } : {}),
    // We own the logger; mute ImapFlow's built-in console logger.
    logger: false,
    // Our own timeout policy.
    connectionTimeout: config.authTimeoutMs,
    greetingTimeout: config.authTimeoutMs,
  });

  flow.on('error', (err: unknown) => {
    log.error('IMAP connection error', {
      msg: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    await flow.connect();
  } catch (err) {
    throw mapImapError(err);
  }

  log.info('IMAP connection ready');
  return flow;
}

/**
 * Thin connection manager over ImapFlow.
 *
 * Responsibilities:
 *  - Own one long-lived connection for the process lifetime (avoid
 *    per-tool-call TLS handshake + LOGIN round trips, which some providers
 *    rate-limit at ~15 LOGIN/min per account).
 *  - Reconnect transparently when the connection drops (NAT timeouts,
 *    server restarts, network hiccups).
 *  - Map driver-level errors into actionable `ImapError` instances via
 *    `errors/mapper.ts` - callers never see raw ImapFlow errors.
 *  - Tear down cleanly on SIGINT/SIGTERM via `close()`.
 */
export class ImapClient {
  #config: AppConfig['imap'];
  #flow: ImapFlow | null = null;
  #connecting: Promise<ImapFlow> | null = null;
  #closed = false;
  #folderList: { at: number; rows: ListResponse[] } | null = null;

  constructor(config: AppConfig['imap']) {
    this.#config = config;
  }

  /**
   * Returns an authenticated ImapFlow instance, connecting if necessary.
   * Multiple concurrent callers share the same in-flight connection attempt.
   */
  async connection(): Promise<ImapFlow> {
    if (this.#closed) {
      throw new Error('ImapClient has been closed');
    }
    if (this.#flow?.usable) {
      return this.#flow;
    }
    if (this.#connecting) {
      return this.#connecting;
    }

    this.#connecting = this.#openConnection();
    try {
      this.#flow = await this.#connecting;
      return this.#flow;
    } finally {
      this.#connecting = null;
    }
  }

  /**
   * The mailbox list, cached for `maxAgeMs`. Resolving \Drafts / \Sent /
   * \Trash needs it on every send, draft and delete, and a LIST is a network
   * round-trip whose answer almost never changes. A newly created folder
   * shows up within the window; `imap_list_folders` bypasses this entirely,
   * so an explicit "what folders do I have" is always current.
   */
  async folderList(maxAgeMs = 60_000): Promise<ListResponse[]> {
    const cached = this.#folderList;
    if (cached && Date.now() - cached.at < maxAgeMs) {
      return cached.rows;
    }
    const flow = await this.connection();
    const rows = await flow.list();
    this.#folderList = { at: Date.now(), rows };
    return rows;
  }

  async #openConnection(): Promise<ImapFlow> {
    const flow = await createImapConnection(this.#config);

    // Surface disconnects so the next `.connection()` call reconnects.
    flow.on('close', () => {
      if (!this.#closed) {
        log.warn('IMAP connection closed unexpectedly');
      }
      // Marking null lets the next `connection()` call rebuild.
      if (this.#flow === flow) {
        this.#flow = null;
      }
    });

    return flow;
  }

  /**
   * Cleanly close the connection. Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const flow = this.#flow;
    this.#flow = null;
    if (flow?.usable) {
      try {
        await flow.logout();
      } catch (err) {
        log.warn('error during IMAP logout', {
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
