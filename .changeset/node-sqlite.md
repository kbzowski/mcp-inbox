---
'@kbzowski/mcp-inbox': minor
---

Drop `better-sqlite3` in favor of Node 24's built-in `node:sqlite`. No more native bindings, no install scripts, no prebuild downloads, no ABI mismatches. Fixes the `pnpm dlx` failure, the "Could not locate the bindings file" error on Windows, and the Node 22-vs-24 binary mismatch reported against 0.2.0. Internally uses the `drizzle-orm/node-sqlite` driver (new in drizzle-orm 1.0.0-beta). On-disk migration format changed; existing cache databases will be rebuilt on first launch.
