import { z } from 'zod';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const BooleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const CsvList = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0),
);

const EnvSchema = z
  .object({
    // Required IMAP
    IMAP_USER: z.string().min(1, 'IMAP_USER is required'),
    IMAP_PASSWORD: z.string().min(1, 'IMAP_PASSWORD is required'),
    IMAP_HOST: z.string().min(1, 'IMAP_HOST is required'),

    // Optional IMAP
    IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
    IMAP_TLS: BooleanString.default(true),
    IMAP_TLS_REJECT_UNAUTHORIZED: BooleanString.default(true),
    IMAP_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    // SMTP (optional; defaulted in transform below)
    // `.min(1)` prevents empty-string envs (e.g. `SMTP_HOST=`) from slipping
    // through and defeating the `??` fallback in the transform.
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: BooleanString.default(true),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),

    // Cache
    IMAP_CACHE_DIR: z.string().min(1).optional(),
    IMAP_CACHE_DEFAULT_STALENESS_SEC: z.coerce.number().int().min(0).default(60),
    IMAP_CACHE_BODY_RETAIN_DAYS: z.coerce.number().int().min(0).default(180),

    // Embeddings (semantic search). Gated on BASE_URL rather than API_KEY -
    // a self-hosted endpoint may not require a key at all.
    IMAP_EMBEDDINGS_BASE_URL: z.url().optional(),
    IMAP_EMBEDDINGS_API_KEY: z.string().min(1).optional(),
    IMAP_EMBEDDINGS_MODEL: z.string().min(1).default('arctic-embed-l-v2'),
    IMAP_EMBEDDINGS_DIMS: z.coerce.number().int().min(1).max(8192).default(1024),
    IMAP_EMBEDDINGS_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(64),
    IMAP_EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // IDLE
    IMAP_IDLE_ENABLED: BooleanString.default(true),
    IMAP_IDLE_FOLDERS: CsvList.default(['INBOX']),

    // Debug
    DEBUG: z.string().optional(),
  })
  .transform((raw) => ({
    imap: {
      user: raw.IMAP_USER,
      password: raw.IMAP_PASSWORD,
      host: raw.IMAP_HOST,
      port: raw.IMAP_PORT,
      tls: raw.IMAP_TLS,
      tlsRejectUnauthorized: raw.IMAP_TLS_REJECT_UNAUTHORIZED,
      authTimeoutMs: raw.IMAP_AUTH_TIMEOUT_MS,
    },
    smtp: {
      host: raw.SMTP_HOST ?? raw.IMAP_HOST,
      port: raw.SMTP_PORT,
      secure: raw.SMTP_SECURE,
      user: raw.SMTP_USER ?? raw.IMAP_USER,
      password: raw.SMTP_PASSWORD ?? raw.IMAP_PASSWORD,
    },
    cache: {
      dir: raw.IMAP_CACHE_DIR ?? defaultCacheDir(),
      defaultStalenessSec: raw.IMAP_CACHE_DEFAULT_STALENESS_SEC,
      bodyRetainDays: raw.IMAP_CACHE_BODY_RETAIN_DAYS,
    },
    embeddings:
      raw.IMAP_EMBEDDINGS_BASE_URL === undefined
        ? null
        : {
            baseUrl: raw.IMAP_EMBEDDINGS_BASE_URL.replace(/\/+$/, ''),
            ...(raw.IMAP_EMBEDDINGS_API_KEY !== undefined && {
              apiKey: raw.IMAP_EMBEDDINGS_API_KEY,
            }),
            model: raw.IMAP_EMBEDDINGS_MODEL,
            dims: raw.IMAP_EMBEDDINGS_DIMS,
            batchSize: raw.IMAP_EMBEDDINGS_BATCH_SIZE,
            timeoutMs: raw.IMAP_EMBEDDINGS_TIMEOUT_MS,
          },
    idle: {
      enabled: raw.IMAP_IDLE_ENABLED,
      folders: raw.IMAP_IDLE_FOLDERS,
    },
    debug: raw.DEBUG ?? '',
  }));

export type AppConfig = z.infer<typeof EnvSchema>;

export type EmbeddingsConfig = NonNullable<AppConfig['embeddings']>;

function defaultCacheDir(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const base = local && local.length > 0 ? local : join(homedir(), 'AppData', 'Local');
    return join(base, 'mcp-inbox', 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'mcp-inbox');
}

/**
 * Parses process.env and returns a validated AppConfig.
 * Throws a readable error on invalid/missing configuration;
 * the caller is responsible for exiting the process.
 *
 * Empty-string values are treated as "not set". This matches how users
 * typically write optional env vars in .env files (`SMTP_HOST=`) and
 * prevents empty strings from defeating the `??` fallbacks downstream.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const scrubbed: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    scrubbed[key] = value === '' ? undefined : value;
  }
  const parsed = EnvSchema.safeParse(scrubbed);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
