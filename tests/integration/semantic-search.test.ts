import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { indexFolderTool } from '@/tools/emails/index-folder';
import { semanticSearchTool } from '@/tools/emails/semantic-search';
import { deleteEmailTool } from '@/tools/emails/delete-email';
import { buildHarness, greenmailAvailable, type IntegrationHarness } from './helpers/context';
import { seedEmail } from './helpers/seed';
import { fakeConfig, FAKE_DIMS, installFakeEmbeddings } from '../unit/helpers/fake-embeddings';

/**
 * Embeddings come from the fake provider, not a real endpoint: the wire
 * protocol is covered by the client unit tests, and what only an integration
 * run can prove is that IMAP sync, the vector index, and the expunge cleanup
 * hook stay consistent with each other.
 */
const harnessReady = greenmailAvailable();
const describeIfGreenmail = harnessReady ? describe : describe.skip;

describeIfGreenmail('integration: semantic search over a real mailbox', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = buildHarness();
    harness.ctx.embeddings = fakeConfig;

    const host = process.env.GREENMAIL_HOST!;
    const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT);
    for (const [subject, from] of [
      ['Payment receipt 4417', 'billing@hosting.example'],
      ['Lecture schedule for spring semester', 'dean@university.example'],
      ['Your parcel is on its way', 'noreply@courier.example'],
    ] as const) {
      await seedEmail({ host, smtpPort, from, to: 'test@localhost', subject, text: subject });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await harness.tearDown();
  });

  const skipWithoutVectors = () => !harness.ctx.vectorsAvailable;

  it('indexes the folder and reports completion', async () => {
    if (skipWithoutVectors()) return;
    installFakeEmbeddings(FAKE_DIMS);

    const res = await indexFolderTool.handler(
      {
        folder: 'INBOX',
        max_messages: 500,
        max_staleness_seconds: 0,
        response_format: 'json',
      },
      harness.ctx,
    );

    const body = res.structuredContent as {
      embedded: number;
      remaining: number;
      complete: boolean;
    };
    expect(res.isError).not.toBe(true);
    expect(body.embedded).toBeGreaterThanOrEqual(3);
    expect(body.complete).toBe(true);
  });

  it('re-running embeds nothing new', async () => {
    if (skipWithoutVectors()) return;
    installFakeEmbeddings(FAKE_DIMS);

    const res = await indexFolderTool.handler(
      {
        folder: 'INBOX',
        max_messages: 500,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );

    expect((res.structuredContent as { embedded: number }).embedded).toBe(0);
  });

  it('ranks a matching message first', async () => {
    if (skipWithoutVectors()) return;
    installFakeEmbeddings(FAKE_DIMS);

    const res = await semanticSearchTool.handler(
      {
        query: 'lecture schedule semester',
        folder: 'INBOX',
        limit: 3,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );

    const body = res.structuredContent as {
      emails: { subject: string | null; score: number }[];
      pending_index: number;
    };
    expect(res.isError).not.toBe(true);
    expect(body.pending_index).toBe(0);
    expect(body.emails[0]?.subject).toBe('Lecture schedule for spring semester');
    expect(body.emails[0]?.score).toBeGreaterThan(0);
  });

  it('drops a deleted message from the index', async () => {
    if (skipWithoutVectors()) return;
    installFakeEmbeddings(FAKE_DIMS);

    const before = await semanticSearchTool.handler(
      {
        query: 'parcel courier delivery',
        folder: 'INBOX',
        limit: 5,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    const target = (
      before.structuredContent as { emails: { uid: number; subject: string | null }[] }
    ).emails.find((e) => e.subject === 'Your parcel is on its way');
    expect(target).toBeDefined();
    if (!target) return;

    await deleteEmailTool.handler(
      { folder: 'INBOX', uid: target.uid, hard_delete: true },
      harness.ctx,
    );

    const after = await semanticSearchTool.handler(
      {
        query: 'parcel courier delivery',
        folder: 'INBOX',
        limit: 5,
        max_staleness_seconds: 60,
        response_format: 'json',
      },
      harness.ctx,
    );
    const uids = (after.structuredContent as { emails: { uid: number }[] }).emails.map(
      (e) => e.uid,
    );
    expect(uids).not.toContain(target.uid);
  });
});
