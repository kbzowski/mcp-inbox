# CLAUDE.md

## Project

Thunderbird WebExtension (MV2) that searches email via Claude CLI + IMAP MCP.
Extension scripts bundle as IIFE (browser), native host as CJS (Node.js).

## Build

| Command | Purpose |
|---|---|
| `npm run build` | esbuild bundle |
| `npm run pack` | build + create `claude-email-search.xpi` |
| `npm run typecheck` | `tsc --noEmit` |

## Critical gotchas

- **Windows native messaging requires a real `.exe`** — Gecko's `CreateProcess` cannot execute `.cmd`/`.bat`. `install.ps1` compiles a C# launcher via Windows PowerShell 5.1 (`powershell.exe`); PS7 (`pwsh`) dropped `ConsoleApplication` support in `Add-Type`.
- **Host output must be `.cjs`** — `package.json` has `"type":"module"`, so Node would treat `.js` as ESM. The host uses CommonJS (`require`, `Buffer`).
- **Claude CLI stream-json tool results**: in current CLI versions, `type:"user"` events carry tool results in `message.content[].type === "tool_result"` blocks where `content` is a **string** (not array). See `parseStreamJson()` in `src/native-host/host.ts`.
- **`claude models` hangs as subprocess** — it makes a network call and waits; do not spawn it from the native host. Model list is hardcoded in `src/options/options.ts`.
- **Message-ID angle brackets** — IMAP returns `<id@domain>`, but `messenger.messages.query({ headerMessageId })` expects the ID without angle brackets. Strip with `.replace(/^<|>$/g, '')`.
- **`browser.storage.local.get` array form** — use `get(['key1','key2'])` not `get('key1')` when reading multiple keys.
