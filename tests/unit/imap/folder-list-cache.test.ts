import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ListResponse } from 'imapflow';
import { ImapClient } from '@/imap/client';

const ROWS = [{ path: 'INBOX', specialUse: undefined }] as unknown as ListResponse[];

interface Fake {
  client: ImapClient;
  calls: () => number;
}

function clientWithFakeFlow(): Fake {
  let calls = 0;
  const flow = {
    usable: true,
    list: () => {
      calls += 1;
      return Promise.resolve(ROWS);
    },
  };

  const client = new ImapClient({} as never);
  // Stand in for a live connection without opening a socket.
  Object.defineProperty(client, 'connection', {
    value: () => Promise.resolve(flow),
    writable: true,
  });

  return { client, calls: () => calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImapClient.folderList', () => {
  it('issues one LIST and serves the rest from cache', async () => {
    const fake = clientWithFakeFlow();

    for (let i = 0; i < 5; i++) await fake.client.folderList();

    expect(fake.calls()).toBe(1);
  });

  it('returns the same rows the server sent', async () => {
    const fake = clientWithFakeFlow();
    await expect(fake.client.folderList()).resolves.toEqual(ROWS);
  });

  it('re-issues LIST once the entry is older than maxAgeMs', async () => {
    vi.useFakeTimers();
    const fake = clientWithFakeFlow();

    await fake.client.folderList(60_000);
    vi.advanceTimersByTime(59_000);
    await fake.client.folderList(60_000);
    expect(fake.calls()).toBe(1);

    vi.advanceTimersByTime(2_000);
    await fake.client.folderList(60_000);
    expect(fake.calls()).toBe(2);
  });

  it('a zero window disables caching', async () => {
    const fake = clientWithFakeFlow();

    await fake.client.folderList(0);
    await fake.client.folderList(0);

    expect(fake.calls()).toBe(2);
  });
});
