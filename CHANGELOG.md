# Changelog

All notable changes to FeedFerret are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

Work merged since v1.1.1 (PRs #88–#150), targeting the next release.

### Added (2026-07-18 — Feed Intelligence M7-T0/T1/T2: extraction robustness)

- **Optional browser-render sidecar** (M7-T2) — for genuinely client-only pages (the article/list is drawn by JS and never appears in the static HTML), FeedFerret can now call out to an **admin-configured** external render service and use the returned HTML as a **fallback** — only when the in-process path returns nothing — on both full-text extraction and the "Create feed from a web page" builder. `lib/render-sidecar.ts` POSTs `{ "url": … }` and accepts `text/html` or a JSON envelope (`html`/`content`/`cleaned_html`/`markdown`, incl. crawl4ai's `results[0]`), so a self-hosted **crawl4ai** or a ~30-line Playwright service both work. Configure in **Server Management → Sync** (URL + encrypted bearer token + Test button, plus an in-app **copy-paste Docker Compose setup guide**) or via `FEEDFERRET_RENDER_SIDECAR_URL`/`_TOKEN`; `FEEDFERRET_DISABLE_RENDER_SIDECAR=1` kill-switch. A ready-to-run reference sidecar ships under [`docker/render-sidecar/`](docker/render-sidecar/) (Dockerfile + tiny Playwright service + example compose). The default image stays untouched (no bundled Chromium) and the browser is isolated in the sidecar. The rendered target URL is still SSRF-validated, so the sidecar is not an SSRF bypass. See [`docs/render-sidecar.md`](docs/render-sidecar.md).
- **Per-site extraction rules (ftr-site-config importer)** — full-text extraction now applies a bundled subset of FiveFilters [`ftr-site-config`](https://github.com/fivefilters/ftr-site-config) (CC0/public domain) rules **before** the generic Defuddle/Readability heuristics. `lib/ftr-site-config.ts` parses the `body`/`title`/`author`/`date`/`strip`/`strip_id_or_class` XPath directives and applies them in-process (jsdom `document.evaluate`) as the first extraction tier (`extractedBy: "ftr"`), falling through to the generic path when no rule matches or a rule yields too little. Ships a curated 44-host set (major EN + DE outlets) compiled into `lib/ftr-site-configs.ts` — **no runtime fs/network/Docker impact**; regenerate/extend with `scripts/gen-ftr-site-configs.mjs`. `FEEDFERRET_DISABLE_FTR=1` kill-switch.
- **Browser-fingerprint page fetches** (PR #160, M7-T0) — the page-fetch paths (page→feed builder, AI config, manual full-text) now use the `impit` HTTP client for real Chrome TLS/HTTP2 fingerprints, still routed through `lib/ssrf.ts` with per-hop redirect re-validation. Routine feed-XML sync is unchanged. `FEEDFERRET_DISABLE_IMPIT=1` kill-switch + graceful fallback if the native binary is absent.
- **JSON-LD full-text recovery** (PR #162) — when the visible DOM is a thin teaser (paywalled/truncated), the extractor recovers the full body from schema.org `articleBody` structured data.

### Removed (2026-07-18)

- **"Copy as Markdown" article action** — the reader toolbar button and overflow-menu item (and their `turndown`-backed copy handler) were removed to trim reader UI. The Markdown **source-view toggle** is unaffected.

### Fixed (2026-07-18)

- **Full-text extraction crash on modern CSS** (PR #162) — jsdom's CSS engine threw on `border: var(--border-width, …)` shorthands, aborting extraction on Wired and similar sites (and surfacing as a "border-width" error in feed-sync logs). `<style>` blocks are now stripped before parsing across the extraction, page→feed and XPath paths.
- **Mobile add-feed input focus on iOS** (PR #161) — the add-feed sheet's inputs could not be focused (no cursor/keyboard) on iOS Safari; the mobile sidebar/add-feed drawer was reimplemented on Radix `Sheet` instead of vaul, restoring focus.
- **Feed sync crash on XenForo/null-prototype category objects** — `Cannot convert object to primitive value` from xml2js `{_, $}` category nodes is handled by reading the text member explicitly.

### Added (2026-07-17 — Feed Intelligence M1/M3/M4 + Phase 0 + a11y CI)

- **Automatic full-text extraction** (PR #141, M1 slice 1) — `lib/readability-extract.ts` runs **Defuddle** (primary) with a **Mozilla Readability** fallback on the existing SSRF-safe fetch/JSDOM pipeline; falls back to the feed's own summary if both fail.
- **Selectable content format** (PR #142, M1 slice 2) — new `Feed.fullTextMode` (`off`/`auto`/`selector`) and `Feed.defaultContentFormat`/`Article.contentFormat` (`html`/`markdown`). "Auto" mode wires the new extractor into the existing sync path; manual per-article "fetch full text" keeps working unchanged; already-configured selector feeds migrate to `"selector"` mode with no behavior change.
- **Markdown reader rendering** (PR #143, M1 slice 3) — `markdown-it` → DOMPurify → the existing `.article-content` prose styles; a reader toolbar toggle switches a Markdown article between rendered view and raw source. Feed Settings gained "Full text: Off / Automatic / Custom selector" + "Preferred format: Markdown / HTML" controls (i18n en/de).
- **"Create feed from a web page" builder** (PRs #145–#147, M3) — paste a listing-page URL (blog index, forum, search results) and FeedFerret proposes ranked, engine-validated candidate item/field selectors (`lib/page-feed-suggest.ts`); accepting saves it as a normal HTML+XPath feed that re-scrapes on schedule, dedups normally, and round-trips through the `ffx:*` OPML extension.
- **AI feed-config proposal engine** (PR #149, M4 slice 1) — `lib/ai-feed-config.ts`: given a URL, fetches + Defuddle-cleans the page and asks the user's BYOK AI provider to propose a full-text or page→feed config as strict JSON, then **validates it through the real extraction engine** before it would ever be shown. Engine + unit tests only — no UI yet ("✨ Let AI set this up" is slice 2).
- **Command palette** (⌘K / Ctrl-K) (PR #135, Phase 0 F4) — fuzzy jump-to for feeds/categories/labels/actions (refresh, mark-all-read, focus search, add feed, settings, theme toggle, keyboard shortcuts).
- **Copy article as Markdown** (PR #135, Phase 0 F3) — toolbar/menu action that copies the article title, link, and body as Markdown via `turndown`.
- **Per-feed reader defaults** (PR #137, Phase 0 F2) — nullable `Feed.readerFontSizeOverride` / `readerWidthOverride` / `openOriginalOverride` (null = inherit the global default); configurable in the feed-edit dialog's "Reader defaults" block.
- **Automated accessibility (axe) CI gate** (PR #139, Phase 0 0.2) — `@axe-core/playwright` runs the WCAG 2.1 A/AA rule set against `/setup`, `/register`, `/accessibility` in a dedicated `accessibility` CI job; fails the build on any `serious`/`critical` violation. The `color-contrast` rule is intentionally excluded (Chromium/axe misreads this app's `oklch()` tokens; contrast is guaranteed at the design-token level — see `docs/accessibility-todo.md` A-4.1).

### Security & robustness (PR #150 — full-app audit)

- **`AUTH_SECRET` now fails closed at production runtime** instead of falling back to a hardcoded secret. `auth.ts`, `lib/crypto.ts` and `lib/greader.ts` previously substituted a built-in secret when `AUTH_SECRET` was unset — which let anyone forge Google Reader API tokens for any user and made every "encrypted at rest" credential decryptable with a public key. The build-phase carve-out (`NEXT_PHASE=phase-production-build`) is preserved so `next build` still works.
- **Size caps on the new full-text/page-feed/AI fetches** (2 MB + timeout/redirect/`allowInternal`), matching every other fetch site — the auto full-text path runs unattended per sync.
- **Markdown articles render to sanitized HTML before external API delivery** (Fever, v1 REST, Google Reader) via `lib/markdown-render.ts`, so markdown feeds no longer reach third-party clients as raw text.
- **Fever `since_id`/`max_id` pivot lookups scoped to `userId`**; **`summarizeArticle` update scoped to `userId`**; **page-feed XPath class tokens escaped**; **`rel="noopener noreferrer"` forced** on sanitized anchors with `target`.

### Changed

- **Inline width/min-width stripped from untrusted article HTML** (PR #136, Phase 0 0.1) — a shared `lib/sanitize-html.ts` `getSanitizer()` DOMPurify hook strips `width`/`min-width` attributes and inline styles (keeps `max-width`) across every article-HTML sanitize site, closing a mobile-overflow issue.

### Docs

- Added `docs/feed-intelligence-plan.md`, `docs/feed-intelligence-roadmap.md`, `docs/feature-ideas.md`, `docs/MASTER-ROADMAP.md` (single consolidated ordered backlog) and `docs/qa-checklist-2026-07-17.md` (step-by-step manual test checklist for this batch).

### Security

Work merged since v1.1.1 (PRs #88–#106):

A four-domain design audit (`docs/design-audit-todo.md`) was run and **all 54 findings resolved** — the four tiers in PRs #99–#102, the deferred features in PRs #104–#106, and the design-system items documented in `docs/design-system.md`. Security fixes (PR #99):

- **SSRF hardening** — auto-read-rule **webhook** actions, **Gotify/Ntfy** notification-channel URLs, and per-user **Ollama** base URLs now go through the same SSRF guard as feed fetching (blocks localhost/private/link-local, re-validates at call time). Previously any authenticated user could make the server issue requests to internal hosts or cloud metadata.
- **Telegram mark-read links** — HMAC now uses `AUTH_SECRET` (was the never-set `NEXTAUTH_SECRET`, so a guessable open-source constant was always the signing key, allowing forged cross-tenant read/unread writes); verification is constant-time and fails closed when `AUTH_SECRET` is unset. ⚠️ *Local Ollama users:* a default `http://localhost:11434` now requires the admin to opt into internal fetching.
- **Timing-safe comparison** for the internal provisioning API key; **`/api/register`** now rate-limited and zod-validated; web-push `endpoint` validated; `categoryId` ownership verified before attaching to a feed.

### Added

- **Indexed full-text search** (PR #104) — free-text search is now index-backed: SQLite gets an FTS5 table with the `trigram` tokenizer (substring-equivalent to the old `LIKE`, kept in sync via triggers), PostgreSQL gets `pg_trgm` GIN indexes. Setup is automatic and idempotent at startup; results are never narrower than before (LIKE fallback for <3-char terms or any FTS failure). See `docs/database.md`.
- **Unsaved-changes warning in the feed-edit dialog** (PR #106) — closing the dialog (backdrop / Escape / X / Cancel) with pending edits now prompts to confirm; a successful save closes without the prompt.
- **Undo for swipe-to-next-feed mark-all-read** (PR #101) — the auto-mark now shows an Undo toast (backed by a new user-scoped `markArticlesAsUnread` action).
- **Automatic retention enforcement** (PR #100) — `defaultRetentionDays` / per-feed retention now run daily from the background scheduler (previously only via a manual settings action).
- **Conditional GET for feed sync** (PR #100) — feeds are re-downloaded only when changed (`If-None-Match` / `If-Modified-Since`; new `Feed.etag` / `Feed.lastModifiedHeader`).
- **Design system documentation** (`docs/design-system.md`) — formalizes the radius scale, icon-size scale and Dialog/AlertDialog conventions the codebase follows.

### Changed

- **Settings page split into five themed tabs** (PR #91) — Appearance, Reading, Account, Notifications, Integrations; replaces the previous 2100+-line single scroll page. Mobile uses a Select dropdown via `ResponsiveTabsNav` (PR #92).
- **Auth pages are now theme-aware** (PR #102) — login / register / setup used hardcoded dark styling and were unusable in light mode; they now use semantic design tokens and render correctly in both themes.
- **Faster feed sync** (PR #100) — the per-article `findUnique → upsert → findFirst → update` loop is replaced by a batched insert/update path (one `findMany` + `createManyAndReturn` + targeted updates), with identical dedup semantics and 8 new unit tests. GReader bulk tag edits, dynamic-OPML sync and retention were similarly de-N+1'd; `getArticles` no longer serializes the full `Feed` row (incl. `authPassword`) to the client.
- **Lighter long article lists** (PR #105) — `content-visibility:auto` + lazy images cut the layout/paint cost of long lists without changing the scroll/gesture behavior.

### Added (email digest & search — earlier in this cycle)

- **Expanded email digest** (PR #95) — configurable article count with min/max thresholds, fixed lookback windows (6 h–30 d), IANA-timezone-aware scheduling, weekdays frequency, feed-grouped layout, and optional AI summaries (overall or per feed) via the user's configured AI provider.
- **Digest polish** (PR #96) — deduplication of already-featured articles (`Article.digestedAt` + `digestSkipFeatured` setting), label filter alongside the feed filter, pause mode with duration picker (tomorrow / 3 d / 1 w / 2 w / indefinite), article-count preview with feed breakdown, RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers across all mail providers, and AI-generated subject lines when AI summary mode is active.
- **Dedicated search results view** (PR #93) — new `SearchResultsView` with a header showing the active query, result/unread counts, a prominent close button and an edit-query affordance; mobile bottom controls gain a search-active variant with thumb-reachable actions. New `searchResults` i18n namespace (de/en).
- **Granular SMTP TLS settings** (PR #89) — new `smtpSecure` (auto/ssl/starttls/plain) and `smtpRejectUnauthorized` fields so admins can explicitly control TLS mode instead of relying on port-based auto-detection.

### Fixed

- **UX / i18n polish** (PR #101) — extracted the remaining hardcoded strings (search modal, spoiler gate, offline banner, rules-action labels) into the i18n message files; search counts use proper ICU plurals; the delete-account confirm phrase now derives from the same translation key as its placeholder (was unsatisfiable for non-English users); summarize failures surface a toast + inline message; the "Fetch Full Text" action shows a spinner; added `aria-expanded`/`aria-label` to settings disclosures, the mobile sidebar toggle and the sidebar category chevron. Also **mounted `<Toaster/>`** — it was never mounted, so every `toast.*` call in the app had been a silent no-op.
- **Visual token discipline** (PR #102) — restored visible keyboard focus rings on auth inputs and nav-menu links (WCAG 2.4.7); tokenized custom toggle-switch knobs, loading spinners, feed-name badges and the theme-color applier so they render correctly in both themes.
- **SMTP authentication** (PR #89) — `smtpPassword` was stored AES-encrypted but passed raw to nodemailer, causing 535 auth failures; it is now decrypted before sending.
- **Search spans hidden feeds** (PR #94) — global search no longer applies the `hideFromAllFeeds` exclusion, so articles in feeds hidden from "All Articles" are findable again. Browsing and mark-all-read keep the exclusion.
- **Mark-all-read respects hidden feeds** (PR #88) — "Mark all read" in the All Articles scope no longer touches articles from feeds/categories marked `hideFromAllFeeds`.
- **Log timestamps in local timezone** (PR #90) — audit log, login attempts and system log tables now render timestamps in the browser's timezone instead of the server's (usually UTC).
- **TypeScript strict mode** (PR #91) — resolved all pre-existing implicit-any and type-mismatch errors; `tsc --noEmit` is clean under strict settings.
- **Sidebar empty-state contrast** (PR #91) — removed 50 % opacity and 10 px font size from the "no feeds" empty-state text.

---

## [1.1.1] — 2026-05-21 — Post-Release Patch

Fixes found during release testing.

### Fixed

- **Empty feed scroll navigation** — Hovering over an empty feed and scrolling the mouse wheel now correctly advances to the next/previous feed. Previously the empty-state rendered outside `<ScrollArea>`, leaving `scrollRoot` null so the wheel handler never attached.
- **Overscroll threshold** — Raised from 280 → 500 px accumulated `deltaY` before a feed switch fires, preventing accidental feed jumps when scrolling to the last article normally.
- **Label unread badges** — Three gaps caused badges to show stale counts:
  - `useLabels` now refetches every 60 s (same cadence as feeds) so badges self-correct in the background.
  - Toggling an individual article read/unread now optimistically adjusts the badge for every label the article belongs to, and invalidates `["labels"]` on success.
  - "Mark all read" on a label scope now optimistically zeros that label's badge immediately instead of waiting for the server round-trip.
- **Search input padding** — Changed `px-0` → `px-2` on the search dialog input so typed text no longer clips against the element boundary.
- **Case-insensitive search** — All `contains` queries in `lib/search.ts` now use `mode: 'insensitive'` on PostgreSQL (ILIKE) and plain LIKE on SQLite (already case-insensitive for ASCII). Searching `wordpress`, `WordPress`, or `WORDPRESS` returns identical results.
- **Lockfile / CI** — Regenerated `pnpm-lock.yaml` to reflect `ws` and `@hono/node-server` overrides added in v1.1.0; fixes `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` in CI and Coolify.

---

## [1.1.0] — 2026-05-21 — Internationalization, Full API Coverage, Security Hardening & UX Polish

### Internationalization (i18n)

- **next-intl integration** — English and German translations ship with this release. All 945 user-visible strings managed in `messages/en.json` (canonical) and `messages/de.json`. ICU MessageFormat plurals throughout.
- **Language picker in Settings** — new "Language" row in Settings → Appearance. Persisted per user in `User.uiLanguage` and a `locale` cookie. Cookie-based locale (no URL prefix restructuring).
- **Locale detection** — middleware reads `Accept-Language` on first visit and sets the locale cookie automatically.
- **Admin default language** — Server Management → Registrations: admins set the instance-wide default language for new users.
- **All components wired** — `settings-form`, `rss-sidebar`, `article-list`, `article-reader`, `rss-header`, `discovery-panel`, `keyboard-shortcuts-dialog`, `pwa-install-prompt`, `server-management-dialog`, `mobile-bottom-controls`, `feed-management`, `feed-edit-dialog`, all page routes.
- **Email localization** — digest and sign-in emails rendered in recipient's `uiLanguage`. Subject uses ICU plural (`{count, plural, one {# new article} other {# new articles}}`). `<html lang>` set per user.
- **RTL CSS** — physical directional Tailwind classes (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, etc.) replaced with logical equivalents (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`) across all components. Directional icons get `rtl:rotate-180`.
- **Translation tooling** — `pnpm run translations:check` CI script; GitHub PR template for community translation contributions; `docs/contributing-translations.md` guide.

### REST API v1 Extensions

- **New endpoints**: `/api/v1/alerts` (CRUD keyword alerts), `/api/v1/rules` (CRUD auto-read rules), `/api/v1/notifications` (list + mark read), `/api/v1/stats`.
- **`POST /api/v1/articles/batch`** — applies `read`/`unread`/`star`/`unstar`/`label`/`unlabel`/`read_later`/`remove_read_later` to up to 500 article IDs in one request. Eliminates round-trip overhead for sync clients.
- **Token scopes** — `read`, `write`, `admin` enforced per endpoint. Read-only tokens blocked from all POST/PATCH/DELETE operations. Scope picker in Settings → API Access.
- **OpenAPI spec** bumped to 1.1.0; all new endpoints documented at `GET /api/v1/openapi.json`.

### MCP Server (AI Agent Integration)

- Expanded from 10 → 28 tools: `delete_feed`, `update_feed`, `create/update/delete_category`, `update/delete_label`, `label_article`, `batch_update_articles`, `list/create/delete_saved_search`, `list/create/update/delete_keyword_alert`, `list_notifications`, `get_stats`.
- An AI agent can now control every operational aspect of the app at the user level via MCP.
- `GET /api/mcp` returns `version: "1.1.0"`, `tools: 28`.

### Rules & Keyword Alerts

- **OR operator** — `openclaw OR hermes` now correctly matches articles containing *either* word. Previously AND-joined all tokens including the literal "OR".
- **Unified label action** — replaced the per-label `Add label: XYZ` action catalog entries with a single "Add label…" / "Remove label…" picker that lists all user labels in a dropdown. No more catalog bloat.
- **Availability filter** — notification actions (Telegram, Gotify, ntfy, email, push) only appear in the action picker when the corresponding channel is configured by the user.

### Sidebar & Labels

- **Label unread counts** — sidebar label badges now show *unread* article count instead of total.
- **Hide empty labels** — new user setting (Settings → Reading): hides labels with 0 unread articles from the sidebar. Mirrors the existing "Hide empty feeds" toggle. Schema: `User.hideEmptyLabels Boolean @default(false)`.

### Admin

- **Storage dashboard** — new "Storage" tab in Server Management shows per-user article/feed/AI-summary counts, sorted by article count descending. Foundation for future quota enforcement.
- **Public saved search kill-switch** — `GlobalSettings.disablePublicSharedSearches` toggle in Server Management → Registrations. Already active: shared search page returns 404 when disabled.

### Security Hardening (Pre-Release Audit — PRs #77–80)

- **Rate limiting — Fever API** — `checkRateLimit` with 120 req/min per user applied after authentication. Prevents article scraping and ID enumeration.
- **Rate limiting — Google Reader API** — same `checkRateLimit` guard in both GET and POST handlers.
- **Email enumeration fix** — `/api/register` now returns a generic `Registration failed` response for existing accounts instead of `User already exists`.
- **Push subscribe input validation** — `platform` and `pushFrequency` validated against explicit allowlists before DB write. Arbitrary strings no longer accepted.
- **Sync error leakage** — `/api/sync` catch blocks replaced `String(error)` in response body with generic `"Sync failed"`. Raw exception messages no longer reach clients.
- **`pnpm audit --audit-level=high`** added as a CI step; fails the build on any high-severity vulnerability.
- **`pnpm.overrides`** — `ws>=8.20.1` and `@hono/node-server>=1.19.13` patched via overrides to resolve moderate dev-dependency CVEs.
- **Husky pre-commit hook** — made executable; `lint-staged` now runs ESLint + TypeScript on every commit.
- **ESLint config** — `.claude/` worktree directory excluded to prevent false positives in container environments.

### TypeScript & Code Quality (PRs #78–79)

- **`as any` elimination** — removed all `as any` casts in `app/page.tsx` (3 instances), `components/feed-management.tsx` (7 instances), and `components/server-management-dialog.tsx` (all typed with Prisma-derived types via `Awaited<ReturnType<...>>`).
- **`useCallback`/`useMemo` deps** — exhaustive-deps ESLint violations fixed across `settings-form.tsx`, `server-management-dialog.tsx`, and `app/page.tsx`.
- **`.catch(console.error)` cleanup** — replaced with `.catch(() => {})` for intentional fire-and-forget operations; server-side errors already logged by the route handler.

### i18n Completions (PRs #77–80)

- **Server management toasts** — all 28+ hardcoded English toast messages in `server-management-dialog.tsx` replaced with `useTranslations("serverManagement.toast")` keys. Admins on DE locales now see translated feedback.
- **Author fallback** — `"Unknown"` author → `tList("unknownAuthor")` (`"Unbekannt"` in DE).
- **Header fallbacks** — `"Feed"`, `"Label"`, `"Saved Search"` → `t("feedFallback")`, `t("labelFallback")`, `t("savedSearchFallback")`.
- **ARIA region labels** — `aria-label="Article list"`, `"Article reader"`, `"Clear search"`, `"Close search"` all translated via `useTranslations("accessibility")`.
- **Sidebar ARIA** — `aria-label` on sidebar `<aside>` and feed action buttons translated via `t("sidebar.feedNavigation")`, `t("sidebar.feedActions")`.
- **Feed management scope labels** — rule scope selects now render `t("rules.feedScope", { name })` and `t("rules.categoryScope", { name })` instead of template literals.
- **Final translation count: 1052 keys** in `de.json`.

### Tests

- **85 Vitest tests** across 6 suites (was 76). New: 9 OR-operator tests for `buildAdvancedSearchWhere`.
- All existing tests continue to pass.

### Documentation

- `docs/api.md` — batch endpoint, token scopes, OR operator syntax
- `docs/mcp.md` — all 28 tools documented
- `docs/releases/backlog.md` — completed items marked
- `docs/releases/v1.1-i18n.md` — milestone checklist updated
- `docs/deferred.md` — new file documenting what was explicitly scoped out of v1.1 and why

---

## [1.0.0] — 2026-05-18 — Initial Public Release 🎉

First stable release. Full feature set, production-hardened, self-hosting ready.

### Highlights

- **License** — switched from MIT to AGPL-3.0 (copyleft; SaaS loophole closed; attribution required; forks must use same license)
- **Notification channels** — Telegram, Gotify, ntfy alongside browser push, email, and webhooks
- **Google Reader API** — full client compatibility for Reeder, NetNewsWire, FeedMe, ReadKit
- **CI pipeline** — lint + type-check + build on every PR
- **Centralized logger** — `lib/logger.ts`, production-safe log levels
- **Dependency updates** — Radix UI, React 19.2.6, Tailwind 4.3, TanStack Query 5.100
- **Coolify deployment guide** — step-by-step with troubleshooting
- **GitHub Issue Templates** — bug report + feature request forms
- **README** — streamlined to < 5-minute read
- **CONTRIBUTING.md** — contribution guide with CLA explanation

See [0.9.0] below for the full pre-release feature list.

---

---

## [0.9.0] — 2026-05-18 — Pre-Launch Release

### Added

**Notification Channels (Telegram, Gotify, ntfy)**
- `lib/notification-channels.ts`: send functions for Telegram Bot API (MarkdownV2), Gotify (`/message?token=`), and ntfy (topic URL + optional Bearer token)
- All three channels wired into keyword alert dispatch and auto-read rule actions (`notify_telegram`, `notify_gotify`, `notify_ntfy`)
- Settings UI: per-channel enable/disable toggle, credential inputs, "Send test" button
- Server actions: `getNotificationChannels`, `updateNotificationChannels`, `testNotificationChannel`
- New User schema fields: `telegramEnabled/BotToken/ChatId`, `gotifyEnabled/Url/Token`, `ntfyEnabled/Url/Token`

**Google Reader API Compatibility**
- `POST stream/items/contents`: batch-fetch articles by item ID list (required by Reeder, NetNewsWire, FeedMe, ReadKit)
- `r=o` oldest-first sort order in stream endpoints
- `ot` older-than timestamp filter (Unix seconds)
- `mark-all-as-read`: honors `ts` microsecond cutoff to protect freshly-synced articles
- `user-info`: real `signupTimeSec` from DB
- `unread-count`: real `newestItemTimestampUsec` for reading-list, starred, and per-feed streams
- Per-client setup guides added to `docs/google-reader-api.md`

**CI Pipeline**
- `.github/workflows/ci.yml`: lint + type-check + build on every PR and push to main

**Infrastructure**
- `lib/logger.ts`: centralized logger — `warn`/`error` always active, `log`/`info`/`debug` suppressed in production
- Migrated all 56 `console.*` calls in server-side code to `logger.*`

### Changed

**Dependency Updates** (patch/minor only, no breaking changes)
- Radix UI primitives: all ~20 packages updated to latest 1.x/2.x
- `react` + `react-dom`: 19.2.0 → 19.2.6
- `tailwindcss` + `@tailwindcss/postcss`: 4.1.18 → 4.3.0
- `@tanstack/react-query`: 5.90 → 5.100.10
- `react-hook-form`: 7.71 → 7.76
- `tailwind-merge`: 3.4 → 3.6
- `cmdk`: 1.0.4 → 1.1.1, `embla-carousel-react`: 8.5.1 → 8.6.0, `input-otp`: 1.4.1 → 1.4.2
- `isomorphic-dompurify`: 3.12 → 3.13, `autoprefixer`: 10.4 → 10.5, `tw-animate-css`: 1.3 → 1.4

**Documentation**
- `docs/self-hosting.md`: full Coolify deployment guide with step-by-step instructions and troubleshooting table
- `docs/google-reader-api.md`: complete rewrite with per-client setup guides and parameter reference table
- `docs/marketing-landing-page-brief.md`: updated with new notification channels and Google Reader API features

---

## [0.8.0] — 2026-05-17

### Added

- Rate limiting for all API surfaces (auth, MCP, internal, v1 read/write)
- Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- API token hardening: SHA-256 hashing, `ff_`-prefix
- Input validation: URL/OPML/length limits across all endpoints
- CVE patching via `pnpm.overrides` for high/moderate findings
- Admin & session hardening: audit log, 2FA enforcement, session invalidation
- Docker secrets warning for default credentials
- Accessibility sprint: ARIA labels, focus management, keyboard navigation (A-1, A-2, A-3)
- Empty states for all views
- Onboarding flow redesign: 6-step wizard, starter packs
- `/api/health` endpoint with DB ping check
- Docker Compose reviewed and hardened
- Self-hosting guide (`docs/self-hosting.md`)
- SEO basics: Open Graph tags, sitemap, robots.txt

---

## [0.1.0] — 2026-04-01 — Initial Release

### Added

- Multi-user RSS reader with per-user data isolation
- Feed management: add, edit, delete, sync, categorize
- Article reader with multiple layout modes
- Advanced search with 15+ query tokens
- Saved searches with public sharing and RSS export
- Labels, starred, read-later workflows
- Auto-mark-as-read rules with query-based matching
- Keyword alerts with push, email, and webhook delivery
- AI article summaries (BYOK: OpenAI, Anthropic, Gemini, Ollama)
- Full-text extraction with CSS selector editor (Scout Studio)
- Retention policies per feed
- Outbound webhooks with HMAC signing and retry logic
- Duplicate detection via SHA-256 URL normalization
- Browser push notifications (Web Push / VAPID)
- Email digests (configurable frequency, scope, AI summaries)
- Multiple email providers: SMTP, Resend, Postmark, Mailgun, SendGrid
- REST API v1 with OpenAPI schema
- MCP endpoint for AI agent integration
- Google Reader API (initial implementation)
- OPML import/export, JSON data export
- PWA: installable, offline fallback, app shortcuts
- Mobile UX: bottom navigation, swipe gestures, safe-area handling
- Auth: local accounts, magic link, Google OAuth, GitHub OAuth, Authelia OIDC, TOTP 2FA
- Docker Compose deployment with PostgreSQL and SQLite support
- Admin UI: user management, email config, instance branding, starter packs
- Keyboard shortcuts
- Dynamic theming: accent color, secondary color, dark mode
