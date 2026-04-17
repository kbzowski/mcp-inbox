# mcp-inbox

> MCP server that gives any MCP-capable agent read/write access to your IMAP inbox, with a local SQLite cache for fast responses and IMAP IDLE for real-time updates.

Works with any IMAP/SMTP provider: Gmail, Outlook, Fastmail, iCloud, Proton Mail (via Bridge), Dovecot, hosted Exchange, self-hosted mail servers. Tools for listing and searching mail, composing and sending, managing drafts, inspecting attachment metadata. Cache stays in sync with the server via CONDSTORE + IDLE so most reads serve from local SQLite without a network round-trip.

**On attachments:** mcp-inbox deliberately does not download attachment bytes. `imap_get_email` surfaces filename / content type / size so the agent can describe what's attached, but if the user wants the file, they open it in their mail client. The MCP server stays out of the business of caching potentially sensitive content on disk.

**Status:** 0.1.0, early. See `CLAUDE.md` for architecture notes.

---

## Requirements

- **Node.js 24 LTS** or newer (`node --version` should print `v24.x` or higher).
- An IMAP/SMTP account. Gmail and Outlook users need an **app password**, not the account password - see [Provider notes](#provider-notes).

---

## Configure

mcp-inbox reads credentials from environment variables. At minimum you need three:

```
IMAP_USER=you@example.com
IMAP_PASSWORD=your-app-password
IMAP_HOST=imap.example.com
```

The full list of variables (ports, TLS flags, cache tuning, IDLE folders) lives in [.env.example](.env.example).

How those env vars reach the server process depends on which MCP client you use. Every client below lets you set env per-server.

---

## Connect it to your client

Pick your client and follow the snippet. Each example sets `IMAP_USER`, `IMAP_PASSWORD`, and `IMAP_HOST`; add any optional variables from `.env.example` the same way.

### Claude Code (CLI)

Works on macOS, Linux, and Windows.

```bash
claude mcp add mcp-inbox \
  --env IMAP_USER=you@example.com \
  --env IMAP_PASSWORD=your-app-password \
  --env IMAP_HOST=imap.gmail.com \
  -- npx -y @kbzowski/mcp-inbox
```

Add `-s user` (user scope) to make the server available in every project instead of just the current directory. List and verify with `claude mcp list`. Remove with `claude mcp remove mcp-inbox`.

**Windows note:** works directly; Claude Code wraps `npx` correctly on Windows since mid-2025. If you hit `spawn npx ENOENT`, upgrade Claude Code first.

### Claude Desktop

Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** (unofficial): `~/.config/Claude/claude_desktop_config.json`

Edit (create the file if it doesn't exist) and merge this into the top-level object:

```json
{
  "mcpServers": {
    "mcp-inbox": {
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.gmail.com"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The server appears in the "Search and tools" menu once the handshake completes.

**Windows quirk:** if Claude Desktop fails to spawn `npx` (older Electron versions do this), replace the `command`/`args` pair with:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@kbzowski/mcp-inbox"],
```

### Codex CLI (OpenAI)

Config lives at `~/.codex/config.toml`:

```toml
[mcp_servers.mcp-inbox]
command = "npx"
args = ["-y", "@kbzowski/mcp-inbox"]

[mcp_servers.mcp-inbox.env]
IMAP_USER = "you@example.com"
IMAP_PASSWORD = "your-app-password"
IMAP_HOST = "imap.gmail.com"
```

Verify with `codex mcp list`. If you're on Windows and Codex can't find `npx`, wrap it: `command = "cmd"`, `args = ["/c", "npx", "-y", "@kbzowski/mcp-inbox"]`.

### Cursor

**Option A - Settings UI:** Settings → MCP → Add new MCP server. Fill in:
- Name: `mcp-inbox`
- Type: `command`
- Command: `npx -y @kbzowski/mcp-inbox`
- Env: add `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST` one per line

**Option B - edit `~/.cursor/mcp.json`:**

```json
{
  "mcpServers": {
    "mcp-inbox": {
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.gmail.com"
      }
    }
  }
}
```

A workspace-scoped variant goes at `.cursor/mcp.json` in the project root.

### VS Code (native MCP)

VS Code added first-party MCP support in 2025. Enable it at the workspace level by creating `.vscode/mcp.json`:

```json
{
  "servers": {
    "mcp-inbox": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.gmail.com"
      }
    }
  }
}
```

User-level config: the `mcp` section under your settings JSON (`Cmd/Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)").

### Cline (VS Code extension)

Cline reads its MCP config from `cline_mcp_settings.json`. Open it from the Cline sidebar → MCP Servers → Configure MCP Servers. Add:

```json
{
  "mcpServers": {
    "mcp-inbox": {
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.gmail.com"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Continue.dev

Edit `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: mcp-inbox
    command: npx
    args:
      - "-y"
      - "@kbzowski/mcp-inbox"
    env:
      IMAP_USER: you@example.com
      IMAP_PASSWORD: your-app-password
      IMAP_HOST: imap.gmail.com
```

### Zed

Zed's editor settings (`Cmd/Ctrl+,`) - add a `context_servers` entry:

```json
{
  "context_servers": {
    "mcp-inbox": {
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.gmail.com"
      }
    }
  }
}
```

### Goose (Block)

Edit `~/.config/goose/config.yaml`:

```yaml
extensions:
  mcp-inbox:
    type: stdio
    cmd: npx
    args: ["-y", "@kbzowski/mcp-inbox"]
    envs:
      IMAP_USER: you@example.com
      IMAP_PASSWORD: your-app-password
      IMAP_HOST: imap.gmail.com
    enabled: true
```

### Any other MCP client

The pattern every MCP client shares:

| Field | Value |
|---|---|
| Transport | stdio |
| Command | `npx` |
| Args | `["-y", "@kbzowski/mcp-inbox"]` |
| Env | `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST` (minimum) |

If the client expects a bundled executable instead of `npx`, install globally (`npm i -g @kbzowski/mcp-inbox`) and point it at `mcp-inbox` directly.

---

## Provider notes

### Gmail / Google Workspace

Use an **[app password](https://myaccount.google.com/apppasswords)**, not your account password. Requires 2-Step Verification turned on first.

```
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
```

### Outlook / Microsoft 365

```
IMAP_HOST=outlook.office365.com
IMAP_PORT=993
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
```

Outlook rejects the default `SMTP_PORT=465` setting - both `SMTP_PORT=587` and `SMTP_SECURE=false` are required. Personal accounts need an [app password](https://account.microsoft.com/security) if 2FA is on.

### Fastmail

Use an [app password](https://app.fastmail.com/settings/security/devicekeys/add) (account-level passwords are rejected).

```
IMAP_HOST=imap.fastmail.com
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
```

### iCloud

Requires an [app-specific password](https://account.apple.com) from your Apple ID security settings.

```
IMAP_HOST=imap.mail.me.com
SMTP_HOST=smtp.mail.me.com
SMTP_PORT=587
SMTP_SECURE=false
```

### Proton Mail

Proton Mail requires [Proton Mail Bridge](https://proton.me/mail/bridge) running locally; point mcp-inbox at the Bridge's advertised host/port (usually `127.0.0.1:1143` for IMAP).

---

## Troubleshooting

### "IMAP authentication failed"

You're almost certainly using your account password instead of an app password. See the provider-specific links above.

### The client can't find `npx` / `spawn ENOENT`

On Windows, some older clients don't resolve `.cmd` shims. Wrap the command:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@kbzowski/mcp-inbox"]
```

Or install globally and use the binary directly:

```bash
npm install -g @kbzowski/mcp-inbox
# then set command: "mcp-inbox"  (no args)
```

### Passwords with shell-special characters

If your password contains `$`, `` ` ``, `!`, or a backslash, put it in an env file / config JSON rather than passing it on a shell command line. The config files above handle this correctly; `claude mcp add --env IMAP_PASSWORD=...` works if you **single-quote** the value in your shell.

### First-run takes a while

The first `npx -y @kbzowski/mcp-inbox` invocation downloads the package. Subsequent runs are cached. If it looks hung on first boot, check your network.

### Verify the connection manually

From any shell, set the env vars and run:

```bash
IMAP_USER=you@example.com IMAP_PASSWORD=... IMAP_HOST=imap.gmail.com npx -y @kbzowski/mcp-inbox
```

On success you'll see JSON log lines on stderr: `booting mcp-inbox` and `mcp-inbox ready`. The server then idles on stdin (waiting for MCP JSON-RPC). Hit `Ctrl+C` to stop.

---

## Tool catalog

All tools are prefixed `imap_` so they don't collide with other email MCPs. Every read tool accepts `response_format: "markdown" | "json"` (default markdown) and `max_staleness_seconds` (default 60 - serves from cache when fresh, syncs otherwise).

### Discovery

- **`imap_list_folders`** - list every mailbox with its path, delimiter, and RFC 6154 special-use attribute (`\Drafts`, `\Sent`, `\Trash`, `\Junk`).
- **`imap_list_emails`** `(folder?, limit?, offset?, unseen_only?, since_date?, before_date?)` - paginated envelope list, newest first. Defaults to `INBOX`, 20 per page.
- **`imap_search_emails`** `(folder?, subject?, from?, to?, body?, unseen?, since_date?, before_date?)` - IMAP SEARCH on the server, returns matching envelopes from the cache. At least one criterion required.

### Reading

- **`imap_get_email`** `(folder, uid)` - full message: headers, plain text, HTML, and attachment metadata (filename, content type, size). Attachment bytes are never downloaded.
- **`imap_list_drafts`** `(folder?, limit?, offset?)` - same as list_emails but auto-resolves the Drafts folder via SPECIAL-USE.
- **`imap_get_draft`** `(uid, folder?)` - full draft content by UID.

### Flagging / filing

- **`imap_mark_read`** `(folder, uid)` - add `\Seen`. Idempotent.
- **`imap_mark_unread`** `(folder, uid)` - remove `\Seen`. Idempotent.
- **`imap_move_to_folder`** `(folder, uid, destination)` - IMAP MOVE with COPY+EXPUNGE fallback.
- **`imap_delete_email`** `(folder, uid, hard_delete?)` - defaults to move-to-Trash. `hard_delete: true` permanently expunges.

### Composing

- **`imap_create_draft`** `(to, subject, body?, html?, cc?, bcc?, from?)` - appends a new draft to the Drafts folder with the `\Draft` flag. nodemailer handles the RFC 2822 construction, so non-ASCII subjects, long bodies, and multipart text+HTML all just work.
- **`imap_update_draft`** `(uid, to, subject, body?, html?, cc?, bcc?, from?)` - replaces an existing draft. Append-then-delete: the new draft is written first, only then is the old UID removed. A failure in the middle never loses the draft.

### Sending

- **`imap_send_email`** `(to, subject, body?, html?, cc?, bcc?, from?)` - SMTP send + best-effort append to the Sent folder so the message shows up in the user's mail client.
- **`imap_send_draft`** `(uid, folder?)` - fetches raw source of the draft, sends it exactly as written (preserves attachments and formatting), then deletes the draft.
- **`imap_reply`** `(folder, uid, body?, html?, reply_all?, cc?, bcc?, from?)` - preserves threading via `In-Reply-To` / `References`. Subject gets a `Re: ` prefix.
- **`imap_forward`** `(folder, uid, to, body?, cc?, bcc?, from?)` - quotes the original inline, `Fwd: ` subject prefix.

### Tool annotations

Every tool carries MCP annotations so clients can gate destructive actions:

| Tool | readOnly | destructive | idempotent |
|---|:-:|:-:|:-:|
| list_folders / list_emails / get_email / search_emails / list_drafts / get_draft | ✓ | | ✓ |
| mark_read / mark_unread | | | ✓ |
| move_to_folder / delete_email | | ✓ | |
| create_draft / update_draft | | | |
| send_email / send_draft / reply / forward | | ✓ | |

---

## License

MIT. Copyright (c) 2026 Krzysztof Bzowski. See [LICENSE](LICENSE).
