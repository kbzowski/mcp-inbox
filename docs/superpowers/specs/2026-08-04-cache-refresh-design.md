# Cache layer refresh — design

Date: 2026-08-04
Status: proposed

## Context

An audit of `src/` (4.5k LOC) found that the four bugs recorded in April
are already fixed (commit `bc04954` aligned cache counts with list
filters and added ghost-UID reconciliation; `sync.ts` does a full
`1:*` fetch when the cache is empty; `search-emails` auto-fills missing
UIDs). What remains are three defects in the cache contract plus a
dependency lag.

The module structure itself is sound — largest file is 277 lines,
boundaries are clean, the tool registry self-registers. No structural
refactor is proposed; it would be churn without benefit.

## Problems

### P1 — Sync re-fetches every envelope in the folder

`runSync` falls through to `fetchAndStoreRange(ctx, folder, '1:*')` for
any server without CONDSTORE. With the default 60-second staleness
window, an active session against a 20 000-message folder re-fetches
20 000 envelopes (plus `bodyStructure`) every minute.

The waste is structural: envelopes are immutable. Only flags change.
And `reconcileUids` already performs a server-side `SEARCH ALL`, so the
full server UID set is available for free on every sync.

### P2 — Cached bodies are written but never read

`ensureBodyCached` unconditionally runs `fetchOne(source)` and
`simpleParser` before checking the cache. The `bodyText`, `bodyHtml`
and `bodyCachedAt` columns are populated and never consulted. Every
`imap_get_email` re-downloads the complete MIME message. The function's
own doc comment claims idempotence that does not hold.

### P3 — Four cache env vars do nothing

`IMAP_CACHE_ENABLED`, `IMAP_CACHE_BODY_INLINE`,
`IMAP_CACHE_DEFAULT_STALENESS_SEC` and `IMAP_CACHE_RETAIN_DAYS` are
parsed, validated, placed on `ToolContext.cacheConfig`, and never read.
Every tool hardcodes `max_staleness_seconds` to `.default(60)`. The
README documents all four as working knobs.

### P4 — Dependency lag

`imapflow` is three minors behind (1.3.2 → 1.6.5) on the most critical
dependency in the project. `nodemailer` 8 → 9, `typescript` 6 → 7 and
`testcontainers` 11 → 12 are majors; the rest are patches. `drizzle-orm`
and `drizzle-kit` stay pinned at `1.0.0-beta.22` per CLAUDE.md.

## Design

### D1 — UID-diff sync

`runSync` is replaced with a single algorithm that no longer branches on
CONDSTORE availability for the envelope path:

1. SELECT the mailbox; read UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ.
2. On UIDVALIDITY change, wipe the folder cache (unchanged behaviour).
3. `imap.search({ all: true }, { uid: true })` — the authoritative
   server UID set. One SEARCH, no envelope traffic.
4. Diff against `listCachedUidsForFolder`:
   - present locally, absent on server → delete (ghosts)
   - present on server, absent locally → fetch envelopes for exactly
     those UIDs
5. Refresh flags on the intersection:
   - CONDSTORE and a cached HIGHESTMODSEQ → `fetch('1:*', { flags },
     { changedSince })`, returning only rows whose MODSEQ advanced
   - otherwise → `fetch('1:*', { flags })`, a flags-only fetch whose
     payload is a fraction of envelope + bodyStructure
6. Persist folder sync state.

An empty cache degenerates to step 4 fetching every UID — identical to
today's cold-start behaviour, which is correct.

`SyncType` keeps its three values: `full` (cold start or UIDVALIDITY
wipe), `incremental`, `skipped` (MODSEQ unchanged and no UID diff).

New query in `cache/queries.ts`: a bulk flag writer taking
`Map<uid, string[]>` and applying it in one transaction. The existing
per-row `setEmailFlags` stays for the IDLE path.

### D2 — Body read-through

`emails` gains a nullable `attachmentsJson` text column (drizzle-kit
migration). Attachment metadata is small and derived from the same
parse, so caching it alongside the body removes the last reason to
re-fetch.

`ensureBodyCached` becomes: if `bodyCachedAt` is non-null, return the
cached text, HTML and attachment metadata without touching the network.
Otherwise fetch, parse, persist all three, and return. Message bodies
are immutable, so no staleness window applies.

### D3 — Config truth

`IMAP_CACHE_ENABLED`, `IMAP_CACHE_BODY_INLINE` and
`IMAP_CACHE_RETAIN_DAYS` are removed from `config/env.ts` and from the
README. Keeping a knob that does nothing is worse than not offering it.

`IMAP_CACHE_DEFAULT_STALENESS_SEC` is wired up. Because Zod defaults are
baked into the exposed JSON Schema, the per-tool
`max_staleness_seconds` field changes from `.default(60)` to
`.optional()`, and handlers resolve
`args.max_staleness_seconds ?? ctx.cacheConfig.defaultStalenessSec`.
Tool descriptions state that the default comes from the environment.

`IMAP_CACHE_DIR` is untouched.

### D4 — Dependencies

Bump everything except the pinned drizzle pair. Majors
(`nodemailer` 9, `typescript` 7, `testcontainers` 12) are taken in a
separate commit from the patch/minor sweep so a regression is bisectable.
The gate is `npm run typecheck && npm run lint && npm run test && npm run
build`, plus `npm run test:integration` against GreenMail.

## Non-goals

**No pluggable cache backend.** Semantic search over embeddings is not a
second cache implementation — it is an additional index over the same
SQLite rows (a vector column plus `sqlite-vec`). `cache/queries.ts`
already isolates query construction from the tools, which is the only
seam that future work needs. An interface with one implementation would
be built for nothing.

**No structural refactor of `src/`.** See Context.

## Testing

- `tests/unit/cache/sync.test.ts` — new cases: server UID set larger
  than cache fetches only the difference; ghost UIDs are deleted; the
  flags-only path updates flags without touching envelope columns;
  MODSEQ-unchanged with no UID diff reports `skipped`.
- New unit test for `ensureBodyCached` — second call performs no IMAP
  fetch and returns the cached attachment metadata.
- `tests/unit/tools/schema-validation.test.ts` — assert
  `max_staleness_seconds` is absent-permitted and that the env default
  is applied by the handler.
- Integration suite runs unchanged against GreenMail as the regression
  gate for the sync rewrite.

## Order of work

1. D4 patch/minor bumps (green baseline before touching logic)
2. D1 sync rewrite + tests
3. D2 body read-through + migration + tests
4. D3 config wiring and README
5. D4 major bumps, separate commit
