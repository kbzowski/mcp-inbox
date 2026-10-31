/**
 * Structured stderr-only logger.
 *
 * MCP's stdio transport owns stdout for protocol frames - any `console.log`
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

// `msg` is the logger's own field and would overwrite anything passed under that
// name. Failures go in as `{ err }`, however deep, and get expanded on the way out.
type Meta = Record<string, unknown> & { msg?: never };

export interface Logger {
  debug: (msg: string, meta?: Meta) => void;
  info: (msg: string, meta?: Meta) => void;
  warn: (msg: string, meta?: Meta) => void;
  error: (msg: string, meta?: Meta) => void;
  child: (subNamespace: string) => Logger;
}

// What ImapFlow, nodemailer and Node attach to their errors. An allowlist because
// the rest (`response`, `input`) can hold raw server replies or message content.
const ERROR_FIELDS = [
  'name',
  'message',
  'code',
  'errno',
  'syscall',
  'address',
  'port',
  'responseStatus',
  'responseText',
  'serverResponseCode',
  'executedCommand',
  'authenticationFailed',
  'throttleReset',
  'command',
  'responseCode',
] as const;

const MAX_FIELD_LENGTH = 1000;
const MAX_STACK_LENGTH = 4000;
const EMAIL_ADDRESS = /[^\s<>"'@]+@[^\s<>"'@]+/g;

// nodemailer appends the raw SMTP reply, recipient included, to `message` itself.
function clean(text: string, maxLength = MAX_FIELD_LENGTH): string {
  return text.slice(0, maxLength).replace(EMAIL_ADDRESS, '[address]');
}

function serializeError(err: object): Record<string, unknown> {
  const source = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of ERROR_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') out[field] = clean(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out[field] = value;
  }
  // Node's dual-stack connect failure: empty message, the addresses are only in here.
  if (Array.isArray(source['errors'])) {
    out['errors'] = source['errors'].filter((e) => e instanceof Error);
  }
  if (typeof source['stack'] === 'string') out['stack'] = clean(source['stack'], MAX_STACK_LENGTH);
  // JSON.stringify runs the replacer on this too, which walks the whole cause chain.
  if (source['cause'] !== undefined) out['cause'] = source['cause'];
  return out;
}

function createReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    // Drivers also throw plain objects and strings, so the key counts as well as the type.
    if (!(value instanceof Error) && key !== 'err' && key !== 'cause') return value;
    if (typeof value === 'string') return clean(value);
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return serializeError(value);
  };
}

export class LoggerContext {
  // JS hard-private - consumers of the published package cannot poke at these
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

  emit(level: Level, namespace: string, msg: string, meta?: Meta): void {
    if (!this.shouldEmit(level, namespace)) return;
    const base = { ts: new Date().toISOString(), level, ns: namespace, msg };
    let line: string;
    try {
      // First so they lead the line ahead of a long stack, last so meta cannot overwrite them.
      line = JSON.stringify({ ...base, ...meta, ...base }, createReplacer());
    } catch (err) {
      line = JSON.stringify({ ...base, logFailure: String(err) });
    }
    process.stderr.write(line + '\n');
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
