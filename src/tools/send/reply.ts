import { z } from 'zod';
import { defineTool, type ToolContext } from '../define-tool';
import { buildRawMessage } from '../../imap/mime-builder';
import { ensureEnvelopeCached } from '../emails/shared';
import { applyFlags } from '../emails/flags';
import { flattenCompose, sendRawAndAppendSent } from './shared';
import { AddressList, AttachmentList, toMessageAttachments } from '../compose-schema';

const Input = z.object({
  folder: z.string().min(1).describe('Folder of the original message.'),
  uid: z.number().int().positive().describe('UID of the message being replied to.'),
  body: z.string().optional(),
  html: z.string().optional(),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  reply_all: z
    .boolean()
    .default(false)
    .describe(
      'When true, CC the original To + Cc recipients (minus the sender). When false, reply only to the original From.',
    ),
  from: z.string().min(1).optional(),
  max_staleness_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Serve from cache if the folder was synced within this many seconds. Defaults to IMAP_CACHE_DEFAULT_STALENESS_SEC.',
    ),
  attachments: AttachmentList,
  mark_answered: z
    .boolean()
    .default(true)
    .describe(
      'Set \\Answered on the original after sending, so the thread shows as replied in the user mail client. Never fails the send - problems are reported in mark_answered_error.',
    ),
});

export const replyTool = defineTool({
  name: 'imap_reply',
  description:
    'Reply to an existing message. Preserves threading headers (In-Reply-To, References) so the reply shows up in the same conversation. Subject gets a "Re: " prefix if not already present. `reply_all` toggles whether to CC the original To+Cc list.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: Input,
  handler: async (args, ctx) => {
    const original = await ensureEnvelopeCached(
      ctx,
      args.folder,
      args.uid,
      args.max_staleness_seconds,
    );
    const parsedEnvelope: ParsedEnvelope = JSON.parse(original.envelopeJson) as ParsedEnvelope;

    const to = original.fromAddr !== null ? [original.fromAddr] : [];
    const autoCc = args.reply_all ? buildReplyAllCc(parsedEnvelope, ctx.defaults.fromAddress) : [];
    const explicitCc = args.cc !== undefined ? flattenCompose({ to: '_', cc: args.cc }).cc : [];
    const cc = dedupeAddrs([...autoCc, ...explicitCc], new Set(to));
    const bcc = args.bcc !== undefined ? flattenCompose({ to: '_', bcc: args.bcc }).bcc : [];
    const from = args.from ?? ctx.defaults.fromAddress;

    const subject = prefixSubject(original.subject ?? '', 'Re: ');
    const references = mergeReferences(
      await fetchReferencesHeader(ctx, args.folder, args.uid),
      parsedEnvelope.messageId,
    );
    const attachments = toMessageAttachments(args.attachments);

    const raw = await buildRawMessage({
      from,
      to,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
      subject,
      ...(args.body !== undefined && { text: args.body }),
      ...(args.html !== undefined && { html: args.html }),
      ...(parsedEnvelope.messageId !== undefined && {
        inReplyTo: parsedEnvelope.messageId,
      }),
      ...(references.length > 0 && { references }),
      ...(attachments !== undefined && { attachments }),
    });

    const envelope: { from: string; to: string[]; cc?: string[]; bcc?: string[] } = {
      from,
      to,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
    };
    const result = await sendRawAndAppendSent(ctx, raw, envelope);

    // Best-effort, exactly like the Sent-folder append: the reply is already
    // delivered, and reporting a flag stumble as a failure would make the
    // caller send it twice.
    let originalMarkedAnswered = false;
    let markAnsweredError: string | null = null;
    if (args.mark_answered) {
      try {
        originalMarkedAnswered = await applyFlags(ctx, args.folder, [args.uid], {
          add: ['\\Answered'],
        });
        if (!originalMarkedAnswered) {
          markAnsweredError = `Server did not apply \\Answered to UID ${String(args.uid)} in ${args.folder}.`;
        }
      } catch (err) {
        markAnsweredError = err instanceof Error ? err.message : String(err);
      }
    }

    const summary = `Replied to "${original.subject ?? '(no subject)'}" (UID ${String(args.uid)}). Sent to ${to.join(', ')}${cc.length > 0 ? `, cc: ${cc.join(', ')}` : ''}.`;

    return {
      content: [
        {
          type: 'text',
          text:
            markAnsweredError !== null
              ? `${summary} Warning: could not mark the original as answered: ${markAnsweredError}`
              : summary,
        },
      ],
      structuredContent: {
        from,
        to,
        cc,
        bcc,
        subject,
        in_reply_to: parsedEnvelope.messageId ?? null,
        references,
        message_id: result.messageId,
        sent_folder: result.sentFolder,
        sent_save_error: result.sentSaveError,
        original_marked_answered: originalMarkedAnswered,
        mark_answered_error: markAnsweredError,
      },
    };
  },
});

interface ParsedEnvelope {
  messageId?: string;
  inReplyTo?: string;
  subject?: string;
  from?: { address?: string; name?: string }[];
  to?: { address?: string; name?: string }[];
  cc?: { address?: string; name?: string }[];
}

function buildReplyAllCc(env: ParsedEnvelope, excludeSelf: string): string[] {
  const out: string[] = [];
  for (const pool of [env.to ?? [], env.cc ?? []]) {
    for (const entry of pool) {
      if (entry.address && entry.address.toLowerCase() !== excludeSelf.toLowerCase()) {
        out.push(entry.address);
      }
    }
  }
  return out;
}

function prefixSubject(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase().trim())
    ? trimmed
    : `${prefix}${trimmed}`;
}

/**
 * The IMAP envelope carries In-Reply-To but not References, so the chain has
 * to come from the header itself. A failure here costs correct threading in
 * the recipient's client; failing the reply would cost the reply. Returns
 * null and lets the caller fall back to the parent Message-ID alone.
 */
async function fetchReferencesHeader(
  ctx: ToolContext,
  folder: string,
  uid: number,
): Promise<string | null> {
  try {
    const imap = await ctx.imap.connection();
    const lock = await imap.getMailboxLock(folder);
    try {
      const msg = await imap.fetchOne(String(uid), { headers: ['references'] }, { uid: true });
      return msg && msg.headers ? msg.headers.toString('utf8') : null;
    } finally {
      lock.release();
    }
  } catch {
    return null;
  }
}

const REFERENCES_CAP = 20;

/**
 * Build the References chain for a reply: the parent's own chain plus the
 * parent's Message-ID last, per RFC 5322 §3.6.4. Over the cap, the root is
 * kept and the most recent entries trimmed to it - the root is what clients
 * thread on, the middle is what they can afford to lose.
 */
export function mergeReferences(
  headerValue: string | null,
  parentMessageId: string | undefined,
  cap: number = REFERENCES_CAP,
): string[] {
  const existing = headerValue?.match(/<[^<>]+>/g) ?? [];
  const refs = [...existing];
  if (parentMessageId !== undefined && !refs.includes(parentMessageId)) {
    refs.push(parentMessageId);
  }
  if (refs.length <= cap) return refs;
  return [refs[0]!, ...refs.slice(refs.length - (cap - 1))];
}

function dedupeAddrs(addrs: string[], exclude: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (seen.has(key) || exclude.has(a) || exclude.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
