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
missing identities in batches of 200 ordered by discovery time and primary key,
before starting background sync. Each update checks that the ID is still null;
restart/concurrent backfill cannot replace an identity already assigned. The
shared Prisma extension assigns IDs for create, upsert, createMany and
createManyAndReturn (RSS, import, page-feed and connector ingestion all use this
client). The standalone CLI reserves IDs with the same sequence.

Google Reader ID references are decimal strings and content IDs are padded
16-digit Google hex names. Reads and edits accept those forms and legacy
FeedFerret CUID references. Bare all-digit IDs are decimal, except 16-digit
zero-padded forms; use the full Google namespace for unambiguous hexadecimal.
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
