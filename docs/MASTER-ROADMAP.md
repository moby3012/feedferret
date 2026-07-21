# FeedFerret — Master Roadmap (single source of truth)

> **Consolidated 2026-07-16, updated 2026-07-21.** One ordered backlog to work through top-to-bottom. Duplicates across docs are merged here (noted).
> **How to use:** this is the *index and ordering*. Detailed task checklists live in the linked source docs — tick them there, keep this file's phase status current.
> Effort: S (<1d) · M (1–3d) · L (1–2w) · XL (2w+). Status: ✅ done · 🔄 in progress · ⬜ planned · ❓ verify.
>
> **Next up ⭐: [Performance & UX Audit](releases/perf-ux-audit.md)** — make the app snappier, faster, and more pleasant. See the dedicated section below.

## Source docs (hub)
- Releases: **[`releases/perf-ux-audit.md`](releases/perf-ux-audit.md) ⭐** · [`releases/v1.2-theming.md`](releases/v1.2-theming.md) · [`releases/v1.3.md`](releases/v1.3.md) · [`releases/v2.md`](releases/v2.md) · [`releases/backlog.md`](releases/backlog.md) · [`releases/maintenance.md`](releases/maintenance.md) · [`releases/testing.md`](releases/testing.md)
- Feed Intelligence: [`feed-intelligence-plan.md`](feed-intelligence-plan.md) · [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md) · [`feature-ideas.md`](feature-ideas.md) · [`scraping-engines-research.md`](scraping-engines-research.md)
- Quality backlogs: [`accessibility-todo.md`](accessibility-todo.md) · [`deferred.md`](deferred.md)
- Index: [`ROADMAP.md`](ROADMAP.md) · completed audits: [`archive/`](archive/)

## Already shipped (context — not re-listed below)
v1.0 + v1.1 + v1.1.1, plus the 2026-07 work: security hardening, performance (FTS, sync batching, conditional GET), i18n/UX polish, **design audit (54/54)**, **visual polish rounds 1 & 2** (flat color system + contrast fixes + mobile/PWA + brand highlights), auth-redirect fix, article-sort tiebreaker, tap/​swipe-to-open-original, **Phase 0 quick wins** (F4 command palette ⌘K, F3 copy-as-markdown), **second UX/design audit (26/26 findings, 2026-07-19/20)**, plus a fourth round of reader-overflow fixes (WebKit flexbox sizing).

**Feed Intelligence — the whole Phase 2 mission — is shipped (M1–M7 ✅, see below).** That includes auto full-text (Markdown/HTML), the page→feed builder, AI config proposal, AI auto-tagging (F8), the RSSHub + changedetection.io connectors (F-connectors), per-article AI extraction, and the 4-tier Heavy-Fetch/anti-bot stack.

**Full REST/MCP automation surface (2026-07-21):** the API and MCP endpoint now cover the *complete* user-facing feature set — full per-feed config, per-article full-text (re)fetch, per-feed keyword content filter, connector-feed discovery + creation (RSSHub / changedetection / page→feed), and auto-read-rule webhook management. MCP grew **28 → 39 tools**; REST API v1.0 → v1.7. Secrets (per-feed auth password, webhook signing secret) are write-only everywhere. **F5** (Send-to Obsidian/Wallabag), **F6** (feed auto-mute + notify), **F7** (PWA share-target) all shipped. Also: three Docker Compose variants (minimal/default/ultimate), per-feed fetch-transparency panel, per-feed image hiding (lead + inline), mobile search fixes, and search progress/end-of-results indicators.

See `CHANGELOG.md` for the detailed per-PR history.

---

## PHASE 0 — Loose ends & quick wins ✅ *(COMPLETE 2026-07-17 — PRs #135–#139)*
> All items done. 0.6's only remaining work (the swipe/gesture trio) was consolidated into **Phase 1** as a single deliberate gesture/animation rework (see below).

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

## PHASE P — Performance & UX Audit ⭐ *(recommended next — make the app snappier, faster, more pleasant)*
Source: [`releases/perf-ux-audit.md`](releases/perf-ux-audit.md). Measurement-first: set baselines & budgets, then fix the biggest offenders; each change ships with a before/after number.

- ⬜ **P0 · Baseline & instrumentation** — Web-Vitals baselines (LCP/INP/CLS) on cold-load / open-article / feed-switch, bundle analysis, server query-count/timing baseline, agreed budgets + soft CI regression check. **Do this first.** — **S ×4**
- ⬜ **Perceived speed** — optimistic UI for read/star/label everywhere, instant article open (paint from list data, hydrate content), prefetch-on-intent, preserve scroll/state across nav, consistent skeletons. — **M**
- ⬜ **Client perf / bundle** — code-split heavy islands (command palette, feed-edit dialog, KaTeX, syntax highlighter, advanced add-feed panels), trim heavy deps, RSC-boundary audit, reduce re-renders, font-loading, route-level streaming. — **M–L**
- ⬜ **Server / data** — kill N+1s + add indexes (list filters/sorts, unread counts, dedupe, label joins) for SQLite+Postgres, cache sidebar counts, trim list payloads (no full `content` in list), sync-path profiling. — **M**
- ⬜ **UX polish** — animation/jank pass (respect `prefers-reduced-motion`, 60 fps on mid phone), empty/error/loading states, mobile gesture responsiveness, keyboard/focus completeness, micro-feedback. — **M**
- ⬜ **Close-out** — re-run baselines, fill the after column, archive the audit doc. — **S**

**Acceptance:** measured wins against the P0 baselines (INP/LCP/first-load JS budgets met on the mid-phone profile), read/star/label feel instant, no blank-frame article open, no dead-end empty/error states.

---

## PHASE 1 — v1.2 Theming & Layout *(next planned release; the color foundation we just shipped is a head start)*
Source: [`releases/v1.2-theming.md`](releases/v1.2-theming.md). Effort **L**.

- ⬜ **Theme system architecture** — `FeedFerretTheme` interface, semantic token layer, `User.themeJson`, migration (Postgres+SQLite), back-compat from `accentColor`/`secondaryColor`.
- ⬜ **Built-in presets** (merges **F13**): OLED-black, Solarized (light/dark), Catppuccin (mocha/latte), Gruvbox-dark, high-contrast-dark; gallery picker with live preview + import/export.
- ⬜ **Per-zone color** (sidebar/list/reader/header), HSL sliders + hex, live preview, **inline WCAG contrast checker**, reset-to-preset.
- ⬜ **Reader typography** (merges part of **F2**): font family incl. OpenDyslexic + Atkinson Hyperlegible, size/line-height/measure/letter-spacing sliders, L/justify align.
- ⬜ **Layout density** modes + **Zen mode (Z key)** (from marketing site).
- ⬜ **Gesture & animation system consolidation** (the deferred swipe trio, gathered here per `deferred.md`'s "full animation system audit"): finger-synced swipe animations (pointer-tracking + spring physics), swipe-down-marks-all-read **with** pull-to-refresh disambiguation + `hideFromAllFeeds` exclusion, desktop pointer-drag feed nav (distinguishable from select/scroll/click). Treat as one deliberate rework of the overloaded touch-gesture layer in `article-list.tsx`, not piecemeal quick wins. Effort **L**, higher risk.
- 🔄 a11y **A-4/A-5**: axe CI + public-page contrast gate **shipped** (0.2); remaining = authenticated-page axe coverage (needs seeded test user) + 200%-zoom pass.

---

## PHASE 2 — Feed Intelligence (core) ✅ *COMPLETE (M1–M7 shipped, 2026-07-20/21)*
Source: [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md). North-star delivered: *paste a URL → AI proposes the whole config → confirm.* All milestones below shipped; the whole pillar is also now controllable over REST/MCP.

- ✅ **M1** — Auto full-text → **Markdown/HTML-selectable** content (`Article.contentFormat`, Defuddle→Readability engine, markdown-it render, per-feed `fullTextMode`/`defaultContentFormat` + reader render/source toggle) — shipped in 3 slices: PRs **#141** (engine) · **#142** (schema + sync wiring, back-compat) · **#143** (reader render + settings + i18n)
- ✅ **M2** — Full-text polish (tables/code/math/images) — **S–M** — *shipped 2026-07-20 (PR #183): 4th extraction tier (`@extractus/article-extractor`) + task-list checkboxes, syntax highlighting, KaTeX math, lazy images in the markdown renderer.*
- ✅ **M3** — Manual **page→feed builder** (paste a listing-page URL → ranked auto-suggested item/field selectors, validated by the real engine → save as an `HTML+XPath` feed that re-scrapes/dedups/OPML-round-trips like any other): PRs **#145** (`lib/page-feed-suggest.ts` engine) · **#146** ("From web page" add-feed flow) · OPML round-trip test + `scout-studio.md` docs
- ✅ **M4 ⭐** — **AI config proposal** (fetch→clean→BYOK→validate→preview→accept) — **M** · **COMPLETE.** Slice 1 (#149): `lib/ai-feed-config.ts` engine — AI proposes a fulltext/pagefeed config, validated through the real engine before it's trusted. Slice 2 (#155): "✨ Let AI set this up" in Add feed → From web page (AI-badge candidate card, article-page detection, rate-limited 10/min, notes as plain text). Slice 3 (#156): "✨" full-text-selector proposal in feed settings → Full Text tab (validates against the feed's latest article, fills the selector, manual save).
- ✅ **F8 ⭐ · AI auto-tagging/classification** (pull in right after M4 — reuses the AI-config plumbing) — **M** — *shipped 2026-07-20 (PR #183): reuses the existing Label/ArticleLabel schema — AI-proposed tags are real Labels, so they show up in the existing label UI for free.*
- ✅ **M5** — Optional connectors: **RSSHub** + **changedetection.io** (self-hosted sidecars) — **M ×2** — *both shipped 2026-07-20. M5a: `lib/rsshub.ts` engine + admin config + "Add from platform" Add-Feed tab (AI-assisted route proposal, always validated for real before trusting it). M5b: `lib/changedetection.ts` — watch creation via changedetection.io's REST API (two separate secrets confirmed from its own source: API key + a distinct RSS access token), "Monitor page" Add-Feed tab, AI selector assist reusing M4's fulltext-proposal engine verbatim. `docs/self-hosting.md` gained a full "Optional Connectors" section covering all three connectors (render sidecar, RSSHub, changedetection.io) plus SSRF/network-isolation guidance.*
- ✅ **M6** — Per-article AI extraction fallback — **M–L** — *shipped 2026-07-20: `Feed.fullTextMode: "ai"` opt-in, `lib/ai-extraction.ts` asks the user's BYOK model for the article as strict-JSON Markdown, wired into `fetchAndExtractReadable` as a tier right after the free deterministic extractors fail. Guardrails: opt-in per feed, capped at 5 AI-extraction calls per sync batch, token/size caps on the prompt.*
- ✅ **M7** — Heavy render / anti-bot — **complete**, all 4 tiers shipped ([`scraping-engines-research.md`](scraping-engines-research.md) has the full decision record): **T0** `impit` HTTP impersonation (#160). **T1** embedded-data extraction (JSON-LD/`ftr-site-config`, in-process, no Docker impact). **T2** optional browser-render **sidecar** connector (admin-configured, default image untouched, wired into `docker-compose.yaml` by default for Coolify). **T3** per-user **BYOK hosted API** (Jina Reader / Firecrawl Cloud) as the last-resort fallback for active anti-bot challenges, opt-in only for background sync (#173). **Rejected: in-process browser in the default image** (~400–500 MB for everyone + browser in the reader's container).

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

- ✅ **F5** · Export / "Send to" Obsidian · Wallabag · Readwise · Pocket — S–M — *shipped 2026-07-20 (Obsidian + Wallabag; Readwise/Pocket deferred, unverified APIs)*
- ✅ **F6** · Auto-mute + notify on persistently-failing feeds — S–M — *shipped 2026-07-20*
- ✅ **F7** · PWA **share-target bookmarklet** ("Share → FeedFerret" → page→feed) — S–M — *shipped 2026-07-20 (manifest + deep link verified; OS-level invocation not testable in-sandbox)*
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
- ⬜ **Security follow-ups (from the 2026-07-17 full-app audit; #150 fixed the critical/robustness items, these remain):**
  - **Encrypt notification-channel tokens at rest** — `telegramBotToken` / `gotifyToken` / `ntfyToken` are still stored + returned in plaintext, unlike `aiApiKey`/mail creds. Encrypt via `lib/crypto.ts` and return a masked "configured" indicator. `M`
  - **Add a real `middleware.ts`** wiring the `auth.config.ts` `authorized()` callback (currently dead code; page access is enforced ad-hoc per page/action — works today but fragile). `M`
  - **Migrate the manual "Fetch full text" button** (`app/actions/feeds.ts` `fetchFullText`) to the new Defuddle/Readability engine and delete the duplicated heuristic. `M`
  - **Re-validate redirects on the Ollama chat POST** (`lib/ai-summary.ts` `summarizeOllama`) like other SSRF-guarded fetches. `S`
- ⬜ **Testing:** expand Vitest (search/validation/token/rate-limit/feed-fetcher) + **Playwright E2E** (login/2FA, onboarding, add-feed→read, OPML round-trip, saved-search share, keyword-alert, account deletion) + CI additions.
- ⬜ **Ops:** GReader/Fever device-test matrix; backup/restore drill; dependency-upgrade cadence.
- ⬜ **CI fix already shipped:** `pnpm audit` made advisory (endpoint retired).

---

## MANAGED HOSTING *(business track, from marketing site — separate from OSS roadmap)*
- ⬜ Dedicated FeedFerret instances + custom domains
- ⬜ Managed setup / updates / backups

---

## Recommended global order (opinionated)
> **Phase 0 and Phase 2 (Feed Intelligence) are done. The whole feature set is now controllable via REST/MCP.** What's left is quality, theming, and the longer-tail features.

1. **Phase P — Performance & UX Audit ⭐** — now that the feature surface is broad and complete, make it *fast and pleasant*. Highest user-visible ROI, and it de-risks everything built on top. Start with P0 baselines.
2. **Phase 1 — v1.2 Theming & Layout** — the cohesive, marketable release; the flat-color foundation + the perf/UX pass feed straight into it (the gesture-system rework lives here).
3. **Phase 3 — v1.3** gaps (nested categories, Telegram inline buttons, PWA background badge, reverse-proxy auth).
4. **Phase 4** differentiators as capacity allows (WebSub + Newsletter→feed are the standout L items; F18 event-hook surface is partly delivered via the new webhook/rules API).
5. **Phase 5 — v2.0** audio/native — the long game.
6. **Continuous** security/testing/ops threaded throughout (don't let it lag — the remaining Zod-schema + notification-token-encryption items are the priority there).

> Rationale: with Feed-Intelligence and the full automation surface shipped, the biggest remaining user complaint surface is *speed and feel*, not missing features — so the **Performance & UX Audit goes first**, then the marketable **Theming** release.
