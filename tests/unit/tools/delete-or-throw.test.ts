import { describe, expect, it } from 'vitest';
import { ImapError } from '@/errors/types';
import { deleteOrThrow } from '@/tools/emails/shared';

function imapReturning(result: unknown) {
  return { messageDelete: () => Promise.resolve(result) } as never;
}

describe('deleteOrThrow', () => {
  it('resolves when the server deleted the message', async () => {
    await expect(deleteOrThrow(imapReturning(true), 'INBOX', '1')).resolves.toBeUndefined();
  });

  it.each([false, undefined])('throws when messageDelete returns %s', async (result) => {
    await expect(deleteOrThrow(imapReturning(result), 'INBOX', '1')).rejects.toBeInstanceOf(
      ImapError,
    );
  });
});
