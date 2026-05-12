# Next Session Workpackages

Last reviewed: 2026-05-12. Workpackages are ordered by value/effort and dependency fit after the completed notifications, FreshRSS OPML, PWA polish, Postgres, and SSRF-security work.

## 0. Current baseline ✅

Already implemented and documented:

- FreshRSS extended OPML import/export and Dynamic OPML sync.
- Browser push, keyword alerts, notification bell, centralized PWA badging, cached-article offline fallback.
- Google Reader API Phase 1 with cursor continuations and stream preferences.
- Saved Search Sharing via tokenized public page and RSS feed.
- PostgreSQL deployment profile and provider switching docs.
- SSRF-safe feed fetching with trusted-admin override for internal URLs.
- Duplicate Detection: cross-feed deduplication with SHA-256 content hashes, user setting, and badge UI.

## 1. Duplicate Detection — ✅ Done

**Implemented 2026-05-12.**

Schema: `Article.contentHash` (SHA-256 of normalized URL, first 32 hex chars), `Article.isDuplicate`, `Article.duplicateOf` (self-relation to canonical), `User.hideDuplicates` (default true).

URL normalization rules (`lib/content-hash.ts`):
- Force HTTPS, strip `www.` prefix, lowercase hostname
- Remove trailing slash from pathname
- Strip tracking params: `utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, `ref`, `source`, `_ga`, `igshid`
- Sort remaining query params for canonical order
- Strip fragment (#)

Limitations: does not deduplicate across different URLs for the same article (e.g. AMP vs canonical). Title/content similarity matching is a future enhancement.

Migration `20260512003000_add_duplicate_detection` adds columns and backfills existing articles with a simplified URL normalization (no SHA-256 in SQLite; proper hashes computed on next sync).

## 2. Outbound Webhooks — ✅ Done

**Implemented 2026-05-12.**

Schema: `Webhook` (id, userId, name, url, secret, enabled, events JSON, feedFilter JSON), `WebhookDelivery` (id, webhookId, event, payload, status, statusCode, error, attempts, nextRetryAt, deliveredAt).

Events: `new_article` (non-duplicate only), `keyword_match` (per matching article), `feed_error`, `test`.

Signature: `X-FeedFerret-Signature: sha256=HMAC-SHA256(secret, raw_body)` — same format as GitHub webhooks.

Retry: 5 attempts with delays [0, 5min, 30min, 2h, 8h]. Processed in background sync tick.

UI: Settings → Outbound Webhooks section. Create/edit form, enable toggle, rotate secret, test ping, delivery log per webhook.

Docs: `docs/webhooks.md` — payload examples, Node.js + Python verification code, retry table.

## 3. Keyword Alerts follow-up — ✅ Done

**Implemented 2026-05-12.**

Alert rows upgraded from MVP display to full management:

- **Inline edit form**: name, query, scope (all/feed/category), push and email toggles.
- **Email delivery** (`notify_email`): `sendSystemEmail` with HTML + plain-text body listing matched articles.
- **Match count badge**: shows total in-app notifications (`_count.notifications`) per alert.
- **History panel**: expandable list of recent keyword_alert notifications with read/unread state; clicking unread marks it read.
- **Webhook dispatch**: `keyword_match` event fired per matching article (was already wired; confirmed end-to-end).

Delivery behavior:
- `notify_inapp` — always included; creates `Notification` rows visible in the bell menu.
- `notify_push` — optional; fires browser push via `sendPushToUser`; bundles multiple matches.
- `notify_email` — optional; requires email provider configured; sends one email per alert trigger listing all matched articles.
- `keyword_match` webhook — fires for every matching article to all enabled webhooks with `keyword_match` in their events list.

## 4. Feed Discovery — ✅ Done

**Implemented 2026-05-12.**

Option A (same-domain crawl) + Option B (curated starter packs) shipped. Option C (Feedly API) skipped; no external dependency needed.

Architecture:

- `lib/feed-discovery.ts`: `discoverFeedsAtUrl(url)` fetches a publisher page (SSRF-protected, 512 KB cap, 12 s timeout) and parses `<link rel="alternate">` tags with RSS/Atom MIME types. Returns up to 10 `DiscoveredFeed` objects with `url`, `title`, `type`.
- `app/api/discover` (GET `?url=`): authenticated route that calls `discoverFeedsAtUrl` and returns JSON. Requires session.
- `public/starter-opml/` — five curated OPML packs: `tech.opml` (5 feeds), `science.opml` (4), `news.opml` (4), `dev.opml` (4), `design.opml` (3). Served as static files.
- `components/rss-sidebar.tsx` — Add Feed panel expanded with:
  - Compass icon button next to URL input triggers `/api/discover`
  - Discovered feeds listed with per-feed Add button
  - Starter Packs section with Import button per pack (fetches static OPML, calls `importOpml` server action)

Privacy/network notes:

- Discovery fetches the *publisher's* page server-side (not from the user's browser). The request originates from the FeedFerret server, uses SSRF protection, and strips private IPs/localhost. No external third-party API calls are made.
- Starter pack imports trigger individual feed syncs, which fetch from the RSS feed servers directly.

## 5. AI Article Summaries (BYOK) — Medium/High

**Outcome:** users can summarize articles on demand or during sync using their own provider credentials.

Acceptance criteria:

- User settings store provider, encrypted key, model, optional Ollama URL, auto-summarize flag, and language.
- Article model stores cached summary and timestamp.
- Provider adapters exist for OpenAI, Anthropic, and Ollama.
- On-demand summarize action works from article reader.
- Auto-summarize is rate-limited and cost-conscious.
- Docs explain BYOK, privacy, cost, and provider setup.

## 6. Reader Client Compatibility QA — Medium

**Outcome:** the Google Reader API is validated against real client apps.

Acceptance criteria:

- Reeder, NetNewsWire, and FeedMe/ReadKit are tested against a deployed instance.
- Client-specific quirks and known-good base URLs are documented.
- API fixes are applied for blocking compatibility gaps.
- Fever API decision is revisited based on actual client needs.

## 7. Saved Search Sharing admin policy — Low

**Outcome:** admins can globally permit or block public saved-search sharing.

Acceptance criteria:

- Global setting controls share creation and public share access behavior.
- UI clearly explains whether sharing is disabled by admin policy.
- Existing share tokens are either invalidated or preserved according to documented policy.
- Docs mention operational consequences for private/public instances.
