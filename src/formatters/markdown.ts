import type { Email } from '../cache/schema.js';

export interface FolderSummary {
  path: string;
  delimiter: string;
  specialUse: string | null;
  flags?: string[];
}

export function formatFoldersMarkdown(folders: readonly FolderSummary[]): string {
  if (folders.length === 0) return '_No folders._';
  const lines: string[] = ['| Path | Delimiter | Special-use |', '|---|---|---|'];
  for (const f of folders) {
    lines.push(`| \`${f.path}\` | \`${f.delimiter}\` | ${f.specialUse ?? '-'} |`);
  }
  return lines.join('\n');
}

/**
 * Compact one-email-per-row summary. Unseen messages are bolded so the
 * agent can scan inbox status at a glance.
 */
export function formatEmailListMarkdown(emails: readonly Email[]): string {
  if (emails.length === 0) return '_No emails match._';

  const lines: string[] = [
    '| # | Flags | From | Subject | Date | UID |',
    '|---|---|---|---|---|---|',
  ];
  emails.forEach((e, i) => {
    const date = e.date ? new Date(e.date).toISOString().slice(0, 16).replace('T', ' ') : '';
    const unseen = !e.flags.includes('\\Seen');
    const flagMarks =
      (unseen ? 'UNSEEN ' : '') +
      (e.flags.includes('\\Flagged') ? '★ ' : '') +
      (e.hasAttachments ? '📎' : '');
    const subject = (e.subject ?? '').replace(/\|/g, '\\|');
    const from = (e.fromAddr ?? '').replace(/\|/g, '\\|');
    const row = `| ${i + 1} | ${flagMarks.trim()} | ${from} | ${subject} | ${date} | ${e.uid} |`;
    lines.push(unseen ? `**${row}**` : row);
  });
  return lines.join('\n');
}
