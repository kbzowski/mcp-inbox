import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEmailsTool } from '@/tools/emails/list-emails';
import { getEmailTool } from '@/tools/emails/get-email';
import { markReadTool, markUnreadTool } from '@/tools/emails/mark-read';
import { setFlagsTool } from '@/tools/emails/set-flags';
import { searchEmailsTool } from '@/tools/emails/search-emails';
import { replyTool } from '@/tools/send/reply';
import { moveToFolderTool } from '@/tools/emails/move-to-folder';
import { deleteEmailTool } from '@/tools/emails/delete-email';
import {
  buildHarness,
  ensureTestFolders,
  greenmailAvailable,
  type IntegrationHarness,
} from './helpers/context';
import { seedEmail } from './helpers/seed';

const describeIfGreenmail = greenmailAvailable() ? describe : describe.skip;

describeIfGreenmail('integration: write-path tools against GreenMail', () => {
  let harness: IntegrationHarness;
  const host = process.env.GREENMAIL_HOST ?? '';
  const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT);

  beforeAll(async () => {
    harness = buildHarness();
    await ensureTestFolders(harness);
  });

  afterAll(async () => {
    await harness.tearDown();
  });

  async function seedAndFindUid(subject: string): Promise<number> {
    await seedEmail({
      host,
      smtpPort,
      from: 'sender@localhost',
      to: 'test@localhost',
      subject,
      text: `Body for "${subject}"`,
    });

    const list = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const emails = (list.structuredContent as { emails: { uid: number; subject: string | null }[] })
      .emails;
    const row = emails.find((e) => e.subject === subject);
    if (!row) throw new Error(`Seeded email "${subject}" not found in INBOX`);
    return row.uid;
  }

  it('set_flags stars a message and search_emails finds it by flag', async () => {
    const uid = await seedAndFindUid('star me');

    const set = await setFlagsTool.handler(
      { folder: 'INBOX', uids: [uid], add: ['\\Flagged'] },
      harness.ctx,
    );
    expect(set.structuredContent).toMatchObject({ applied: true, added: ['\\Flagged'] });

    const detail = await getEmailTool.handler(
      { folder: 'INBOX', uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    expect((detail.structuredContent as { flags: string[] }).flags).toContain('\\Flagged');

    const found = await searchEmailsTool.handler(
      {
        folder: 'INBOX',
        flagged: true,
        limit: 20,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const hits = (found.structuredContent as { emails: { uid: number }[] }).emails;
    expect(hits.map((e) => e.uid)).toContain(uid);

    await setFlagsTool.handler(
      { folder: 'INBOX', uids: [uid], remove: ['\\Flagged'] },
      harness.ctx,
    );

    const gone = await searchEmailsTool.handler(
      {
        folder: 'INBOX',
        flagged: true,
        limit: 20,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    expect(
      (gone.structuredContent as { emails: { uid: number }[] }).emails.map((e) => e.uid),
    ).not.toContain(uid);
  });

  it('reply marks the original as answered', async () => {
    const uid = await seedAndFindUid('answer me');

    const replied = await replyTool.handler(
      { folder: 'INBOX', uid, body: 'On it.', reply_all: false, mark_answered: true },
      harness.ctx,
    );
    expect(replied.structuredContent).toMatchObject({
      original_marked_answered: true,
      mark_answered_error: null,
    });

    const detail = await getEmailTool.handler(
      { folder: 'INBOX', uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    expect((detail.structuredContent as { flags: string[] }).flags).toContain('\\Answered');
  });

  it('reply carries the original References chain forward', async () => {
    const chain = ['<root@thread.test>', '<second@thread.test>'];
    await seedEmail({
      host,
      smtpPort,
      from: 'sender@localhost',
      to: 'test@localhost',
      subject: 'mid-thread message',
      text: 'third in the thread',
      inReplyTo: chain[1]!,
      references: chain,
    });

    const list = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const row = (
      list.structuredContent as { emails: { uid: number; subject: string | null }[] }
    ).emails.find((e) => e.subject === 'mid-thread message');
    expect(row).toBeDefined();
    if (!row) return;

    const replied = await replyTool.handler(
      { folder: 'INBOX', uid: row.uid, body: 'fourth', reply_all: false, mark_answered: false },
      harness.ctx,
    );

    const refs = (replied.structuredContent as { references: string[] }).references;
    expect(refs.slice(0, 2)).toEqual(chain);
    expect(refs).toHaveLength(3);
  });

  it('mark_read flips the cached \\Seen flag through IMAP', async () => {
    const uid = await seedAndFindUid('mark-read round-trip');

    // Initially the message is unread - mailparser / IMAP sync reports empty flags.
    const before = await getEmailTool.handler(
      { folder: 'INBOX', uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const beforeBody = before.structuredContent as { flags: string[]; unseen: boolean };
    expect(beforeBody.unseen).toBe(true);
    expect(beforeBody.flags).not.toContain('\\Seen');

    // Mark read.
    await markReadTool.handler({ folder: 'INBOX', uid }, harness.ctx);

    // Re-read with fresh sync to confirm the server picked it up.
    const after = await getEmailTool.handler(
      { folder: 'INBOX', uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const afterBody = after.structuredContent as { flags: string[]; unseen: boolean };
    expect(afterBody.unseen).toBe(false);
    expect(afterBody.flags).toContain('\\Seen');

    // Round-trip back via mark_unread.
    await markUnreadTool.handler({ folder: 'INBOX', uid }, harness.ctx);
    const roundTrip = await getEmailTool.handler(
      { folder: 'INBOX', uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const rtBody = roundTrip.structuredContent as { unseen: boolean };
    expect(rtBody.unseen).toBe(true);
  });

  it('move_to_folder relocates a message', async () => {
    const uid = await seedAndFindUid('move target');

    // GreenMail creates folders on demand via append/copy. Use an existing
    // one (Trash comes from setup.test.all).
    const moveResult = await moveToFolderTool.handler(
      { folder: 'INBOX', uid, destination: 'Trash' },
      harness.ctx,
    );
    expect(moveResult.isError).not.toBe(true);

    // Post-move, list INBOX fresh - the subject should be gone.
    const inbox = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const inboxEmails = (inbox.structuredContent as { emails: { subject: string | null }[] })
      .emails;
    expect(inboxEmails.find((e) => e.subject === 'move target')).toBeUndefined();

    // Trash should now contain it.
    const trash = await listEmailsTool.handler(
      {
        folder: 'Trash',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const trashEmails = (trash.structuredContent as { emails: { subject: string | null }[] })
      .emails;
    expect(trashEmails.find((e) => e.subject === 'move target')).toBeDefined();
  });

  it('delete_email with default hard_delete=false moves to Trash', async () => {
    const uid = await seedAndFindUid('soft-delete target');

    const res = await deleteEmailTool.handler(
      { folder: 'INBOX', uid, hard_delete: false },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);
    const payload = res.structuredContent as {
      action: string;
      trash_folder?: string;
    };
    expect(payload.action).toBe('moved_to_trash');
    expect(typeof payload.trash_folder).toBe('string');

    const inbox = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const inboxEmails = (inbox.structuredContent as { emails: { subject: string | null }[] })
      .emails;
    expect(inboxEmails.find((e) => e.subject === 'soft-delete target')).toBeUndefined();
  });

  it('delete_email with hard_delete=true permanently expunges', async () => {
    const uid = await seedAndFindUid('hard-delete target');

    const res = await deleteEmailTool.handler(
      { folder: 'INBOX', uid, hard_delete: true },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);
    const payload = res.structuredContent as { action: string };
    expect(payload.action).toBe('hard_delete');

    // Neither INBOX nor Trash should have it.
    const inbox = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const inboxEmails = (inbox.structuredContent as { emails: { subject: string | null }[] })
      .emails;
    expect(inboxEmails.find((e) => e.subject === 'hard-delete target')).toBeUndefined();

    const trash = await listEmailsTool.handler(
      {
        folder: 'Trash',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const trashEmails = (trash.structuredContent as { emails: { subject: string | null }[] })
      .emails;
    expect(trashEmails.find((e) => e.subject === 'hard-delete target')).toBeUndefined();
  });
});
