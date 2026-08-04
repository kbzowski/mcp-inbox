import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../../src/config/env';

const BASE_ENV = {
  IMAP_USER: 'me@example.com',
  IMAP_PASSWORD: 'secret',
  IMAP_HOST: 'imap.example.com',
};

describe('embeddings config', () => {
  it('is null when no base url is set', () => {
    expect(loadConfig(BASE_ENV).embeddings).toBeNull();
  });

  it('treats an empty base url as unset', () => {
    expect(loadConfig({ ...BASE_ENV, IMAP_EMBEDDINGS_BASE_URL: '' }).embeddings).toBeNull();
  });

  it('enables on base url alone, with defaults and no api key', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      IMAP_EMBEDDINGS_BASE_URL: 'https://llm.example.com/v1',
    }).embeddings;

    expect(cfg).toEqual({
      baseUrl: 'https://llm.example.com/v1',
      model: 'arctic-embed-l-v2',
      dims: 1024,
      batchSize: 64,
      timeoutMs: 30_000,
    });
    expect(cfg).not.toHaveProperty('apiKey');
  });

  it('strips trailing slashes so the request path never doubles up', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      IMAP_EMBEDDINGS_BASE_URL: 'https://llm.example.com/v1//',
    }).embeddings;

    expect(cfg?.baseUrl).toBe('https://llm.example.com/v1');
  });

  it('carries overrides through', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      IMAP_EMBEDDINGS_BASE_URL: 'https://llm.example.com/v1',
      IMAP_EMBEDDINGS_API_KEY: 'sk-test',
      IMAP_EMBEDDINGS_MODEL: 'other-model',
      IMAP_EMBEDDINGS_DIMS: '768',
      IMAP_EMBEDDINGS_BATCH_SIZE: '8',
      IMAP_EMBEDDINGS_TIMEOUT_MS: '1000',
    }).embeddings;

    expect(cfg).toEqual({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-test',
      model: 'other-model',
      dims: 768,
      batchSize: 8,
      timeoutMs: 1000,
    });
  });

  it('rejects a non-url base url', () => {
    expect(() => loadConfig({ ...BASE_ENV, IMAP_EMBEDDINGS_BASE_URL: 'not-a-url' })).toThrow(
      /Invalid configuration/,
    );
  });
});
