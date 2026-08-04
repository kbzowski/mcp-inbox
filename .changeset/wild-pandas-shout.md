---
'@kbzowski/mcp-inbox': minor
---

Cache layer refresh.

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
