# 🦦 FeedFerret

FeedFerret is a versatile, self-hostable, and multi-user capable RSS reader built with a focus on speed, privacy, and a premium reading experience. Designed for power users who want control over their information stream.

![FeedFerret Mockup](https://raw.githubusercontent.com/lucide-react/lucide/main/icons/rss.svg)

## ✨ Features

- **Multi-User Ready**: Built-in authentication and strict data isolation for shared hosting.
- **Flexible Auth**: Local credentials, optional TOTP 2FA, Google/GitHub OAuth, and Authelia OIDC login.
- **Smart Sync Engine**: High-performance RSS parsing with content normalization and secure sanitization.
- **Advanced Search**: Full query syntax — filter by feed, category, `is:starred`, `is:unread`, `label:`, date ranges. Save searches for quick access.
- **Auto-Mark-as-Read Rules**: Define filter rules (feed/category/query) that auto-mark, star, or label articles on sync. Preview matches before enabling.
- **Keyword Alerts**: Watch new articles with saved queries and receive in-app notifications or optional browser push alerts.
- **Full-Text Extraction**: Per-feed CSS selectors to fetch full article content from truncated feeds. Auto-fetch on sync.
- **Feed Authentication**: HTTP Basic Auth, custom User-Agent, timeout, SSL verification, and max-size per feed.
- **Retention Policies**: Keep minimum N articles per feed, never delete starred/labelled articles, dry-run purge preview.
- **Feed Health Dashboard**: Per-feed stats — article count, unread count, last sync, avg articles/day, error rate.
- **Dynamic Theming**: Accent and secondary color pickers in Settings, applied via CSS variables. Full dark mode.
- **OPML Management**: Import with duplicate detection, selective export by category/feed, JSON full-data export.
- **Labels & Categories**: Tag articles with colored labels; organize feeds into hierarchical categories.
- **Google Reader API**: Expanded compatibility for native RSS clients (Reeder, NetNewsWire, FeedMe, ReadKit, etc.).
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
- **Self-Hostable**: Simple deployment with Docker and SQLite by default, plus optional PostgreSQL via `DATABASE_PROVIDER=postgresql`.

## 🚀 Getting Started

## Prerequisites

- **Node.js**: 20.x or later
- **pnpm**: Recommended package manager
- **SQLite**: (Built-in, no setup required)

### Local Development

1. **Clone & Install**:

   ```bash
   git clone <your-repo-url>
   cd feedferret
   pnpm install
   ```

2. **Environment Setup**:
   Create a `.env` file based on `.env.example`:

   ```env
   DATABASE_URL="file:./prisma/dev.db"
   NEXTAUTH_SECRET="your-super-secret-key"
   NEXTAUTH_URL="http://localhost:3000"
   ```

3. **Initialize Database**:

   ```bash
   pnpm exec prisma db push
   pnpm exec prisma generate
   ```

4. **Run the App**:
   ```bash
   pnpm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) and register your first account.

### 🔐 Auth & Email Provider Docs

For self-hosting configuration of TOTP 2FA, Authelia OIDC, and API-based email providers, see:

- [`docs/self-hosting-auth-email.md`](docs/self-hosting-auth-email.md)
- [`docs/next-session-workpackages.md`](docs/next-session-workpackages.md) — ordered backlog for the next development sessions.

### 🧙 Admin Onboarding

On first run, navigate to `/setup` for a guided multi-step wizard:

1. **Account** — create the admin account (auto sign-in)
2. **Instance** — set name and public URL (used in welcome emails)
3. **Email** — configure SMTP or Resend inline; skip to do it later in Server Management
4. **Security** — disable public registration (recommended for private instances)
5. **Done** — launch the app

### ⚡ SaaS Provisioning (Internal API)

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

### 🛡 GDPR / Right to Erasure

Users can delete their account from **Settings → Delete Account**. All data is cascade-deleted atomically. See [`docs/gdpr.md`](docs/gdpr.md).


### 🔒 Feed Fetch Security

FeedFerret blocks server-side feed fetches to private/internal IP ranges by default to reduce SSRF risk. Trusted single-tenant deployments can enable internal feed URLs in Server Management → Sync. See [`docs/security.md`](docs/security.md).

### 🗄 Database Providers

SQLite is the default. PostgreSQL is available through `DATABASE_PROVIDER=postgresql` and the bundled Docker Compose `postgres` profile. See [`docs/database.md`](docs/database.md) for provider switching, migration, backup, and restore commands.

### 🐳 Docker Deployment

The simplest way to run FeedFerret in production is using Docker Compose:

```bash
# Set your secret
export NEXTAUTH_SECRET=$(openssl rand -base64 32)

# Start the services
docker-compose up -d --build
```

The app will be available on port `3000`. Database persistence is handled via a volume.

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

## 🛠 Tech Stack

- **Framework**: [Next.js App Router](https://nextjs.org/) (v16+, React 19)
- **Auth**: [Auth.js (NextAuth v5)](https://authjs.dev/)
- **Database**: [Prisma](https://www.prisma.io/) with [SQLite](https://sqlite.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) & [shadcn/ui](https://ui.shadcn.com/)
- **State Management**: [TanStack Query](https://tanstack.com/query/latest)
- **Parsing**: [rss-parser](https://github.com/rbren/rss-parser) & [isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify)

## 📄 License

MIT License. See [LICENSE](LICENSE) for more details.

## Browser Push Notifications

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

## FreshRSS Extended OPML

FeedFerret imports and exports FreshRSS extended OPML (`xmlns:frss="https://freshrss.org/opml"`) including:

- FreshRSS source types: RSS/Atom, JSONFeed, JSON+DotNotation, HTML+XPath, XML+XPath, HTML+XPath+JSON+DotNotation.
- Feed priority and unicity criteria.
- XPath/JSON scraper settings.
- Full-content selectors, content filters, and auto-read filter strings.
- FreshRSS cURL-style HTTP options such as custom headers, cookies, POST fields, redirects, proxies, and user-agent.
- Dynamic OPML categories via `frss:opmlUrl`, synchronized automatically with SSRF protections.
