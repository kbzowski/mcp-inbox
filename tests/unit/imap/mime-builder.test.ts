import { describe, it, expect } from 'vitest';
import { simpleParser, type AddressObject } from 'mailparser';
import { buildRawMessage } from '../../../src/imap/mime-builder.js';

/** Narrow mailparser's `AddressObject | AddressObject[]` to a text blob. */
function addrText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return '';
  return Array.isArray(a) ? a.map((x) => x.text).join(', ') : a.text;
}

/**
 * Round-trip tests: build a message with nodemailer, parse it back with
 * mailparser, and assert the fields survive intact. This catches encoding
 * regressions for non-ASCII subjects, long bodies, threading headers, etc.
 */
describe('buildRawMessage', () => {
  it('produces a parseable RFC 2822 buffer for a plain-text message', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Hello',
      text: 'Hi Bob.',
    });

    expect(Buffer.isBuffer(raw)).toBe(true);

    const parsed = await simpleParser(raw);
    expect(addrText(parsed.from)).toContain('alice@example.com');
    expect(addrText(parsed.to)).toContain('bob@example.com');
    expect(parsed.subject).toBe('Hello');
    expect(parsed.text?.trim()).toBe('Hi Bob.');
  });

  it('round-trips non-ASCII subjects (RFC 2047 encoded-word)', async () => {
    // The v1 code path built headers by string concat, which silently
    // mangled non-ASCII. Nodemailer emits `=?utf-8?B?...?=` correctly.
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Faktura za kwiecień — 🧾 #12/2026',
      text: 'Szczegóły w załączeniu.',
    });

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('Faktura za kwiecień — 🧾 #12/2026');
    expect(parsed.text?.trim()).toBe('Szczegóły w załączeniu.');
  });

  it('preserves threading headers required for replies', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Re: Budget',
      text: 'Looks good.',
      inReplyTo: '<original-message-id@example.com>',
      references: ['<earlier@example.com>', '<original-message-id@example.com>'],
    });

    const parsed = await simpleParser(raw);
    expect(parsed.inReplyTo).toBe('<original-message-id@example.com>');
    // mailparser returns `references` as string or string[]; normalize.
    const refs = Array.isArray(parsed.references) ? parsed.references : [parsed.references];
    expect(refs).toContain('<original-message-id@example.com>');
    expect(refs).toContain('<earlier@example.com>');
  });

  it('builds multipart/alternative when both text and html are provided', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Both',
      text: 'plain version',
      html: '<p>html version</p>',
    });

    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe('plain version');
    expect(parsed.html).toContain('html version');
  });

  it('handles multiple recipients in to/cc', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: ['bob@example.com', 'carol@example.com'],
      cc: 'dave@example.com',
      subject: 'Team update',
      text: 'hi all',
    });

    const parsed = await simpleParser(raw);
    expect(addrText(parsed.to)).toContain('bob@example.com');
    expect(addrText(parsed.to)).toContain('carol@example.com');
    expect(addrText(parsed.cc)).toContain('dave@example.com');
  });

  it('auto-generates a Message-ID', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Test',
      text: 'body',
    });
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toMatch(/^<.+@.+>$/);
  });
});
