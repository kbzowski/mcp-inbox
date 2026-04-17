# @kbzowski/mcp-inbox

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
