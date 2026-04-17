import type { SearchObject } from 'imapflow';

/**
 * Typed IMAP search criteria, produced by our Zod-validated tool inputs.
 *
 * This type is the single source of truth for what every `imap_*_emails`
 * tool accepts. It stays deliberately narrow — ImapFlow's `SearchObject`
 * is much richer (flags, modseq, gmail extensions) but most of that
 * surface isn't exposed to tool callers.
 */
export interface EmailSearchCriteria {
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  /** If true, only messages without `\Seen`. If undefined/false, no filter. */
  unseen?: boolean;
  /** Only messages received on/after this date (Date or ISO string). */
  since?: Date;
  /** Only messages received before this date. */
  before?: Date;
}

/**
 * Convert our typed criteria into ImapFlow's `SearchObject`.
 *
 * An empty criteria object yields `{ all: true }` — ImapFlow sends that
 * as a bare IMAP `ALL`, matching every message in the mailbox.
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

  // Only emit `all: true` if no other criterion is present. ImapFlow treats
  // that as the bare IMAP ALL keyword; combining it with other filters is
  // redundant and some servers reject it.
  if (Object.keys(q).length === 0) {
    q.all = true;
  }

  return q;
}
