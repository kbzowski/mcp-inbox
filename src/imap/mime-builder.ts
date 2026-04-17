import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';

/**
 * Input shape for building a raw RFC 2822 message.
 *
 * This is a narrowed view of nodemailer's `Mail.Options` - we expose only
 * the fields the draft/reply/forward tools actually use. Nodemailer handles
 * RFC 2047 encoded-word for non-ASCII headers, RFC 5322 line folding,
 * multipart boundaries, and Message-ID generation automatically.
 */
export interface BuildMessageInput {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Threading headers - required for reply/forward. */
  inReplyTo?: string;
  references?: string | string[];
  /** Optional extra headers (e.g. X-Mailer). */
  headers?: Record<string, string>;
}

/**
 * Build a raw RFC 2822 message buffer, suitable for `IMAP APPEND` to the
 * Drafts folder, a Sent-folder backup after SMTP send, or any other
 * on-the-wire scenario that needs a parseable message.
 *
 * Never hand-roll this - non-ASCII subjects, international recipients,
 * and long bodies all have rules that are easy to get wrong. Reuse
 * nodemailer's battle-tested builder.
 */
export async function buildRawMessage(input: BuildMessageInput): Promise<Buffer> {
  const options: Mail.Options = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    ...(input.cc !== undefined && { cc: input.cc }),
    ...(input.bcc !== undefined && { bcc: input.bcc }),
    ...(input.text !== undefined && { text: input.text }),
    ...(input.html !== undefined && { html: input.html }),
    ...(input.inReplyTo !== undefined && { inReplyTo: input.inReplyTo }),
    ...(input.references !== undefined && { references: input.references }),
    ...(input.headers !== undefined && { headers: input.headers }),
  };

  const composer = new MailComposer(options);
  const message = composer.compile();
  return await message.build();
}
