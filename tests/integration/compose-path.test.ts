import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDraftsTool } from '@/tools/drafts/list-drafts';
import { createDraftTool } from '@/tools/drafts/create-draft';
import { updateDraftTool } from '@/tools/drafts/update-draft';
import { sendEmailTool } from '@/tools/send/send-email';
import { listEmailsTool } from '@/tools/emails/list-emails';
import { getEmailTool } from '@/tools/emails/get-email';
import { getAttachmentTool } from '@/tools/attachments/get-attachment';
import {
  buildHarness,
  ensureTestFolders,
  greenmailAvailable,
  type IntegrationHarness,
} from './helpers/context';
import { seedEmail } from './helpers/seed';

const describeIfGreenmail = greenmailAvailable() ? describe : describe.skip;

describeIfGreenmail('integration: compose/send/attachment against GreenMail', () => {
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

  it('create_draft then list_drafts finds the new draft', async () => {
    const created = await createDraftTool.handler(
      {
        to: 'recipient@localhost',
        subject: 'draft for integration test',
        body: 'Hello from the integration test.',
      },
      harness.ctx,
    );
    expect(created.isError).not.toBe(true);
    const payload = created.structuredContent as { folder: string; uid: number | null };
    expect(typeof payload.folder).toBe('string');

    const list = await listDraftsTool.handler(
      {
        limit: 100,
        offset: 0,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const drafts = (list.structuredContent as { drafts: { subject: string | null }[] }).drafts;
    expect(drafts.find((d) => d.subject === 'draft for integration test')).toBeDefined();
  });

  it('update_draft replaces content and preserves the user draft on success', async () => {
    // Create a baseline draft first.
    await createDraftTool.handler(
      {
        to: 'someone@localhost',
        subject: 'original draft subject',
        body: 'original body',
      },
      harness.ctx,
    );

    const initialList = await listDraftsTool.handler(
      { limit: 100, offset: 0, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const original = initialList.structuredContent as {
      folder: string;
      drafts: { uid: number; subject: string | null }[];
    };
    const originalDraft = original.drafts.find((d) => d.subject === 'original draft subject');
    expect(originalDraft).toBeDefined();
    if (!originalDraft) return;

    const updated = await updateDraftTool.handler(
      {
        uid: originalDraft.uid,
        to: 'someone@localhost',
        subject: 'updated draft subject',
        body: 'updated body',
      },
      harness.ctx,
    );
    const updatedPayload = updated.structuredContent as {
      old_deleted: boolean;
      new_uid: number | null;
    };
    expect(updatedPayload.old_deleted).toBe(true);

    // Old subject gone, new subject present.
    const afterList = await listDraftsTool.handler(
      { limit: 100, offset: 0, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const afterDrafts = (afterList.structuredContent as { drafts: { subject: string | null }[] })
      .drafts;
    expect(afterDrafts.find((d) => d.subject === 'updated draft subject')).toBeDefined();
    expect(afterDrafts.find((d) => d.subject === 'original draft subject')).toBeUndefined();
  });

  it('send_email delivers to the recipient and saves a copy to Sent', async () => {
    const res = await sendEmailTool.handler(
      {
        to: 'test@localhost',
        subject: 'integration send-email',
        body: 'Delivered via GreenMail SMTP.',
      },
      harness.ctx,
    );
    expect(res.isError).not.toBe(true);

    // GreenMail delivers to the recipient inbox.
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
    const received = (inbox.structuredContent as { emails: { subject: string | null }[] }).emails;
    expect(received.find((e) => e.subject === 'integration send-email')).toBeDefined();

    // And a copy should exist in the server's Sent folder.
    const sent = await listEmailsTool.handler(
      {
        folder: 'Sent',
        limit: 100,
        offset: 0,
        unseen_only: false,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );
    const sentEmails = (sent.structuredContent as { emails: { subject: string | null }[] }).emails;
    expect(sentEmails.find((e) => e.subject === 'integration send-email')).toBeDefined();
  });

  it('get_attachment downloads inline base64 bytes of a real attachment', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n% integration test body\n%%EOF\n');
    await seedEmail({
      host,
      smtpPort,
      from: 'sender@localhost',
      to: 'test@localhost',
      subject: 'with attachment',
      text: 'see attached',
      attachments: [{ filename: 'test.pdf', content: pdfBytes, contentType: 'application/pdf' }],
    });

    // Find the UID.
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
    const row = emails.find((e) => e.subject === 'with attachment');
    expect(row).toBeDefined();
    if (!row) return;

    // First: get_email must report the attachment metadata.
    const detail = await getEmailTool.handler(
      { folder: 'INBOX', uid: row.uid, max_staleness_seconds: 0, response_format: 'json' },
      harness.ctx,
    );
    const detailBody = detail.structuredContent as {
      attachments: { filename: string | null; content_type: string; size_bytes: number }[];
    };
    const meta = detailBody.attachments.find((a) => a.filename === 'test.pdf');
    expect(meta).toBeDefined();
    expect(meta?.content_type).toContain('pdf');

    // Then: get_attachment returns the bytes inline.
    const att = await getAttachmentTool.handler(
      { folder: 'INBOX', uid: row.uid, filename: 'test.pdf', max_inline_mb: 5 },
      harness.ctx,
    );
    expect(att.isError).not.toBe(true);
    const attBody = att.structuredContent as {
      filename: string;
      content_type: string;
      size_bytes: number;
      content_base64: string;
    };
    expect(attBody.filename).toBe('test.pdf');
    const decoded = Buffer.from(attBody.content_base64, 'base64');
    expect(decoded.equals(pdfBytes)).toBe(true);
  });
});
