# 🦦 FeedFerret

A self-hosted, multi-user RSS reader with a modern reading experience, power-user automation, and native client compatibility.

> **Self-hosted · Multi-user · PWA · Google Reader API · REST API + MCP · AGPL-3.0 License**

---

## ✨ Features

- **Modern Reader** — multiple layouts, dark mode, configurable width, mobile swipe gestures, PWA install
- **Feed Intelligence** — automatic full-text extraction (Defuddle → Readability) with clean Markdown or HTML rendering, per feed; build a feed from any web page that has no RSS (paste a listing URL → engine-validated selectors)
- **Power-User Extras** — ⌘K command palette, copy article as Markdown, per-feed reader defaults, auto-mark-as-read rules, keyword alerts, outbound webhooks (HMAC-signed)
- **Notifications** — browser push, email digests, Telegram, Gotify, ntfy
- **Native Client Support** — Google Reader API (Reeder, NetNewsWire, FeedMe, ReadKit) and Fever API
- **API-First** — REST API v1 + MCP endpoint for AI agents (Claude, n8n, LangChain)
- **AI Summaries (BYOK)** — OpenAI, Anthropic, Gemini, OpenRouter, Ollama — keys stored encrypted
- **Flexible Auth** — local accounts, magic link, Google/GitHub OAuth, Authelia OIDC, TOTP 2FA
- **Self-Hosting Ready** — Docker Compose, PostgreSQL or SQLite, Coolify-compatible, 5-minute setup

---

## 🚀 Quick Start

```bash
git clone https://github.com/moby3012/feedferret.git && cd feedferret
cp .env.example .env       # set AUTH_SECRET, AUTH_URL, POSTGRES_PASSWORD
docker compose up -d --build
```

Open `http://localhost:3000` and follow the setup wizard. Done.

> **Required `.env` values:**
> ```env
> AUTH_SECRET="$(openssl rand -base64 32)"   # keep stable across deploys
> AUTH_URL="https://rss.example.com"
> AUTH_TRUST_HOST=true
> POSTGRES_PASSWORD="strong-random-password"
> ```

---

## 🐳 Deploy

| Method | Command / Notes |
|---|---|
| **Docker Compose + PostgreSQL** | `docker compose up -d --build` — Postgres starts automatically |
| **Docker Compose + SQLite** | Set `DATABASE_PROVIDER=sqlite` in `.env`, run `docker compose up feedferret -d --build` |
| **Coolify** | Use *Docker Compose* deployment type — point to repo root, set env vars in the Coolify dashboard. Do **not** add a custom `networks:` block. See [`docs/self-hosting.md`](docs/self-hosting.md#deployment-mit-coolify) |
| **Local dev** | `pnpm install && pnpm run dev` (SQLite recommended, no Docker needed) |

Full guide including reverse proxy (Nginx, Caddy, Traefik), updates, and backup: [`docs/self-hosting.md`](docs/self-hosting.md)

---

## 📚 Documentation

| Topic | File |
|---|---|
| Self-hosting, Coolify, backup | [`docs/self-hosting.md`](docs/self-hosting.md) |
| Reverse proxy (Nginx/Caddy/Traefik) | [`docs/reverse-proxy.md`](docs/reverse-proxy.md) |
| Auth, OAuth, OIDC, email providers | [`docs/self-hosting-auth-email.md`](docs/self-hosting-auth-email.md) |
| REST API v1 + OpenAPI | [`docs/api.md`](docs/api.md) |
| MCP endpoint (AI agents) | [`docs/mcp.md`](docs/mcp.md) |
| Google Reader API (Reeder, NNW, FeedMe) | [`docs/google-reader-api.md`](docs/google-reader-api.md) |
| Outbound webhooks | [`docs/webhooks.md`](docs/webhooks.md) |
| Full-text extraction & page→feed builder (Scout Studio) | [`docs/scout-studio.md`](docs/scout-studio.md) |
| Security | [`docs/security.md`](docs/security.md) |
| GDPR / right to erasure | [`docs/gdpr.md`](docs/gdpr.md) |
| Roadmap (consolidated backlog) | [`docs/MASTER-ROADMAP.md`](docs/MASTER-ROADMAP.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Feed Intelligence plan / milestones | [`docs/feed-intelligence-roadmap.md`](docs/feed-intelligence-roadmap.md) |
| Browser-render sidecar (M7-T2) | [`docs/render-sidecar.md`](docs/render-sidecar.md) |
| Design system (radius/icon/modal conventions) | [`docs/design-system.md`](docs/design-system.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |
| Completed audits & one-time QA checklists (archive) | [`docs/archive/`](docs/archive/) |

---

## 🛠 Tech Stack

Next.js 16 · React 19 · TypeScript 6 · Prisma 7 · PostgreSQL / SQLite · Tailwind CSS v4 · shadcn/ui · Auth.js v5 · next-intl · TanStack Query · Defuddle + @mozilla/readability (full-text) · markdown-it / turndown (Markdown)

---

## 📊 Status

**v1.1.1** — production ready. English + German UI (i18n via next-intl).  
`pnpm run build` ✅ · `pnpm run lint` ✅ · `tsc --noEmit` ✅ · `pnpm test` ✅ · CI on every PR ✅

See [`CHANGELOG.md`](CHANGELOG.md) for released changes and the Unreleased section for what's landed since (Feed Intelligence M1/M3, M4 slice 1, Phase 0 quick wins, a11y CI gate, security hardening). Next up is the M4 "✨ Let AI set this up" UX, then v1.2 Theming — see [`docs/MASTER-ROADMAP.md`](docs/MASTER-ROADMAP.md) for the consolidated, ordered backlog.

---

## 📄 License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

You are free to use, fork, and contribute to FeedFerret. Any modified version — including one run as a hosted service — must be released under the same license with attribution. See [LICENSE](LICENSE) for the full terms.

For commercial use without the AGPL obligations, contact us about a commercial license.
