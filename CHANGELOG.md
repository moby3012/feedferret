# Changelog

All notable changes to FeedFerret are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.1.0] — 2026-05-20 — Internationalization + Full API Coverage

### Added

- **next-intl integration** — English and German translations ship with this release. All user-visible strings are now managed in `messages/en.json` (canonical) and `messages/de.json` (German translation).
- **Language picker in Settings** — new "Language" row in Settings → Appearance. Selecting a language immediately updates the UI and persists the choice per user. Language names are displayed in their own language ("Deutsch", not "German").
- **Locale detection from browser** — the middleware reads the `Accept-Language` header on first visit and sets the locale cookie automatically. No URL restructuring required.
- **`uiLanguage` preference persisted per user** — stored in `User.uiLanguage` (Prisma) and in a `locale` cookie. The two stay in sync via the `updateUiLanguage` server action.
- **`defaultUiLanguage` in GlobalSettings** — administrators can define the instance-level default language for unauthenticated pages and new users.
- **Cookie-based locale strategy** — locale is stored in a cookie (`locale`, 1-year `maxAge`). No `[locale]` folder restructuring, no URL prefixes. Compatible with all existing links and API routes.
- **Contributing translations guide** — `docs/contributing-translations.md` explains how to add a new locale, key naming conventions, ICU syntax, and the 100% coverage requirement.
- **REST API v1 extended** — new endpoints for keyword alerts (`/api/v1/alerts`), auto-read rules (`/api/v1/rules`), notifications (`/api/v1/notifications`), and aggregate stats (`/api/v1/stats`). All are Bearer-token-secured with standard rate limiting and ownership checks.
- **MCP endpoint v1.1.0** — expanded from 10 to 28 tools. New tools: `delete_feed`, `update_feed`, `create/update/delete_category`, `update/delete_label`, `label_article`, `batch_update_articles`, `list/create/delete_saved_search`, `list/create/update/delete_keyword_alert`, `list_notifications`, `get_stats`. An AI agent can now control every operational aspect of the app at the user level.
- **Vitest unit tests** — 76 tests across 6 suites covering `lib/rate-limit`, `lib/token`, `lib/validation`, `lib/search` (tokenizeSearch + parseDateToken), `lib/ssrf` (isPrivateIp — IPv4, IPv6, CGNAT, mapped addresses), and Telegram callback parsing.
- **OpenAPI spec** — version bumped to 1.1.0; all new endpoints documented at `GET /api/v1/openapi.json`.
- **Updated documentation** — `docs/api.md` and `docs/mcp.md` fully updated with all new endpoints and tools.

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
