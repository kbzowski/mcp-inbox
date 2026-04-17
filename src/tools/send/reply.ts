import { z } from 'zod';
import { defineTool } from '../define-tool';
import { buildRawMessage } from '../../imap/mime-builder';
import { ensureEnvelopeCached } from '../emails/shared';
import { flattenCompose, sendRawAndAppendSent } from './shared';

const AddressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

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
  max_staleness_seconds: z.number().int().min(0).default(60),
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
    const references = buildReferences(parsedEnvelope);

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
    });

    const envelope: { from: string; to: string[]; cc?: string[]; bcc?: string[] } = {
      from,
      to,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
    };
    const result = await sendRawAndAppendSent(ctx, raw, envelope);

    return {
      content: [
        {
          type: 'text',
          text: `Replied to "${original.subject ?? '(no subject)'}" (UID ${String(args.uid)}). Sent to ${to.join(', ')}${cc.length > 0 ? `, cc: ${cc.join(', ')}` : ''}.`,
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

function buildReferences(env: ParsedEnvelope): string[] {
  const refs: string[] = [];
  // Preserve existing References chain by parsing from the envelope.
  // (Our cache doesn't store the raw References header separately; this
  // is a minimal implementation that keeps the thread alive via
  // In-Reply-To alone. Full chain preservation lands when we cache the
  // raw header set.)
  if (env.messageId) refs.push(env.messageId);
  return refs;
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
