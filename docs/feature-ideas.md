# Feature Ideas — FreshRSS parity & beyond

> Brainstorm captured 2026-07-16, prompted by "what else, especially FreshRSS-inspired?" Not committed scope — an idea backlog to pick from. Cross-referenced against what FeedFerret **already** ships so we don't re-plan existing features.
>
> Tags: 🟦 **FreshRSS-parity** (they have it, we don't) · 🤖 **AI-synergy** (leans on our BYOK AI) · ⭐ **high value / recommended** · Effort S/M/L/XL.

## What we already have (so we don't re-suggest it)
Multi-user · Google Reader API + Fever API · REST v1 + **MCP** · Scout Studio (XPath/CSS/JSON scraping) · **dynamic OPML** · nested categories · labels · saved searches · auto-read rules · keyword alerts · outbound webhooks (HMAC) · AI summaries (BYOK) · email digests · push/Telegram/Gotify/ntfy · OAuth/GitHub/Google + **OIDC/Authelia** + magic link + TOTP 2FA · PWA · i18n (en/de) · full-text search (FTS5/pg_trgm) · shared saved searches · feed health · retention · read-later · "Recently Read" view.

FreshRSS things we **already match**: XPath/JSON scraping (Scout Studio), OIDC login, Recently-Read, GReader/Fever APIs, OPML, multi-user, categories, filter actions (auto-read rules), full-text.

---

## Shortlist (my opinionated top picks)

### 1. ⭐ Command palette (⌘K / Ctrl-K) — `S–M`
`cmdk` is **already a dependency**. A fuzzy "jump to feed / category / label / action / search" overlay. Modern power-user delight, near-zero new infra, discoverable home for the keyboard shortcuts we already have. **Quickest win here.**

### 2. ⭐ 🤖 🟦 AI auto-tagging / classification of incoming articles — `M`
FreshRSS just shipped an "LLM classification" extension (auto-tag articles from a prompt). We have AI + labels + rules — do it natively: per-feed or global, user writes a prompt ("label as `work` / `AI` / `ignore`"), the model tags new articles on sync. Pairs with auto-read rules (auto-archive the boring ones). Strong fit with the Feed-Intelligence direction and the BYOK investment.

### 3. ⭐ 🟦 WebSub (PubSubHubbub) — real-time push instead of polling — `L`
FreshRSS's signature feature. Feeds from WordPress/Medium/Blogger/Friendica/etc. advertise a hub; we subscribe and get **pushed** the moment they publish — instant articles + far less polling load. Needs a public callback endpoint + subscription lifecycle (subscribe/verify/renew/unsubscribe) and falls back to polling when unsupported. Distinctive, and it makes the reader feel *live*.

### 4. ⭐ 🤖 Newsletter → feed (per-user inbound email address) — `L`
The modern "newsletters are the new RSS" gap. Give each user a unique address (`u_xxxx@feeds.example.com`); inbound newsletters become feed items (optionally AI-cleaned to the M1 markdown pipeline). We already run mail infra + digests; this is inbound instead of outbound. Big differentiator, high user love. (Needs an inbound-mail path — self-host via a catch-all + webhook, or an optional provider.)

### 5. 🤖 Reading statistics dashboard (user-facing) — `M`
We have *admin* storage stats; users have none. Articles read over time, most-active feeds, unread trend, longest streak, "time saved by AI summaries". Engagement + a satisfying "inbox zero" loop. AI could add a weekly "here's what you missed / your reading in 3 bullets".

### 6. ⭐ Export / share an article — Markdown, Obsidian, Wallabag, Readwise — `S–M`
Pairs perfectly with the M1 Markdown work: "Copy as Markdown", "Send to Obsidian" (URI), "Save to Wallabag/Readwise/Pocket" (API). We have internal read-later; this bridges to the wider read-it-later ecosystem. Start with "Copy as Markdown" (S) which M1 makes almost free.

---

## Also worth considering

| Idea | Tag | Effort | Note |
|---|---|---|---|
| **Reverse-proxy / trusted-header auth** (`X-Forwarded-User`) | 🟦 | M | Common self-host ask (Authelia/Authentik header auth) beyond the OIDC we have. |
| **Article notes / highlights** | — | M | Annotate passages, personal notes per article; searchable. |
| **AI "translate this article"** | 🤖 | M | One-click translate via BYOK model; pairs with i18n. |
| **AI semantic / "find similar" search** | 🤖 | L | Embeddings over articles → "more like this", topic clustering. Heavier (vector store). |
| **Auto-mute / notify on failing feeds** | — | S–M | We track feed health; add auto-mute after N failures + a heads-up. |
| **Feed refresh via WebSub or on-demand "refresh now"** | 🟦 | S | Manual per-feed force-refresh button (if not already exposed everywhere). |
| **Per-feed "read view" defaults** (font/width/format) | — | S | We have global reader prefs; per-feed overrides. |
| **Themes / theme sharing** | 🟦 | M | FreshRSS ships many themes; we have accent theming — could add a few curated presets + import/export. |
| **Extension/plugin surface** | 🟦 | XL | FreshRSS's biggest differentiator. Full plugins are huge; a *lighter* path = user "post-processing scripts" or an event/hook API on top of our existing webhooks/rules. Long-term. |
| **Podcast / audio + "read aloud" (TTS)** | — | L | Already on the v2 roadmap; TTS of articles via a provider is a nice AI-adjacent add. |
| **"Turn any page into a feed" bookmarklet / share-target** | — | S–M | PWA share-target so mobile "Share → FeedFerret" starts the page→feed flow (ties into the intelligence plan). |

---

## How these relate to the Feed-Intelligence plan
Several reinforce it directly: **AI auto-tagging (#2)** and **AI translate/semantic search** extend the same BYOK-AI surface; **WebSub (#3)** complements the polling/scraping engine; **Newsletter→feed (#4)** and the **share-target bookmarklet** are more "turn anything into a feed" on-ramps; **Export-as-Markdown (#6)** is almost free once M1 lands. Suggested: fold **#1 (command palette)** and **#6 (copy-as-markdown)** in as quick wins alongside M1, and slot **#2 (AI auto-tagging)** right after M4 (it reuses the same AI-config plumbing).

## Positioning note
FreshRSS's edge is **lightweight (runs on a Pi) + a mature extension ecosystem**. FeedFerret's edge is **modern UX + first-class AI + API/MCP**. We won't out-lightweight PHP-on-a-Pi; we *can* out-intelligence and out-polish it. Lean the roadmap toward the AI/automation and UX differentiators (above) rather than chasing extension-ecosystem parity.

---

### Sources
- [FreshRSS features / README](https://github.com/FreshRSS/FreshRSS) · [WebSub docs](https://freshrss.github.io/FreshRSS/en/users/WebSub.html) · [Official extensions (incl. LLM classification)](https://github.com/FreshRSS/Extensions)
