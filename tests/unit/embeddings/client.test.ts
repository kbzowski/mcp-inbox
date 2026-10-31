import { describe, it, expect, vi, afterEach } from 'vitest';
import { embedTexts, envelopeText } from '../../../src/embeddings/client';
import { EmbeddingError } from '../../../src/errors/types';
import { fakeConfig, FAKE_DIMS, installFakeEmbeddings } from '../helpers/fake-embeddings';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function vector(fill: number): number[] {
  return Array.from({ length: FAKE_DIMS }, () => fill);
}

describe('embeddings client', () => {
  it('splits input into batches of batchSize', async () => {
    const { batches } = installFakeEmbeddings();
    const texts = Array.from({ length: 150 }, (_, i) => `message ${i}`);

    const vectors = await embedTexts(texts, fakeConfig);

    expect(vectors).toHaveLength(150);
    expect(batches.map((b) => b.length)).toEqual([64, 64, 22]);
  });

  it('reassociates vectors by index when the server answers out of order', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        jsonResponse({
          data: [
            { index: 2, embedding: vector(0.3) },
            { index: 0, embedding: vector(0.1) },
            { index: 1, embedding: vector(0.2) },
          ],
        }),
      ),
    );

    const vectors = await embedTexts(['a', 'b', 'c'], fakeConfig);

    expect(vectors[0]?.[0]).toBeCloseTo(0.1);
    expect(vectors[1]?.[0]).toBeCloseTo(0.2);
    expect(vectors[2]?.[0]).toBeCloseTo(0.3);
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' })
          : jsonResponse({ data: [{ index: 0, embedding: vector(0.5) }] }),
      );
    });

    const vectors = await embedTexts(['a'], fakeConfig);

    expect(calls).toBe(2);
    expect(vectors).toHaveLength(1);
  });

  it('maps 401 to EMBEDDING_AUTH_FAILED without retrying', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve(jsonResponse({ error: 'nope' }, 401));
    });

    await expect(embedTexts(['a'], fakeConfig)).rejects.toMatchObject({
      code: 'EMBEDDING_AUTH_FAILED',
    });
    expect(calls).toBe(1);
  });

  it('rejects a dimension mismatch and names both numbers', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        jsonResponse({ data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }] }),
      ),
    );

    const err = await embedTexts(['a'], fakeConfig).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).code).toBe('EMBEDDING_DIM_MISMATCH');
    expect((err as EmbeddingError).userMessage).toContain('768');
    expect((err as EmbeddingError).userMessage).toContain(String(FAKE_DIMS));
  });

  it('maps a network failure to EMBEDDING_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    await expect(embedTexts(['a'], fakeConfig)).rejects.toMatchObject({
      code: 'EMBEDDING_UNREACHABLE',
    });
  });

  it('omits the authorization header when no api key is configured', async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return Promise.resolve(jsonResponse({ data: [{ index: 0, embedding: vector(0.5) }] }));
    });

    await embedTexts(['a'], fakeConfig);

    expect(seen).not.toHaveProperty('authorization');
  });

  it('sends a bearer token when an api key is configured', async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return Promise.resolve(jsonResponse({ data: [{ index: 0, embedding: vector(0.5) }] }));
    });

    await embedTexts(['a'], { ...fakeConfig, apiKey: 'sk-test' });

    expect(seen['authorization']).toBe('Bearer sk-test');
  });

  it('does not call the endpoint for an empty input list', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(embedTexts([], fakeConfig)).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projects subject and sender into the embedded text', () => {
    expect(envelopeText({ subject: 'Faktura', fromAddr: 'billing@example.com' })).toBe(
      'Subject: Faktura\nFrom: billing@example.com',
    );
    expect(envelopeText({ subject: null, fromAddr: null })).toBe('Subject: \nFrom: ');
  });
});
