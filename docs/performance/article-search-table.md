# Article search projection

ArticleSearch is a trigger-maintained 1:1 projection of Article, keyed by its article
ID (PK and cascading FK). It owns title/content/excerpt/author/entities search and
all five PostgreSQL pg_trgm GIN indexes. Article keeps its original serving columns.
The user/feed/read-state filters remain on Article; duplicating them in the projection
would add synchronization work to state changes. UI, REST v1, MCP, saved searches,
auto-read rules and list filters share lib/search.ts. Newsletter diagnostics also use
the projection. GReader and Fever have stream/state filters, no text-search endpoint.

Read-state remains Article.isRead/readAt/isStarred/isReadLater/readLaterSavedAt (and
spoiler flags). **This does not enable HOT for mark-read:** existing B-tree indexes
contain isRead/readAt, and Article still carries the serving text. It removes the
expensive GIN maintenance from non-HOT Article updates. Splitting read state and/or
serving content can be considered separately.

Both providers use insert and column-specific update triggers, with a value-change
guard so even SET title=title does no work. Read state, updatedAt and full-text
bookkeeping do not fire them. Deletion and identity changes cascade through the FK.
All ingestion paths, raw SQL, full-text extraction and entity enrichment are covered.
The startup helper provisions the identical triggers only for explicit db-push/dev
databases; migration-managed installations take a cheap catalog probe. It then compares
the Article and ArticleSearch row counts (the FK makes the projection a subset, so equal
counts mean complete) and, if rows are missing, fills them in small batches in the
background, logging it and reporting `search.projection` in /api/health. **Search uses the
projection only after this process has verified it complete and, on Postgres, its five trigram
indexes are valid** (`isArticleSearchReady()`; with pg_trgm unavailable, completeness suffices);
until then lib/search.ts runs the identical predicates on the Article columns (free text,
fields, entities and negations; result-equivalence is tested), so an incomplete projection
can never hide articles. A failed or incomplete check is retried with backoff (30 s … 15 min),
not only on restart; a verified projection is re-checked hourly. The legacy Article trigram
indexes are dropped only once the projection is verified and its indexes are valid, right after
search switched over, so search never runs unindexed (an unindexed `content:` query was measured
at 2.7 s vs 0.18 s on 100k). The newsletter test-mail lookup uses the same routing
(`articleTextWhere`). If the index check fails transiently (connection loss, statement
timeout) or another instance holds the build lock, it is retried with backoff (30 s … 15 min)
until ready; with the lock held elsewhere it only checks validity and switches without building. db-push test databases use
tests/helpers/sqlite-test-db.ts (schema + triggers + verified), mirroring production.

SQLite's existing external-content trigram FTS now reads ArticleSearch. The old
Article-backed FTS is discarded atomically at startup, including stale completion
markers, then rebuilt with the existing resumable/time-boxed background backfill.
While incomplete, search uses LIKE against ArticleSearch. Article rowids are copied
to projection rowids for compatibility with older binaries. Entity search remains
LIKE on SQLite. Negation stays inside the Prisma relation to preserve SQL NULL
semantics, especially -author and -entity.

## Deployment and locks

The migration only does the fast part; it is idempotent and never builds or drops a GIN index
on a populated database (that is what made the first version deadlock and run ~130 s at 200k).

Postgres migration (`20261112170000_article_search_table`), each phase its own short transaction:
1. Table (`IF NOT EXISTS`), `CREATE OR REPLACE FUNCTION`, then FK and triggers in one guarded
   `DO` block. Only the FK/trigger DDL locks Article (SHARE ROW EXCLUSIVE, first run only; a
   re-run takes none). Writers queue behind a pending lock request, so each attempt is bounded by
   `lock_timeout = 2s`, followed by a 1 s pause that lets them through; up to 30 attempts. **True
   bound: writers wait at most ~2 s at a time** (instead of as long as the longest running
   transaction). If the lock is never granted in ~90 s the migration fails and the next start
   re-runs it (see P3009 below). App routes with a 5 s interactive transaction (e.g. REST v1
   PATCH) therefore no longer hit Prisma's timeout because of this phase.
2. Copy into the unindexed projection under `LOCK TABLE "Article" IN EXCLUSIVE MODE` with
   `lock_timeout` and `statement_timeout` of 10 s. Plain reads continue; writers **and row-locking readers** (bulk
   mark-read's `SELECT … FOR UPDATE`) wait for the copy. The lock is granted only after every
   transaction that wrote or row-locked Article has finished, so neither a trigger-written
   projection row nor a foreign row lock can be in flight: the copy's inserts and FK checks
   never wait on another transaction, hence no cycle. (A SHARE lock, used by an earlier draft,
   still admits `FOR UPDATE` and deadlocks with bulk mark-read; the PG test keeps that as a
   control.) `ON CONFLICT DO NOTHING` makes a re-run cheap. The lock wait and the copy run in one
   statement (the `DO` block), so `statement_timeout` bounds the **total** time writers can be
   held up to 10 s, independent of corpus size and storage speed (bulk mark-read's own
   transaction allows 30 s; an unbounded copy on a large/slow corpus would have failed it with
   P2028). If the lock is not granted in time (a long-running transaction) or the copy is too
   slow (a large corpus — at the measured ~0.5 s per 20k articles, roughly beyond 300–400k on
   this hardware), the subtransaction rolls back, which releases the lock, and the copy is
   skipped with a WARNING instead of failing the deploy. Search stays on the Article columns
   until the app's self-check has filled the gap in batches and verified it. Each batch holds the
   same EXCLUSIVE lock with `lock_timeout` and `statement_timeout` of 5 s (writers wait ≤ 10 s
   per batch); a batch that hits the statement timeout is retried with half the rows actually in
   its range (down to 1) without spending the retry budget, so a slow disk shrinks the batches
   instead of stalling writers. The size is remembered for the process (also across maintenance
   cycles) and doubles again after batches that finish in under 1 s. Only lock conflicts and
   timeouts of a single-row batch count toward the 8-attempt budget. Tested with fault injection (1 s per
   projection insert): the real bulk mark-read finished inside the bound, the copy was handed
   off cleanly.
3. Only if Article is empty (fresh install, Prisma's shadow replay): drop the old
   `Article_*_trgm_idx` and create the new GIN indexes (instant). Both branches key on Article
   being empty, so a populated database whose copy was deferred never takes them.
   The migration history must produce the schema's index set for the CI drift gate, so this
   small, lock-safe branch remains; populated databases never take it.

After the migration, on a populated database, `ensureSearchIndexes()` (lib/search-indexes.ts)
runs in the background, not awaited before serving (also no longer awaited on Postgres in
instrumentation.ts):
- dedicated connection, session advisory lock (one instance builds), `statement_timeout = 0`;
- per column `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ArticleSearch_<col>_trgm_idx"`; an
  `INVALID` leftover (`pg_index.indisvalid = false`, from a killed concurrent build) is first
  dropped with `DROP INDEX CONCURRENTLY` and rebuilt;
- only when all five are valid: `DROP INDEX CONCURRENTLY IF EXISTS` the five old
  `Article_*_trgm_idx`. This runs on every start, so it also cleans up after a roll-forward
  from an older image (which recreates them, see Rollback);
- skipped entirely with `PRISMA_PG_TRGM=0`, or when pg_trgm is missing and cannot be created
  by the role (restricted installs): search uses unindexed ILIKE, as before.

Search stays correct throughout, only slower until the indexes are ready: ILIKE without a
trigram index is a sequential scan of ArticleSearch. Until the swap is done, the startup drift
check logs `✅ Database schema matches prisma/schema.prisma, except the search index swap the
app finishes in the background…` (only these exact ten statements are tolerated; anything else
is still reported as drift). Progress: `[search-indexes]` log lines with per-index build times,
and `/api/health` → `search.indexes` (`pending`/`building`/`ready`/`unavailable`/`error`).
`FEEDFERRET_DB_SYNC=push` (fallback) applies the swap synchronously via `db push`, i.e. with a
blocking index build; do not use it for this upgrade.

### Measured (synthetic, Postgres 16, 200,000 articles)

`scripts/bench-search-migration.mjs` (results in
[article-search-migration-results.json](article-search-migration-results.json)), Docker
Postgres 16 on the dev Mac. Article: 413 MB heap+TOAST, 901 MB with indexes (≈450-word bodies).
Two writers run multi-statement transactions throughout: insert an article, update a title,
bulk mark-read 50 articles as server/articles/bulk-read.ts does (`SELECT … FOR UPDATE`, then
`UPDATE`), 20 % delete one. That covers both deadlock patterns found in review.

| step | result |
|---|---|
| migration (`prisma migrate deploy`), 3 trials | 4.6 s, 5.0 s, 6.0 s; 0 deadlocks, 0 deferred copies, 0 writer errors; projection == Article, 0 content mismatches; Article GIN indexes untouched |
| writer pause during the migration | ≈ the copy phase (a few seconds); writers resume, no errors |
| background index build (app helper, writers running) | 485.5 s: content 357.5 s, entities 74.5 s, author 17.6 s, excerpt 9.2 s, title 3.3 s; 2,348 writer transactions completed meanwhile, 0 errors; then 5 valid ArticleSearch indexes, 0 legacy. (An earlier run with lighter writers: 295 s. CONCURRENTLY builds also wait for running transactions, so expect variance.) |
| projection size | 869 MB incl. 414 MB GIN indexes |
| kill during `CREATE INDEX CONCURRENTLY` (SIGKILL + backend terminated) | INVALID leftover detected on restart, dropped, rebuilt; all 5 valid |
| kill during the migration copy (SIGKILL + backend terminated) | plain restart: `♻️ … failed or was interrupted (P3009)`, auto `--rolled-back`, re-run completes; projection complete, triggers present |
| legacy Article GIN build (what an older image does at start after rollback) | 66.8 s, blocking |

Regression run after the round-3 fixes (phase-1 lock retry, interactive backfill transactions),
100,000 articles, same writers: migration 2.1 / 2.9 / 2.9 s, 0 writer errors; background index
build 160 s, 0 writer errors; projection 446 MB incl. 240 MB GIN; both kill tests pass. Phase 1
behind a 10 s writer transaction (1,000 articles): other writers waited at most 2.0 s at a time,
the migration completed after 9.5 s.

The PG test suite (tests/lib/article-search-storage.test.ts with `SEARCH_TEST_PG_URL`, also run
in the CI `Migrations (postgresql)` job) also runs
the real migration copy and the app backfill against a bulk mark-read writer in both orders
(writer row-locks first / copy locks first) with no error, plus a control showing the old SHARE
copy deadlocks (40P01) in the same setup.

The app's HTTP server is up right after the migration (≈5 s plus normal boot), well inside the
60 s healthcheck start period; the index build no longer delays startup. Real bodies, slower
storage and WAL pressure will make both numbers larger; the build time scales mostly with the
total content size (the content index dominates).

### Deploy procedure (production)

1. Backup (`pg_dump -Fc`, restore tested) — owner's normal process. **Disk:** the projection
   adds roughly 0.9–1 GB per 100k articles once indexed (measured: 937 MB per 100k on a Postgres 17
   review corpus; 869 MB per 200k with the shorter synthetic bodies here), with a peak of about
   1.5× that during the copy and the index builds (WAL, build temp files). The legacy Article
   indexes are freed only at the end.
2. Deploy normally. Expected startup log: `Applying migration 20261112170000_article_search_table`,
   then `…except the search index swap the app finishes in the background…`. During the
   migration, Article writers (and `SELECT … FOR UPDATE`) wait at most ~2 s at a time in phase 1
   and at most 10 s in phase 2 (lock wait plus copy, bounded by `statement_timeout`; a longer copy
   is handed off to the app's batches, ≤ 10 s each); plain reads are never blocked.
3. Watch `[search-indexes] … built in N s` / `Dropped legacy Article_*` lines, or poll
   `/api/health` until `search.indexes` is `ready` and `search.projection.state` is `complete`.
   Search works meanwhile (slower). Ingestion continues.
4. If the container is killed during the migration, or it fails: just restart. Prisma records
   the migration as failed (P3009); because it is listed in `IDEMPOTENT_MIGRATIONS`
   (scripts/migration-utils.mjs), startup logs `♻️ Migration … failed or was interrupted (P3009)…`,
   marks it rolled back and runs it again (under the schema lock), **at most 3 times** (manual
   `--rolled-back` runs count toward that limit). After that
   (a permanent cause such as a full disk, SQLSTATE 53100) it stops with manual steps instead of
   re-taking the Article lock on every start. Prisma then often shows only `current transaction
   is aborted…` and `_prisma_migrations.logs` is empty: the real error is in the Postgres server
   log. Any other failed migration still stops the start for manual recovery (docs/database.md).
   If it is killed during the index build: just restart (INVALID indexes are rebuilt).

SQLite copies text in its migration write transaction (`IF NOT EXISTS`/`ON CONFLICT`, so it is
re-runnable too); its single-writer architecture means writes wait for that copy. The expensive
trigram build is deferred to the existing resumable background FTS process. Startup search
remains complete throughout FTS rebuilding. Leave additional disk space for both copies of the text.

The migration passes scripts/check-migration-policy.mjs with an explicit, narrow
ff:allow-destructive reason (empty-database index swap only). **It is deliberately not added to
the pure-DDL adoption allowlist** in migration-utils.mjs: that allowlist means "safe to mark
applied WITHOUT executing", which would skip both triggers and backfill. Consequence: every
legacy db-push database that is already *ahead of* the baseline now stops at startup and needs
the operator path in docs/database.md (run the idempotent migration SQL, then
`FEEDFERRET_DB_ADOPT_CONFIRM=20261112170000_article_search_table` once). Databases with
`_prisma_migrations` (production) are not affected.

## Rollback

Do not merge until the PM has arranged the owner's backup. No merge is part of this work.
Roll back the application image; keep ArticleSearch, its triggers and migration history.
All original Article columns remain authoritative for the older binary, and the triggers keep
ArticleSearch in sync while it runs, so a later roll-forward needs no backfill.

Older Postgres images recreate the five Article GIN indexes **at startup, awaited, with a plain
CREATE INDEX** (66.8–71.5 s at 200k above, holding a SHARE lock on Article). That old code cannot be
changed. To avoid the startup delay, pre-build them concurrently while the new image still runs,
then roll back (the old `CREATE INDEX IF NOT EXISTS` then finds them):

    CREATE INDEX CONCURRENTLY IF NOT EXISTS "Article_title_trgm_idx" ON "Article" USING GIN ("title" gin_trgm_ops);
    -- same for content, excerpt, author, entities

(Do not restart the new image in between: its startup drops them again.) After rolling forward
again, the new image drops them concurrently once the ArticleSearch indexes are valid.

SQLite's older startup reinstalls its Article FTS triggers; preserved rowids keep its
lookups compatible. For a clean legacy SQLite FTS rebuild, discard only the disposable
article_fts table/triggers and markers before starting the older binary.
Do not down-migrate or drop Article columns in this release. Restore the backup only
under the owner's normal recovery process if needed.

## Validation and benchmark

The opt-in tests/mark-read-scale-benchmark.test.ts harness uses synthetic data only:
user A has 50,000 articles (44,879 unread), user B 5,000 unread; 200 feeds and ~2 KB
bodies. Same seed and Docker Postgres 17 instance before (1709286) and after; fresh
databases, normal durability, no other benchmark running on the instance. Bulk timings
are single wall-clock samples per route, not statistical medians. Search is count plus
a 50-ID sorted page, one warmup and five measured runs. The harness now records search
latency too.

Reproduce using a disposable empty database with pg_trgm installed, after generating
the client with DATABASE_PROVIDER=postgresql pnpm prisma:generate:

    MARK_READ_BENCH=1 MARK_READ_BENCH_RESULT=/tmp/search.json \
      PERF_BENCH_DATABASE_URL=postgresql://.../empty_bench \
      pnpm exec vitest run tests/mark-read-scale-benchmark.test.ts

For cross-provider upgrade/equivalence/trigger assertions:

    pnpm exec vitest run tests/lib/article-search-storage.test.ts
    # Generate Postgres client, then use a disposable EMPTY Postgres DB:
    SEARCH_TEST_PG_URL=postgresql://.../empty_test \
      pnpm exec vitest run tests/lib/article-search-storage.test.ts

Migration and index-build timings: see "Measured" above (the earlier 9 s figure for the
first version was wrong; an independent review measured 129.6 s at 200k for it, almost all in
the in-migration GIN builds that this version moved to the background).

All local gates passed: lint, TypeScript, 3,200 unit tests and 58 timing tests,
plus both full migration integration gates (including restricted Postgres roles and the
interrupted-migration `--rolled-back` re-run).
The separate real-DB equivalence suite also passed on Postgres. No UI changes.

### Results

The alternating paired experiment isolates Article GIN maintenance on the SAME 55k
corpus, with the projection and triggers present in both variants. It performs the
actual UI markAllAsRead action, alternating retained/removed/removed/retained/retained/
removed. VACUUM ANALYZE runs outside each timing to normalize pending GIN entries and
setup writes. Each sample changes 44,879 rows, leaves the other user's 5,000 unread rows
alone, and records zero updatedAt bumps. There is host I/O variation; report all samples.

| Article GIN indexes | samples (ms) | median (ms) |
|---|---|---:|
| retained | 5993.6, 5881.8, 9726.1 | 5993.6 |
| removed | 1842.0, 1967.0, 3883.7 | 1967.0 |

This is a 3.05× median speedup (67.2% reduction), without claiming HOT updates.

Reproduce the paired run on a fresh synthetic database:

    MARK_READ_BENCH=1 MARK_READ_BENCH_PAIRED=1 \
      PERF_BENCH_DATABASE_URL=postgresql://.../empty_bench \
      pnpm exec vitest run tests/mark-read-scale-benchmark.test.ts -t 'paired:'

The original end-to-end harness (one sample per route) gives the following. Later
samples show substantial I/O variation, so they are not evidence of a universal speedup
for every endpoint; the alternating experiment above isolates the physical change.


| operation | baseline (ms) | projection (ms) |
|---|---:|---:|
| ui.markAll.all | 7025.8 | 2371.8 |
| ui.undo.all | 6280.6 | 2790.4 |
| ui.markAll.search | 3149.9 | 1447.5 |
| greader.markAll.readingList | 6539.4 | 3365.4 |
| fever.group0 | 6569.3 | 7801.3 |
| v1.markAll | 5612.3 | 7829.4 |
| mcp.markAll | 8020.9 | 5967.8 |
| concurrency.markAllWithSync | 8953 | 7298.4 |

The baseline overlap stress test returned one incomplete retry result despite leaving
zero unread rows; it also recorded a sync deadlock. The after run passed all seven
scenarios, including overlap, with zero unread rows remaining and no post-cutoff inserts
marked. Sync transaction deadlocks remain possible and were recorded in both runs.

Steady-state search: scripts/bench-article-search.mjs runs legacy Article predicates
and equivalent projection predicates in alternating order on the same paired corpus.
It temporarily creates missing legacy indexes, VACUUM ANALYZEs both tables outside
timing, then removes only the indexes it created. Each result below is five measured
count+page runs after warmup; result counts AND page IDs are asserted equal.

    PERF_BENCH_DATABASE_URL=postgresql://.../seeded_paired_bench \
      node scripts/bench-article-search.mjs

| query | matches | Article median/p95 (ms) | projection median/p95 (ms) |
|---|---:|---:|---:|
| alpha 12345 | 1 | 1162.9 / 1206.5 | 1272 / 1370.5 |
| charlie | 16667 | 404.5 / 432.5 | 411.4 / 443.4 |
| title:12345 | 1 | 1.1 / 1.9 | 1.2 / 1.2 |

The join adds about 9% for the multi-term free-text query in this fixture; broad search
remains dominated by the unchanged link/feed/label OR branches and counting. Selective
title search still uses the GIN bitmap scan followed by the Article PK lookup.

For completeness, the fresh-load harness search medians (before pending-list
normalization) were 1129.5 → 1277.9 ms for alpha 12345, 378.6 → 401.1 ms for charlie,
and 3.4 → 32.5 ms for title:12345. GIN pending-list state matters after a large import:
Article extId/bookkeeping writes previously churned the old GIN indexes, whereas the
projection skips those writes. The normalized paired measurements show that the
selective-query regression is not persistent, but fresh-load latency is still a risk.

Raw synthetic results, including all samples and invariants, are in
[article-search-results.json](article-search-results.json). No owner data was used.
