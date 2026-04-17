import type { SearchObject } from 'imapflow';

/**
 * Typed IMAP search criteria, produced by our Zod-validated tool inputs.
 *
 * Recursive via `or` and `not`: tools can build `{subject, or: [{from}, {from}]}`
 * which maps to `subject=X AND (from=a OR from=b)` at the IMAP layer.
 *
 * The type stays narrower than ImapFlow's full `SearchObject` - we don't
 * expose modseq, Gmail extensions, or custom keywords yet.
 */
// `| undefined` on each field is required by exactOptionalPropertyTypes
// for Zod's inferred type to match this interface.
export interface EmailSearchCriteria {
  subject?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  body?: string | undefined;
  /** If true, only messages without `\Seen`. If undefined/false, no filter. */
  unseen?: boolean | undefined;
  /** Only messages received on/after this date. */
  since?: Date | undefined;
  /** Only messages received before this date. */
  before?: Date | undefined;
  /** Only messages larger than this many bytes. */
  larger_than_bytes?: number | undefined;
  /** Only messages smaller than this many bytes. */
  smaller_than_bytes?: number | undefined;
  /**
   * Array of sub-criteria (>=2); at least one must match. Maps to IMAP OR.
   * IMAP OR is strictly binary on the wire but ImapFlow unrolls arrays
   * for us, so `or: [a, b, c]` works as (a OR b OR c).
   */
  or?: EmailSearchCriteria[] | undefined;
  /** Sub-criteria that must NOT match. Maps to IMAP NOT. */
  not?: EmailSearchCriteria | undefined;
}

/**
 * Convert our typed criteria into ImapFlow's `SearchObject`.
 *
 * Recurses into `or` and `not` so full boolean trees survive the
 * translation. Empty criteria objects yield `{ all: true }`, matching
 * every message - preserves the old behavior when no filters are set.
 */
export function buildImapSearch(c: EmailSearchCriteria): SearchObject {
  const q: SearchObject = {};

  if (c.subject) q.subject = c.subject;
  if (c.from) q.from = c.from;
  if (c.to) q.to = c.to;
  if (c.body) q.body = c.body;
  if (c.since) q.since = c.since;
  if (c.before) q.before = c.before;
  if (c.unseen === true) q.seen = false;
  if (c.larger_than_bytes !== undefined) q.larger = c.larger_than_bytes;
  if (c.smaller_than_bytes !== undefined) q.smaller = c.smaller_than_bytes;
  if (c.or !== undefined && c.or.length > 0) q.or = c.or.map(buildImapSearch);
  if (c.not !== undefined) q.not = buildImapSearch(c.not);

  // Only emit `all: true` if no other criterion is present. ImapFlow treats
  // that as the bare IMAP ALL keyword; combining it with other filters is
  // redundant and some servers reject it.
  if (Object.keys(q).length === 0) {
    q.all = true;
  }

  return q;
}
