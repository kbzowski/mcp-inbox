# mcp-inbox

MCP server for IMAP/SMTP mail: read, search, compose, send, manage drafts and flags. Backed by a local SQLite cache with IMAP IDLE, so most reads never touch the network.

Works with any IMAP provider - Gmail, Outlook, Fastmail, iCloud, Proton (via Bridge), Dovecot, Exchange.

## Add it to your agent

Node 24+. Nothing to install; the agent starts the server itself through `npx`.

**1.** Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "inbox": {
      "command": "npx",
      "args": ["-y", "@kbzowski/mcp-inbox"],
      "env": {
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-app-password",
        "IMAP_HOST": "imap.example.com"
      }
    }
  }
}
```

**2.** Add it to `.gitignore`. That file holds a password.

**3.** Restart the agent. Claude Code asks once to approve project-scoped servers; `/mcp` shows whether it connected. The tools then appear as `imap_*`.

On Windows, if you get `spawn ENOENT`, use `"command": "cmd", "args": ["/c", "npx", "-y", "@kbzowski/mcp-inbox"]`.

Claude Code can also write the file for you:

```bash
claude mcp add inbox --scope project \
  --env IMAP_USER=you@example.com \
  --env IMAP_PASSWORD='your-app-password' \
  --env IMAP_HOST=imap.example.com \
  -- npx -y @kbzowski/mcp-inbox
```

### Other clients

The same `mcpServers` object works in `claude_desktop_config.json`, `~/.cursor/mcp.json` and `cline_mcp_settings.json`. VS Code reads `.vscode/mcp.json` and calls the key `servers`, not `mcpServers`. Codex CLI, Zed, Continue and Goose use their own formats: [docs/clients.md](docs/clients.md).

### Credentials

Gmail, Outlook, Fastmail and iCloud all need an **app password**, not the account password.

| Provider | `IMAP_HOST` | `SMTP_HOST` | `SMTP_PORT` | `SMTP_SECURE` |
|---|---|---|---|---|
| Gmail | `imap.gmail.com` | `smtp.gmail.com` | `465` | `true` |
| Outlook | `outlook.office365.com` | `smtp.office365.com` | `587` | `false` |
| Fastmail | `imap.fastmail.com` | `smtp.fastmail.com` | `465` | `true` |
| iCloud | `imap.mail.me.com` | `smtp.mail.me.com` | `587` | `false` |
| Proton | `127.0.0.1` port `1143` (Bridge) | Bridge | | |

Outlook fails on the `465`/`true` defaults; both overrides are required.

## Tools

All prefixed `imap_`. Read tools take `response_format: "markdown" | "json"` (default markdown) and `max_staleness_seconds` (default 60; serves cache when fresh, syncs otherwise). UIDs are folder-scoped, so every tool taking a `uid` also takes a `folder`.

| Tool | Arguments |
|---|---|
| `imap_list_folders` | |
| `imap_list_emails` | `folder?, limit?, offset?, unseen_only?, since_date?, before_date?` |
| `imap_search_emails` | `folder?, subject?, from?, to?, body?, unseen?, flagged?, answered?, since_date?, before_date?, or?, not?` |
| `imap_semantic_search` | `query, folder?, limit?, since_date?, before_date?` |
| `imap_index_folder` | `folders?, max_messages?` |
| `imap_get_email` | `folder, uid` |
| `imap_get_attachment` | `folder, uid, filename? \| part_id?, max_inline_mb?` |
| `imap_list_drafts` | `folder?, limit?, offset?` |
| `imap_get_draft` | `uid, folder?` |
| `imap_mark_read` / `imap_mark_unread` | `folder, uid` |
| `imap_set_flags` | `folder, uids, add?, remove?` |
| `imap_move_to_folder` | `folder, uid, destination` |
| `imap_delete_email` | `folder, uid, hard_delete?` |
| `imap_create_draft` | `to, subject, body?, html?, cc?, bcc?, from?, attachments?, folder?` |
| `imap_update_draft` | `uid, to, subject, body?, html?, cc?, bcc?, from?, attachments?, folder?` |
| `imap_send_email` | `to, subject, body?, html?, cc?, bcc?, from?, attachments?` |
| `imap_send_draft` | `uid, folder?` |
| `imap_reply` | `folder, uid, body?, html?, reply_all?, cc?, bcc?, from?, attachments?, mark_answered?` |
| `imap_forward` | `folder, uid, to, body?, cc?, bcc?, from?, attachments?` |

`imap_mark_read_multiple`, `imap_mark_unread_multiple`, `imap_move_multiple` and `imap_delete_multiple` take `uids` (max 500) instead of `uid`.

Worth knowing:

- `imap_get_email` returns attachment metadata only. `imap_get_attachment` fetches bytes as base64 for one response, capped at 5 MB (`max_inline_mb`, up to 50). Nothing is written to disk.
- Outgoing `attachments` are `{ filename, content_base64, content_type? }`. Those bytes cross the model context - a 2 MB PDF is roughly 2.7M characters. To pass on a file you did not create, forward it.
- `imap_forward` attaches the original verbatim as `.eml`, so its attachments, signatures and DKIM survive.
- `imap_reply` sets `\Answered` on the original (`mark_answered: false` to skip) and carries the full `References` chain.
- `imap_set_flags` writes `\Flagged` and `\Answered` only. Read state and deletion have their own tools.
- `imap_delete_email` moves to Trash; `hard_delete: true` expunges.
- `imap_update_draft` appends before deleting, so a mid-flight failure never loses the draft.

`destructiveHint` is set on move, delete, and everything that sends.

## Semantic search (optional)

`imap_search_emails` matches literal text on the server. `imap_semantic_search` matches meaning: "the invoice from the hosting provider" finds a message titled "Payment receipt #4417". It works across languages and paraphrases, and it only ranks what has been indexed.

Indexing covers the subject, the sender, and the message text, so a message is findable by what it says even when its subject is useless ("Re: 4417"). Quoted reply history is stripped before embedding, and a message is ranked by its single most relevant passage.

Off unless you set `IMAP_EMBEDDINGS_BASE_URL`. Any OpenAI-compatible `/v1/embeddings` endpoint works, including a local one:

```bash
IMAP_EMBEDDINGS_BASE_URL=https://your-endpoint/v1
IMAP_EMBEDDINGS_API_KEY=sk-...
```

**Indexing is opt-in per folder.** Run `imap_index_folder` on the folders you care about before searching them - it takes a list, and they share the call's `max_messages` budget. That call sends each message's subject, sender, and body text to the configured endpoint. **Attachments are never downloaded or sent** - only the message's text part is fetched, which on a real mailbox is roughly 80x less data than the full messages. It is safe to re-run: already-indexed messages are skipped, so a large folder can be indexed over several calls. Afterwards a background pass keeps every indexed folder current, so new mail becomes searchable on its own. It runs every `IMAP_EMBEDDINGS_SWEEP_MINUTES` (15 by default, `0` disables it) and embeds at most `IMAP_EMBEDDINGS_SWEEP_BATCH` messages per pass. Searching never writes, so its latency stays predictable; `pending_index` tells you when the index is still catching up.

`imap_semantic_search` takes an optional `folder`. Omit it and every indexed folder is searched in one pass, with each result reporting the folder it came from.

If your IMAP server refuses to serve individual body parts, indexing falls back to subjects and senders alone and says so: `bodies_indexed` comes back as zero.

Vectors live in the same SQLite cache as everything else and survive restarts. They also outlive the message bodies that `IMAP_CACHE_BODY_RETAIN_DAYS` prunes, so old mail stays findable.

Changing `IMAP_EMBEDDINGS_MODEL` or `IMAP_EMBEDDINGS_DIMS` drops the index - the vector table's dimensionality is fixed when it is created. Upgrading mcp-inbox can do the same when the index format changes. Either way the fix is the same: re-run `imap_index_folder`.

**Platform support.** Vector search needs the `sqlite-vec` extension, which ships prebuilt binaries for linux-x64/arm64, macOS x64/arm64, and windows-x64. On **windows-arm64 and Alpine/musl** there is no binary: the two semantic tools return a clear error pointing at `imap_search_emails`, and every other tool works normally.

## Environment

| Variable | Default |
|---|---|
| `IMAP_USER` `IMAP_PASSWORD` `IMAP_HOST` | required |
| `IMAP_PORT` | `993` |
| `IMAP_TLS` | `true` |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | `true` |
| `IMAP_AUTH_TIMEOUT_MS` | `10000` |
| `SMTP_HOST` `SMTP_USER` `SMTP_PASSWORD` | falls back to the IMAP value |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `IMAP_CACHE_DIR` | platform cache dir |
| `IMAP_CACHE_DEFAULT_STALENESS_SEC` | `60` |
| `IMAP_CACHE_BODY_RETAIN_DAYS` | `180` (`0` keeps forever) |
| `IMAP_EMBEDDINGS_BASE_URL` | unset (semantic search off) |
| `IMAP_EMBEDDINGS_API_KEY` | unset (no auth header sent) |
| `IMAP_EMBEDDINGS_MODEL` | `arctic-embed-l-v2` |
| `IMAP_EMBEDDINGS_DIMS` | `1024` |
| `IMAP_EMBEDDINGS_BATCH_SIZE` | `64` |
| `IMAP_EMBEDDINGS_TIMEOUT_MS` | `30000` |
| `IMAP_EMBEDDINGS_SWEEP_MINUTES` | `15` (`0` disables background indexing) |
| `IMAP_EMBEDDINGS_SWEEP_BATCH` | `200` |
| `IMAP_IDLE_ENABLED` | `true` |
| `IMAP_IDLE_FOLDERS` | `INBOX` (empty disables) |
| `DEBUG` | unset; try `mcp-inbox:*` |

Empty values count as unset. Logs go to stderr.

## Troubleshooting

**"IMAP authentication failed"** - you are using the account password instead of an app password.

**Passwords containing `$`, `` ` ``, `!` or `\`** - put them in the config JSON, not on a command line. With `claude mcp add --env`, single-quote the value.

**"requires Node.js 24 or later"** - `node:sqlite` needs 24. Check what your client runs, not what your shell has.

**Check it works** - `IMAP_USER=... IMAP_PASSWORD=... IMAP_HOST=... npx -y @kbzowski/mcp-inbox`. You should get `mcp-inbox ready` on stderr; it then waits on stdin.

## License

MIT. Copyright (c) 2026 Krzysztof Bzowski. See [LICENSE](LICENSE).
