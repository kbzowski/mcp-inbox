import { z } from 'zod';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const BooleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .or(z.boolean());

const CsvList = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v.length > 0));

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
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: BooleanString.default(true),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    // Cache
    IMAP_CACHE_ENABLED: BooleanString.default(true),
    IMAP_CACHE_DIR: z.string().optional(),
    IMAP_CACHE_MAX_ATTACHMENTS_MB: z.coerce.number().int().positive().default(500),
    IMAP_CACHE_BODY_INLINE: BooleanString.default(false),
    IMAP_CACHE_DEFAULT_STALENESS_SEC: z.coerce.number().int().min(0).default(60),
    IMAP_CACHE_RETAIN_DAYS: z.coerce.number().int().min(0).default(365),

    // IDLE
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
      enabled: raw.IMAP_CACHE_ENABLED,
      dir: raw.IMAP_CACHE_DIR ?? defaultCacheDir(),
      maxAttachmentsMB: raw.IMAP_CACHE_MAX_ATTACHMENTS_MB,
      eagerBodyCache: raw.IMAP_CACHE_BODY_INLINE,
      defaultStalenessSec: raw.IMAP_CACHE_DEFAULT_STALENESS_SEC,
      retainDays: raw.IMAP_CACHE_RETAIN_DAYS,
    },
    idle: {
      folders: raw.IMAP_IDLE_FOLDERS,
    },
    debug: raw.DEBUG ?? '',
  }));

export type AppConfig = z.infer<typeof EnvSchema>;

function defaultCacheDir(): string {
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
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
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
