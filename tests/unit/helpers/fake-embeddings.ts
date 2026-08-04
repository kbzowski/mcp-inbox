import { vi } from 'vitest';
import type { EmbeddingsConfig } from '../../../src/config/env';

export const FAKE_DIMS = 32;

export const fakeConfig: EmbeddingsConfig = {
  baseUrl: 'https://embeddings.test/v1',
  model: 'fake-embed',
  dims: FAKE_DIMS,
  batchSize: 64,
  timeoutMs: 5_000,
  sweepMinutes: 0,
  sweepBatch: 200,
};

/**
 * Deterministic bag-of-tokens vector: texts sharing words land near each
 * other, so nearest-neighbour assertions mean something without a network
 * call or a real model.
 */
export function fakeVector(text: string, dims: number = FAKE_DIMS): Float32Array {
  const raw = Array.from({ length: dims }, () => 0);
  for (const token of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dims;
    raw[bucket] = (raw[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Float32Array.from(raw, (x) => x / norm);
}

/**
 * Stub `fetch` with an OpenAI-compatible embeddings endpoint. Returns the
 * recorded request bodies so tests can assert on batching.
 */
export function installFakeEmbeddings(dims: number = FAKE_DIMS): { batches: string[][] } {
  const batches: string[][] = [];

  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { input: string[] };
    batches.push(body.input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: body.input.map((text, index) => ({
            index,
            embedding: [...fakeVector(text, dims)],
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  return { batches };
}
