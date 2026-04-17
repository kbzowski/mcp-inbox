import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../config/env';
import { mapSmtpError } from '../errors/mapper';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:smtp');

/**
 * Thin SMTP client that lazily creates a nodemailer transporter on first
 * use. Reusing one transporter across calls saves the TLS handshake on
 * every message - same optimization as ImapClient does for IMAP.
 *
 * Kept deliberately minimal: no send queue, no retry logic. Failures
 * surface as SmtpError via the error mapper; callers decide what to do.
 */
export class SmtpClient {
  #config: AppConfig['smtp'];
  #transporter: Transporter | null = null;
  #closed = false;

  constructor(config: AppConfig['smtp']) {
    this.#config = config;
  }

  transporter(): Transporter {
    if (this.#closed) {
      throw new Error('SmtpClient has been closed');
    }
    if (this.#transporter) return this.#transporter;

    log.info('creating SMTP transporter', {
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.secure,
    });

    this.#transporter = nodemailer.createTransport({
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.secure,
      auth: {
        user: this.#config.user,
        pass: this.#config.password,
      },
    });
    return this.#transporter;
  }

  /**
   * Send a pre-built raw RFC 2822 message. Uses the explicit envelope
   * to avoid relying on header parsing - the envelope from/to are
   * what actually drive SMTP delivery.
   */
  async sendRaw(
    raw: Buffer,
    envelope: { from: string; to: string[] },
  ): Promise<{ messageId: string | null; response: string }> {
    try {
      // nodemailer's SentMessageInfo is typed `any`; narrow to just the
      // fields we actually read.
      const info: { messageId?: string; response?: string } = (await this.transporter().sendMail({
        envelope: {
          from: envelope.from,
          to: envelope.to,
        },
        raw,
      })) as { messageId?: string; response?: string };
      return {
        messageId: info.messageId ?? null,
        response: info.response ?? '',
      };
    } catch (err) {
      throw mapSmtpError(err);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#transporter?.close();
    } catch {
      // best-effort
    }
  }
}
