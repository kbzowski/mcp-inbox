# CLAUDE.md

Guidance for Claude Code when working on this repository.

## Project

MCP server exposing IMAP/SMTP email over a fast local SQLite cache. Published to npm as `@kbzowski/mcp-inbox`; consumers run it via `npx -y @kbzowski/mcp-inbox` over stdio.

## Runtime & tooling

- **Node.js 24 LTS** - `engines.node: ">=24.0.0"`. SQLite via Node's built-in `node:sqlite` (zero native deps, zero install scripts, no ABI mismatches). `node:sqlite` still emits an ExperimentalWarning on load; it's filtered by `src/utils/suppress-sqlite-warning.ts`, which only works because the build emits `dist/index.js` and `dist/app.js` as separate files and the entry dynamically imports the app (see `scripts/build.mjs`). Don't collapse the two bundles.
- **TypeScript strict** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Do not disable.
- **oxlint + oxfmt** replace ESLint and Prettier. Type-aware rules run through `oxlint-tsgolint`, so `npm run lint` needs `--type-aware` to catch anything about types. Config lives in `.oxlintrc.json` / `.oxfmtrc.json`. oxfmt handles JS/TS/JSON only - the three HTML/CSS files under `thunderbird-plugin/src/` are no longer auto-formatted.
- **ESM only** (`"type": "module"`). Use `.js` import extensions in source (TS resolves them at compile time).
- **Zod v4** is the single source of truth for all external inputs - env vars and tool arguments. JSON Schemas for MCP `inputSchema` are derived from Zod via `zod-to-json-schema`; never duplicate a schema.
- **Drizzle ORM** (`drizzle-orm/node-sqlite`) is the cache layer; pinned to an exact `1.0.0-beta.X` version because the 1.0 line is still pre-release. Schema lives in `src/cache/schema.ts`; migrations are generated via `npm run db:generate`.

## Architecture

```
src/
├── index.ts           # Binary entry: shebang, main(), signal handling
├── server.ts          # MCP Server wiring
├── config/env.ts      # Zod env loader
├── tools/             # One file per tool; self-registering
├── imap/              # ImapFlow client, folder discovery, MIME builder, text-part fetch
├── smtp/              # Nodemailer transporter
├── embeddings/        # Embeddings HTTP client + quote stripping / chunking
├── cache/             # Drizzle schema, sync engine, IDLE listener, vector index
├── errors/            # Error hierarchy + raw-error mapper
├── formatters/        # markdown + json response formatters
├── utils/             # logger, assertions
└── types/             # shared domain types
```

## Critical rules

- **Never write to stdout.** stdio is the MCP transport. Use `console.error` or the `createLogger()` helper. oxlint enforces `no-console` with `allow: ['error']`.
- **Never hand-roll MIME.** Use `nodemailer`'s message builder for drafts and sent-copy appends.
- **Never mutate the database directly.** Use Drizzle queries - they carry types through.
- **Never make a tool both listed and undispatched, or dispatched without a listing.** The registry handles this automatically; don't bypass it.
- **IMAP UIDs are folder-scoped.** Every tool that accepts a `uid` must also accept a `folder`. Don't assume INBOX.
- **Drafts**: `update_draft` is append-then-delete, never delete-then-append - a failure in the middle must not lose the user's draft.
- **Semantic search must never become load-bearing.** It is optional, opt-in per folder, and unavailable on some platforms. Every failure path has to name `imap_search_emails` as the fallback, and no existing tool may start depending on the vector index.
- **Never hold the mailbox lock across an HTTP call.** One IMAP connection serves the whole server, so an embeddings round-trip inside a lock stalls every other tool.

## Cache layer

- Freshness: each read tool accepts `max_staleness_seconds` (default 60). If the folder was synced within that window, serve from cache with no network.
- Invalidation: `UIDVALIDITY` change ⇒ wipe that folder's cache. `EXPUNGE` (from IDLE) ⇒ delete cached row.
- Write-through: mutations optimistically update the cache; next sync/IDLE event reconciles.
- Retention: message bodies are the only unbounded part of the cache, so `IMAP_CACHE_BODY_RETAIN_DAYS` (default 180, `0` disables) clears bodies older than that at startup. Envelopes stay - they're small and drive list/search.
- Any query with an `IN (...)` over UIDs must batch. SQLite caps a statement at 32766 bound parameters and real folders exceed that; `inBatches()` in `queries.ts` is the shared helper.
- IDLE is on by default for INBOX via `IMAP_IDLE_FOLDERS`. Empty string disables.

## Semantic search (optional feature)

Off unless `IMAP_EMBEDDINGS_BASE_URL` is set. `imap_index_folder` builds a per-folder vector index; `imap_semantic_search` reads it. Vectors live in `vec_emails`, a `vec0` virtual table inside the same SQLite cache, via the `sqlite-vec` extension.

- **`sqlite-vec` is the one native dependency**, and the only break from the zero-native-deps rule. It ships no binary for **win32-arm64 or Alpine/musl**; there `openCache` sets `vectorsAvailable: false`, the two tools fail with an actionable error, and everything else works. Keep it a regular `dependency`: as an `optionalDependency` the static import would throw `ERR_MODULE_NOT_FOUND` before any try/catch could run.
- **The `vec0` table is created lazily, never in a migration.** `CREATE VIRTUAL TABLE ... USING vec0` throws where the extension is missing, and a failing migration is a fatal startup error - it would take the whole server down, not just this feature.
- **Every integer bound into a vec0 statement must be a `BigInt`.** `node:sqlite` binds JS numbers as FLOAT and vec0 rejects that for its INTEGER columns (`Expected integer ... received FLOAT`). `int()` in `vectors.ts` is the helper.
- **`k = ?` is mandatory in a KNN query** and the CTE must stay `MATERIALIZED`, or the planner inlines the scan and loses the constraint. Group by `uid` *outside* the CTE.
- **A message owns several rows** - `part 0` is the envelope, `part 1..n` are body chunks - so `insertVectors` deletes per `uid` (not per `uid, part`), and anything counting messages needs `count(DISTINCT uid)`.
- **Fetch only the text part, never full RFC822.** Measured on a real 1534-message INBOX: 284 MB of full messages versus ~3.4 MB of text. Use `pickTextPart` + `bodyParts`, and request part **`1`** for a single-part message - GreenMail returns zero bytes for `TEXT` there, while both it and Dovecot accept `1`. Only leaf `text/*` nodes qualify; a `multipart/alternative` child fetched by id returns raw MIME with boundaries.
- **`bodyParts` returns transfer-encoded bytes.** Only `download()` decodes, and it is `fetchOne`-based so it cannot be used in bulk. `decodeTextPart` handles base64, quoted-printable and the charset. Response keys are lower-cased.
- **Fetched body text is never written to `emails.bodyText`.** That column's contract includes attachment metadata and `bodyCachedAt`; a partial write would make `imap_get_email` report zero attachments.
- **`INDEX_VERSION` in `vectors.ts` forces a rebuild.** Bump it whenever the meaning of an indexed row changes; `ensureVecTable` then drops the index and the next `imap_index_folder` re-embeds. Say so in the changeset - users pay for it in wall-clock.
- **Search reads, the sweeper writes.** `IndexSweeper` (`cache/indexer.ts`) is the only thing that tops up the index in the background; `imap_semantic_search` must stay a pure reader so its latency is predictable. Don't reintroduce inline backfill there.
- Omitting `folder` in `imap_semantic_search` searches every indexed folder: vec0 scans all partitions when the partition key is unconstrained, and each hit carries its own `folder`.
- Throughput on real hardware is ~4 messages/second end to end. `max_messages` defaults to 500 (~2 min) because a longer tool call trips MCP client timeouts.

## Common pitfalls

- **Credentials with shell-special characters** break `claude mcp add` invocations. Document single-quoting in the README.
- **Outlook** needs `SMTP_PORT=587` + `SMTP_SECURE=false`; the 465/true defaults won't work there.
- **Gmail** requires an app password, not the account password. The error mapper surfaces this with an actionable hint.
- **GreenMail integration tests** need Docker. The CI workflow provides the service; local runs need `docker run -p 3143:3143 greenmail/standalone`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server via `tsx` (no build step) |
| `npm run build` | esbuild bundle + `tsc --emitDeclarationOnly` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | oxlint over `src/` + `tests/`, with type-aware rules |
| `npm run format` | oxfmt write |
| `npm run test` | Vitest unit tests |
| `npm run test:integration` | Vitest integration (requires GreenMail) |
| `npm run db:generate` | drizzle-kit generate migrations from `src/cache/schema.ts` |
| `npm run release` | `changeset publish` - publish a new version |

## Release

First publish (0.1.0):

```bash
# Fresh build + verify everything passes
npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build

# See what ends up in the tarball
npm pack --dry-run

# Publish with provenance (requires npm login)
npm publish --provenance --access public
```

Subsequent releases use changesets:

```bash
# 1. While making changes, for each user-visible change:
npx changeset add

# 2. When ready to release - bumps package.json, writes CHANGELOG.md:
npx changeset version

# 3. Publish:
npm run release
```

Changesets maps `patch | minor | major` in each changeset file to a
semver bump per standard rules. For 0.x versions, treat `minor` as
the "new feature" bump and `patch` as "fix only."
