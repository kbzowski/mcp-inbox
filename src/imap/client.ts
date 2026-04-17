import { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config/env.js';
import { mapImapError } from '../errors/mapper.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-inbox:imap');

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
 *    `errors/mapper.ts` — callers never see raw ImapFlow errors.
 *  - Tear down cleanly on SIGINT/SIGTERM via `close()`.
 */
export class ImapClient {
  #config: AppConfig['imap'];
  #flow: ImapFlow | null = null;
  #connecting: Promise<ImapFlow> | null = null;
  #closed = false;

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

  async #openConnection(): Promise<ImapFlow> {
    log.info('opening IMAP connection', {
      host: this.#config.host,
      port: this.#config.port,
      tls: this.#config.tls,
    });

    const flow = new ImapFlow({
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.tls,
      auth: {
        user: this.#config.user,
        pass: this.#config.password,
      },
      ...(this.#config.tls && !this.#config.tlsRejectUnauthorized
        ? { tls: { rejectUnauthorized: false } }
        : {}),
      // We own the logger; mute ImapFlow's built-in console logger.
      logger: false,
      // Our own timeout policy.
      connectionTimeout: this.#config.authTimeoutMs,
      greetingTimeout: this.#config.authTimeoutMs,
    });

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
