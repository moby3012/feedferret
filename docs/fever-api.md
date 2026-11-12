# Fever API

Use `/api/fever?api` with a Fever key from Settings → API tokens.
Feed, group, item and favicon IDs are persistent numeric identities; clients must
preserve their integer precision. Whitespace around incoming IDs is accepted;
invalid IDs are ignored. Group `0` marks all feeds, while group `-1` is a no-op.
Only failed authentication returns `auth: 0`; server errors retain `auth: 1` and
include an error with HTTP 500.

## Archived feeds

Feeds archived in FeedFerret (stopped syncing; their articles stay, subject to the usual retention rules) are not part of the Fever view: they are
missing from `feeds`, `feeds_groups` and `favicons`, and their items are missing from `items`,
`unread_item_ids` and `saved_item_ids`. Group `0` ("mark all") skips them. Restoring the feed in
FeedFerret brings everything back; clients may need a full re-sync afterwards.

## Upgrade and concurrent ingestion

Perform a **one-time full re-sync of GReader/Fever clients after upgrade**.
See [numeric API identities](numeric-api-ids.md) for storage, pagination and
rolling-deploy backfill details. Allocation happens before the insert commits,
so concurrent writers can commit IDs out of order. Fever `since_id` consumers
need periodic full reconciliation to recover late commits and backfilled rows.

## Credential upgrades

Existing plaintext Fever keys migrate automatically to SHA-256 on first use and in a non-blocking startup backfill; no client credential rotation is needed for this upgrade. Operators should apply the additive Prisma schema update before starting the new server. If you change your email, all Fever keys are cleared: rotate the API password and recreate tokens used with Fever, then reconnect clients. Passwordless accounts without 2FA can manage API passwords within ten minutes of a new sign-in; older sessions must sign out and sign in again. TOTP codes accepted for API-password step-up or login cannot be reused within the acceptance window.
