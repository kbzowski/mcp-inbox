import type { Email } from '../cache/schema';

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

export interface RankedEmailSummary {
  uid: number;
  subject: string | null;
  from: string | null;
  date: string | null;
  unseen: boolean;
  has_attachments: boolean;
  score: number;
}

/**
 * Semantic-search results, scores included.
 *
 * The score column is the point: this tool never filters, so the caller has
 * to judge relevance itself, and a ranked list without scores gives it
 * nothing to judge with. The trailing note exists because the absolute
 * values mislead - the model rates even strong matches around 0.4-0.6, so a
 * naive reader would discard good hits against an intuitive threshold.
 */
export function formatSemanticResultsMarkdown(
  rows: readonly RankedEmailSummary[],
  pendingIndex: number,
): string {
  if (rows.length === 0) return '_No indexed message resembles that query._';

  const lines: string[] = [
    '| # | Score | Flags | From | Subject | Date | UID |',
    '|---|---|---|---|---|---|---|',
  ];
  rows.forEach((r, i) => {
    const marks = (r.unseen ? 'UNSEEN ' : '') + (r.has_attachments ? '📎' : '');
    const subject = (r.subject ?? '').replace(/\|/g, '\\|');
    const from = (r.from ?? '').replace(/\|/g, '\\|');
    const date = r.date === null ? '' : r.date.slice(0, 16).replace('T', ' ');
    const row = `| ${i + 1} | ${r.score.toFixed(3)} | ${marks.trim()} | ${from} | ${subject} | ${date} | ${r.uid} |`;
    lines.push(r.unseen ? `**${row}**` : row);
  });

  lines.push(
    '',
    '_Scores are relative cosine similarity, not probabilities: this model rates even strong matches around 0.4-0.6, so judge each result on its own merits rather than against a fixed cutoff. A large gap between consecutive scores says more than any single value._',
  );

  if (pendingIndex > 0) {
    lines.push(
      '',
      `_${pendingIndex} message(s) in this folder are not yet indexed; re-run \`imap_index_folder\` to include them._`,
    );
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
