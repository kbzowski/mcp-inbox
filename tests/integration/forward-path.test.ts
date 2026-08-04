import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { forwardTool } from '@/tools/send/forward';
import { listEmailsTool } from '@/tools/emails/list-emails';
import { getAttachmentTool } from '@/tools/attachments/get-attachment';
import {
  buildHarness,
  ensureTestFolders,
  greenmailAvailable,
  type IntegrationHarness,
} from './helpers/context';
import { seedEmail } from './helpers/seed';

const describeIfGreenmail = greenmailAvailable() ? describe : describe.skip;

interface EmailRow {
  uid: number;
  subject: string | null;
}

async function findUid(
  harness: IntegrationHarness,
  folder: string,
  subject: string,
): Promise<number> {
  const list = await listEmailsTool.handler(
    {
      folder,
      limit: 100,
      offset: 0,
      unseen_only: false,
      max_staleness_seconds: 0,
      response_format: 'json',
    },
    harness.ctx,
  );
  const emails = (list.structuredContent as { emails: EmailRow[] }).emails;
  const row = emails.find((e) => e.subject === subject);
  expect(row, `no message with subject "${subject}" in ${folder}`).toBeDefined();
  return row!.uid;
}

describeIfGreenmail('integration: forward against GreenMail', () => {
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

  it('forwards the original verbatim so attachments survive', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n% forwarded invoice\n%%EOF\n');
    await seedEmail({
      host,
      smtpPort,
      from: 'accounting@localhost',
      to: 'test@localhost',
      subject: 'invoice to forward',
      text: 'Invoice attached.',
      attachments: [{ filename: 'invoice.pdf', content: pdfBytes, contentType: 'application/pdf' }],
    });

    const originalUid = await findUid(harness, 'INBOX', 'invoice to forward');

    const result = await forwardTool.handler(
      {
        folder: 'INBOX',
        uid: originalUid,
        to: 'test@localhost',
        body: 'FYI',
        max_staleness_seconds: 0,
      },
      harness.ctx,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      original_attached: true,
      subject: 'Fwd: invoice to forward',
    });

    const forwardedUid = await findUid(harness, 'INBOX', 'Fwd: invoice to forward');

    const att = await getAttachmentTool.handler(
      {
        folder: 'INBOX',
        uid: forwardedUid,
        filename: 'invoice to forward.eml',
        max_inline_mb: 5,
      },
      harness.ctx,
    );
    expect(att.isError).not.toBe(true);
    const eml = Buffer.from(
      (att.structuredContent as { content_base64: string }).content_base64,
      'base64',
    );

    const inner = await simpleParser(eml);
    expect(inner.subject).toBe('invoice to forward');
    const innerPdf = inner.attachments.find((a) => a.filename === 'invoice.pdf');
    expect(innerPdf).toBeDefined();
    expect(innerPdf!.content.equals(pdfBytes)).toBe(true);
  });

  it('keeps the inline quote alongside the attached original', async () => {
    const forwardedUid = await findUid(harness, 'INBOX', 'Fwd: invoice to forward');
    const { ensureBodyCached } = await import('@/tools/emails/shared');
    const body = await ensureBodyCached(harness.ctx, 'INBOX', forwardedUid);

    expect(body.bodyText).toContain('FYI');
    expect(body.bodyText).toContain('---------- Forwarded message ----------');
    expect(body.bodyText).toContain('Invoice attached.');
  });
});
