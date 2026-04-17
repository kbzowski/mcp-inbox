import { describe, it, expect } from 'vitest';
import { formatFoldersMarkdown, formatEmailListMarkdown } from '../../../src/formatters/markdown';
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

describe('formatEmailListMarkdown', () => {
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
      modseq: 1,
      cachedAt: 0,
      bodyCachedAt: null,
      ...overrides,
    };
  }

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
