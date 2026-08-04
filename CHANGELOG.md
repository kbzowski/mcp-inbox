# @kbzowski/mcp-inbox

## 0.5.1

### Patch Changes

- Rewrite the README around adding the server via `.mcp.json`, and fix
  `.env.example`.

  The env example listed `IMAP_CACHE_ENABLED`, `IMAP_CACHE_BODY_INLINE` and
  `IMAP_CACHE_RETAIN_DAYS`. None of those are read by anything. The retention
  setting is `IMAP_CACHE_BODY_RETAIN_DAYS` and defaults to 180 days, not 365.
  The README pointed at that file as the full list of variables, so anyone
  tuning the cache was copying names that did nothing.

## 0.5.0

### Minor Changes

- 5690d05: `imap_forward` no longer drops attachments.

  Forwarding rebuilt the message from the cached plain-text and HTML bodies, so
  anything else in the original was discarded. Forwarding an invoice delivered
  the covering note without the PDF, and neither the response text nor
  `structuredContent` said so.

  The original is now attached verbatim as a `message/rfc822` part named after
  its subject, the way desktop mail clients forward. Attachments, inline images,
  S/MIME signatures and DKIM all survive, because nothing is re-encoded. The
  inline quoted body stays as it was, and `structuredContent` reports
  `original_attached`.

  The bytes travel server to server and never pass through the model's context,
  so a large forward costs nothing in tokens.

  One behaviour change: a forward of an already-cached message now issues one
  body fetch where it previously issued none. Reading the original in full is
  what makes the passthrough possible.

- 5690d05: You can now attach files to outgoing mail.

  `imap_send_email`, `imap_reply`, `imap_forward`, `imap_create_draft` and
  `imap_update_draft` take an optional `attachments` array of
  `{ filename, content_base64, content_type? }`. Leave `content_type` off and the
  type is derived from the filename. On a forward, these are added alongside the
  attached original rather than replacing it.

  Attachments are base64 only, never a local path. Reading arbitrary files off
  disk is not something this server does, and it would be a worse idea on the way
  out than on the way in.

  Bear in mind the bytes travel through the model context, so a 2 MB PDF is
  roughly 2.7M characters. There is no size cap, because the real ceiling is the
  context window and a made-up number would only obscure it. To relay a file the
  model did not create, `imap_forward` is far cheaper.

- 5690d05: Stars and follow-up flags are now writable, and replies mark the thread answered.

  `\Flagged` was readable all along - the cache stored it and the markdown
  formatter rendered it as a star - but nothing could set it. New
  `imap_set_flags(folder, uids, add?, remove?)` sets or clears `\Flagged` and
  `\Answered` on up to 500 UIDs in one round-trip, and `imap_search_emails`
  gained matching `flagged` / `answered` criteria so a starred message can be
  found again. Unlike `unseen`, these are three-state: `false` means "match the
  negation", not "no filter".

  The whitelist is those two flags only. `\Seen` has `imap_mark_read` and
  deletion has `imap_delete_email`; routing either through a tool annotated as
  idempotent and non-destructive would have been a quiet way to lose mail.

  `imap_reply` now sets `\Answered` on the message it replies to, so a thread the
  model answered no longer reads as unanswered in Thunderbird or Apple Mail. Pass
  `mark_answered: false` to opt out. Like the Sent-folder copy, this never fails
  the send - a flag that does not stick is reported in `mark_answered_error`,
  because an error here would invite a duplicate reply.

  Two smaller consequences: flag writes now share one code path, and that path
  checks whether the server actually applied the change. If it reports none - the
  UID is gone, or the mailbox opened read-only - the cache is left alone instead
  of claiming a flag the server does not hold.

  Also fixes `imap_search_emails` rejecting `{ unseen: false }`. The
  at-least-one-criterion check was a `??` chain, which read `false` as "nothing
  provided".

- 0ef671f: Cache layer refresh.

  - Sync now diffs the server's UID set against the cache instead of refetching
    every envelope in the folder. On servers without CONDSTORE this turned a
    full-folder fetch on every stale read into a fetch of only the new messages
    plus a flags-only pass over the rest.
  - `imap_get_email` and `imap_get_draft` serve a message body from the cache on
    repeat reads. Previously the full MIME source was downloaded and parsed every
    time, and the cached body was written but never read back. Attachment
    metadata is cached alongside it.
  - `IMAP_CACHE_DEFAULT_STALENESS_SEC` now works. It was parsed and ignored while
    every tool hardcoded 60 seconds. `max_staleness_seconds` is optional on each
    tool and falls back to this value.

  - New `IMAP_CACHE_BODY_RETAIN_DAYS` (default 180, `0` disables) clears cached
    message bodies older than that at startup. Bodies are the only unbounded part
    of the cache now that they are actually served; envelopes are kept.
  - The MCP handshake reports the real package version instead of a hardcoded
    `0.1.0`.
  - `imap_get_attachment` now measures the same MIME part it downloads. When two
    attachments shared a filename the size guard could inspect the wrong one and
    reject a small attachment; container parts such as forwarded `message/rfc822`
    were skipped by the guard entirely.

  `IMAP_CACHE_ENABLED`, `IMAP_CACHE_BODY_INLINE` and `IMAP_CACHE_RETAIN_DAYS` are
  gone. None of them ever affected behaviour. They are now ignored rather than
  documented, so existing configs keep working unchanged.

  The published tarball no longer carries source maps, which nothing was reading.
  It drops from 97 kB to 45 kB.

### Patch Changes

- 35e40f6: Cold sync of a large folder writes envelopes in batches.

  `fetchEnvelopes` inserted one envelope per statement, and outside a transaction
  each of those commits on its own. Seeding a 40k-message folder took 7.8s of
  local database work; batching the writes brings it to 4.4s on the same machine.
  The remaining time is query-building overhead, not SQLite, and on a folder that
  size the IMAP fetch itself dwarfs both.

  The batch size is a constant rather than the whole folder because the
  transaction is synchronous and cannot span the `await` on the fetch iterator.

- 35e40f6: Stop issuing a LIST on every send, draft and delete.

  Resolving `\Drafts`, `\Sent` or `\Trash` ran a full mailbox LIST each time, and
  eight code paths do that - every send appends to Sent, every draft tool
  resolves Drafts, every delete resolves Trash. Measured against a local
  GreenMail with four folders it cost about 90ms a call, roughly a fifth of a
  send; a real account with hundreds of labels over the network pays far more,
  for an answer that had not changed.

  `ImapClient` now caches the list for 60 seconds, which brings twenty
  resolutions from 1.8s to nothing measurable. A folder created elsewhere shows
  up within the window, and `imap_list_folders` bypasses the cache entirely, so
  asking what folders exist still reads the server.

  `imap_search_emails` also stopped querying the cache one UID at a time. At the
  default limit it ran up to a hundred single-row selects, then a hundred
  single-row inserts, then a hundred more selects; it now uses batched queries
  throughout - about 9.5ms down to 0.5ms of local work per search.

- 5690d05: Replies keep the whole conversation thread together.

  `imap_reply` emitted a References header containing only the parent's
  Message-ID, because the IMAP envelope carries In-Reply-To but not References
  and nothing ever read the raw header. Mail clients thread on that chain, so
  every reply the server sent started a fresh branch in the recipient's inbox
  from the third message onward.

  The header is now read with one targeted fetch and the parent's Message-ID
  appended to it, capped at 20 entries - keeping the thread root, which is what
  clients actually thread on, and trimming the middle. If the fetch fails the
  reply still goes out with the old single-entry chain: worse threading is a far
  smaller loss than a reply that never left.

## 0.4.0

### Minor Changes

- Fix cache/sync coherence and align total_count with list filters.
  - `countEmailsInFolder` now respects the same filters as `listEmailsByFolder` (unseen, since, before). Previously `total_count` ignored filters, so paginated clients using `unseen_only: true` saw inflated totals and empty pages.
  - Unseen filter moved from JS post-pass into SQL via `json_each`, so paging with `unseen_only` no longer returns empty windows when a chunk of seen messages sits between unseen ones.
  - New `reconcileUids` step runs after every sync. Messages expunged from the server while the client was offline (no IDLE event) are now detected by diffing cache UIDs against `SEARCH ALL` and removed as ghost entries.
  - `imap_search_emails` auto-fills the cache for matching UIDs that aren't yet envelope-cached, so `returned` no longer trails `total_matches` silently.
  - Added lefthook pre-commit (prettier + eslint --fix) and pre-push (typecheck + tests).

## 0.3.2

### Patch Changes

- Simplify the Node 24 version-guard message — no tool-specific references, just the version requirement and a link to nodejs.org.

## 0.3.1

### Patch Changes

- Add Node 24 version guard at startup. When run under Node 22 or earlier (e.g. because proto resolves to an older version outside the project directory), the server now exits immediately with a clear actionable error instead of crashing silently. Adds README troubleshooting section for proto / nvm / fnm users.

## 0.3.0

### Minor Changes

- f0ba09c: Drop `better-sqlite3` in favor of Node 24's built-in `node:sqlite`. No more native bindings, no install scripts, no prebuild downloads, no ABI mismatches. Fixes the `pnpm dlx` failure, the "Could not locate the bindings file" error on Windows, and the Node 22-vs-24 binary mismatch reported against 0.2.0. Internally uses the `drizzle-orm/node-sqlite` driver (new in drizzle-orm 1.0.0-beta). On-disk migration format changed; existing cache databases will be rebuilt on first launch.

## 0.2.0

### Minor Changes

- Bulk operations and richer search.

  ### Bulk mutation tools

  Four new tools that batch a UID list into a single IMAP round-trip,
  replacing loops of the per-UID versions:

  - `imap_mark_read_multiple(folder, uids[])`
  - `imap_mark_unread_multiple(folder, uids[])`
  - `imap_move_multiple(folder, uids[], destination)`
  - `imap_delete_multiple(folder, uids[], hard_delete?)` - soft-deletes
    to `\Trash` by default; `hard_delete: true` permanently expunges.

  Each caps at 500 UIDs per call.

  ### Complex search combinators

  `imap_search_emails` now accepts:

  - `larger_than_bytes` / `smaller_than_bytes` - message size filters
  - `or: [{...}, {...}]` - array of ≥2 sub-criteria; at least one
    must match (maps to IMAP OR)
  - `not: {...}` - sub-criteria that must not match (maps to IMAP NOT)

  Sub-criteria can themselves contain `or` / `not`, so trees like
  `{subject: "invoice", not: {or: [{from: "noreply"}, {from: "donotreply"}]}}`
  work.

  Tool count: 17 → 21.

## 0.1.1

### Patch Changes

- Fix misleading cache-open error message.

  The `CacheError: Could not open cache database at ... Check
IMAP_CACHE_DIR permissions.` message was thrown on every possible
  failure (native binding load failure, file lock, disk issue, and
  actual permission problems), pointing users at the wrong fix.

  The error now distinguishes:

  - native binding load failure → "better-sqlite3 native binding failed
    to load" with a `npm rebuild` hint
  - EBUSY / database-locked → "cache file is locked, probably by
    another mcp-inbox instance" with an IMAP_CACHE_DIR override hint
  - EACCES / EPERM → "Permission denied"
  - ENOENT → "Path not found"
  - disk full → dedicated message
  - anything else → prints the raw driver message verbatim so users
    can debug without having to rerun under DEBUG=mcp-inbox:\*

  Top-level fatal handler also walks and prints the `cause` chain, so
  the underlying native-driver error shows up alongside the hint.
