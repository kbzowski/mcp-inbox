import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:body-text');

/** Text parts above this are pathological (pasted logs, base64 in prose). */
const MAX_PART_BYTES = 1_000_000;

export interface TextPart {
  part: string;
  charset: string;
  encoding: string;
  isHtml: boolean;
}

export interface TextBodies {
  texts: Map<number, string>;
  /** How many of the requested messages actually had a usable text part. */
  expected: number;
}

/**
 * Locate the message's readable text part.
 *
 * Only leaf `text/*` nodes qualify: on a real Dovecot mailbox the first child
 * of a `multipart/mixed` is often a `multipart/alternative`, and fetching that
 * container returns raw MIME with boundaries rather than prose.
 *
 * A root node carries no `part` id, in which case the body is part `1`.
 * ImapFlow's own `download()` uses `TEXT` there, but GreenMail returns zero
 * bytes for `TEXT` on a single-part message while both servers accept `1`.
 */
export function pickTextPart(structure: MessageStructureObject | undefined): TextPart | null {
  if (structure === undefined) return null;

  let best: { node: MessageStructureObject; rank: number } | null = null;
  const queue: MessageStructureObject[] = [structure];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) continue;
    if (isAttachment(node)) continue;

    const rank = node.type === 'text/plain' ? 0 : node.type === 'text/html' ? 1 : -1;
    if (rank >= 0 && (best === null || rank < best.rank)) {
      best = { node, rank };
    }
    if (node.childNodes) queue.push(...node.childNodes);
  }

  if (best === null) return null;
  if (typeof best.node.size === 'number' && best.node.size > MAX_PART_BYTES) return null;

  return {
    part: best.node.part ?? '1',
    charset: best.node.parameters?.['charset'] ?? 'utf-8',
    encoding: best.node.encoding ?? '7bit',
    isHtml: best.rank === 1,
  };
}

export function decodeTextPart(raw: Buffer, part: TextPart, alreadyDecoded = false): string {
  const bytes = alreadyDecoded ? raw : decodeTransfer(raw, part.encoding);
  let text: string;
  try {
    text = new TextDecoder(part.charset).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return part.isHtml ? flattenHtml(text) : text;
}

/**
 * Fetch the text part of many messages without pulling their attachments.
 *
 * Two passes because one FETCH command carries one part list for the whole UID
 * set, and part ids differ per message. Each part group is isolated: a server
 * that rejects one shape (GreenMail answers `NO` for a part id it has not got,
 * which fails the whole command) must not cost us the other groups.
 */
export async function fetchTextBodies(
  imap: ImapFlow,
  uids: readonly number[],
): Promise<TextBodies> {
  const texts = new Map<number, string>();
  if (uids.length === 0) return { texts, expected: 0 };

  const parts = new Map<number, TextPart>();
  for await (const msg of imap.fetch([...uids], { bodyStructure: true }, { uid: true })) {
    const picked = pickTextPart(msg.bodyStructure);
    if (picked !== null) parts.set(msg.uid, picked);
  }

  const groups = new Map<string, number[]>();
  for (const [uid, part] of parts) {
    const bucket = groups.get(part.part);
    if (bucket === undefined) groups.set(part.part, [uid]);
    else bucket.push(uid);
  }

  for (const [partId, groupUids] of groups) {
    const key = partId.toLowerCase();
    try {
      for await (const msg of imap.fetch([...groupUids], { bodyParts: [partId] }, { uid: true })) {
        const raw = msg.bodyParts?.get(key);
        const part = parts.get(msg.uid);
        if (raw === undefined || raw.length === 0 || part === undefined) continue;
        const decoded = decodeTextPart(raw, part, msg.binaryParts?.has(key) === true);
        const trimmed = decoded.trim();
        if (trimmed.length > 0) texts.set(msg.uid, trimmed);
      }
    } catch (err) {
      log.warn('body part fetch failed for a part group', {
        part: partId,
        uids: groupUids.length,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { texts, expected: parts.size };
}

function isAttachment(node: MessageStructureObject): boolean {
  return (
    node.disposition === 'attachment' || node.dispositionParameters?.['filename'] !== undefined
  );
}

function decodeTransfer(raw: Buffer, encoding: string): Buffer {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return Buffer.from(raw.toString('ascii'), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

function decodeQuotedPrintable(raw: Buffer): Buffer {
  const source = raw.toString('latin1').replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.charAt(i) === '=' && /^[\da-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(source.charCodeAt(i));
  }
  return Buffer.from(out);
}

/** ponytail: naive tag stripper - this feeds an embedding, not a renderer. */
function flattenHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
