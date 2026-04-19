import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchRequest {
  type: 'search';
  query: string;
  mcpDir: string;
  model?: string;
}

interface PingRequest {
  type: 'ping';
}

type IncomingMessage = SearchRequest | PingRequest;

interface EmailSummary {
  uid: number;
  folder: string;
  message_id: string | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  unseen: boolean;
  has_attachments: boolean;
}

interface SearchResult {
  emails: EmailSummary[];
  total_matches: number;
  folder: string;
  query: string;
  error: string | null;
}

// Minimal representation of a stream-json event line
interface StreamEvent {
  type: string;
  subtype?: string;
  result?: unknown;
  error?: string;
  content?: Array<{ type: string; text?: string }>;
}

// ── Native Messaging protocol (4-byte LE length prefix) ───────────────────────

function readMessage(): IncomingMessage {
  const lenBuf = Buffer.alloc(4);
  let bytesRead = 0;
  while (bytesRead < 4) {
    const n = readSync(0, lenBuf, bytesRead, 4 - bytesRead, null);
    if (n === 0) process.exit(0);
    bytesRead += n;
  }
  const len = lenBuf.readUInt32LE(0);

  const msgBuf = Buffer.alloc(len);
  bytesRead = 0;
  while (bytesRead < len) {
    const n = readSync(0, msgBuf, bytesRead, len - bytesRead, null);
    if (n === 0) process.exit(1);
    bytesRead += n;
  }
  return JSON.parse(msgBuf.toString('utf8')) as IncomingMessage;
}

function sendMessage(obj: unknown): void {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf8');
  process.stderr.write(`[host] sending ${buf.length} bytes\n`);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(buf.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(buf);
}

// ── Standalone test mode: node host.cjs "<query>" "<mcpDir>" ─────────────────

if (process.argv.length >= 4) {
  const result = runClaude(process.argv[2] as string, process.argv[3] as string);
  process.stderr.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(query: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an email search assistant. Today: ${today}.
Search emails for: "${query}"
Call imap_search_emails once with response_format:"json". Limit 20.
Compute absolute ISO dates for relative expressions (e.g. "last week" = since_date 7 days ago).`;
}

// ── Project raw email object to only the fields we need ───────────────────────

function projectEmail(raw: Record<string, unknown>): EmailSummary {
  return {
    uid: Number(raw['uid'] ?? 0),
    folder: String(raw['folder'] ?? 'INBOX'),
    message_id: raw['message_id'] != null ? String(raw['message_id']) : null,
    subject: raw['subject'] != null ? String(raw['subject']) : null,
    from: raw['from'] != null ? String(raw['from']) : null,
    date: raw['date'] != null ? String(raw['date']) : null,
    unseen: Boolean(raw['unseen']),
    has_attachments: Boolean(raw['has_attachments']),
  };
}

// ── Parse stream-json output ──────────────────────────────────────────────────
// Prefers the tool-result event (direct MCP response) over Claude's text summary.
// This avoids relying on Claude formatting JSON correctly and keeps response small.

function parseStreamJson(stdout: string, query: string): SearchResult {
  const fallback: SearchResult = {
    emails: [],
    total_matches: 0,
    folder: 'INBOX',
    query,
    error: null,
  };

  let toolResult: SearchResult | null = null;
  let claudeError: string | null = null;
  const eventTypes: string[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }

    eventTypes.push(event.type + (event.subtype ? ':' + event.subtype : ''));

    // ── Tool result event: direct MCP response ────────────────────────────────
    // Check both type:"tool" and type:"user" (tool results are user-role messages in some CLI versions)
    const contentToCheck: Array<{ type: string; text?: string }> = [];
    if (Array.isArray(event.content)) {
      contentToCheck.push(...event.content);
    }
    // Also look inside message.content for type:"user" events
    const msg = (event as unknown as { message?: { content?: unknown } }).message;
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; content?: unknown }>) {
        // tool_result blocks have nested content
        if (block.type === 'tool_result') {
          if (Array.isArray(block.content)) {
            contentToCheck.push(...(block.content as Array<{ type: string; text?: string }>));
          } else if (typeof block.content === 'string') {
            // This Claude CLI version serializes tool result content as a raw JSON string
            contentToCheck.push({ type: 'text', text: block.content });
          }
        }
      }
    }

    if (contentToCheck.length > 0) {
      for (const block of contentToCheck) {
        if (block.type !== 'text' || !block.text) continue;
        try {
          const data = JSON.parse(block.text) as Record<string, unknown>;
          if (!Array.isArray(data['emails'])) continue;

          process.stderr.write(
            `[host] found tool result: ${(data['emails'] as unknown[]).length} emails\n`,
          );

          toolResult = {
            emails: (data['emails'] as Record<string, unknown>[]).slice(0, 50).map(projectEmail),
            total_matches: Number(data['total_matches'] ?? (data['emails'] as unknown[]).length),
            folder: String(data['folder'] ?? 'INBOX'),
            query,
            error: null,
          };
        } catch {
          continue;
        }
      }
    }

    // ── Result event: capture Claude-level errors ─────────────────────────────
    if (event.type === 'result' && event.subtype !== 'success') {
      claudeError = event.error ?? event.subtype ?? 'claude error';
    }
  }

  if (toolResult) return toolResult;
  if (claudeError) return { ...fallback, error: claudeError };

  process.stderr.write(`[host] no tool result found. events: [${eventTypes.join(', ')}]\n`);
  return { ...fallback, error: 'No tool result found in Claude output' };
}

// ── Claude invocation ─────────────────────────────────────────────────────────

function runClaude(query: string, mcpDir: string, model = 'claude-sonnet-4-6'): SearchResult {
  process.stderr.write(`[host] runClaude: "${query}" model=${model} cwd=${mcpDir}\n`);

  const result = spawnSync(
    'claude',
    [
      '-p',
      buildPrompt(query),
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'mcp__imap-email__imap_search_emails',
      '--model',
      model,
    ],
    {
      cwd: mcpDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 90_000,
      windowsHide: true,
    },
  );

  if (result.error) {
    return {
      emails: [],
      total_matches: 0,
      folder: 'INBOX',
      query,
      error: `spawn failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    return {
      emails: [],
      total_matches: 0,
      folder: 'INBOX',
      query,
      error: `claude exited ${result.status}: ${stderr}`,
    };
  }

  const parsed = parseStreamJson(result.stdout ?? '', query);
  process.stderr.write(
    `[host] done: ${parsed.error ? 'ERR ' + parsed.error : parsed.emails.length + ' emails'}\n`,
  );
  return parsed;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

while (true) {
  const msg = readMessage();

  if (msg.type === 'ping') {
    sendMessage({ type: 'pong' });
    continue;
  }

  if (msg.type === 'search') {
    sendMessage({ type: 'result', ...runClaude(msg.query, msg.mcpDir, msg.model) });
  }
}
