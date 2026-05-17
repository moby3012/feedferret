# 🦦 FeedFerret

FeedFerret is a versatile, self-hostable, and multi-user capable RSS reader built with a focus on speed, privacy, and a premium reading experience. Designed for power users who want control over their information stream.

## ✨ Features

- **Multi-User Ready**: Built-in authentication and strict data isolation for shared hosting.
- **Flexible Auth**: Local credentials, optional TOTP 2FA, Google/GitHub OAuth, and Authelia OIDC login.
- **Smart Sync Engine**: High-performance RSS parsing with content normalization and secure sanitization.
- **Advanced Search**: Full query syntax — filter by feed, category, `is:starred`, `is:unread`, `label:`, date ranges. Save searches for quick access.
- **Auto-Mark-as-Read Rules**: Define filter rules (feed/category/query) that auto-mark, star, or label articles on sync. Preview matches before enabling.
- **Keyword Alerts**: Watch new articles with saved queries and receive in-app notifications or optional browser push alerts.
- **AI Summaries (BYOK)**: Optional article summaries on demand or during sync with user-provided OpenAI, Anthropic, Gemini, OpenRouter, or Ollama credentials.
- **Full-Text Extraction**: Per-feed CSS selectors to fetch full article content from truncated feeds. Auto-fetch on sync.
- **Feed Authentication**: HTTP Basic Auth, custom User-Agent, timeout, SSL verification, and max-size per feed.
- **Retention Policies**: Keep minimum N articles per feed, never delete starred/labelled articles, dry-run purge preview.
- **Feed Health Dashboard**: Per-feed stats — article count, unread count, last sync, avg articles/day, error rate.
- **Dynamic Theming**: Accent and secondary color pickers in Settings, applied via CSS variables. Full dark mode.
- **OPML Management**: Import with duplicate detection, selective export by category/feed, JSON full-data export.
- **Labels & Categories**: Tag articles with colored labels; organize feeds into hierarchical categories.
- **Google Reader API**: Expanded compatibility for native RSS clients (Reeder, NetNewsWire, FeedMe, ReadKit, etc.).
- **Public REST API + MCP**: Token-authenticated `/api/v1/*` endpoints and `/api/mcp` for n8n, automations, and AI agents.
- **Keyboard First**: Power-user shortcuts for blazing-fast navigation (press `?` for overlay):
  - `/`: Open search
  - `Esc`: Close search / dismiss
  - `j` / `k`: Next / Previous article
  - `n` / `p`: Next / Previous unread
  - `s`: Toggle star
  - `m`: Toggle read/unread
  - `o`: Open original URL
  - `r`: Refresh feeds
  - `Shift+S`: Save current search
  - `Shift+A`: Mark all as read
  - `?`: Show shortcut help overlay
- **PWA Support**: Install on mobile for a native-like experience with app shortcuts, best-effort badging, and cached-article offline fallback.
- **Flexible Email Delivery**: SMTP or API-based delivery with Resend, Postmark, Mailgun, or SendGrid — configurable via Admin UI (credentials stored encrypted) or environment variables.
- **Admin Onboarding Wizard**: Multi-step setup flow for first-time admins — account creation, instance settings, email, and security configuration.
- **SaaS Provisioning API**: Internal API endpoints for creating and suspending users from external systems (Stripe webhooks, SaaS portals) via Bearer token auth.
- **GDPR Compliance**: Self-service account deletion (Art. 17) with full cascade removal of all user data.
- **Self-Hostable**: Docker Compose deployment with your choice of PostgreSQL (recommended) or SQLite.

---

## 🚀 Quick Start

```bash
git clone https://github.com/moby3012/feedferret.git && cd feedferret
cp .env.example .env
# Edit .env — at minimum set AUTH_SECRET and AUTH_URL
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) and run the setup wizard. Done.

---

## 🗄 Choosing a Database

| | **PostgreSQL** (default) | **SQLite** |
|---|---|---|
| **Best for** | Multi-user, production, shared hosting | Personal use, testing, minimal infra |
| **Setup** | Included in Docker Compose, zero config | Single file, no extra service |
| **Persistence** | Docker volume `feedferret_postgres_data` | Docker volume `feedferret_db_data` |
| **Scaling** | Multiple replicas, managed cloud DBs | Single container only |
| **Backup** | `pg_dump` / managed snapshots | Copy one `.db` file |

Both providers are fully supported. You can switch later (data migration is manual — export OPML/JSON first).

---

## 🐳 Docker Deployment

### Option A — PostgreSQL (recommended)

PostgreSQL starts automatically alongside FeedFerret. No extra flags required.

**1. Copy and edit the env file:**

```bash
cp .env.example .env
```

Minimum required values in `.env`:

```env
AUTH_SECRET="$(openssl rand -base64 32)"
AUTH_URL="https://your-domain.example.com"
AUTH_TRUST_HOST=true
POSTGRES_PASSWORD="change-me-to-something-strong"
```

> **Security:** Keep `AUTH_SECRET` stable across deploys. FeedFerret uses it to encrypt stored API keys, including AI summary credentials.

The `DATABASE_PROVIDER`, `DATABASE_URL`, `POSTGRES_DB`, and `POSTGRES_USER` are pre-filled in `.env.example` and work out of the box.

**2. Start the stack:**

```bash
docker compose up -d --build
```

FeedFerret waits for Postgres to pass its healthcheck before starting. All data persists in the `feedferret_postgres_data` Docker volume.

> **Security:** The Postgres port (`5432`) is exposed on the host by default for maintenance access. For public-facing servers, either remove the `ports` entry from `docker-compose.yaml` or block it at the firewall — the app container connects to Postgres over the internal Docker network.

---

### Option B — SQLite

No separate database service. Single container, single file.

**1. Edit `.env`:**

```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:/app/data/dev.db"
AUTH_SECRET="$(openssl rand -base64 32)"
AUTH_URL="https://your-domain.example.com"
AUTH_TRUST_HOST=true
```

**2. Start only the app container:**

```bash
docker compose up feedferret -d --build
```

Data persists in the `feedferret_db_data` Docker volume.

---

### Coolify Deployment

Use Coolify's **Docker Compose** deployment type — this starts both FeedFerret and PostgreSQL together via `docker-compose.yaml` in the repo root.

**Setup steps:**

1. In Coolify → New Resource → select **Docker Compose**
2. Point to your repo (GitHub/GitLab) — Coolify auto-detects `docker-compose.yaml` in the root
3. Set environment variables (Coolify → Service → Environment):

| Variable | Value |
|---|---|
| `DATABASE_PROVIDER` | `postgresql` |
| `DATABASE_URL` | `postgresql://feedferret:YOUR_PASSWORD@postgres:5432/feedferret?schema=public` |
| `POSTGRES_DB` | `feedferret` |
| `POSTGRES_USER` | `feedferret` |
| `POSTGRES_PASSWORD` | `YOUR_PASSWORD` (same as in DATABASE_URL) |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | `https://your-domain.example.com` |
| `AUTH_TRUST_HOST` | `true` |
| `PORT` | `3000` |

> **Important:** `DATABASE_URL` and `POSTGRES_PASSWORD` must use the **same password**. `DATABASE_PROVIDER` must be `postgresql` (not `postgres`) for production/Coolify deploys.

> **Build args:** Coolify's Docker Compose flow reads the `build.args` from `docker-compose.yaml`. If you override build arguments manually, set both `DATABASE_PROVIDER=postgresql` and the same `DATABASE_URL` there too — the Prisma client is compiled at build time and must match runtime.

> **Fresh deploy:** If you changed `POSTGRES_PASSWORD` after a previous deploy, delete the `feedferret_postgres_data` volume in Coolify first — PostgreSQL ignores `POSTGRES_PASSWORD` on an already-initialized volume.

After deploy, open `https://your-domain.example.com/setup` and complete the onboarding wizard. The setup route intentionally remains accessible after the admin account is created so the wizard can save instance/email/security settings with the newly authenticated admin session.

**Troubleshooting:** If Coolify logs show `Error: Unauthorized` immediately after the first admin account is created, make sure you deployed a version that includes the setup route auth fix and set `AUTH_TRUST_HOST=true`.

After deploying a new version, hard-refresh already open browser tabs before using forms. Next.js Server Action IDs change per build; requests from an old tab can log `Failed to find Server Action ...` until the page is reloaded.

---

## 💻 Local Development

Prerequisites: Node.js 20+, pnpm

**Quickest path — SQLite (no Docker needed):**

```bash
git clone https://github.com/moby3012/feedferret.git && cd feedferret
cp .env.example .env
# Edit .env: set DATABASE_PROVIDER=sqlite, DATABASE_URL=file:./prisma/dev.db, AUTH_SECRET, AUTH_URL
pnpm install
pnpm run dev
```

**With PostgreSQL locally:**

```bash
# Start Postgres via Docker
docker compose up postgres -d

# Then in .env:
# DATABASE_PROVIDER="postgresql"
# DATABASE_URL="postgresql://feedferret:feedferret-change-me@localhost:5432/feedferret?schema=public"

pnpm install
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000) and register your first account.

---

## 🧙 Admin Onboarding

On first run, navigate to `/setup` for a guided multi-step wizard:

1. **Account** — create the admin account (auto sign-in)
2. **Instance** — set name and public URL (used in welcome emails)
3. **Email** — configure SMTP or Resend inline; skip to do it later in Server Management
4. **Security** — disable public registration (recommended for private instances)
5. **Done** — launch the app

---

## ⏱ Background Feed Sync

FeedFerret runs an in-process scheduler that refreshes feeds without requiring an external cron. It starts automatically via Next.js `instrumentation.ts` when the Node server boots and respects each feed's `updateFrequency` (per-feed → category → user → 60min default).

Environment variables:

| Var | Default | Effect |
|-----|---------|--------|
| `BACKGROUND_SYNC_INTERVAL_MINUTES` | `5` | How often the scheduler ticks. Each tick syncs feeds whose cadence has elapsed. |
| `DISABLE_BACKGROUND_SYNC` | unset | Set to `true` to opt out (e.g. when running an external cron against `/api/sync`). |
| `SYNC_SECRET` | unset | Required `Bearer` token for unauthenticated `GET /api/sync` and `GET /api/sync/status`. |

Health/status: `GET /api/sync/status` (requires login or `SYNC_SECRET`) reports last run, last error, and config.

Sync interval and enabled/disabled state can also be configured in **Server Management → Sync** (stored in DB, ENV fallback still works).

External cron alternative (recommended when running multiple replicas):

```bash
DISABLE_BACKGROUND_SYNC=true
SYNC_SECRET=$(openssl rand -hex 32)
# crontab: */5 * * * * curl -fsS -H "Authorization: Bearer $SYNC_SECRET" https://your.host/api/sync
```

---

## 🔌 API & Integrations

- Public REST API v1, n8n examples, OpenAPI: [`docs/api.md`](docs/api.md)
- MCP endpoint for AI agents: [`docs/mcp.md`](docs/mcp.md)
- Google Reader compatibility: [`docs/google-reader-api.md`](docs/google-reader-api.md)
- Outbound webhooks: [`docs/webhooks.md`](docs/webhooks.md)
- Internal SaaS provisioning API: [`docs/internal-api.md`](docs/internal-api.md)
- Admin customization: [`docs/admin-customization.md`](docs/admin-customization.md)
- Larger admin/UX follow-up workpackages: [`docs/admin-ux-workpackages.md`](docs/admin-ux-workpackages.md)
- Unified settings modal UX notes: [`docs/unified-settings-ux.md`](docs/unified-settings-ux.md)
- Scout Studio extraction assistant: [`docs/scout-studio.md`](docs/scout-studio.md)

## 🔐 Auth & Email

For TOTP 2FA, Authelia OIDC, and API-based email provider configuration, see [`docs/self-hosting-auth-email.md`](docs/self-hosting-auth-email.md).

## 🔒 Feed Fetch Security

FeedFerret blocks server-side feed fetches to private/internal IP ranges by default to reduce SSRF risk. Trusted single-tenant deployments can enable internal feed URLs in Server Management → Sync. See [`docs/security.md`](docs/security.md).

## ⚡ SaaS Provisioning (Internal API)

FeedFerret exposes internal API routes for external systems to manage user lifecycle without SaaS logic in the OSS core.

**Required:** Set `INTERNAL_API_KEY` environment variable.

```bash
# Create a user (e.g., from a Stripe checkout webhook)
curl -X POST https://rss.example.com/api/internal/provision-user \
  -H "Authorization: Bearer $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "name": "Alice"}'

# Suspend a user (e.g., from a subscription cancellation)
curl -X POST https://rss.example.com/api/internal/suspend-user \
  -H "Authorization: Bearer $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

Full docs: [`docs/internal-api.md`](docs/internal-api.md)

## 🛡 GDPR / Right to Erasure

Users can delete their account from **Settings → Delete Account**. All data is cascade-deleted atomically. See [`docs/gdpr.md`](docs/gdpr.md).

---

## 🛠 Tech Stack

- **Framework**: [Next.js 16 App Router](https://nextjs.org/) with React 19
- **Language**: TypeScript 5 (strict)
- **Auth**: [Auth.js / NextAuth v5](https://authjs.dev/)
- **Database**: [Prisma 5](https://www.prisma.io/) with [PostgreSQL](https://www.postgresql.org/) (default) or [SQLite](https://sqlite.org/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) & [shadcn/ui](https://ui.shadcn.com/) on Radix Primitives
- **State**: [TanStack Query](https://tanstack.com/query/latest) + React Server Components
- **Parsing**: [rss-parser](https://github.com/rbren/rss-parser) + [isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify) + [jsdom](https://github.com/jsdom/jsdom) for full-text extraction
- **Push**: [web-push](https://github.com/web-push-libs/web-push) (VAPID)
- **Email**: [nodemailer](https://nodemailer.com/) (SMTP) + native fetch for Resend, Postmark, Mailgun, SendGrid APIs

---

## 🗺 Project Status

FeedFerret is in **late Pre-Launch**. The full feature surface is implemented and documented; remaining work is hardening, polish, and launch readiness.

**See [`docs/ROADMAP.md`](docs/ROADMAP.md)** for the full status table — security, accessibility, deployment, marketing, maintenance, and post-launch (Phase 2: Podcasts, TTS, Telegram/Gotify/ntfy, Theming, i18n).

Build status: `pnpm run build` ✅ • `pnpm run lint` ✅ • `tsc --noEmit` ✅

---

## 🔔 Browser Push Notifications

FeedFerret supports browser/PWA push notifications for new articles.

1. Generate VAPID keys:

   ```bash
   pnpm run webpush:keys
   ```

2. Configure the generated values in your environment:

   ```bash
   WEB_PUSH_VAPID_PUBLIC_KEY="..."
   WEB_PUSH_VAPID_PRIVATE_KEY="..."
   WEB_PUSH_CONTACT="mailto:admin@example.com"
   ```

3. Open Settings → Browser notifications and enable notifications per device.

Notification frequency is user-configurable (`immediate`, `hourly`, `daily`, `off`). By default, notifications include article titles; users can switch to generic private notifications.

---

## 📥 Scout Studio Extended OPML

FeedFerret imports and exports Scout Studio extended OPML (`xmlns:ffx="FeedFerret Scout OPML namespace"`) including:

- Scout Studio source types: RSS/Atom, JSONFeed, JSON+DotNotation, HTML+XPath, XML+XPath, HTML+XPath+JSON+DotNotation.
- Feed priority and unicity criteria.
- XPath/JSON scraper settings.
- Full-content selectors, content filters, and auto-read filter strings.
- Scout Studio cURL-style HTTP options such as custom headers, cookies, POST fields, redirects, proxies, and user-agent.
- Dynamic OPML categories via `ffx:opmlUrl`, synchronized automatically with SSRF protections.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for more details.
