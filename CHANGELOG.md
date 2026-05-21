# Changelog

All notable changes to FeedFerret are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

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
