import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapError } from '../../../src/errors/types';
import { LoggerContext } from '../../../src/utils/logger';

function capture(meta: Parameters<ReturnType<LoggerContext['logger']>['error']>[1]) {
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  new LoggerContext().logger('test').error('boom', meta);
  return JSON.parse(String(write.mock.calls.at(-1)?.[0])) as Record<string, unknown> & {
    err: Record<string, unknown>;
  };
}

describe('logger error output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands the whole cause chain, with driver fields', () => {
    const driver = Object.assign(new Error('Command failed'), {
      responseStatus: 'BAD',
      responseText: 'Too long argument',
    });
    const entry = capture({
      folder: 'INBOX',
      err: new ImapError('IMAP_UNKNOWN', 'failed', driver),
    });

    expect(entry['msg']).toBe('boom');
    expect(entry['folder']).toBe('INBOX');
    expect(entry['err']['code']).toBe('IMAP_UNKNOWN');
    expect(entry['err']['stack']).toContain('logger.test');
    expect(entry['err']['cause']).toMatchObject({
      message: 'Command failed',
      responseStatus: 'BAD',
      responseText: 'Too long argument',
    });
  });

  it('leaves out fields that can hold raw message content', () => {
    const driver = Object.assign(new Error('x'), {
      input: 'message body',
      response: '550 raw server reply',
    });
    const { err } = capture({ err: driver });

    expect(err['input']).toBeUndefined();
    expect(err['response']).toBeUndefined();
  });

  it('masks email addresses, as nodemailer puts the SMTP reply in the message', () => {
    const { err } = capture({ err: new Error('550 5.1.1 <jan.kowalski@example.com> unknown') });

    expect(err['message']).toBe('550 5.1.1 <[address]> unknown');
    expect(JSON.stringify(err)).not.toContain('jan.kowalski');
  });

  it('caps long fields, including the message and stack', () => {
    const driver = Object.assign(new Error('M'.repeat(5000)), {
      executedCommand: 'A'.repeat(5000),
    });
    driver.stack = 'S'.repeat(9000);
    const { err } = capture({ err: driver });

    expect(err['executedCommand']).toHaveLength(1000);
    expect(err['message']).toHaveLength(1000);
    expect(err['stack']).toHaveLength(4000);
  });

  it('applies the same rules to non-Error throws and causes', () => {
    const plain = { message: 'plain', code: 'E1', input: 'message body', other: 'raw' };
    expect(capture({ err: plain })['err']).toEqual({ message: 'plain', code: 'E1' });
    expect(capture({ err: 'text' })['err']).toBe('text');

    const { err } = capture({ err: new ImapError('IMAP_UNKNOWN', 'failed', plain) });
    expect(err['cause']).toEqual({ message: 'plain', code: 'E1' });
  });

  it('keeps the per-address errors of an AggregateError', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:993'), {
      code: 'ECONNREFUSED',
      address: '::1',
      port: 993,
    });
    const { err } = capture({ err: new AggregateError([refused], '') });

    expect(err['errors']).toMatchObject([{ code: 'ECONNREFUSED', address: '::1', port: 993 }]);
  });

  it('stops at a cyclic cause and keeps the rest of the entry', () => {
    const cyclic = new Error('loop');
    cyclic.cause = cyclic;
    const entry = capture({ folder: 'INBOX', err: cyclic });

    expect(entry['folder']).toBe('INBOX');
    expect(entry['err']['message']).toBe('loop');
    expect(entry['err']['cause']).toBe('[circular]');
  });

  it('survives a meta it cannot serialize', () => {
    expect(capture({ big: 10n })['big']).toBe('10');

    const data: Record<string, unknown> = {};
    data['self'] = data;
    const entry = capture({ data });
    expect(entry['msg']).toBe('boom');
    expect(entry['logFailure']).toBeDefined();
  });
});
