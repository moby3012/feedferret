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

## 3. Keyword Alerts follow-up — Low/Medium

**Outcome:** alerts move from MVP to full management.

Acceptance criteria:

- Existing alerts can be fully edited.
- Optional email action uses the already configured email providers.
- Alert history shows recent matches/deliveries and unread/read state where relevant.
- Analytics expose match counts per alert.
- Docs clarify in-app, push, and email delivery behavior.

## 4. Feed Discovery — High / design first

**Outcome:** users can discover related feeds and starter subscriptions.

Recommended decision:

- Baseline: Option A + B, no external dependency.
- Optional: Option C behind `FEEDLY_API_KEY`.

Acceptance criteria:

- Same-domain crawl extracts RSS/Atom alternate links from publisher homepages.
- Curated starter OPML packs are bundled and importable.
- Add Feed dialog has a Discover panel with related feeds and topic packs.
- Optional external search is disabled unless API key is configured.
- Docs describe privacy/network implications.

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
