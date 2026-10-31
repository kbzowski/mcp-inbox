import { z } from 'zod';
import type { EmbeddingsConfig } from '../config/env';
import { EmbeddingError } from '../errors/types';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp-inbox:embeddings');

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

const EmbeddingsResponse = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

/**
 * The exact text projected into a vector. Exported so the indexer and any
 * future re-indexer provably embed the same thing - a drift here silently
 * degrades recall instead of failing.
 */
export function envelopeText(email: { subject: string | null; fromAddr: string | null }): string {
  return `Subject: ${email.subject ?? ''}\nFrom: ${email.fromAddr ?? ''}`;
}

export async function embedTexts(
  texts: readonly string[],
  cfg: EmbeddingsConfig,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize);
    out.push(...(await embedBatch(batch, cfg)));
  }
  return out;
}

async function embedBatch(batch: string[], cfg: EmbeddingsConfig): Promise<Float32Array[]> {
  const response = await postWithRetry(batch, cfg);

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new EmbeddingError(
      'EMBEDDING_UNREACHABLE',
      `The embeddings endpoint at ${cfg.baseUrl} returned a non-JSON response. Check IMAP_EMBEDDINGS_BASE_URL points at an OpenAI-compatible API.`,
      err,
    );
  }

  const parsed = EmbeddingsResponse.safeParse(body);
  if (!parsed.success) {
    throw new EmbeddingError(
      'EMBEDDING_UNREACHABLE',
      `The embeddings endpoint at ${cfg.baseUrl} returned an unexpected response shape. Check that IMAP_EMBEDDINGS_MODEL="${cfg.model}" is an embedding model, not a chat model.`,
      parsed.error,
    );
  }

  // OpenAI-compatible servers may return results out of order; pairing them
  // back by position instead of by `index` would silently attach the wrong
  // vector to a message.
  const ordered = parsed.data.data.toSorted((a, b) => a.index - b.index);
  if (ordered.length !== batch.length) {
    throw new EmbeddingError(
      'EMBEDDING_UNREACHABLE',
      `Asked the embeddings endpoint for ${batch.length} vectors but received ${ordered.length}.`,
    );
  }

  return ordered.map((item) => {
    if (item.embedding.length !== cfg.dims) {
      throw new EmbeddingError(
        'EMBEDDING_DIM_MISMATCH',
        `Model "${cfg.model}" returned ${item.embedding.length}-dimensional vectors but IMAP_EMBEDDINGS_DIMS is ${cfg.dims}. Set IMAP_EMBEDDINGS_DIMS=${item.embedding.length} and re-run imap_index_folder.`,
      );
    }
    return Float32Array.from(item.embedding);
  });
}

async function postWithRetry(batch: string[], cfg: EmbeddingsConfig): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey !== undefined && { authorization: `Bearer ${cfg.apiKey}` }),
        },
        body: JSON.stringify({ model: cfg.model, input: batch, encoding_format: 'float' }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) return response;

    if (response.status === 401 || response.status === 403) {
      throw new EmbeddingError(
        'EMBEDDING_AUTH_FAILED',
        `The embeddings endpoint at ${cfg.baseUrl} rejected the credentials (HTTP ${response.status}). Check IMAP_EMBEDDINGS_API_KEY.`,
      );
    }

    // Never surface the response body to the model - an echoing endpoint
    // could reflect the API key back into the conversation.
    lastError = new Error(`HTTP ${response.status}: ${(await safeText(response)).slice(0, 200)}`);

    if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) break;

    log.debug('embeddings request failed, retrying', { status: response.status, attempt });
    await sleep(retryAfterMs(response) ?? backoffMs(attempt));
  }

  throw new EmbeddingError(
    'EMBEDDING_UNREACHABLE',
    `Could not reach the embeddings endpoint at ${cfg.baseUrl} after ${MAX_ATTEMPTS} attempts. Check IMAP_EMBEDDINGS_BASE_URL and that the service is up.`,
    lastError,
  );
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
