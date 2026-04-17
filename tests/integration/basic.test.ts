import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listFoldersTool } from '@/tools/folders/list-folders';
import { listEmailsTool } from '@/tools/emails/list-emails';
import { searchEmailsTool } from '@/tools/emails/search-emails';
import { getEmailTool } from '@/tools/emails/get-email';
import { buildHarness, greenmailAvailable, type IntegrationHarness } from './helpers/context';
import { seedEmail } from './helpers/seed';

const describeIfGreenmail = greenmailAvailable() ? describe : describe.skip;

describeIfGreenmail('integration: basic read path against GreenMail', () => {
  let harness: IntegrationHarness;

  beforeAll(() => {
    harness = buildHarness();
  });

  afterAll(async () => {
    await harness.tearDown();
  });

  it('list_folders returns the standard mailboxes (INBOX + defaults)', async () => {
    const res = await listFoldersTool.handler({ response_format: 'json' }, harness.ctx);
    expect(res.isError).not.toBe(true);
    const structured = res.structuredContent as { folders: { path: string }[] };
    const paths = structured.folders.map((f) => f.path).sort();
    // GreenMail creates INBOX on first access. Other folders may or may
    // not exist depending on the server's setup mode; we assert the
    // essentials and leave the rest.
    expect(paths).toContain('INBOX');
  });

  it('syncs an email delivered via SMTP into the cache', async () => {
    const host = process.env.GREENMAIL_HOST!;
    const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT);
    await seedEmail({
      host,
      smtpPort,
      from: 'alice@localhost',
      to: 'test@localhost',
      subject: 'Hello from integration test',
      text: 'Body of the test message.',
    });

    const res = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 20,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0, // force sync
        response_format: 'json',
      },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);
    const body = res.structuredContent as {
      emails: { subject: string | null; from: string | null }[];
      total_count: number;
      served_from: string;
    };
    expect(body.served_from).toBe('sync');
    expect(body.total_count).toBeGreaterThanOrEqual(1);
    const match = body.emails.find((e) => e.subject === 'Hello from integration test');
    expect(match).toBeDefined();
    expect(match?.from).toContain('alice@localhost');
  });

  it('list_emails with max_staleness=60 serves from cache after a prior sync', async () => {
    // Previous test synced. Re-list with default staleness should read cached.
    const res = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 20,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    const body = res.structuredContent as { served_from: string };
    expect(body.served_from).toBe('cache');
  });

  it('search_emails finds a message by subject substring', async () => {
    const res = await searchEmailsTool.handler(
      {
        folder: 'INBOX',
        subject: 'integration test',
        limit: 20,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);
    const body = res.structuredContent as {
      total_matches: number;
      emails: { subject: string | null }[];
    };
    expect(body.total_matches).toBeGreaterThanOrEqual(1);
    expect(body.emails.some((e) => e.subject?.includes('integration test'))).toBe(true);
  });

  it('get_email returns the parsed body for a known UID', async () => {
    // Find a UID to request via list_emails.
    const list = await listEmailsTool.handler(
      {
        folder: 'INBOX',
        limit: 20,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    const emails = (list.structuredContent as { emails: { uid: number; subject: string | null }[] })
      .emails;
    const testEmail = emails.find((e) => e.subject === 'Hello from integration test');
    expect(testEmail).toBeDefined();
    if (!testEmail) return;

    const res = await getEmailTool.handler(
      {
        folder: 'INBOX',
        uid: testEmail.uid,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);
    const body = res.structuredContent as {
      subject: string | null;
      body_text: string | null;
      attachments: { filename: string | null }[];
    };
    expect(body.subject).toBe('Hello from integration test');
    expect(body.body_text?.trim()).toBe('Body of the test message.');
    expect(body.attachments).toEqual([]);
  });
});
