import type { ListResponse } from 'imapflow';

/**
 * RFC 6154 SPECIAL-USE attributes. These are the standard flags IMAP
 * servers advertise on the mailbox list response. All modern providers
 * (Gmail, Fastmail, Outlook, modern Dovecot) support this; only ancient
 * Courier installs fall back to name-probing.
 */
export type SpecialUseAttr = '\\Drafts' | '\\Sent' | '\\Trash' | '\\Junk' | '\\All' | '\\Flagged';

/**
 * Resolve a special-use folder to its mailbox path.
 *
 * Strategy: prefer the RFC 6154 `specialUse` property from the server's
 * LIST response; fall back to a name-probe against known provider-specific
 * conventions if no folder advertises the attribute.
 *
 * Returns `undefined` if no matching folder exists - callers should handle
 * that explicitly (e.g. by creating the folder or surfacing an error).
 */
export function findSpecialFolder(
  folders: readonly ListResponse[],
  attr: SpecialUseAttr,
): string | undefined {
  // Primary: RFC 6154 SPECIAL-USE attribute.
  const bySpecial = folders.find((f) => f.specialUse === attr);
  if (bySpecial) return bySpecial.path;

  // Fallback: name-probe against known provider conventions.
  const candidates = NAME_CANDIDATES[attr];
  const pathSet = new Set(folders.map((f) => f.path));
  for (const candidate of candidates) {
    if (pathSet.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Known mailbox names for each special-use attribute, ordered by
 * likelihood. Used only when the server does not advertise SPECIAL-USE.
 *
 * Keep this list conservative - the primary mechanism is the RFC 6154
 * attribute, and over-long fallback lists just mask server misconfiguration.
 */
const NAME_CANDIDATES: Record<SpecialUseAttr, readonly string[]> = {
  '\\Drafts': [
    'Drafts',
    'Draft',
    'INBOX.Drafts',
    'INBOX/Drafts',
    '[Gmail]/Drafts',
    '[Google Mail]/Drafts',
  ],
  '\\Sent': [
    'Sent',
    'Sent Items',
    'Sent Mail',
    'INBOX.Sent',
    'INBOX/Sent',
    '[Gmail]/Sent Mail',
    '[Google Mail]/Sent Mail',
  ],
  '\\Trash': [
    'Trash',
    'Deleted',
    'Deleted Items',
    'INBOX.Trash',
    'INBOX/Trash',
    '[Gmail]/Trash',
    '[Google Mail]/Trash',
  ],
  '\\Junk': [
    'Junk',
    'Junk Email',
    'Spam',
    'INBOX.Junk',
    'INBOX/Junk',
    '[Gmail]/Spam',
    '[Google Mail]/Spam',
  ],
  '\\All': ['Archive', 'All Mail', '[Gmail]/All Mail', '[Google Mail]/All Mail'],
  '\\Flagged': ['Starred', 'Flagged', '[Gmail]/Starred', '[Google Mail]/Starred'],
};
