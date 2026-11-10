# Numeric API identities

Google Reader and Fever share persistent article, feed and category identities.
`extId` is a nullable unique fixed-width (19-digit) decimal string, so both SQLite
and PostgreSQL compare ranges numerically without JavaScript number conversion.
CUID primary keys, deduplication keys and Google Reader continuation tokens stay
unchanged. Labels also receive identities; Google Reader label stream names stay
name-based for compatibility.

The database-wide `ExternalIdSequence` reserves ranges atomically. Its initial
value uses discovery time in microseconds; later allocations increment it. IDs
are ordering keys, not publication timestamps. Gaps from failed inserts/upserts
and overlapping backfills are expected and IDs are never recycled.

Deploy with the usual Prisma schema push before starting the app. Startup fills
missing identities asynchronously in set-based batches of 500 ordered by discovery time and primary key.
Failures are logged and retried at the start of every background-sync cycle, including
rows written by old instances during rolling deploys. Read responses skip rows
without identities until the next backfill. Each update checks that the ID is still null;
restart/concurrent backfill cannot replace an identity already assigned. The
shared Prisma extension assigns IDs for create, upsert, createMany and
createManyAndReturn (RSS, import, page-feed and connector ingestion all use this
client). The standalone CLI reserves IDs with the same sequence.

Google Reader ID references are decimal strings and content IDs are padded
16-digit Google hex names. Reads and edits accept those forms and legacy
FeedFerret CUID references. Bare all-digit IDs are decimal, including zero-padded
forms. Hexadecimal requires the full Google namespace; other bare strings remain legacy references.
New subscription IDs are numeric `feed/<id>`; old URL-based feed streams remain
accepted. Never convert IDs through `Number` in adapters or clients.

Fever emits JSON integer tokens for identities using exact decimal text; comma
lists and cursors are strings. `since_id` is exclusive and ascending; default and
`max_id` pages descend, capped at 50 even with `with_ids`. Deleted pivots work
because ranges compare identities directly. State reconciliation lists have no
10,000-entry truncation. Mark `before` uses discovery time. Favicon records use
stored image data URIs when available and a valid PNG fallback otherwise (remote
icon fetching is deliberately avoided). Hot Links remain an empty list.

Content and user-state changes still share `updatedAt`. Separating the clocks is
deferred: reliable separation requires auditing every UI, rule, import and API
state writer, plus label joins, rather than changing only these two APIs. The
existing ot/nt delta contract is retained in this PR.

These are database-backed protocol contract tests, not certification of native
client releases. No Reeder, FeedMe, Fiery Feeds, Unread, ReadKit or NetNewsWire
session was exercised. NetNewsWire support in particular requires establishing
an API adapter supported by that client.

Allocation currently reserves IDs before the insert commits. Prisma query extensions
also run within caller-owned transactions and cannot safely wrap arbitrary query()
operations in a new transaction. Consequently, concurrent writers may commit a
higher ID before a lower one. A Fever client advancing `since_id` past the higher
ID can miss that late commit (and backfilled rows below its cursor). Periodic full
reconciliation/full re-sync is required; a strict commit-order cursor would require
serializing all ingestion and CLI writes in a shared transactional allocator.
After upgrade, perform a one-time full re-sync of GReader/Fever clients.

## Backfill measurement (2026-11-10)

On the local macOS development host, the production backfill function assigned
100,000 legacy Article identities (plus one Feed) in **1.352 seconds on SQLite**
and **5.853 seconds on PostgreSQL 16 Alpine** in a disposable Docker container.
Both used batches of 500. Timing excludes schema setup and fixture insertion;
verification confirmed all 100,000 Article rows had non-null identities.
These are local single-run timings, not production latency guarantees.

The opt-in `tests/backfill-benchmark.test.ts` reproduces the measurement against a
fresh schema: generate the client and push the schema for the target provider,
then run `BACKFILL_BENCH_URL=<disposable-url> BACKFILL_BENCH_RESULT=<json-path>
pnpm exec vitest run tests/backfill-benchmark.test.ts`. Never use a production DB.
The Postgres container was stopped and removed after measurement.
