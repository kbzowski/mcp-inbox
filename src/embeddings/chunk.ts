const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS = 10;
const MIN_CHUNK = 40;
const MIN_AFTER_STRIP = 200;

const FORWARD_SUBJECT = /\b(fwd?|fw|pd)\s*:/i;

/**
 * Lines that begin quoted history. Cutting at the earliest match keeps a
 * reply's own words and drops the thread it carries, which is 30% of the
 * characters in a real mailbox and would otherwise make every message in a
 * thread embed to nearly the same vector.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^\s*>/,
  /^\s*_{5,}\s*$/,
  /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i,
  /^\s*-{2,}\s*(?:Wiadomo[śs][ćc] oryginalna|Oryginalna wiadomo[śs][ćc])\s*-{2,}/i,
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*(?:W dniu|Dnia)\b.{0,200}\b(?:napisa[łl](?:\(a\))?|pisze)\s*:\s*$/i,
];

/** A header block only starts a quote when its siblings follow it closely. */
const HEADER_START = /^\s*(?:From|Od)\s*:\s*\S/i;
const HEADER_FOLLOW = /^\s*(?:Sent|Wys[łl]ano|To|Do|Subject|Temat)\s*:\s*\S/i;

export function stripQuoted(text: string, subject: string | null): string {
  if (FORWARD_SUBJECT.test(subject ?? '')) return text;

  const lines = text.split(/\r?\n/);
  let cutAt = -1;

  for (const [i, line] of lines.entries()) {
    if (QUOTE_MARKERS.some((re) => re.test(line))) {
      cutAt = i;
      break;
    }
    if (HEADER_START.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_FOLLOW.test(l))) {
      cutAt = i;
      break;
    }
  }

  if (cutAt < 0) return text;

  const kept = lines.slice(0, cutAt).join('\n').trim();
  return kept.length < MIN_AFTER_STRIP ? text : kept;
}

export function chunkText(text: string): string[] {
  const paragraphs = splitParagraphs(text.replace(/\r\n/g, '\n').trim());
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (chunks.length >= MAX_CHUNKS) break;

    if (current.length > 0 && current.length + paragraph.length + 2 > CHUNK_TARGET) {
      chunks.push(current.trim());
      current = overlapFrom(current);
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (chunks.length < MAX_CHUNKS && current.trim().length > 0) chunks.push(current.trim());

  return chunks.slice(0, MAX_CHUNKS).filter((c) => c.length >= MIN_CHUNK);
}

export function bodyChunks(text: string, subject: string | null): string[] {
  return chunkText(stripQuoted(text, subject));
}

function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= CHUNK_TARGET) {
      out.push(trimmed);
      continue;
    }
    for (const piece of hardSplit(trimmed)) out.push(piece);
  }
  return out;
}

/** Break an oversized paragraph on whitespace so no chunk splits a word. */
function hardSplit(paragraph: string): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_TARGET) {
    const window = rest.slice(0, CHUNK_TARGET);
    const cut = window.lastIndexOf(' ');
    const at = cut > CHUNK_TARGET / 2 ? cut : CHUNK_TARGET;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Carry the tail of a chunk into the next one so a sentence spanning the
 * boundary stays retrievable from at least one of them. */
function overlapFrom(chunk: string): string {
  if (chunk.length <= CHUNK_OVERLAP) return chunk;
  const tail = chunk.slice(-CHUNK_OVERLAP);
  const space = tail.indexOf(' ');
  return space === -1 ? tail : tail.slice(space + 1);
}
