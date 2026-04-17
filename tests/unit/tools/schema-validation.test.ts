import { describe, it, expect } from 'vitest';
import { getEmailTool } from '../../../src/tools/emails/get-email.js';
import { searchEmailsTool } from '../../../src/tools/emails/search-emails.js';
import { getDraftTool } from '../../../src/tools/drafts/get-draft.js';
import { listEmailsTool } from '../../../src/tools/emails/list-emails.js';

/**
 * Tool handlers are integration-heavy, but their Zod schemas are pure
 * and cover most of the "bad input" surface. These tests lock the
 * public argument contract without touching IMAP or SQLite.
 */

describe('imap_get_email input schema', () => {
  it('rejects missing uid', () => {
    const r = getEmailTool.inputSchema.safeParse({ folder: 'INBOX' });
    expect(r.success).toBe(false);
  });

  it('rejects zero and negative UIDs', () => {
    for (const uid of [0, -1]) {
      const r = getEmailTool.inputSchema.safeParse({ folder: 'INBOX', uid });
      expect(r.success).toBe(false);
    }
  });

  it('accepts the minimum required fields', () => {
    const r = getEmailTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 });
    expect(r.success).toBe(true);
  });
});

describe('imap_search_emails input schema', () => {
  it('rejects an empty query (no criteria)', () => {
    const r = searchEmailsTool.inputSchema.safeParse({ folder: 'INBOX' });
    expect(r.success).toBe(false);
  });

  it('accepts a single-criterion query', () => {
    const r = searchEmailsTool.inputSchema.safeParse({
      folder: 'INBOX',
      subject: 'invoice',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty-string criteria via .min(1) on each field', () => {
    const r = searchEmailsTool.inputSchema.safeParse({ folder: 'INBOX', subject: '' });
    expect(r.success).toBe(false);
  });

  it('rejects malformed dates', () => {
    const r = searchEmailsTool.inputSchema.safeParse({
      folder: 'INBOX',
      since_date: 'yesterday',
    });
    expect(r.success).toBe(false);
  });
});

describe('imap_get_draft input schema', () => {
  it('does not require a folder (SPECIAL-USE auto-resolves)', () => {
    const r = getDraftTool.inputSchema.safeParse({ uid: 1 });
    expect(r.success).toBe(true);
  });

  it('allows an explicit folder override', () => {
    const r = getDraftTool.inputSchema.safeParse({ uid: 1, folder: 'INBOX.Drafts' });
    expect(r.success).toBe(true);
  });
});

describe('imap_list_emails input schema', () => {
  it('defaults folder to INBOX', () => {
    const r = listEmailsTool.inputSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.folder).toBe('INBOX');
  });

  it('caps limit at 100', () => {
    const r = listEmailsTool.inputSchema.safeParse({ limit: 500 });
    expect(r.success).toBe(false);
  });
});
