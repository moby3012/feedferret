# FeedFerret Backlog

Last reviewed: 2026-05-12. This file is the active planning list; detailed next-session packages live in [`docs/next-session-workpackages.md`](../docs/next-session-workpackages.md).

---

## Completed on current branch ✅

### Sprint 1 — FreshRSS parity basics
- [x] Keyboard shortcut help overlay (`?` key + full overlay)
- [x] Per-feed quick actions menu (refresh, mark read, edit, health)
- [x] Better import/export (selective OPML export, JSON export, import report with badges)
- [x] Feed statistics cards (article count, unread, last sync, avg/day, error rate)
- [x] User preferences for reading behaviour (delay, open-original, view mode, reader width, sort)
- [x] Auto-mark-as-read rules (query syntax, preview, run-now, auto-runs on sync)
- [x] Feed authentication + fetch options (Basic Auth, User-Agent, timeout, SSL, max-size)
- [x] Full-text extraction settings (CSS selectors, remove selectors, preview, auto-fetch)
- [x] Retention policy UI expansion (min articles, protect starred/labelled, dry-run)
- [x] Dynamic theming (accent + secondary color pickers, CSS vars)

### FreshRSS / PWA / Notifications work
- [x] FreshRSS extended OPML import/export (`frss:*` attributes, source types, cURL-style options)
- [x] Dynamic OPML categories with automatic sync and SSRF-safe fetching
- [x] Browser/PWA push notifications with VAPID, device subscription APIs, Settings UI, and service worker handling
- [x] Centralized app badging updates for unread-count changes, push payloads, sync, and mark-all-read
- [x] Manifest screenshots, richer PWA shortcuts, deep-link handling, PWA checks, cached-article offline fallback

### Product features
- [x] Saved Search Sharing: public tokenized HTML page, RSS endpoint, UI share toggle/copy/open actions
- [x] Google Reader API Phase 1: stable stream continuations, stream preference persistence, subscription edit/quickadd, labels/categories metadata, unread counts
- [x] Read Later queue with API, search token, UI shortcuts, and retention protection
- [x] Digest Email with scheduler, SMTP delivery, unsubscribe link, and Settings UI
- [x] Keyword Alerts with in-app notifications, optional browser push, bell dropdown, Alerts tab, query preview/test

### Platform / operations / security
- [x] Multi-Database / PostgreSQL profile: provider switch script, Docker Compose profile, migration workflow, backup/restore docs
- [x] Advanced SSRF security: protocol allowlist, DNS/rebinding checks, private-IP blocking, redirect checks, size limits
- [x] Internal-admin override for trusted internal feed URLs in Server Management → Sync

---

## Next-session workpackages — ordered

### 1. Duplicate Detection — Medium Effort
**Goal:** detect repeated articles across feeds and hide or badge duplicates.

- [ ] Add `Article.contentHash`, `Article.isDuplicate`, `Article.duplicateOfId` self-relation
- [ ] Add `User.hideDuplicates` preference and index `(userId, contentHash)`
- [ ] Implement `lib/dedup.ts` with URL normalization (`utm_*`, `ref`, `source` stripping) and SHA-256 hash
- [ ] Hook dedupe into article ingest after creation
- [ ] Hide duplicates from default article queries when enabled
- [ ] Add Settings → Reading toggle “Hide duplicates”
- [ ] Show duplicate badge / “Also in …” info when duplicates are visible
- [ ] Add duplicate count to feed statistics

### 2. Outbound Webhooks — Medium Effort
**Goal:** post signed event payloads to n8n, Zapier, Make, or custom endpoints.

- [ ] Add `Webhook` model (`name`, `url`, generated `secret`, event list, filters, enabled)
- [ ] Add `WebhookDelivery` model with status/error/attempt log
- [ ] Implement `lib/webhooks.ts` with JSON POST and `X-FeedFerret-Signature` HMAC-SHA256 header
- [ ] Retry up to 3× with exponential backoff and log each attempt
- [ ] Payloads for `new_article`, `keyword_match`, `feed_error`
- [ ] Hook `new_article` into sync ingest, `keyword_match` into keyword alerts, `feed_error` into fetch errors
- [ ] Add Management → Webhooks tab with create/edit, event checkboxes, filters, secret copy/rotate, enable toggle
- [ ] Add delivery log and “Send test payload” action

### 3. Keyword Alerts follow-up — Low/Medium Effort
**Goal:** complete alert management after the first implemented alerts pass.

- [ ] Optional email delivery action using existing email providers
- [ ] Edit form for existing alert details beyond enable/disable/delete
- [ ] Per-alert delivery history and match analytics
- [ ] Document action semantics and privacy expectations

### 4. Feed Discovery — High Effort / design first
**Goal:** help users find related feeds without forcing a third-party dependency.

- [ ] Decision: baseline Option A + B, optional Option C behind API key
- [ ] Option A: same-domain crawl on subscribe; extract `<link rel="alternate" type="application/rss+xml">`
- [ ] Option B: bundle 5–10 curated starter OPML packs in `/public/starter-opml/`
- [ ] Option C optional: `FEEDLY_API_KEY` search endpoint in Management → Add Feed
- [ ] Add “Discover” panel in Add Feed dialog for related feeds and starter packs

### 5. AI Article Summaries (BYOK) — Medium/High Effort
**Goal:** summarize articles on demand or on sync with user-provided OpenAI/Anthropic/Ollama credentials.

- [ ] Add user AI settings (`aiProvider`, encrypted API key, model, Ollama base URL, auto-summarize, language)
- [ ] Add article summary fields (`aiSummary`, `aiSummarizedAt`)
- [ ] Implement `lib/ai-summary.ts` with provider adapters and 8k-char input cap
- [ ] Add on-demand summarize action and optional auto-summarize hook (rate-limited)
- [ ] Add Settings AI section with provider/key/model/test controls
- [ ] Add article-reader summary card, loading state, cached display, regenerate action

### 6. Reader Client Compatibility QA — Medium Effort
**Goal:** validate the GReader API against real clients and tune quirks.

- [ ] Test Reeder against a deployed instance
- [ ] Test NetNewsWire against a deployed instance
- [ ] Test FeedMe / ReadKit where possible
- [ ] Document per-client base URL/login instructions and known quirks in `docs/google-reader-api.md`
- [ ] Stretch: Fever API compatibility if client support needs it

### 7. Saved Search Sharing admin policy — Low Effort
**Goal:** give admins a global kill switch for public saved-search sharing.

- [ ] Add global setting to enable/disable public saved-search sharing
- [ ] Hide/disable sharing UI when off
- [ ] Reject shared page/RSS access or share creation according to the policy
- [ ] Document consequences for existing share tokens

---

## Parking lot / later

- [ ] Website scraping feeds from arbitrary HTML/JSON sources beyond FreshRSS-compatible imported definitions
- [ ] WebSub / PubSubHubbub instant updates
- [ ] Extension system with safe server/UI hooks
- [ ] Multi-user shared/anonymous reading mode beyond tokenized saved searches
- [ ] Durable notification queue if multi-process retry semantics become necessary
