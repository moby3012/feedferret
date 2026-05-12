# Sprint 1 — Completed ✅

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

---

# Sprint 2

## Saved Search Sharing (#7) — Completed ✅
- [x] Public read-only saved-search page (tokenized URL)
- [x] RSS feed endpoint for saved search results
- [x] Optional private/tokenized links with share toggle in UI
- [ ] Admin control to enable/disable public sharing

Follow-up ideas: per-share title/description, expiry, analytics, OPML export, team-only shares.

## Full Google Reader API (#13) — Phase 1 Completed ✅
- [x] Stream item IDs with stable continuation tokens (cursor paging)
- [x] Stream preferences persistence endpoints (`preference/stream/list|set|delete`)
- [x] Subscription edit endpoints (`/reader/api/0/subscription/edit`)
- [x] Quick-add feed endpoint (`/reader/api/0/subscription/quickadd`)
- [x] Tag/folder list and unread-count completeness for labels + categories
- [ ] Test with Reeder / NetNewsWire / FeedMe against a deployed instance
- [ ] (Stretch) Fever API compatibility

## Multi-Database / Postgres (#15) — Completed ✅
- [x] Document Prisma provider swap (SQLite → Postgres)
- [x] Add `DATABASE_PROVIDER` env var to docker-compose
- [x] Add Postgres service to docker-compose.yml
- [x] Test migration workflow on Postgres (`DATABASE_PROVIDER=postgresql` + `prisma db push`)
- [x] Document backup/restore commands

## Advanced SSRF Security (#18) — Very High Effort
- [ ] Block private IP ranges (RFC1918) in feed fetch by default
- [ ] DNS rebinding protection (resolve → recheck IP after DNS lookup)
- [ ] Protocol allowlist (http/https only)
- [ ] Max response size enforcement in fetcher
- [ ] Admin override: trusted-deployment mode to allow internal URLs

---

# Sprint 3

## Read Later Queue ✅ — Medium Effort

**Goal:** Save articles to a persistent read-later list, separate from star/label system. Retention policy must never purge read-later articles.

### DB
- [x] Add `isReadLater: Boolean @default(false)` to `Article` model
- [x] Add `readLaterSavedAt: DateTime?` to `Article` model
- [x] Migration: update retention query to exclude `isReadLater: true` (like starred)

### Server Actions
- [x] `toggleReadLater(articleId)` — flip `isReadLater`, set/clear `readLaterSavedAt`
- [x] `getReadLaterCount()` — count of read-later articles
- [x] REST API: `GET/POST/DELETE /api/read-later` with session + Bearer token auth

### UI
- [x] Bookmark icon button in `article-list.tsx` (alongside star) — active state uses `text-accent`
- [x] Bookmark button in `article-reader.tsx` header
- [x] Keyboard shortcut `l` → toggle read later
- [x] "Read Later" section in `rss-sidebar.tsx` with count badge
- [x] `is:readlater` filter token in `lib/search.ts`
- [x] API documented in `docs/api.md`

---

## Digest Email ✅ — Medium Effort

**Goal:** Send scheduled email digest of new/unread articles. Uses existing admin SMTP config.

### DB
- [x] Added to `User` model: `digestEnabled`, `digestFrequency`, `digestDayOfWeek`, `digestHour`, `digestScope`, `digestFeedIds`, `digestLastSentAt`, `digestUnsubscribeToken`
- [x] Migration via `prisma db push`

### Email Template
- [x] `lib/digest-email.ts` — HTML email (table-based, branded), plain-text fallback
- [x] Max 20 articles per digest, sorted by `publishedAt` desc
- [x] Unsubscribe link → `GET /api/digest/unsubscribe?token=<token>` sets `digestEnabled: false`

### Scheduler
- [x] `lib/digest-scheduler.ts` — runs inside `background-sync.ts` tick
- [x] `shouldSendNow()` checks UTC hour, day-of-week (weekly), gap ≥ 23h/167h
- [x] Send via nodemailer, update `digestLastSentAt`

### UI (Settings)
- [x] Enable toggle, frequency select, day-of-week (weekly only), hour picker (UTC)
- [x] Scope select (unread / all / starred / read later)
- [x] Feed multi-select chip filter
- [x] "Send test digest now" button → fires immediately to user email
- [x] Last sent timestamp display

---

## Keyword Monitoring & Alerts ✅ — Medium Effort

**Goal:** Notify user in-app and optionally via browser push when new articles match a keyword/query. Uses existing search parser in `lib/search.ts`.

### DB
- [x] New model `KeywordAlert` with `name`, `query`, `scope`, `actions`, `enabled`, `lastTriggeredAt`
- [x] New model `Notification` with unread state and optional article/feed/alert links

### Logic
- [x] `lib/keyword-alerts.ts` — `applyKeywordAlerts(userId, newArticleIds[])`
- [x] Hook into `syncFeed` after new article ingest
- [x] Browser push action (`notify_push`) available in addition to in-app notifications

### UI
- [x] Bell icon in header with unread notification count badge
- [x] Notification dropdown panel with mark-all-read and article links
- [x] "Alerts" tab in Management dialog:
  - list/create alerts
  - query preview
  - scope by all/feed/category
  - enable/disable toggle
  - "Test" button against recent articles

Follow-ups:
- [ ] Optional email action for keyword alerts
- [ ] Edit form for existing alert details beyond enable/disable/delete
- [ ] Per-alert delivery history / match analytics

---

## Outbound Webhooks — Medium Effort

**Goal:** Fire HTTP POST to user-defined URL on events. Enables n8n, Zapier, Make, custom pipelines.

### DB
- [ ] New model `Webhook`:
  - `id, userId, name, url`
  - `secret: String` — HMAC-SHA256 signing key (auto-generated, user can view/rotate)
  - `events: String` — JSON array: `["new_article", "keyword_match", "feed_error"]`
  - `filters: String?` — JSON: `{ feedIds?: [], categoryIds?: [], labelIds?: [] }`
  - `enabled: Boolean @default(true)`
  - `createdAt, updatedAt`
- [ ] New model `WebhookDelivery`:
  - `id, webhookId, event, payload, statusCode?, error?, attempt`
  - `sentAt: DateTime`

### Logic
- [ ] `lib/webhooks.ts` — `fireWebhook(webhook, event, payload)`:
  - POST JSON payload with headers: `X-FeedFerret-Event`, `X-FeedFerret-Signature` (HMAC-SHA256 of body with secret)
  - Retry up to 3× with exponential backoff (1s, 5s, 25s)
  - Log each attempt to `WebhookDelivery`
- [ ] Payload shape per event:
  - `new_article`: `{ event, article: { id, title, url, feedName, publishedAt } }`
  - `keyword_match`: `{ event, alert: { name, query }, article: {...} }`
  - `feed_error`: `{ event, feed: { id, name, url }, error }`
- [ ] Hook `new_article` into `syncUserFeeds` after ingest
- [ ] Hook `keyword_match` into `applyKeywordAlerts`
- [ ] Hook `feed_error` into fetch error handler

### UI
- [ ] "Webhooks" tab in Management dialog:
  - List webhooks (name, URL masked, events, last delivery status)
  - Create/edit: name, URL, secret (generated, copy button), events checkboxes, optional feed/category filter
  - Toggle enable/disable
  - Delivery log: last 20 deliveries, status code, timestamp, retry count
  - "Send test payload" button

---

## Duplicate Detection — Medium Effort

**Goal:** Detect same article appearing across multiple feeds. Hide or badge duplicates.

### DB
- [ ] Add `contentHash: String?` to `Article` — hash of normalized URL + title (first 100 chars)
- [ ] Add `isDuplicate: Boolean @default(false)` to `Article`
- [ ] Add `duplicateOfId: String?` → `Article?` (self-relation)
- [ ] Add `hideDuplicates: Boolean @default(true)` to `User`
- [ ] Migration + index on `(userId, contentHash)`

### Logic
- [ ] `lib/dedup.ts` — `deduplicateArticles(userId, newArticles[])`:
  - Normalize URL (strip tracking params: `utm_*`, `ref=`, `source=`), lowercase
  - Hash = `sha256(normalizedUrl + title.slice(0,100).toLowerCase())`
  - On ingest: check for existing article with same hash for this user
  - If found: mark new article `isDuplicate: true`, set `duplicateOfId` to oldest match
- [ ] Hook into `syncUserFeeds` after article creation
- [ ] Filter duplicates out of default article queries when `hideDuplicates: true`

### UI
- [ ] User setting "Hide duplicates" toggle in Settings → Reading
- [ ] When `hideDuplicates: false`: show duplicate badge on article (e.g. "Also in: Feed X")
- [ ] In feed stats: show duplicate count per feed

---

## Feed Discovery — High Effort ⚠️ Design Needed

**Goal:** Help users find new feeds related to what they already follow.

### Approach options (choose before implementing):
- **Option A — Same-domain crawl:** When user subscribes to a feed, parse publisher's homepage for other `<link rel="alternate">` feeds. Zero external dependency.
- **Option B — OPML directory:** Ship curated starter OPML packs by topic (tech, science, news). User picks topics on onboarding or in Management.
- **Option C — Feedly Cloud API:** Use public Feedly search API (free tier) to find feeds by keyword/topic. Requires API key in GlobalSettings.
- **Option D — Self-hosted index:** Build/import feed index from OPML directories (OPML.org, OpenRSS). Store in local DB table. Full-text search over it.

### Agreed scope (to be decided):
- [ ] **Decision:** pick Option A + B as baseline (no external dependency), Option C as opt-in
- [ ] Option A: `lib/feed-discovery.ts` — on feed subscribe, fetch homepage, extract `<link rel="alternate" type="application/rss+xml">` tags, return discovered feeds list
- [ ] Option B: bundle 5–10 curated starter OPML packs in `/public/starter-opml/`, surfaced in onboarding and Management → Add Feed
- [ ] Option C (optional): `FEEDLY_API_KEY` env var → search endpoint in Management → Add Feed search
- [ ] UI: "Discover" panel in Add Feed dialog — shows related feeds from same publisher, plus topic-based starter packs

---

## AI Article Summaries (BYOK) — Medium Effort

**Goal:** Summarize articles on demand or auto-summarize on sync. User brings their own API key (OpenAI, Anthropic, or Ollama).

### DB
- [ ] Add to `User` model:
  - `aiProvider: String?` — `"openai"` | `"anthropic"` | `"ollama"`
  - `aiApiKey: String?` — encrypted at rest (use `lib/crypto.ts` or env-level encryption)
  - `aiModel: String?` — e.g. `"gpt-4o-mini"`, `"claude-haiku-4-5"`, `"llama3.2"`
  - `aiOllamaBaseUrl: String?` — for self-hosted Ollama
  - `aiAutoSummarize: Boolean @default(false)` — auto-summarize on sync
  - `aiSummaryLanguage: String @default("original")` — `"original"` | `"en"` | `"de"` | ...
- [ ] Add to `Article` model:
  - `aiSummary: String?`
  - `aiSummarizedAt: DateTime?`
- [ ] Migration

### Logic
- [ ] `lib/ai-summary.ts`:
  - `summarizeArticle(article, userAiSettings)` → calls provider API
  - OpenAI: `openai` npm package, chat completions, `gpt-4o-mini` default
  - Anthropic: `@anthropic-ai/sdk`, `claude-haiku-4-5-20251001` default (cheapest, fast)
  - Ollama: direct HTTP POST to `aiOllamaBaseUrl/api/generate`
  - Prompt: "Summarize this article in 3 sentences. Language: {lang}. Article: {content}"
  - Max input: 8000 chars of `article.content` to control cost
- [ ] `summarizeArticle` action — on-demand call from article reader
- [ ] Auto-summarize hook in `syncUserFeeds` when `aiAutoSummarize: true` (rate-limit: max 10/sync to control cost)

### UI
- [ ] AI Settings section in `settings-form.tsx`:
  - Provider select (OpenAI / Anthropic / Ollama)
  - API Key input (password field, masked, stored encrypted)
  - Model input (text, with placeholder defaults per provider)
  - Ollama base URL input (shown only when Ollama selected)
  - Auto-summarize toggle + language select
  - "Test connection" button
- [ ] In `article-reader.tsx`:
  - "Summarize" button in article header (only shown when AI configured)
  - Summary shown in collapsible card above article content
  - Loading spinner during generation
  - Cached: if `aiSummary` already set, show cached version with "regenerate" option
