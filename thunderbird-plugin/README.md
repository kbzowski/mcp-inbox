# Claude Email Search — Thunderbird Extension

Natural language email search for Thunderbird. Type *"emails from John about the project last week"* and the extension finds and opens the matching email.

Powered by [Claude CLI](https://claude.ai/download) and an MCP server that talks to your IMAP account. The MCP server is configured via a `.mcp.json` file in your project directory — the same format used by Claude Code and other MCP-compatible tools.

---

## What it works with

| Component | Role |
|---|---|
| **Claude CLI** (`claude`) | Interprets natural language, calls the MCP tool |
| **Any IMAP MCP server** | Searches the mailbox; configured in `.mcp.json` |
| **Thunderbird 102+** | Hosts the extension |

The extension itself is LLM-agnostic — it passes queries to whatever `claude` binary is on your PATH and reads `.mcp.json` from the directory you configure. See [docs/claude-integration.md](docs/claude-integration.md) for details on how Claude CLI is invoked.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Thunderbird 102+ | Tested on 115 |
| [Claude CLI](https://claude.ai/download) | Must be on PATH as `claude` |
| Node.js 18+ | Must be on PATH as `node` |
| .NET Framework 4.x | Ships with Windows; needed for the C# launcher |
| MCP project directory | A folder with `.mcp.json` that includes an IMAP server config |

---

## Installation

### 1. Build and package

```powershell
cd thunderbird-plugin
npm install
npm run pack
```

This produces `claude-email-search.xpi`.

### 2. Install the native messaging host

```powershell
.\native-host\install.ps1
```

Compiles a small C# launcher and registers it in `HKCU\Software\Mozilla\NativeMessagingHosts` (no admin required).

### 3. Install the extension in Thunderbird

1. **Tools → Add-on Manager**
2. Gear icon → **Install Add-on From File…**
3. Select `claude-email-search.xpi`

### 4. Configure

Open **Extension Options** (gear icon in Add-on Manager):

- **MCP Project Directory** — folder containing your `.mcp.json`
- **Claude Model** — any model ID accepted by `claude --model` (default: `claude-sonnet-4-6`)

---

## Usage

Click the **Claude Search** toolbar button. Type a natural language query and press **Enter**. Results show sender, subject, date, folder, and read/attachment status. Click any result to open the email in Thunderbird's main window.

---

## Uninstall

```powershell
.\native-host\uninstall.ps1
```

Then remove the extension from Thunderbird's Add-on Manager.

---

## Project structure

```
thunderbird-plugin/
├── src/
│   ├── background.ts          # Native messaging glue, window management, email navigation
│   ├── globals.d.ts           # WebExtension browser global type
│   ├── native-host/
│   │   └── host.ts            # Node.js host: spawns Claude CLI, parses stream-json
│   ├── options/
│   │   ├── options.html
│   │   └── options.ts         # Settings page (mcpDir, model)
│   └── sidebar/
│       ├── sidebar.html
│       ├── sidebar.css
│       └── sidebar.ts         # Search UI, result cards
├── native-host/
│   ├── install.ps1            # Compile launcher + register native host (Windows)
│   └── uninstall.ps1          # Remove registry key + manifest
├── docs/
│   └── claude-integration.md  # Claude CLI invocation, prompt, troubleshooting
├── build.mjs                  # esbuild + archiver (XPI packaging)
├── manifest.json              # MV2, gecko id: claude-email-search@local
├── package.json
└── tsconfig.json
```

---

## Development

```powershell
npm run build          # one-shot build
npm run build:watch    # rebuild on save
npm run pack           # build + create claude-email-search.xpi
npm run typecheck      # tsc --noEmit
```

---

## Known limitations

- **Windows only** — the native host requires a compiled `.exe`; Linux/macOS would use a shell script launcher
- **Cold start** — first query takes 3–10 s while Claude CLI starts the MCP server
- **20 results max** — set in the prompt; edit `buildPrompt()` in `src/native-host/host.ts` to change
