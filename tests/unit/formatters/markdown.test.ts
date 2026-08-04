import { describe, it, expect } from 'vitest';
import {
  formatFoldersMarkdown,
  formatEmailListMarkdown,
  formatSemanticResultsMarkdown,
  type RankedEmailSummary,
} from '../../../src/formatters/markdown';
import type { Email } from '../../../src/cache/schema';

describe('formatFoldersMarkdown', () => {
  it('renders an empty list with a placeholder', () => {
    expect(formatFoldersMarkdown([])).toBe('_No folders._');
  });

  it('renders special-use attribute when present, dash otherwise', () => {
    const out = formatFoldersMarkdown([
      { path: 'INBOX', delimiter: '/', specialUse: null },
      { path: '[Gmail]/Sent Mail', delimiter: '/', specialUse: '\\Sent' },
    ]);
    expect(out).toContain('| `INBOX` | `/` | - |');
    expect(out).toContain('| `[Gmail]/Sent Mail` | `/` | \\Sent |');
  });
});

function email(overrides: Partial<Email> = {}): Email {
  return {
    folder: 'INBOX',
    uid: 1,
    messageId: '<m@example.com>',
    subject: 'Test',
    fromAddr: 'alice@example.com',
    toAddrs: ['bob@example.com'],
    ccAddrs: null,
    date: new Date('2026-04-17T08:00:00Z').getTime(),
    flags: ['\\Seen'],
    hasAttachments: false,
    envelopeJson: '{}',
    bodyText: null,
    bodyHtml: null,
    attachmentsJson: null,
    modseq: 1,
    cachedAt: 0,
    bodyCachedAt: null,
    ...overrides,
  };
}

describe('formatEmailListMarkdown', () => {
  it('returns placeholder for empty list', () => {
    expect(formatEmailListMarkdown([])).toBe('_No emails match._');
  });

  it('bolds unseen rows', () => {
    const out = formatEmailListMarkdown([email({ flags: [] })]);
    expect(out).toMatch(/\*\*\|.*UNSEEN.*\*\*/);
  });

  it('leaves seen rows unbolded', () => {
    const out = formatEmailListMarkdown([email({ flags: ['\\Seen'] })]);
    // No surrounding ** on the data row.
    const lines = out.split('\n').filter((l) => l.startsWith('|'));
    const dataRow = lines[2];
    expect(dataRow?.startsWith('**')).toBe(false);
  });

  it('shows star for flagged and paperclip for attachments', () => {
    const out = formatEmailListMarkdown([
      email({ flags: ['\\Seen', '\\Flagged'], hasAttachments: true }),
    ]);
    expect(out).toMatch(/★/);
    expect(out).toMatch(/📎/);
  });

  it('escapes pipe characters in subject and from (cell separator collision)', () => {
    const out = formatEmailListMarkdown([
      email({ subject: 'Question | request', fromAddr: 'x|y@example.com' }),
    ]);
    expect(out).toContain('Question \\| request');
    expect(out).toContain('x\\|y@example.com');
  });
});

function ranked(overrides: Partial<RankedEmailSummary> = {}): RankedEmailSummary {
  return {
    uid: 42,
    subject: 'Payment receipt 4417',
    from: 'billing@hosting.example',
    date: '2026-04-17T08:00:00.000Z',
    unseen: false,
    has_attachments: false,
    score: 0.5123,
    ...overrides,
  };
}

describe('formatSemanticResultsMarkdown', () => {
  it('says so when nothing was indexed close enough', () => {
    expect(formatSemanticResultsMarkdown([], 0)).toBe('_No indexed message resembles that query._');
  });

  it('renders the score so the caller can weigh each hit', () => {
    const out = formatSemanticResultsMarkdown([ranked()], 0);
    expect(out).toContain('| # | Score | Flags | From | Subject | Date | UID |');
    expect(out).toContain('| 1 | 0.512 |');
    expect(out).toContain('Payment receipt 4417');
  });

  it('warns that the absolute value is not a threshold', () => {
    const out = formatSemanticResultsMarkdown([ranked()], 0);
    expect(out).toMatch(/judge each result on its own merits/);
  });

  it('preserves rank order rather than re-sorting', () => {
    const out = formatSemanticResultsMarkdown(
      [ranked({ uid: 1, score: 0.9 }), ranked({ uid: 2, score: 0.2 })],
      0,
    );
    expect(out.indexOf('| 1 | 0.900 |')).toBeLessThan(out.indexOf('| 2 | 0.200 |'));
  });

  it('bolds unseen rows and marks attachments', () => {
    const out = formatSemanticResultsMarkdown([ranked({ unseen: true, has_attachments: true })], 0);
    expect(out).toMatch(/\*\*\| 1 \|.*UNSEEN 📎/);
  });

  it('escapes pipes so a subject cannot break the table', () => {
    const out = formatSemanticResultsMarkdown([ranked({ subject: 'a | b' })], 0);
    expect(out).toContain(String.raw`a \| b`);
  });

  it('mentions pending messages only when some remain', () => {
    expect(formatSemanticResultsMarkdown([ranked()], 7)).toContain('7 message(s)');
    expect(formatSemanticResultsMarkdown([ranked()], 0)).not.toContain('not yet indexed');
  });

  it('tolerates a null date and null subject', () => {
    expect(() =>
      formatSemanticResultsMarkdown([ranked({ date: null, subject: null, from: null })], 0),
    ).not.toThrow();
  });
});
