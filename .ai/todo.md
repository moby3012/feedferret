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

## Saved Search Sharing (#7) — Medium Effort
- [ ] Public read-only saved-search page (tokenized URL)
- [ ] RSS feed endpoint for saved search results
- [ ] Optional private/tokenized links with share toggle in UI
- [ ] Admin control to enable/disable public sharing

## Full Google Reader API (#13) — High Effort
- [ ] Stream item IDs with continuation tokens (paging)
- [ ] Stream preferences endpoints
- [ ] Subscription edit endpoints (`/reader/api/0/subscription/edit`)
- [ ] Quick-add feed endpoint (`/reader/api/0/subscription/quickadd`)
- [ ] Tag list/edit completeness
- [ ] Test with Reeder / NetNewsWire
- [ ] (Stretch) Fever API compatibility

## Multi-Database / Postgres (#15) — High Effort
- [ ] Document Prisma provider swap (SQLite → Postgres)
- [ ] Add `DATABASE_PROVIDER` env var to docker-compose
- [ ] Add Postgres service to docker-compose.yml
- [ ] Test migration workflow on Postgres
- [ ] Document backup/restore commands

## Advanced SSRF Security (#18) — Very High Effort
- [ ] Block private IP ranges (RFC1918) in feed fetch by default
- [ ] DNS rebinding protection (resolve → recheck IP after DNS lookup)
- [ ] Protocol allowlist (http/https only)
- [ ] Max response size enforcement in fetcher
- [ ] Admin override: trusted-deployment mode to allow internal URLs

---

# Sprint 3

## Read Later Queue — Medium Effort

**Goal:** Save articles to a persistent read-later list, separate from star/label system. Retention policy must never purge read-later articles.

### DB
- [ ] Add `isReadLater: Boolean @default(false)` to `Article` model
- [ ] Add `readLaterSavedAt: DateTime?` to `Article` model
- [ ] Migration: update retention query to exclude `isReadLater: true` (like starred)

### Server Actions
- [ ] `toggleReadLater(articleId)` — flip `isReadLater`, set/clear `readLaterSavedAt`
- [ ] `getReadLaterArticles(userId)` — paginated, sorted by `readLaterSavedAt` desc
- [ ] `clearReadLater(articleId)` — remove from queue after reading

### UI
- [ ] Bookmark icon button in `article-list.tsx` (alongside star) — active state uses `text-accent`
- [ ] Bookmark button in `article-reader.tsx` header
- [ ] Keyboard shortcut `l` → toggle read later (add to `keyboard-shortcuts-dialog.tsx`)
- [ ] "Read Later" section in `rss-sidebar.tsx` (below Starred, above Labels)
- [ ] `is:readlater` filter token in `lib/search.ts`
- [ ] Badge count on sidebar Read Later entry (unread count within queue)
- [ ] Mark-as-read on open respects `openOriginalByDefault` pref like normal articles

---

## Digest Email — Medium Effort

**Goal:** Send scheduled email digest of new/unread articles. Uses existing admin SMTP config.

### DB
- [ ] Add to `User` model:
  - `digestEnabled: Boolean @default(false)`
  - `digestFrequency: String @default("daily")` — `"daily"` | `"weekly"`
  - `digestDayOfWeek: Int?` — 0–6, only for weekly
  - `digestHour: Int @default(8)` — hour in user's local time (store UTC offset separately or use UTC)
  - `digestScope: String @default("all")` — `"all"` | `"unread"` | `"starred"` | `"readlater"`
  - `digestFeedIds: String?` — JSON array of feed IDs to include (null = all)
  - `digestLastSentAt: DateTime?`
- [ ] Migration

### Email Template
- [ ] `lib/digest-email.ts` — build HTML email: header, per-feed sections, article title+summary+link
- [ ] Max 20 articles per digest, sorted by `publishedAt` desc
- [ ] Unsubscribe link (one-click sets `digestEnabled: false` via token)
- [ ] Plain-text fallback

### Scheduler
- [ ] `lib/digest-scheduler.ts` — runs inside existing `background-sync.ts` tick
- [ ] On each tick: find users where `digestEnabled && digestLastSentAt < threshold`
- [ ] Send via existing SMTP (`nodemailer` already used in admin settings)
- [ ] Update `digestLastSentAt` after send

### UI (Settings)
- [ ] New "Digest" tab in `settings-form.tsx`
- [ ] Toggle enable, frequency select, day-of-week (if weekly), hour picker
- [ ] Scope select (all / unread / starred / read later)
- [ ] Feed multi-select (optional filter to specific feeds)
- [ ] "Send test digest now" button → fires immediately to user email

---

## Keyword Monitoring & Alerts — Medium Effort

**Goal:** Notify user (in-app + optional email) when new articles match a keyword/query. Extension of existing `AutoReadRule` query parser in `lib/search.ts`.

### DB
- [ ] New model `KeywordAlert`:
  - `id, userId, name, query` — same query syntax as AutoReadRules
  - `scope: String` — `"all"` | `"feed:<id>"` | `"category:<id>"`
  - `actions: String` — JSON array: `["notify_inapp", "notify_email", "webhook"]`
  - `enabled: Boolean @default(true)`
  - `lastTriggeredAt: DateTime?`
  - `createdAt, updatedAt`
- [ ] New model `Notification`:
  - `id, userId, type` — `"keyword_alert"` | `"feed_error"` | `"digest_sent"`
  - `title, body, articleId?, feedId?, alertId?`
  - `isRead: Boolean @default(false)`
  - `createdAt`

### Logic
- [ ] `lib/keyword-alerts.ts` — `applyKeywordAlerts(userId, newArticles[])`:
  - Run each enabled alert's query against new articles from sync
  - On match: create `Notification` record, optionally send email, optionally fire webhook
  - Update `lastTriggeredAt`
- [ ] Hook into `syncUserFeeds` → call after article ingest (alongside `applyAutoReadRules`)

### UI
- [ ] Bell icon in header with unread notification count badge
- [ ] Notification dropdown panel (mark all read, link to matched article)
- [ ] "Alerts" tab in Management dialog:
  - List alerts (name, query, scope, last triggered)
  - Create/edit alert (name, query field with live preview, scope, actions checkboxes)
  - Enable/disable toggle per alert
  - "Test now" button — runs against last 100 articles

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
