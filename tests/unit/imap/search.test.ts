import { describe, it, expect } from 'vitest';
import { buildImapSearch } from '../../../src/imap/search';

describe('buildImapSearch', () => {
  it('returns { all: true } when no criteria are provided', () => {
    expect(buildImapSearch({})).toEqual({ all: true });
  });

  it('passes subject/from/to/body through verbatim', () => {
    const result = buildImapSearch({
      subject: 'invoice',
      from: 'alice@example.com',
      to: 'bob@example.com',
      body: 'refund',
    });
    expect(result).toEqual({
      subject: 'invoice',
      from: 'alice@example.com',
      to: 'bob@example.com',
      body: 'refund',
    });
  });

  it('translates unseen=true to seen=false (no dedicated `unseen` field in SearchObject)', () => {
    expect(buildImapSearch({ unseen: true })).toEqual({ seen: false });
  });

  it('leaves seen unfiltered when unseen=false', () => {
    // false means "do not filter by seen-ness", not "only seen"
    expect(buildImapSearch({ unseen: false })).toEqual({ all: true });
  });

  it('combines unseen with since (fixes the v1 filter-overwrite bug)', () => {
    // In v1 index.js, since_date overwrote unseen. Here both must coexist.
    const since = new Date('2026-04-01T00:00:00Z');
    expect(buildImapSearch({ unseen: true, since })).toEqual({
      seen: false,
      since,
    });
  });

  it('accepts Date instances for since/before (not ISO strings)', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const before = new Date('2026-02-01T00:00:00Z');
    const result = buildImapSearch({ since, before });
    expect(result.since).toBe(since);
    expect(result.before).toBe(before);
  });

  it('drops falsy string fields (empty string is not a filter)', () => {
    expect(buildImapSearch({ subject: '', from: '' })).toEqual({ all: true });
  });

  it('does not emit `all: true` when at least one criterion is present', () => {
    expect(buildImapSearch({ subject: 'test' })).not.toHaveProperty('all');
  });

  describe('combinators', () => {
    it('passes larger_than_bytes / smaller_than_bytes through as `larger` / `smaller`', () => {
      expect(buildImapSearch({ larger_than_bytes: 1024 })).toEqual({ larger: 1024 });
      expect(buildImapSearch({ smaller_than_bytes: 500 })).toEqual({ smaller: 500 });
    });

    it('recursively translates `or` with 2 sub-criteria into a SearchObject[] array', () => {
      const result = buildImapSearch({
        or: [{ from: 'alice@example.com' }, { from: 'bob@example.com' }],
      });
      expect(result.or).toEqual([{ from: 'alice@example.com' }, { from: 'bob@example.com' }]);
    });

    it('recursively translates `not` into a SearchObject wrapper', () => {
      const result = buildImapSearch({ not: { subject: 'newsletter' } });
      expect(result.not).toEqual({ subject: 'newsletter' });
    });

    it('combines top-level AND fields with `or` (natural AND-of-OR)', () => {
      const result = buildImapSearch({
        subject: 'invoice',
        or: [{ from: 'acme.com' }, { from: 'beta.com' }],
      });
      expect(result.subject).toBe('invoice');
      expect(result.or).toHaveLength(2);
      expect(result.all).toBeUndefined();
    });

    it('handles nested combinators (or inside not)', () => {
      const result = buildImapSearch({
        not: {
          or: [{ from: 'noreply@example.com' }, { from: 'donotreply@example.com' }],
        },
      });
      expect(result.not).toBeDefined();
      const nested = result.not as { or?: unknown[] };
      expect(nested.or).toHaveLength(2);
    });
  });
});
