/**
 * Structured stderr-only logger.
 *
 * MCP's stdio transport owns stdout for protocol frames — any `console.log`
 * corrupts the stream. All diagnostic output here must go to stderr, and the
 * `no-console` ESLint rule enforces this at the code level.
 *
 * Namespaces follow the `debug` convention: set DEBUG="mcp-inbox:*" to enable
 * everything, or DEBUG="mcp-inbox:cache,mcp-inbox:imap" to enable specific
 * namespaces.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let enabledNamespaces: RegExp[] = [];
let minLevel: Level = 'info';

export function configureLogger(opts: { debug?: string; level?: Level }): void {
  enabledNamespaces = parseNamespaces(opts.debug ?? '');
  minLevel = opts.level ?? 'info';
}

function parseNamespaces(spec: string): RegExp[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`);
    });
}

function namespaceEnabled(ns: string): boolean {
  return enabledNamespaces.some((re) => re.test(ns));
}

function emit(level: Level, ns: string, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel] && !namespaceEnabled(ns)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    ns,
    msg,
    ...(meta ?? {}),
  };
  // Stderr only; see file header.
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (subNamespace: string) => Logger;
}

export function createLogger(namespace: string): Logger {
  return {
    debug: (msg, meta) => emit('debug', namespace, msg, meta),
    info: (msg, meta) => emit('info', namespace, msg, meta),
    warn: (msg, meta) => emit('warn', namespace, msg, meta),
    error: (msg, meta) => emit('error', namespace, msg, meta),
    child: (sub) => createLogger(`${namespace}:${sub}`),
  };
}

export const rootLogger = createLogger('mcp-inbox');
