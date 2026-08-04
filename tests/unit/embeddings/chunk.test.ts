import { describe, it, expect } from 'vitest';
import { stripQuoted, chunkText, bodyChunks } from '@/embeddings/chunk';

const LEAD = 'To jest moja własna odpowiedź na Twoje pytanie. '.repeat(6);

describe('stripQuoted', () => {
  it('cuts at an English reply header', () => {
    const out = stripQuoted(
      `${LEAD}\n\nOn Mon, 3 Mar 2025 at 10:00, Bob <b@x> wrote:\n> old text`,
      null,
    );
    expect(out).toBe(LEAD.trim());
  });

  it('cuts at a Polish reply header', () => {
    const out = stripQuoted(`${LEAD}\n\nW dniu 2025-03-03 o 10:00, Bob napisał(a):\n> stare`, null);
    expect(out).toBe(LEAD.trim());
  });

  it('cuts at "Dnia ... pisze:"', () => {
    const out = stripQuoted(`${LEAD}\n\nDnia 3 marca 2025 Bob pisze:\n> stare`, null);
    expect(out).toBe(LEAD.trim());
  });

  it('cuts at a Polish original-message separator', () => {
    const out = stripQuoted(`${LEAD}\n\n-----Wiadomość oryginalna-----\nstare`, null);
    expect(out).toBe(LEAD.trim());
  });

  it('cuts at an Outlook header block', () => {
    const out = stripQuoted(
      `${LEAD}\n\nOd: bob@x\nWysłano: 3 marca\nDo: me@x\nTemat: cokolwiek`,
      null,
    );
    expect(out).toBe(LEAD.trim());
  });

  it('cuts at a bare quote marker with no header line', () => {
    expect(stripQuoted(`${LEAD}\n> cytat`, null)).toBe(LEAD.trim());
  });

  it('does not cut a From: line with no sibling headers after it', () => {
    const text = `${LEAD}\nFrom: this is prose, not a header block\nmore prose`;
    expect(stripQuoted(text, null)).toBe(text);
  });

  it('keeps everything when the subject marks a forward', () => {
    const text = 'FYI\n\nOn Mon, 3 Mar 2025 at 10:00, Bob wrote:\n> the actual content';
    for (const subject of ['Fwd: raport', 'FW: raport', 'PD: raport', 'Re: Fwd: raport']) {
      expect(stripQuoted(text, subject)).toBe(text);
    }
  });

  it('falls back to the full text when stripping leaves too little', () => {
    const text = 'FYI\n\nOn Mon, 3 Mar 2025 at 10:00, Bob wrote:\n> the actual content';
    expect(stripQuoted(text, 'jakiś temat')).toBe(text);
  });

  it('returns the text unchanged when there is nothing to cut', () => {
    expect(stripQuoted(LEAD, null)).toBe(LEAD);
  });
});

function paragraph(n: number): string {
  return `Akapit numer ${String(n)}. ${'Treść zdania. '.repeat(20)}`;
}

describe('chunkText', () => {
  const long = Array.from({ length: 20 }, (_, i) => paragraph(i)).join('\n\n');

  it('returns nothing for empty or whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short body as a single chunk', () => {
    const short = 'Krótka wiadomość o wystarczającej długości, żeby przejść próg minimalny.';
    expect(chunkText(short)).toEqual([short]);
  });

  it('splits a long body into several chunks', () => {
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(10);
  });

  it('overlaps consecutive chunks', () => {
    const chunks = chunkText(long);
    const second = chunks[1];
    expect(second).toBeDefined();
    const head = second!.slice(0, 40);
    expect(chunks[0]).toContain(head);
  });

  it('never splits in the middle of a word', () => {
    const runOn = 'wyraz '.repeat(2000);
    for (const chunk of chunkText(runOn)) {
      expect(chunk.startsWith('yraz')).toBe(false);
      expect(chunk.endsWith('wyra')).toBe(false);
    }
  });

  it('caps at ten chunks however long the body is', () => {
    const huge = Array.from({ length: 400 }, (_, i) => paragraph(i)).join('\n\n');
    expect(chunkText(huge)).toHaveLength(10);
  });

  it('drops a chunk that is only a stray signature line', () => {
    expect(chunkText('Pozdrawiam')).toEqual([]);
  });
});

describe('bodyChunks', () => {
  it('strips before chunking', () => {
    const chunks = bodyChunks(`${LEAD}\n\nOn Mon wrote:\n> ${'stary cytat '.repeat(200)}`, null);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain('stary cytat');
  });
});
