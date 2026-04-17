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
 *
 * All logger state is encapsulated in `LoggerContext`. The module exposes a
 * shared default context for production use; tests construct isolated
 * contexts to avoid cross-test leakage.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (subNamespace: string) => Logger;
}

export class LoggerContext {
  // JS hard-private — consumers of the published package cannot poke at these
  // from plain JS. TS `private` would be compile-time only.
  #enabledNamespaces: RegExp[] = [];
  #minLevel: Level = 'info';

  configure(opts: { debug?: string; level?: Level }): void {
    this.#enabledNamespaces = parseNamespaces(opts.debug ?? '');
    this.#minLevel = opts.level ?? 'info';
  }

  shouldEmit(level: Level, namespace: string): boolean {
    if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.#minLevel]) return true;
    return this.#enabledNamespaces.some((re) => re.test(namespace));
  }

  emit(level: Level, namespace: string, msg: string, meta?: Record<string, unknown>): void {
    if (!this.shouldEmit(level, namespace)) return;
    // Canonical fields last so user-provided meta cannot overwrite them.
    const entry = {
      ...(meta ?? {}),
      ts: new Date().toISOString(),
      level,
      ns: namespace,
      msg,
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  logger(namespace: string): Logger {
    return {
      debug: (msg, meta) => this.emit('debug', namespace, msg, meta),
      info: (msg, meta) => this.emit('info', namespace, msg, meta),
      warn: (msg, meta) => this.emit('warn', namespace, msg, meta),
      error: (msg, meta) => this.emit('error', namespace, msg, meta),
      child: (sub) => this.logger(`${namespace}:${sub}`),
    };
  }
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

/** Shared context used by the running server. Tests should construct their own. */
const defaultContext = new LoggerContext();

export function configureLogger(opts: { debug?: string; level?: Level }): void {
  defaultContext.configure(opts);
}

export function createLogger(namespace: string, context: LoggerContext = defaultContext): Logger {
  return context.logger(namespace);
}

export const rootLogger = createLogger('mcp-inbox');
