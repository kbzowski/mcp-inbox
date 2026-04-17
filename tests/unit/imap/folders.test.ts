import { describe, it, expect } from 'vitest';
import type { ListResponse } from 'imapflow';
import { findSpecialFolder } from '../../../src/imap/folders';

/**
 * Build a minimal ListResponse for tests. Only the fields the function
 * actually reads need to be set; the rest get reasonable defaults.
 */
function mailbox(path: string, specialUse?: string, delimiter = '/'): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split(delimiter).pop() ?? path,
    delimiter,
    parent: [],
    parentPath: '',
    flags: new Set<string>(),
    ...(specialUse !== undefined ? { specialUse } : {}),
    listed: true,
    subscribed: true,
  };
}

describe('findSpecialFolder', () => {
  describe('RFC 6154 SPECIAL-USE (primary path)', () => {
    it('prefers specialUse attribute over matching name', () => {
      // The "real" Drafts folder has the attribute, but there's also an
      // unrelated folder literally called "Drafts" that should be ignored.
      const folders = [mailbox('Custom-Label-Drafts', '\\Drafts'), mailbox('Drafts')];
      expect(findSpecialFolder(folders, '\\Drafts')).toBe('Custom-Label-Drafts');
    });

    it('resolves Gmail-style nested paths', () => {
      const folders = [
        mailbox('INBOX'),
        mailbox('[Gmail]/Drafts', '\\Drafts'),
        mailbox('[Gmail]/Sent Mail', '\\Sent'),
        mailbox('[Gmail]/Trash', '\\Trash'),
      ];
      expect(findSpecialFolder(folders, '\\Drafts')).toBe('[Gmail]/Drafts');
      expect(findSpecialFolder(folders, '\\Sent')).toBe('[Gmail]/Sent Mail');
      expect(findSpecialFolder(folders, '\\Trash')).toBe('[Gmail]/Trash');
    });

    it('resolves Dovecot-style dotted paths', () => {
      const folders = [mailbox('INBOX', undefined, '.'), mailbox('INBOX.Drafts', '\\Drafts', '.')];
      expect(findSpecialFolder(folders, '\\Drafts')).toBe('INBOX.Drafts');
    });
  });

  describe('name-probe fallback (legacy servers)', () => {
    it('falls back to known name when specialUse is absent', () => {
      const folders = [mailbox('INBOX'), mailbox('Drafts')];
      expect(findSpecialFolder(folders, '\\Drafts')).toBe('Drafts');
    });

    it('tries candidate names in order', () => {
      // First candidate "Drafts" exists → prefer it over "Draft".
      const folders = [mailbox('INBOX'), mailbox('Drafts'), mailbox('Draft')];
      expect(findSpecialFolder(folders, '\\Drafts')).toBe('Drafts');
    });

    it('handles "Sent Items" for Outlook-style servers', () => {
      const folders = [mailbox('INBOX'), mailbox('Sent Items'), mailbox('Deleted Items')];
      expect(findSpecialFolder(folders, '\\Sent')).toBe('Sent Items');
      expect(findSpecialFolder(folders, '\\Trash')).toBe('Deleted Items');
    });
  });

  describe('no match', () => {
    it('returns undefined when neither specialUse nor known name exists', () => {
      const folders = [mailbox('INBOX'), mailbox('SomeCustomFolder')];
      expect(findSpecialFolder(folders, '\\Drafts')).toBeUndefined();
    });

    it('returns undefined for empty folder list', () => {
      expect(findSpecialFolder([], '\\Drafts')).toBeUndefined();
    });
  });
});
