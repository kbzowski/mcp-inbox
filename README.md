# mcp-inbox

> MCP server exposing IMAP/SMTP email over a fast local cache.

Reads, searches, composes, and manages email from any IMAP provider. A local SQLite cache keeps results fast and stays in sync with the real inbox via IMAP IDLE push notifications.

**Status:** 0.1.0 - under active development. See `CLAUDE.md` for architecture and contributor notes.

## Install

```bash
npm install -g mcp-inbox
```

Or run on demand via `npx`:

```bash
npx -y mcp-inbox
```

## Configure

Copy `.env.example` to `.env` and fill in:

```bash
IMAP_USER=you@example.com
IMAP_PASSWORD=your-app-password
IMAP_HOST=imap.example.com
```

For Gmail use an [app password](https://myaccount.google.com/apppasswords), not your account password.

## Wire up to Claude Code

```bash
claude mcp add mcp-inbox -- npx -y mcp-inbox
```

## Tool catalog

_To be documented in Phase 5. See `C:/Users/Krzysztof/.claude/plans/agile-zooming-graham.md` for the planned tool surface._

## License

MIT © Krzysztof Bzowski
