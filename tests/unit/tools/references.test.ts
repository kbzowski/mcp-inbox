import { describe, it, expect } from 'vitest';
import { mergeReferences } from '@/tools/send/reply';

const PARENT = '<parent@example.com>';

describe('mergeReferences', () => {
  it('falls back to the parent Message-ID alone when no header came back', () => {
    expect(mergeReferences(null, PARENT)).toEqual([PARENT]);
  });

  it('returns nothing when there is neither a header nor a parent', () => {
    expect(mergeReferences(null, undefined)).toEqual([]);
  });

  it('appends the parent to an existing chain, preserving order', () => {
    const header = 'References: <a@x> <b@x> <c@x>';
    expect(mergeReferences(header, PARENT)).toEqual(['<a@x>', '<b@x>', '<c@x>', PARENT]);
  });

  it('parses a folded header into discrete tokens', () => {
    const header = 'References: <a@x>\r\n\t<b@x>\r\n <c@x>\r\n';
    expect(mergeReferences(header, PARENT)).toEqual(['<a@x>', '<b@x>', '<c@x>', PARENT]);
  });

  it('does not duplicate a parent already present in the chain', () => {
    const header = `References: <a@x> ${PARENT}`;
    expect(mergeReferences(header, PARENT)).toEqual(['<a@x>', PARENT]);
  });

  it('keeps the thread root and trims the middle when over the cap', () => {
    const header = `References: ${Array.from({ length: 30 }, (_, i) => `<r${String(i)}@x>`).join(' ')}`;
    const out = mergeReferences(header, PARENT, 5);

    expect(out).toHaveLength(5);
    expect(out[0]).toBe('<r0@x>');
    expect(out.at(-1)).toBe(PARENT);
    expect(out).toEqual(['<r0@x>', '<r27@x>', '<r28@x>', '<r29@x>', PARENT]);
  });

  it('leaves a chain exactly at the cap untouched', () => {
    const header = 'References: <a@x> <b@x> <c@x>';
    expect(mergeReferences(header, PARENT, 4)).toEqual(['<a@x>', '<b@x>', '<c@x>', PARENT]);
  });

  it('ignores text that is not an angle-bracketed message id', () => {
    expect(mergeReferences('References: garbage no brackets', PARENT)).toEqual([PARENT]);
  });
});
