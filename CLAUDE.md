# CLAUDE.md

Guidance for Claude Code when working on this repository.

## Project

MCP server exposing IMAP/SMTP email over a fast local SQLite cache. Published to npm as `mcp-inbox`; consumers run it via `npx -y mcp-inbox` over stdio.

## Runtime & tooling

- **Node.js 24 LTS** — `engines.node: ">=24.0.0"`. SQLite via `better-sqlite3` (prebuilt binaries, no build toolchain required). Previously planned `node:sqlite` but Drizzle ORM does not yet ship a driver for it (drizzle-team/drizzle-orm#2648).
- **TypeScript strict** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Do not disable.
- **ESM only** (`"type": "module"`). Use `.js` import extensions in source (TS resolves them at compile time).
- **Zod v4** is the single source of truth for all external inputs — env vars and tool arguments. JSON Schemas for MCP `inputSchema` are derived from Zod via `zod-to-json-schema`; never duplicate a schema.
- **Drizzle ORM** (`drizzle-orm/node-sqlite`) is the cache layer. Schema lives in `src/cache/schema.ts`; migrations are generated via `npm run db:generate`.

## Architecture

```
src/
├── index.ts           # Binary entry: shebang, main(), signal handling
├── server.ts          # MCP Server wiring
├── config/env.ts      # Zod env loader
├── tools/             # One file per tool; self-registering
├── imap/              # ImapFlow client, folder discovery, MIME builder
├── smtp/              # Nodemailer transporter
├── cache/             # Drizzle schema, sync engine, IDLE listener, attachments
├── errors/            # Error hierarchy + raw-error mapper
├── formatters/        # markdown + json response formatters
├── utils/             # logger, assertions
└── types/             # shared domain types
```

## Critical rules

- **Never write to stdout.** stdio is the MCP transport. Use `console.error` or the `createLogger()` helper. ESLint enforces `no-console` with `allow: ['error']`.
- **Never hand-roll MIME.** Use `nodemailer`'s message builder for drafts and sent-copy appends.
- **Never mutate the database directly.** Use Drizzle queries — they carry types through.
- **Never make a tool both listed and undispatched, or dispatched without a listing.** The registry handles this automatically; don't bypass it.
- **IMAP UIDs are folder-scoped.** Every tool that accepts a `uid` must also accept a `folder`. Don't assume INBOX.
- **Drafts**: `update_draft` is append-then-delete, never delete-then-append — a failure in the middle must not lose the user's draft.

## Cache layer

- Freshness: each read tool accepts `max_staleness_seconds` (default 60). If the folder was synced within that window, serve from cache with no network.
- Invalidation: `UIDVALIDITY` change ⇒ wipe that folder's cache. `EXPUNGE` (from IDLE) ⇒ delete cached row.
- Write-through: mutations optimistically update the cache; next sync/IDLE event reconciles.
- IDLE is on by default for INBOX via `IMAP_IDLE_FOLDERS`. Empty string disables.

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
| `npm run lint` | ESLint over `src/` |
| `npm run format` | Prettier write |
| `npm run test` | Vitest unit tests |
| `npm run test:integration` | Vitest integration (requires GreenMail) |
| `npm run db:generate` | drizzle-kit generate migrations from `src/cache/schema.ts` |
| `npm run release` | `changeset publish` — publish a new version |
