# FeedFerret — Master Roadmap (single source of truth)

> **Consolidated 2026-07-16** from every planning doc + the marketing site (feedferret.org). One ordered backlog to work through top-to-bottom. Duplicates across docs are merged here (noted).
> **How to use:** this is the *index and ordering*. Detailed task checklists live in the linked source docs — tick them there, keep this file's phase status current.
> Effort: S (<1d) · M (1–3d) · L (1–2w) · XL (2w+). Status: ✅ done · 🔄 in progress · ⬜ planned · ❓ verify.

## Source docs (hub)
- Releases: [`releases/v1.2-theming.md`](releases/v1.2-theming.md) · [`releases/v1.3.md`](releases/v1.3.md) · [`releases/v2.md`](releases/v2.md) · [`releases/backlog.md`](releases/backlog.md) · [`releases/maintenance.md`](releases/maintenance.md) · [`releases/testing.md`](releases/testing.md)
- Feed Intelligence: [`feed-intelligence-plan.md`](feed-intelligence-plan.md) · [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md) · [`feature-ideas.md`](feature-ideas.md)
- Quality backlogs: [`design-polish-2-todo.md`](design-polish-2-todo.md) · [`accessibility-todo.md`](accessibility-todo.md) · [`deferred.md`](deferred.md)
- Index: [`ROADMAP.md`](ROADMAP.md)

## Already shipped (context — not re-listed below)
v1.0 + v1.1 + v1.1.1, plus the 2026-07 work: security hardening, performance (FTS, sync batching, conditional GET), i18n/UX polish, **design audit (54/54)**, **visual polish rounds 1 & 2** (flat color system + contrast fixes + mobile/PWA + brand highlights), auth-redirect fix, article-sort tiebreaker, tap/​swipe-to-open-original, **Phase 0 quick wins** (F4 command palette ⌘K, F3 copy-as-markdown). See `CHANGELOG.md`.

---

## PHASE 0 — Loose ends & quick wins *(do first; small, high-ratio)*

| # | Item | Effort | Status | Source |
|---|---|---|---|---|
| 0.1 | Design-polish P3 tail: strip inline `width`/`min-width` from untrusted article HTML; 320px (iPhone SE) pass on tabs + header | S | ✅ | design-polish-2 |
| 0.2 | Accessibility **A-4 / A-5** + **axe-playwright** in CI | M | ✅ (public pages) | accessibility-todo, v1.2 |
| 0.3 | **F4 · Command palette (⌘K)** — `cmdk` already a dep; home for existing shortcuts | S–M | ✅ | feature-ideas |
| 0.4 | **F3 · Copy article as Markdown** (interim via turndown; reuses M1's stored markdown once shipped) | S | ✅ | feature-ideas |
| 0.5 | **F1 · "Refresh now" per feed** (already shipped — sidebar feed context menu, `useRefreshFeed`) · **F2 · per-feed reader defaults** (nullable `Feed.readerFontSizeOverride`/`readerWidthOverride`/`openOriginalOverride`, null=inherit; Feed-Edit dialog "Reader defaults" block; reader resolves `feed.override ?? user default`) | S ea. | ✅ | feature-ideas |
| 0.6 | Deferred small UX. **AI-summary auto-save-on-first-generation = already implemented** (per `deferred.md`; no action). Remaining = the three **swipe/gesture** items (swipe-down-marks-all-read, desktop swipe/drag nav, finger-synced swipe animations) — deferred doc flags these **complex + significant risk** (gesture disambiguation vs pull-to-refresh); handle deliberately, not as a cheap quick win. | M ea. (risk) | ⬜ (gestures only) | deferred |
| 0.7 | **Fever API** — verified **already shipped** (`app/api/fever/route.ts`: api_key, feeds, feeds_groups, items, mark, etc.); marketing site was stale. Remaining: device-test matrix (tracked under Continuous → Ops). | S | ✅ | v1.3, maintenance |

---

## PHASE 1 — v1.2 Theming & Layout *(next planned release; the color foundation we just shipped is a head start)*
Source: [`releases/v1.2-theming.md`](releases/v1.2-theming.md). Effort **L**.

- ⬜ **Theme system architecture** — `FeedFerretTheme` interface, semantic token layer, `User.themeJson`, migration (Postgres+SQLite), back-compat from `accentColor`/`secondaryColor`.
- ⬜ **Built-in presets** (merges **F13**): OLED-black, Solarized (light/dark), Catppuccin (mocha/latte), Gruvbox-dark, high-contrast-dark; gallery picker with live preview + import/export.
- ⬜ **Per-zone color** (sidebar/list/reader/header), HSL sliders + hex, live preview, **inline WCAG contrast checker**, reset-to-preset.
- ⬜ **Reader typography** (merges part of **F2**): font family incl. OpenDyslexic + Atkinson Hyperlegible, size/line-height/measure/letter-spacing sliders, L/justify align.
- ⬜ **Layout density** modes + **Zen mode (Z key)** (from marketing site).
- ⬜ Bundles a11y **A-4/A-5** (see 0.2) + axe CI.

---

## PHASE 2 — Feed Intelligence (core) *(the big new mission; mostly in-process/self-hosted)*
Source: [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md). North-star: *paste a URL → AI proposes the whole config → confirm.*

- ⬜ **M1** — Auto full-text → **Markdown/HTML-selectable** content (`Article.contentFormat`, Defuddle+Readability, markdown-it render) — **M**
- ⬜ **M2** — Full-text polish (tables/code/math/images) — **S–M**
- ⬜ **M3** — Manual **page→feed builder** (extends Scout Studio) — **M–L**
- ⬜ **M4 ⭐** — **AI config proposal** (fetch→clean→BYOK→validate→preview→accept) — **M**
- ⬜ **F8 ⭐ · AI auto-tagging/classification** (pull in right after M4 — reuses the AI-config plumbing) — **M**
- ⬜ **M5** — Optional connectors: **RSSHub** + **changedetection.io** (self-hosted sidecars) — **M ×2**
- ⬜ **M6** — Per-article AI extraction fallback — **M–L**
- ⬜ **M7** — Heavy render / anti-bot (Playwright / Firecrawl / Jina) — **L**

---

## PHASE 3 — v1.3 Feature Backlog *(high-demand gaps)*
Source: [`releases/v1.3.md`](releases/v1.3.md).

- ⬜ **Nested categories UI** (schema already has `parentId`; UI+logic only) — **L** *(also `deferred.md`)*
- ⬜ **Telegram inline buttons** (mark-read / open) — needs bot webhook mode — **M**
- ⬜ **PWA background badge** updates without the app open — **M** *(deferred.md)*
- ⬜ **F10 · Reverse-proxy / trusted-header auth** (`X-Forwarded-User`) — **M**
- ✅ Fever API (verified already shipped — see 0.7; only device-testing remains under Continuous → Ops)

---

## PHASE 4 — Feature backlog (differentiators) *(F-items not already pulled forward; easy → complex)*
Source: [`feature-ideas.md`](feature-ideas.md), [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md) (F-list).

- ⬜ **F5** · Export / "Send to" Obsidian · Wallabag · Readwise · Pocket — S–M
- ⬜ **F6** · Auto-mute + notify on persistently-failing feeds — S–M
- ⬜ **F7** · PWA **share-target bookmarklet** ("Share → FeedFerret" → page→feed) — S–M
- ⬜ **F9** · 🤖 User reading-stats dashboard — M
- ⬜ **F11** · Article notes / highlights — M
- ⬜ **F12** · 🤖 AI "translate this article" — M
- ⬜ **F14 ⭐** · WebSub (PubSubHubbub) real-time push — L
- ⬜ **F15 ⭐** · 🤖 Newsletter → feed (per-user inbound email) — L
- ⬜ **F16** · 🤖 AI semantic / "find similar" search (embeddings) — L
- ⬜ **F18** · Extension / event-hook surface (start light on webhooks+rules) — XL

---

## PHASE 5 — v2.0 Podcast, Audio & Native Apps *(future vision)*
Source: [`releases/v2.md`](releases/v2.md). Effort **XL** (ship as independent sub-PRs).

- ⬜ Podcast feed parsing (enclosure/iTunes/Podcasting-2.0, `Episode` model)
- ⬜ Audio player (persistent mini-player, Media Session API, chapters, resume)
- ⬜ Podcast UX (sidebar section, queue, unplayed filter, mark-played)
- ⬜ **TTS** — Web Speech MVP → optional cloud TTS (merges **F17**)
- ⬜ **Morning-briefing auto-digest** (from marketing site)
- ⬜ Native iOS/Android via **Capacitor** (from marketing site)

---

## CONTINUOUS — runs alongside every phase
Source: [`releases/maintenance.md`](releases/maintenance.md), [`releases/testing.md`](releases/testing.md).

- ⬜ **Security:** full **Zod schemas** on all server actions (partial: addFeed ✓); CSP `unsafe-inline`/`unsafe-eval` cleanup (blocked on Next.js nonce API); Mozilla Observatory ≥ B+.
- ⬜ **Testing:** expand Vitest (search/validation/token/rate-limit/feed-fetcher) + **Playwright E2E** (login/2FA, onboarding, add-feed→read, OPML round-trip, saved-search share, keyword-alert, account deletion) + CI additions.
- ⬜ **Ops:** GReader/Fever device-test matrix; backup/restore drill; dependency-upgrade cadence.
- ⬜ **CI fix already shipped:** `pnpm audit` made advisory (endpoint retired).

---

## MANAGED HOSTING *(business track, from marketing site — separate from OSS roadmap)*
- ⬜ Dedicated FeedFerret instances + custom domains
- ⬜ Managed setup / updates / backups

---

## Recommended global order (opinionated)
1. **Phase 0** quick wins (a few days, immediate polish + F4 command palette delight).
2. **Phase 2 M1→M3→M4 + F8** — the Feed-Intelligence core is the biggest differentiator and the current strategic focus; ship it before the theming release.
3. **Phase 1 v1.2 Theming** — cohesive, marketable release; our recent flat-color foundation feeds straight into it.
4. **Phase 3 v1.3** gaps (nested categories, Telegram buttons, PWA badge).
5. **Phase 4** differentiators as capacity allows (WebSub + Newsletter→feed are the standout L items).
6. **Phase 5 v2** audio/native — the long game.
7. **Continuous** security/testing/ops threaded throughout (don't let it lag).

> If you'd rather ship a *marketed release* next (what the site promises), do **Phase 1 (v1.2 Theming)** first, then Phase 2. If you'd rather lead with the *differentiator*, do Phase 2 first. My recommendation: **Phase 0 → Phase 2 core → Phase 1**, because Feed-Intelligence is the harder-to-copy moat and the theming work is lower-risk to slot in after.
