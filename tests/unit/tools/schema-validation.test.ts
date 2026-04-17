import { describe, it, expect } from 'vitest';
import { getEmailTool } from '../../../src/tools/emails/get-email';
import { searchEmailsTool } from '../../../src/tools/emails/search-emails';
import { getDraftTool } from '../../../src/tools/drafts/get-draft';
import { listEmailsTool } from '../../../src/tools/emails/list-emails';
import { markReadTool, markUnreadTool } from '../../../src/tools/emails/mark-read';
import { moveToFolderTool } from '../../../src/tools/emails/move-to-folder';
import { deleteEmailTool } from '../../../src/tools/emails/delete-email';
import { createDraftTool } from '../../../src/tools/drafts/create-draft';
import { updateDraftTool } from '../../../src/tools/drafts/update-draft';
import { sendEmailTool } from '../../../src/tools/send/send-email';
import { sendDraftTool } from '../../../src/tools/send/send-draft';
import { replyTool } from '../../../src/tools/send/reply';
import { forwardTool } from '../../../src/tools/send/forward';

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

describe('mark-read / mark-unread input schemas', () => {
  it('both require folder + uid', () => {
    for (const tool of [markReadTool, markUnreadTool]) {
      expect(tool.inputSchema.safeParse({ uid: 1 }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ folder: 'INBOX' }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 }).success).toBe(true);
    }
  });

  it('both carry idempotent + non-destructive annotations', () => {
    for (const tool of [markReadTool, markUnreadTool]) {
      expect(tool.annotations.idempotentHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });
});

describe('imap_move_to_folder input schema', () => {
  it('requires destination', () => {
    const r = moveToFolderTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 });
    expect(r.success).toBe(false);
  });

  it('accepts valid move args', () => {
    const r = moveToFolderTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 42,
      destination: 'Archive',
    });
    expect(r.success).toBe(true);
  });

  it('carries destructive annotation', () => {
    expect(moveToFolderTool.annotations.destructiveHint).toBe(true);
  });
});

describe('imap_delete_email input schema', () => {
  it('defaults hard_delete to false (Trash behavior)', () => {
    const r = deleteEmailTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hard_delete).toBe(false);
  });

  it('accepts hard_delete=true', () => {
    const r = deleteEmailTool.inputSchema.safeParse({
      folder: 'INBOX',
      uid: 1,
      hard_delete: true,
    });
    expect(r.success).toBe(true);
  });

  it('is marked destructive', () => {
    expect(deleteEmailTool.annotations.destructiveHint).toBe(true);
  });
});

describe('imap_create_draft input schema', () => {
  it('requires to and subject', () => {
    expect(createDraftTool.inputSchema.safeParse({}).success).toBe(false);
    expect(createDraftTool.inputSchema.safeParse({ to: 'x@y' }).success).toBe(false);
    expect(createDraftTool.inputSchema.safeParse({ to: 'x@y', subject: 'hi' }).success).toBe(true);
  });

  it('accepts single or array recipients', () => {
    expect(createDraftTool.inputSchema.safeParse({ to: 'a@b', subject: 's' }).success).toBe(true);
    expect(
      createDraftTool.inputSchema.safeParse({ to: ['a@b', 'c@d'], subject: 's' }).success,
    ).toBe(true);
  });

  it('rejects empty-array recipients', () => {
    expect(createDraftTool.inputSchema.safeParse({ to: [], subject: 's' }).success).toBe(false);
  });
});

describe('imap_update_draft input schema', () => {
  it('requires uid + to + subject', () => {
    const missingUid = updateDraftTool.inputSchema.safeParse({ to: 'x@y', subject: 's' });
    expect(missingUid.success).toBe(false);
    const complete = updateDraftTool.inputSchema.safeParse({
      uid: 1,
      to: 'x@y',
      subject: 's',
    });
    expect(complete.success).toBe(true);
  });
});

describe('send tool annotations', () => {
  it('all four send tools are marked destructive (outbound = irreversible)', () => {
    for (const tool of [sendEmailTool, sendDraftTool, replyTool, forwardTool]) {
      expect(tool.annotations.destructiveHint).toBe(true);
      expect(tool.annotations.idempotentHint).toBe(false);
    }
  });
});

describe('imap_send_email input schema', () => {
  it('requires to + subject', () => {
    expect(sendEmailTool.inputSchema.safeParse({ subject: 'x' }).success).toBe(false);
    expect(sendEmailTool.inputSchema.safeParse({ to: 'a@b' }).success).toBe(false);
    expect(sendEmailTool.inputSchema.safeParse({ to: 'a@b', subject: 'x' }).success).toBe(true);
  });
});

describe('imap_reply input schema', () => {
  it('requires folder + uid', () => {
    expect(replyTool.inputSchema.safeParse({ uid: 1 }).success).toBe(false);
    expect(replyTool.inputSchema.safeParse({ folder: 'INBOX' }).success).toBe(false);
    expect(replyTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 }).success).toBe(true);
  });

  it('reply_all defaults to false', () => {
    const r = replyTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reply_all).toBe(false);
  });
});

describe('imap_forward input schema', () => {
  it('requires folder + uid + to', () => {
    expect(forwardTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1 }).success).toBe(false);
    expect(forwardTool.inputSchema.safeParse({ folder: 'INBOX', uid: 1, to: 'x@y' }).success).toBe(
      true,
    );
  });
});

describe('imap_send_draft input schema', () => {
  it('requires uid', () => {
    expect(sendDraftTool.inputSchema.safeParse({}).success).toBe(false);
    expect(sendDraftTool.inputSchema.safeParse({ uid: 1 }).success).toBe(true);
  });

  it('folder is optional (auto-resolves to Drafts)', () => {
    const r = sendDraftTool.inputSchema.safeParse({ uid: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.folder).toBeUndefined();
  });
});
