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
});
