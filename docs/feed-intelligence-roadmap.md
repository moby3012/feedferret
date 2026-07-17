# Feed Intelligence — Implementation Roadmap

> **Companion to** [`feed-intelligence-plan.md`](feed-intelligence-plan.md) (research + architecture). This is the **actionable, milestone-based TODO**.
> **Created:** 2026-07-16.

## North-star UX (the thing every milestone serves)

> **A user pastes a URL. If they have an AI key, the AI figures out the whole setup and proposes it. They just confirm.**

No thinking about selectors, XPath, item boundaries, or full-text rules. The manual Scout Studio controls stay for power users and for people without an AI key, but the *happy path* is: **paste → AI proposes → preview → accept.** Everything below is built so the AI layer can slot on top of a working manual layer (AI proposes a config; the same config also works if typed by hand).

**Guiding principles**
- **AI proposes, human confirms** — never auto-save an AI-generated config silently; always show a live preview and let the user accept/tweak. (Also keeps us safe from hallucinated selectors.)
- **Config once, scrape forever** — AI generates a reusable selector config (cheap, one-shot). Per-article AI is the fallback, not the default (cost).
- **In-process first** — default path needs no extra services; connectors are optional (see plan §4b).
- **Never regress SSRF** — every fetch of a user-supplied URL goes through `lib/ssrf.ts`.
- **Reuse what exists** — Scout Studio config model, `ffx:*` OPML, AI BYOK (`lib/ai-summary.ts`), auto-full-text trigger, retention, conditional GET.

Legend — **Effort:** S (hours) · M (≤ a few days) · L (multi-day) · XL (multi-week). Status: ⬜ todo · 🔄 in progress · ✅ done.

---

## Milestone M1 — Auto full-text → clean, format-selectable content ✅ *shipped (PRs #141–#143)*
*Phase 1.1 + 1.2. The mission's first ask.*

**User outcome:** truncated feeds automatically show the full article; the user picks **Markdown (clean/aligned) or HTML** per feed, and can override per article. No selectors needed.

- [x] **M1-T1** `lib/readability-extract.ts` — automatic extractor: **Defuddle** (primary, on our existing JSDOM) → **Mozilla Readability** fallback when Defuddle returns empty → keep feed summary if both fail. SSRF-safe fetch via `lib/ssrf.ts`. Returns `{ html, markdown, title, byline, excerpt, wordCount, extractedBy }`. — `M`
- [x] **M1-T2** Add deps: `defuddle`, `@mozilla/readability`, `markdown-it` (+`markdown-it` plugins as needed), `turndown`(+gfm, as a selector-path MD converter). Confirm they run under our Node/JSDOM + `serverExternalPackages`. — `S`
- [x] **M1-T3** Schema: `Article.contentFormat` (`"html" | "markdown"`, default per feed) + `Feed.fullTextMode` (`"off" | "auto" | "selector"`) and `Feed.defaultContentFormat`. Prisma migrate via `db push`. — `S`
- [x] **M1-T4** Wire "auto" mode into the existing full-text flow (`lib/feed-fetcher.ts` `autoFetchFullText` / sync path): when `fullTextMode="auto"`, run M1-T1 and store the chosen format. Keep manual per-article "fetch full text" working. — `M`
- [x] **M1-T5** Reader render path for Markdown: `markdown-it` → **DOMPurify** (already present) → existing `.article-content` prose. Add a per-article/per-feed **Markdown ⟷ HTML toggle** in the reader UI. Old HTML articles keep rendering (respect `contentFormat`). — `M`
- [x] **M1-T6** Settings UX: in Feed Settings, a simple **"Full text: Off / Automatic / Custom selector"** control + **"Preferred format: Markdown / HTML"**. Automatic requires zero further input. i18n en+de. — `M`
- [x] **M1-T7** Tests: extractor unit tests (fixture HTML → expected markdown/plain), fallback path, format round-trip; verify sanitization on the markdown→HTML render. — `M`

**Acceptance:** add a known truncated feed → set Automatic → articles show full clean content; toggling Markdown/HTML re-renders; nothing leaks unsanitized HTML; `tsc`/`lint`/`test`/`build` green. **Deps:** none. **Risk:** extraction quality (mitigated by fallback + M3 manual + M4 AI); storage growth (retention covers it).

---

## Milestone M2 — Full-text polish
*Phase 1.3.*

- [ ] **M2-T1** GFM tables, code blocks (theme already exists), footnotes, task lists in the markdown renderer. — `S`
- [ ] **M2-T2** Math (MathJax/KaTeX) — Defuddle normalizes it; render or gracefully downgrade. — `S–M`
- [ ] **M2-T3** Image handling: keep `https:` images (CSP already allows), lazy-load, strip inline `width`/`min-width` from extracted HTML (also closes a P3 from the mobile audit). — `S`
- [ ] **M2-T4** Per-feed default format + instance default (admin); retention interplay check (full text is bigger). — `S`

**Acceptance:** rich articles (tables/code/math/images) render cleanly in both formats and themes on mobile + desktop. **Deps:** M1.

---

## Milestone M3 — Page → Feed builder (manual, in-process) ✅ *shipped (PRs #145–#147)*
*Phase 2.A, Model A. The foundation the AI layer (M4) sits on.*

**User outcome:** paste a *listing* page URL (blog index, forum, search results) → mark the repeating item + fields → save as a feed that re-scrapes on schedule. (Works without an AI key.)

- [x] **M3-T1** Generalize Scout Studio extraction to "**list of items from an arbitrary page**": given a page + an item selector + per-field selectors (title/link/date/summary/image), produce feed items. Reuse the existing XPath/CSS engine in `lib/feed-extraction.ts`. — `M`
- [x] **M3-T2** **Ranked candidate suggestion** for the repeating-item container (extend the current Scout Studio ranking: repetition count, structural similarity, link density) + live preview of the parsed items. — `M`
- [x] **M3-T3** "**Create feed from a web page**" entry point (new-feed dialog → "This page has no RSS? Build one"): fetch (SSRF-safe) → pick item → map fields → preview → save as a synthetic feed (`sourceType` extension). — `M`
- [x] **M3-T4** Persist as a normal feed; re-scrape on the sync schedule; dedup via existing unicity keys; export/import through the `ffx:*` OPML extension (FreshRSS interop). — `M`
- [x] **M3-T5** Tests + docs (extend `docs/scout-studio.md`). — `S`

**Acceptance:** turn a real static listing page (e.g. a blog index) into a working, auto-refreshing feed by clicking through the builder. **Deps:** M1-T1 (shared fetch/clean). **Risk:** page structure variety (M4 AI + candidate ranking help); JS-only pages out of scope here (→ M5b/M7).

---

## Milestone M4 — AI config proposal ⭐ (the north-star UX) 🔄 *slice 1 shipped (#149): engine + validation + tests; UI (T3–T5) pending*
*Phase 2.C1. "Paste a URL, the AI sets it up."*

**User outcome (with an AI key):** paste any URL → AI analyzes it → **proposes the complete config** (full-text selector for a truncated feed, *or* the item + field selectors for a page→feed) → live preview → user accepts (or tweaks). No selector thinking.

- [x] **M4-T1** *(slice 1, PR #149)* `lib/ai-feed-config.ts` — takes a URL, fetches (SSRF-safe) + Defuddle-cleans the HTML (keep it small/tokens-bounded), sends a structured prompt to the user's BYOK provider (`lib/ai-summary.ts` plumbing), and gets back a **strict JSON config** matching our Scout Studio schema (`{ mode: "fulltext"|"pagefeed", itemSelector?, fields?, fullTextSelector?, confidence, notes }`). — `M`
- [x] **M4-T2** *(slice 1, PR #149)* **Validate before showing:** run the proposed config through the real extraction engine (M1/M3) server-side, return a **preview** (extracted article / parsed items) alongside the config + a confidence signal. Never save unseen. — `M`
- [ ] **M4-T3** UX: a single **"✨ Let AI set this up"** button in the add-feed / full-text flow → spinner → shows the preview + an editable summary of what the AI chose → **Accept** (saves the config) or **Edit** (drops into the manual Scout Studio fields, pre-filled). Falls back to manual if no AI key / AI fails. i18n en+de. — `M`
- [ ] **M4-T4** Guardrails: token/size caps on the page sent to the model; rate-limit (`lib/rate-limit.ts`); clear error states; the AI call is **one-shot config generation** (not per-fetch) — after Accept it's plain selector scraping. — `S`
- [ ] **M4-T5** Also offer AI proposal for **M1 truncated-feed full-text** (propose the article-body selector automatically), not just page→feed. — `S`
- [x] **M4-T6** *(slice 1, PR #149)* Tests (mocked AI returning good/garbage JSON → validation catches garbage; preview path). — `M`

**Acceptance:** with a valid AI key, pasting a blog index *or* a truncated-feed article URL yields a correct, preview-backed config the user accepts in one click; with no key, the manual builder (M3) still works. **Deps:** M1, M3. **Risk:** hallucinated/invalid selectors (mitigated by mandatory server-side validation + preview + confirm); provider variance (strict JSON schema + retry/repair); cost (one-shot + caps).

---

## Milestone M5 — Optional self-hosted connectors (Model B)
*Phase 2.B. Broad coverage + JS rendering without us maintaining scrapers.*

**User outcome:** an admin can point FeedFerret at a self-hosted RSSHub and/or changedetection.io; users then get platform feeds and any-page monitoring — the AI can even pick the right route/watch for them.

- [ ] **M5a — RSSHub connector** — `M`
  - [ ] Admin setting: RSSHub base URL (+ optional key); reachable only via SSRF-allowlisted host.
  - [ ] "Add from platform" UX: user names a source (YouTube channel, subreddit, GitHub repo releases…) → we build the RSSHub route → add as feed. AI can map "this YouTube URL" → the route.
  - [ ] Hidden entirely when unconfigured.
- [ ] **M5b — changedetection.io connector** — `M`
  - [ ] Admin setting: changedetection base URL + API key.
  - [ ] "Monitor this page → feed": create a **watch** via its REST API (with CSS/xpath filter, optional restock/price processor), subscribe to its RSS output as a feed. Leans on its **own browser rendering** for JS pages (so we don't run Playwright in-process).
  - [ ] AI assist: propose the watch's filter/selector from the page (reuse M4).
- [ ] **M5-T3** Docs: `docs/self-hosting.md` connector setup; SSRF/network-isolation guidance. — `S`

**Acceptance:** with a sidecar configured, a user adds e.g. a YouTube channel (RSSHub) and a no-RSS product page (changedetection) as feeds; with no sidecar, the options are cleanly absent. **Deps:** M3/M4 for the AI-assist bits. **Risk:** ops burden (strictly optional); sidecar is an SSRF surface (isolate + allowlist).

---

## Milestone M6 — Per-article AI extraction fallback
*Phase 2.C2. For sites too unstable for a fixed selector config.*

- [ ] **M6-T1** Opt-in per-feed "AI extraction" mode: when selectors are unreliable, run the article HTML through the BYOK model to extract clean content per article. — `M`
- [ ] **M6-T2** Strong guardrails: opt-in only, per-user rate limits, token caps, cost visibility, cache results (don't re-extract unchanged articles — reuse contentHash). — `M`

**Acceptance:** a site that M4 selectors can't pin down still yields clean articles in AI-extraction mode, within rate/cost limits. **Deps:** M1, M4. **Risk:** ongoing token cost (gated + cached), latency (async, off the render path).

---

## Milestone M7 — Heavy rendering / anti-bot (optional, top of the ramp)
*Phase 2.D.*

- [ ] **M7-T1** In-process **Playwright** "render then extract" opt-in per feed (Chromium already provisioned) — isolate resource use; per-feed opt-in only. — `L`
- [ ] **M7-T2** OR delegate to **Firecrawl/Jina** — self-hosted (Model B) or per-user BYO-key hosted (Model C), clearly flagged "content leaves your server". — `L`

**Acceptance:** a JS-only / mildly anti-bot page that all earlier tiers miss can be captured via the opt-in heavy path. **Deps:** M3–M5. **Risk:** RAM/CPU (isolate), fragility, ToS — position as last resort.

---

## Sequencing & milestones summary

| Milestone | Delivers | Effort | Gate |
|---|---|---|---|
| **M1** ✅ | Auto full-text, Markdown/HTML selectable — *shipped, PRs #141–#143* | M | — |
| **M2** | Full-text polish (tables/code/math/images) | S–M | M1 |
| **M3** ✅ | Manual page→feed builder — *shipped, PRs #145–#147* | M–L | M1 |
| **M4 ⭐** 🔄 | **AI proposes the whole config** (paste → accept) — *slice 1 engine shipped (#149); UI pending* | M | M1, M3 |
| **M5** | Optional RSSHub + changedetection.io connectors | M (×2) | M3/M4 |
| **M6** | Per-article AI extraction fallback | M–L | M1, M4 |
| **M7** | Playwright / Firecrawl / Jina heavy path | L | M3–M5 |

**Recommended delivery order:** **M1 → M3 → M4** gets us to the north-star ("paste a URL, AI sets up any feed") entirely in-process/self-hosted. **M2** slots in whenever (polish). **M5** adds the big coverage jump once the core is solid. **M6/M7** are demand-driven.

Each milestone ships as its own verified PR(s) (`tsc`/`lint`/`test`, `next build` on CSS/schema changes), with checkboxes ticked here as they land.

---

## Cross-cutting acceptance (applies to every milestone)
- SSRF: all user-URL fetches through `lib/ssrf.ts`; connectors/sidecars host-allowlisted.
- Privacy: in-process by default; any path that sends content off-box is opt-in + labelled.
- Cost: AI is one-shot config by default; per-article/hosted paths are opt-in + rate-limited + cached.
- i18n: all new strings en+de; `translations:check` green.
- Interop: preserve `ffx:*` OPML round-trip; consider importing `full-text-rss` site-config format later.
- Retention/perf: full text + scraped feeds honor retention + content caps + conditional GET.

---

## Post-core feature backlog (queued after M1–M7)

> Appended 2026-07-16. All the ideas from [`feature-ideas.md`](feature-ideas.md), queued behind the core Feed-Intelligence milestones and **sorted by effort, easy → complex**. Tags: 🟦 FreshRSS-parity · 🤖 AI-synergy · ⭐ high value. Two are recommended to pull *forward* (noted inline) because they ride along with core work.

### Tier S — quick wins
- [x] **F1** · "Refresh now" per feed (expose a manual force-refresh everywhere) — `S` — *shipped, Phase 0*
- [x] **F2** · Per-feed reader defaults (font / width / format override on top of the global prefs) — `S` — *shipped, Phase 0 (PR #137)*
- [x] **F3** · ⭐ Copy article as Markdown (nearly free once M1 lands) — `S` — *shipped, Phase 0 (PR #135)*

### Tier S–M
- [x] **F4** · ⭐ Command palette (⌘K / Ctrl-K) — `cmdk` is already a dependency — `S–M` — *shipped, Phase 0 (PR #135)*
- [ ] **F5** · Export / "Send to" Obsidian · Wallabag · Readwise · Pocket — `S–M`
- [ ] **F6** · Auto-mute + notify on persistently-failing feeds (we already track feed health) — `S–M`
- [ ] **F7** · PWA share-target bookmarklet ("Share → FeedFerret" → starts the page→feed flow) — `S–M`

### Tier M
- [ ] **F8** · ⭐ 🤖 🟦 AI auto-tagging / classification of incoming articles (prompt → labels on sync) — `M` — *recommend right after M4 (reuses the AI-config plumbing)*
- [ ] **F9** · 🤖 User-facing reading-stats dashboard (read-over-time, top feeds, streaks, "time saved by AI") — `M`
- [ ] **F10** · 🟦 Reverse-proxy / trusted-header auth (`X-Forwarded-User`) — `M`
- [ ] **F11** · Article notes / highlights (annotate passages, searchable) — `M`
- [ ] **F12** · 🤖 AI "translate this article" (one-click, BYOK) — `M`
- [ ] **F13** · 🟦 Theme presets + import/export (on top of the accent theming we have) — `M`

### Tier L
- [ ] **F14** · ⭐ 🟦 WebSub (PubSubHubbub) — real-time push instead of polling — `L`
- [ ] **F15** · ⭐ 🤖 Newsletter → feed (per-user inbound email address; optional M1 markdown clean-up) — `L`
- [ ] **F16** · 🤖 AI semantic / "find similar" search (embeddings + vector store) — `L`
- [ ] **F17** · Podcast / audio + "read aloud" (TTS) — `L` (aligns with the planned v2 audio surface)

### Tier XL
- [ ] **F18** · 🟦 Extension / event-hook surface — FreshRSS's biggest differentiator. Full plugins are XL; start lighter with an event/hook API on top of our existing webhooks + rules — `XL`

---

*Next action: convert **M1** into concrete PR-sized tasks and start implementation.*
