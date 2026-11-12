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
databases; migration-managed installations take a cheap catalog probe.

SQLite's existing external-content trigram FTS now reads ArticleSearch. The old
Article-backed FTS is discarded atomically at startup, including stale completion
markers, then rebuilt with the existing resumable/time-boxed background backfill.
While incomplete, search uses LIKE against ArticleSearch. Article rowids are copied
to projection rowids for compatibility with older binaries. Entity search remains
LIKE on SQLite. Negation stays inside the Prisma relation to preserve SQL NULL
semantics, especially -author and -entity.

## Deployment and locks

Generated with pnpm db:migration:new article_search_table, then reviewed to add
synchronization/backfill and reorder index removal. Both provider histories remain
additive with respect to application data.

Postgres:
1. In a short explicit transaction, create the table/FK and install triggers.
2. In a separate transaction, INSERT...SELECT into the unindexed projection.
   FOR KEY SHARE protects source rows against concurrent deletion/identity changes;
   ordinary read-state and non-key content updates remain possible. ON CONFLICT
   DO NOTHING preserves newer projections inserted by a concurrent trigger.
3. Build the new GIN indexes, guarded by extension availability, then remove the five
   old indexes with IF EXISTS. No Article columns are removed.

The copy uses one set-based INSERT, not per-article application calls. It needs WAL
and additional text storage, but no long exclusive lock on Article. Initial trigger/FK
installation and final DROP INDEX require short table locks; long-running transactions
can delay them. New projection indexes use ordinary CREATE INDEX: they block projection
writers (and consequently ingestion) while building, but do not block Article read-state
updates. Deploy during a quiet ingestion period. Explicit transaction boundaries keep
the Article trigger-installation locks out of the copy/index phases. A failed later
phase can leave the new table populated; inspect the failed Prisma migration and resume
from that phase with the documented migrate resolve workflow rather than rerunning CREATE
TABLE blindly. Old indexes are removed only after new index creation succeeds.
Without pg_trgm privileges, the projection/triggers/backfill still deploy and queries
use ILIKE without GIN, matching the existing PRISMA_PG_TRGM=0 behavior.

SQLite copies text in its migration write transaction; its single-writer architecture
means writes wait for that copy. The expensive trigram build is deferred to the resumable
background process. Leave additional disk space for both copies of the text and temporary
index build files. Startup search remains complete throughout FTS rebuilding.

The migration passes scripts/check-migration-policy.mjs with an explicit, narrow
ff:allow-destructive reason for removing disposable GIN indexes. **It is deliberately
not added to the pure-DDL adoption allowlist** in migration-utils.mjs: that allowlist
means "safe to mark applied WITHOUT executing", which would skip both triggers and
backfill. A test explicitly verifies rejection. Normal migrate deploy executes it.
A legacy database already pushed to the new schema fails closed: install the operational
trigger/backfill part, then use FEEDFERRET_DB_ADOPT_CONFIRM for this migration once, as
documented in docs/database.md. Integration tests exercise this operator path and prove
that default adoption cannot skip the projection.

## Rollback

Do not merge until the PM has arranged the owner's backup. No merge is part of this work.
Roll back the application image; keep ArticleSearch, its triggers and migration history.
All original Article columns remain authoritative for the older binary. Older Postgres
startup can recreate the five Article GIN indexes (allow build time and disk space).
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

The migration itself was applied to a copy of the 55k synthetic benchmark database,
with its articles duplicated (new IDs) to 110,000 rows: **9.16 seconds** for the complete
Postgres migration, including backfill and all indexes. Expect seconds to minutes for
100k+ real rows depending on body length, storage throughput, WAL and lock waits; this
synthetic timing is not a production downtime guarantee.

All local gates passed: lint, TypeScript, 2,986 unit tests and 58 timing tests,
plus both full migration integration gates (including restricted Postgres roles).
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
