# @kbzowski/mcp-inbox

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
