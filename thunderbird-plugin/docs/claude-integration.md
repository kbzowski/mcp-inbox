# Claude CLI Integration

This document describes how the extension communicates with Claude CLI.

## How it works

```
Sidebar (popup window)
  → background.ts (WebExtension background script)
    → native messaging (4-byte length-prefix protocol)
      → host.cjs (Node.js process)
        → claude -p "…" --output-format stream-json
          → IMAP MCP server (reads .mcp.json in your project dir)
```

Claude calls the `imap_search_emails` tool. The native host reads the
`stream-json` event stream directly, extracts the raw tool result (bypassing
Claude's text summary), and sends the email list back to the sidebar. This
keeps the response small and avoids JSON parsing of Claude's prose output.

## Why native messaging

Thunderbird extensions cannot spawn processes directly. The native messaging
protocol (4-byte little-endian length prefix over stdin/stdout) bridges the
WebExtension sandbox to a local Node.js process, which can then run `claude`.

On Windows, Gecko's `CreateProcess` cannot execute `.cmd`/`.bat` files, so
`install.ps1` compiles a tiny C# launcher (`host-launcher.exe`) that inherits
Thunderbird's stdin/stdout pipes and forwards them to `node.exe`.

## Why `--allowedTools` instead of `--dangerously-skip-permissions`

`--allowedTools mcp__imap-email__imap_search_emails` pre-approves exactly one
read-only tool. Claude never asks for permission and never has access to other
tools. `--dangerously-skip-permissions` is unnecessary and skips all safety
checks — avoid it.

## Model selection

The model is configured in Extension Options and passed as `--model <id>` to
the CLI. Any model ID accepted by `claude --model` works. Defaults to
`claude-sonnet-4-6`.

## Prompt

```
You are an email search assistant. Today: <ISO date>.
Search emails for: "<query>"
Call imap_search_emails once with response_format:"json". Limit 20.
Compute absolute ISO dates for relative expressions (e.g. "last week" = since_date 7 days ago).
```

To change the result limit or prompt behaviour, edit `buildPrompt()` in
`src/native-host/host.ts`.

## Standalone test (no Thunderbird needed)

```powershell
node dist/native-host/host.cjs "emails from John last week" "C:\path\to\mcp-project"
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Native host disconnected` | `install.ps1` not run, or `host-launcher.exe` missing |
| `spawn failed: ENOENT` | `claude` not on PATH |
| `claude exited 1` | MCP project dir wrong — `.mcp.json` not found |
| `No tool result found` | MCP server not configured for `imap-email` in `.mcp.json` |
| Search returns 0 results | Query too specific; try broader terms |
