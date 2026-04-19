# Client setup

Per-client configuration snippets for mcp-inbox. Each example sets the three
required env vars (`IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST`); add optional
variables from [`.env.example`](../.env.example) the same way.

---

## Claude Code (CLI)

Works on macOS, Linux, and Windows.

```bash
claude mcp add mcp-inbox \
  --env IMAP_USER=you@example.com \
  --env IMAP_PASSWORD=your-app-password \
  --env IMAP_HOST=imap.gmail.com \
  -- npx -y @kbzowski/mcp-inbox
```

Add `-s user` to make the server available in every project instead of just
the current directory. List with `claude mcp list`, remove with
`claude mcp remove mcp-inbox`.

**Windows:** works directly since Claude Code mid-2025. If you hit
`spawn npx ENOENT`, upgrade Claude Code first.

---

## Claude Desktop

Config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** (unofficial): `~/.config/Claude/claude_desktop_config.json`

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

Restart Claude Desktop after saving. **Windows quirk:** if it fails to spawn
`npx`, replace `command`/`args` with:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@kbzowski/mcp-inbox"],
```

---

## Codex CLI (OpenAI)

`~/.codex/config.toml`:

```toml
[mcp_servers.mcp-inbox]
command = "npx"
args = ["-y", "@kbzowski/mcp-inbox"]

[mcp_servers.mcp-inbox.env]
IMAP_USER = "you@example.com"
IMAP_PASSWORD = "your-app-password"
IMAP_HOST = "imap.gmail.com"
```

Verify with `codex mcp list`. Windows `npx` workaround: `command = "cmd"`,
`args = ["/c", "npx", "-y", "@kbzowski/mcp-inbox"]`.

---

## Cursor

**Settings UI:** Settings → MCP → Add new MCP server. Fill in name
`mcp-inbox`, type `command`, command `npx -y @kbzowski/mcp-inbox`, then add
env vars one per line.

**Or edit `~/.cursor/mcp.json`:**

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

Workspace-scoped: `.cursor/mcp.json` in the project root.

---

## VS Code (native MCP)

`.vscode/mcp.json` in the workspace:

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

User-level: `mcp` section in your User Settings JSON
(`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)").

---

## Cline (VS Code extension)

Cline sidebar → MCP Servers → Configure MCP Servers → add to
`cline_mcp_settings.json`:

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

---

## Continue.dev

`~/.continue/config.yaml`:

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

---

## Zed

Editor settings (`Ctrl+,`) — add a `context_servers` entry:

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

---

## Goose (Block)

`~/.config/goose/config.yaml`:

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

---

## Thunderbird (Claude-only)

A dedicated Thunderbird extension is available in the
[`thunderbird-plugin/`](../thunderbird-plugin/) directory. It provides a
natural language search panel that calls Claude CLI with this MCP server in
the background. Requires Claude CLI — not compatible with other LLMs.

---

## Any other MCP client

| Field | Value |
|---|---|
| Transport | stdio |
| Command | `npx` |
| Args | `["-y", "@kbzowski/mcp-inbox"]` |
| Env | `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST` (minimum) |

If the client needs a bundled binary: `npm i -g @kbzowski/mcp-inbox` then
point it at `mcp-inbox` directly (no `npx` needed).
