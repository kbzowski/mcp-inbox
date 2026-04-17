import type { ToolContext } from '../define-tool.js';
import { ToolInputError } from '../../errors/types.js';
import { resolveSpecialFolder } from '../emails/shared.js';

/**
 * Normalize an address field (which the Zod schema accepts as
 * `string | string[]`) to the flat string[] that SMTP envelope wants.
 */
export function normalizeAddrs(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Send a pre-built raw RFC 2822 message and (best-effort) append a copy
 * to the \Sent folder so the user's mail client shows it.
 *
 * SMTP failure is fatal and propagates up. Sent-folder append failure
 * logs a warning but does not fail the tool call - the message was
 * delivered; missing a backup copy is a minor degradation, not a bug
 * worth retrying or erroring on.
 */
export async function sendRawAndAppendSent(
  ctx: ToolContext,
  raw: Buffer,
  envelope: { from: string; to: string[]; cc?: string[]; bcc?: string[] },
): Promise<{
  messageId: string | null;
  sentFolder: string | null;
  sentSaveError: string | null;
}> {
  const envelopeTo = [...envelope.to, ...(envelope.cc ?? []), ...(envelope.bcc ?? [])];
  if (envelopeTo.length === 0) {
    throw new ToolInputError('Cannot send: no recipients (to/cc/bcc all empty).');
  }

  const sendInfo = await ctx.smtp.sendRaw(raw, {
    from: envelope.from,
    to: envelopeTo,
  });

  // Best-effort save to Sent. Don't fail the tool if this step fails.
  let sentFolder: string | null = null;
  let sentSaveError: string | null = null;
  try {
    sentFolder = await resolveSpecialFolder(ctx, '\\Sent');
    const imap = await ctx.imap.connection();
    await imap.append(sentFolder, raw, ['\\Seen']);
  } catch (err) {
    sentSaveError = err instanceof Error ? err.message : String(err);
    sentFolder = null;
  }

  return {
    messageId: sendInfo.messageId,
    sentFolder,
    sentSaveError,
  };
}

/**
 * Convenience helper for tools whose address fields are strings or
 * string arrays at the Zod schema level.
 */
export function flattenCompose(args: {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
}): {
  fromOrDefault: (defaultFrom: string) => string;
  to: string[];
  cc: string[];
  bcc: string[];
} {
  return {
    fromOrDefault: (d) => args.from ?? d,
    to: normalizeAddrs(args.to),
    cc: normalizeAddrs(args.cc),
    bcc: normalizeAddrs(args.bcc),
  };
}
