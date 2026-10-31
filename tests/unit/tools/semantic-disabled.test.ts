import { describe, it, expect } from 'vitest';
import type { ToolContext } from '../../../src/tools/define-tool';
import { indexFolderTool } from '../../../src/tools/emails/index-folder';
import { semanticSearchTool } from '../../../src/tools/emails/semantic-search';
import { fakeConfig } from '../helpers/fake-embeddings';

/**
 * The IMAP stub rejects every connection, so any handler that reaches the
 * network before refusing fails this test rather than passing quietly.
 */
function offlineContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    db: {} as ToolContext['db'],
    imap: { connection: () => Promise.reject(new Error('network access attempted')) },
    smtp: {},
    cacheConfig: { dir: '/tmp', defaultStalenessSec: 60, bodyRetainDays: 180 },
    embeddings: null,
    vectorsAvailable: true,
    defaults: { fromAddress: 'me@example.com' },
    now: () => 1_000,
    ...overrides,
  } as unknown as ToolContext;
}

const cases = [
  { name: 'imap_index_folder', tool: indexFolderTool, args: { folder: 'INBOX' } },
  {
    name: 'imap_semantic_search',
    tool: semanticSearchTool,
    args: { query: 'anything', folder: 'INBOX' },
  },
] as const;

describe('semantic tools degrade instead of breaking', () => {
  for (const { name, tool } of cases) {
    it(`${name} refuses when embeddings are not configured`, async () => {
      const ctx = offlineContext({ embeddings: null });
      const args = tool.inputSchema.parse({ folder: 'INBOX', query: 'anything' }) as never;

      const err = await tool.handler(args, ctx).catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'EMBEDDING_DISABLED' });
      expect((err as { userMessage: string }).userMessage).toMatch(/imap_search_emails/);
    });

    it(`${name} refuses when sqlite-vec is unavailable on this platform`, async () => {
      const ctx = offlineContext({ embeddings: fakeConfig, vectorsAvailable: false });
      const args = tool.inputSchema.parse({ folder: 'INBOX', query: 'anything' }) as never;

      const err = await tool.handler(args, ctx).catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'EMBEDDING_INDEX_UNAVAILABLE' });
      expect((err as { userMessage: string }).userMessage).toMatch(/imap_search_emails/);
    });
  }

  it('both tools are exposed regardless of platform support', () => {
    expect(cases.map((c) => c.tool.name)).toEqual(['imap_index_folder', 'imap_semantic_search']);
  });
});
