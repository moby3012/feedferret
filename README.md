# 🦦 FeedFerret

FeedFerret is a versatile, self-hostable, and multi-user capable RSS reader built with a focus on speed, privacy, and a premium reading experience. Designed for power users who want control over their information stream.

![FeedFerret Mockup](https://raw.githubusercontent.com/lucide-react/lucide/main/icons/rss.svg)

## ✨ Features

- **Multi-User Ready**: Built-in authentication and strict data isolation for shared hosting.
- **Smart Sync Engine**: High-performance RSS parsing with content normalization and secure sanitization.
- **OPML Management**: Seamlessly import your existing library or export your subscriptions.
- **Premium UX**: Responsive design, dark mode, and smooth animations.
- **Keyboard First**: Power-user shortcuts for blazing-fast navigation:
  - `/`: Open search
  - `Esc`: Close search
  - `j` / `k`: Next/Previous Article
  - `s`: Toggle Star
  - `r`: Refresh Feeds
- **PWA Support**: Install it on your mobile device for a native-like experience.
- **Self-Hostable**: Simple deployment with Docker and SQLite.

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

External cron alternative (recommended when running multiple replicas):

```bash
DISABLE_BACKGROUND_SYNC=true
SYNC_SECRET=$(openssl rand -hex 32)
# crontab: */5 * * * * curl -fsS -H "Authorization: Bearer $SYNC_SECRET" https://your.host/api/sync
```

## 🛠 Tech Stack

- **Framework**: [Next.js 14+ (App Router)](https://nextjs.org/)
- **Auth**: [Auth.js (NextAuth v5)](https://authjs.dev/)
- **Database**: [Prisma](https://www.prisma.io/) with [SQLite](https://sqlite.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) & [shadcn/ui](https://ui.shadcn.com/)
- **State Management**: [TanStack Query](https://tanstack.com/query/latest)
- **Parsing**: [rss-parser](https://github.com/rbren/rss-parser) & [isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify)

## 📄 License

MIT License. See [LICENSE](LICENSE) for more details.
