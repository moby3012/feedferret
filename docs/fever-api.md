# Fever API

Use `/api/fever?api` with a Fever key from Settings → API tokens.
Feed, group, item and favicon IDs are persistent numeric identities; clients must
preserve their integer precision. Whitespace around incoming IDs is accepted;
invalid IDs are ignored. Group `0` marks all feeds, while group `-1` is a no-op.
Only failed authentication returns `auth: 0`; server errors retain `auth: 1` and
include an error with HTTP 500.

## Upgrade and concurrent ingestion

Perform a **one-time full re-sync of GReader/Fever clients after upgrade**.
See [numeric API identities](numeric-api-ids.md) for storage, pagination and
rolling-deploy backfill details. Allocation happens before the insert commits,
so concurrent writers can commit IDs out of order. Fever `since_id` consumers
need periodic full reconciliation to recover late commits and backfilled rows.
