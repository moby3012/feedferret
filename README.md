# 🦦 FeedFerret

A self-hosted, multi-user RSS reader with a modern reading experience, power-user automation, and native client compatibility.

[![CI](https://github.com/moby3012/feedferret/actions/workflows/ci.yml/badge.svg)](https://github.com/moby3012/feedferret/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

> **Self-hosted · Multi-user · PWA · Google Reader API · REST API + MCP · AGPL-3.0 License**

---

## ✨ Features

- **Modern Reader** — multiple layouts, dark mode, configurable width, mobile swipe gestures, PWA install
- **Feed Intelligence** — automatic full-text extraction (Defuddle → Readability, +AI fallback) with clean Markdown or HTML rendering, per feed; **build a feed from any web page that has no RSS** (paste a listing URL → engine-validated selectors); optional self-hosted **RSSHub** (YouTube/Reddit/GitHub…) and **changedetection.io** ("any page as a change feed") connectors
- **Per-Feed Control** — fetch transparency + health, full-text mode, keyword content filters, image hiding, HTTP auth, reader/display overrides — all also settable over the API
- **Power-User Extras** — ⌘K command palette, copy article as Markdown, per-feed reader defaults, auto-mark-as-read rules, keyword alerts, outbound webhooks (HMAC-signed)
- **Notifications** — browser push, email digests, Telegram, Gotify, ntfy
- **Native Client Support** — Google Reader API (Reeder, NetNewsWire, FeedMe, ReadKit) and Fever API
- **API-First** — REST API v1 + MCP endpoint (**39 tools**) for AI agents (Claude, n8n, LangChain); *everything the UI can do is controllable via API and by LLM — no feature is UI-only*
- **AI Summaries & Tagging (BYOK)** — OpenAI, Anthropic, Gemini, OpenRouter, Ollama — keys stored encrypted, all strictly optional
- **Flexible Auth** — local accounts, magic link, Google/GitHub OAuth, Authelia OIDC, TOTP 2FA
- **Self-Hosting Ready** — three Docker Compose variants (minimal / default / ultimate), PostgreSQL or SQLite, Coolify-compatible, 5-minute setup

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

Three ready-to-use Compose files ship in the repo — pick the one that matches what you need, no editing required:

| File | Database | Render sidecar | RSSHub | changedetection.io |
|---|---|---|---|---|
| `docker-compose.minimal.yaml` | SQLite | ✗ | ✗ | ✗ |
| `docker-compose.yaml` (default) | PostgreSQL | ✓ | ✗ | ✗ |
| `docker-compose.ultimate.yaml` | PostgreSQL | ✓ | ✓ | ✓ |

```bash
docker compose -f docker-compose.minimal.yaml up -d --build   # or .yaml / .ultimate.yaml
```

| Method | Command / Notes |
|---|---|
| **Docker Compose** | `docker compose -f <file> up -d --build` — see the table above for which file, or [`docs/self-hosting.md`](docs/self-hosting.md#choosing-a-docker-compose-variant) for the full comparison |
| **Coolify** | Use *Docker Compose* deployment type — point to repo root and one of the three files above, set env vars in the Coolify dashboard. Do **not** add a custom `networks:` block. See [`docs/self-hosting.md`](docs/self-hosting.md#deploying-with-coolify) |
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
| Example feeds/pages to smoke-test every fetch path | [`docs/testing-feeds.md`](docs/testing-feeds.md) |
| Security | [`docs/security.md`](docs/security.md) |
| GDPR / right to erasure | [`docs/gdpr.md`](docs/gdpr.md) |
| Roadmap (consolidated backlog) | [`docs/MASTER-ROADMAP.md`](docs/MASTER-ROADMAP.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| **Performance & UX Audit (next up)** | [`docs/releases/perf-ux-audit.md`](docs/releases/perf-ux-audit.md) |
| Feed Intelligence build record (shipped) | [`docs/feed-intelligence-roadmap.md`](docs/feed-intelligence-roadmap.md) |
| Browser-render sidecar (M7-T2) | [`docs/render-sidecar.md`](docs/render-sidecar.md) |
| Design system (radius/icon/modal conventions) | [`docs/design-system.md`](docs/design-system.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |
| Completed audits & one-time QA checklists (archive) | [`docs/archive/`](docs/archive/) |

---

## 🛠 Tech Stack

Next.js 16 · React 19 · TypeScript 6 · Prisma 7 · PostgreSQL / SQLite · Tailwind CSS v4 · shadcn/ui · Auth.js v5 · next-intl · TanStack Query · Defuddle + @mozilla/readability (full-text) · markdown-it / turndown (Markdown)

---

## 📊 Status

**Production ready.** English + German UI (i18n via next-intl).  
`pnpm run build` ✅ · `pnpm run lint` ✅ · `tsc --noEmit` ✅ · `pnpm test` ✅ · CI on every PR ✅

Since v1.1.1, the **entire Feed Intelligence pillar** shipped (auto full-text, page→feed builder, AI config proposal, AI auto-tagging, RSSHub + changedetection.io connectors, per-article AI extraction, the 4-tier anti-bot/heavy-fetch stack), and the **REST API v1 + MCP endpoint grew to cover the complete feature set** (MCP 28 → 39 tools) — see [`CHANGELOG.md`](CHANGELOG.md) for the full history. These land in the `Unreleased` section pending a version bump.

**Next up ⭐: a [Performance & UX Audit](docs/releases/perf-ux-audit.md)** — making the app snappier, faster, and more pleasant — then the v1.2 Theming release. See [`docs/MASTER-ROADMAP.md`](docs/MASTER-ROADMAP.md) for the consolidated, ordered backlog.

---

## 📄 License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

You are free to use, fork, and contribute to FeedFerret. Any modified version — including one run as a hosted service — must be released under the same license with attribution. See [LICENSE](LICENSE) for the full terms.

For commercial use without the AGPL obligations, [open a GitHub Discussion](https://github.com/moby3012/feedferret/discussions) to inquire about a commercial license.
