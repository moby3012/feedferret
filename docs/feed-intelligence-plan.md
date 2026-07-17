# Feed Intelligence — Project Plan

> **Status:** Original thinking document (2026-07-16). **Since superseded by delivery:** M1 (auto full-text) and M3 (page→feed builder) shipped, M4 slice 1 (AI config engine) shipped — see [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md) for live status. Kept for the rationale/decisions below.
> **→ Actionable milestone TODO:** [`feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md).
> **Mission:** make FeedFerret great at *getting the actual content*. Two phases:
> 1. **Auto full-text** — automatically de-truncate partial feeds and render the full article as clean, well-typeset content ("nice markdown") in the reader, with no manual selector work.
> 2. **Turn anything into a feed** — generate a feed from an arbitrary web page/source that has no RSS.
>
> This is the FreshRSS/rss-bridge problem space. We already ship a chunk of it — this plan builds on it rather than starting over.

---

## Decisions locked (2026-07-16, maintainer)

1. **Content format is user-selectable.** Introduce `Article.contentFormat` and let the user choose **Markdown or HTML** (per feed, with a sensible default; ideally overridable per article). Markdown is the "clean, aligned" path; HTML stays available for people who want the source rendering.
2. **Deployment is staged, in-process first.** Default everything to **in-process** (no extra services) so minimal/Coolify deployments keep working with zero setup; expose external engines (RSSHub / changedetection.io / Firecrawl / Jina) as **optional, admin-configured connectors**; hosted third-party APIs only as **per-user opt-in** (like AI BYOK). Full rationale in §4b.
3. **AI extraction is multi-stage by hardness:** (a) **AI selector detection** first — the model proposes a reusable extraction config, user confirms, cheap one-shot; (b) if a site is too inconsistent for stable selectors, fall back to **per-article AI extraction**; (c) also evaluate an **API connector to changedetection.io** for the "any page → feed" monitoring path.
4. **Scope: "the more the better", delivered in ascending build stages.** We don't have to solve *everything* at once — ship value at each stage (see the staged roadmap in §5), climbing from static-HTML to JS-rendered/anti-bot coverage as effort allows.

---

## 0. Where we are today (honest inventory)

| Capability | State | Where |
|---|---|---|
| RSS/Atom/JSON feed parsing | ✅ solid | `lib/feed-fetcher.ts`, `rss-parser` |
| **Scout Studio** — selector-based full-text extraction (CSS / XPath / JSONPath), live preview, ranked selector candidates, per-feed config, OPML `ffx:*` round-trip (FreshRSS-compatible) | ✅ shipped (manual) | `lib/feed-extraction.ts`, `lib/feed-fetcher.ts`, `docs/scout-studio.md` |
| SSRF-safe outbound fetching (blocks localhost/private/link-local, redirect re-validation, size caps) | ✅ solid | `lib/ssrf.ts` |
| Article rendering | HTML → DOMPurify → Tailwind `prose` (`.article-content`) | `components/article-reader.tsx`, `app/globals.css` |
| DOM tooling already in the bundle | `jsdom`, `isomorphic-dompurify` | `package.json` |
| AI (BYOK: OpenAI/Anthropic/Gemini/OpenRouter/Ollama, encrypted keys) | ✅ shipped | `lib/ai-summary.ts` |
| **Automatic** (no-selector) readability extraction | ✅ shipped (M1) | `lib/readability-extract.ts` (Defuddle → Readability) |
| HTML → Markdown pipeline | ✅ shipped (M1) | `lib/html-to-markdown.ts`, `lib/markdown-render.ts` |
| Page → feed (scrape a listing page into items) | ✅ shipped (M3) — "Create feed from a web page" builder | `lib/page-feed-suggest.ts`, `components/page-feed-panel.tsx` |

**Takeaway:** the *plumbing* (SSRF-safe fetch, jsdom, per-feed extraction config, AI) is already here. Phase 1 is mostly "add an automatic extractor + a markdown render path." Phase 2 is a genuine new product surface, but a lot of it is an *extension* of Scout Studio + optional external engines.

---

## 1. Package / repo landscape (research 2026-07)

### 1a. Automatic article extraction (readability-style)

| Option | Lang / runtime | License | Notes | Fit |
|---|---|---|---|---|
| **Defuddle** (`defuddle`, npm) | TS, ships a **Node/JSDOM bundle** | MIT | Modern Readability alternative (built for Obsidian Web Clipper). Multi-pass "forgiving" extraction, **built-in HTML→Markdown**, standardizes code blocks, converts MathJax/KaTeX, site-specific extractors (Reddit/HN/X, AI chats). Uses JSDOM — which we already have. | ⭐ **Primary recommendation** |
| **Mozilla Readability** (`@mozilla/readability`) | JS + JSDOM | Apache-2.0 | The classic (Firefox Reader View). Battle-tested but conservative — sometimes strips useful content. | Strong fallback / cross-check |
| **@extractus/article-extractor** | JS (node/deno/bun) | MIT | Returns structured `{title, author, image, content, …}`; uses sanitize-html; transform hooks. | Good "batteries-included" alt |

*Direction:* **Defuddle as the primary auto-extractor, Mozilla Readability as a fallback** when Defuddle returns nothing (defence in depth). Both run on the JSDOM we already ship — no headless browser needed for static HTML.

### 1b. HTML → Markdown

| Option | License | Notes |
|---|---|---|
| **Defuddle built-in MD** | MIT | If we use Defuddle, we may not need a separate converter — it can emit Markdown directly. |
| **turndown** (`turndown` + `turndown-plugin-gfm`) | MIT | The standard high-fidelity HTML→MD (4.9M weekly dl). Best for tables/code/GFM; very customizable. |
| **node-html-markdown** | MIT | ~1.5× faster, node-only, lighter, less flexible. Good if throughput matters. |

*Direction:* start with **Defuddle's markdown output**; keep **turndown** in the toolbox for cases where we extract via selectors/Readability and still want MD, or need finer table/code control.

### 1c. Markdown → rendered in the reader

We currently render sanitized HTML through `prose`. To render Markdown we'd add a renderer:
- **markdown-it** (MIT) or **marked** (MIT) → HTML → **DOMPurify** (already here) → existing `.article-content` prose styles.
- This is the "nice, aligned, consistent typography regardless of source cruft" win: source HTML → extract → Markdown → *our* controlled HTML → our prose. The reader stops inheriting the source site's messy inline markup.

### 1d. Turn-anything-into-a-feed engines (Phase 2)

| Project | Lang | License | What it does | Integration angle for us |
|---|---|---|---|---|
| **RSSHub** | Node/TS | MIT | 5,000+ curated *routes* (YouTube, Reddit, Bilibili, GitHub releases, Twitter/X, Telegram, …). 41k★. The gold standard for "platform → RSS". | Run as an optional **sidecar service**; let users add an RSSHub route as a feed, or bundle a curated subset. Same language as us. |
| **RSS-Bridge** | PHP | Unlicense/public-domain | Bridges for sites lacking RSS; community "bridges". | External service only (PHP) — reference for bridge patterns, not embeddable. |
| **morss** | Python | AGPL-3.0 | Truncated→full-text **and** page→RSS in one. | External service; gets rate-limited by big sites. Concept reference. |
| **changedetection.io** | Python | Apache-2.0 | Monitors *any* page for changes → notifications **and RSS output**; restock/price processors; **own browser rendering for JS pages**; clean **REST API** (create/update/delete "watches"). 30k★, very active. | ⭐ Strong optional connector for "any page → feed" via change-monitoring; we'd create watches via its API and subscribe to its RSS. Complements RSSHub (generic change-monitoring vs. curated platform routes). Handles JS rendering for us. |
| **full-text-rss** (FiveFilters) | PHP | dual (GPL/commercial) | The classic "site config" full-text service many readers embed. | Its **site-config format** is a de-facto standard worth supporting/importing. |
| **Firecrawl** | TS | AGPL-3.0 | Scrape/crawl/**extract** → clean Markdown/JSON, LLM-oriented. 130k★, self-hostable. | Optional external engine for hard/JS-heavy pages; AGPL is fine alongside our AGPL app (self-hosted). |
| **Jina Reader** (`r.jina.ai`, `reader` repo) + **ReaderLM-v2** | TS + a 1.5B model | Apache-2.0 (oss branch, stateless) | URL → LLM-friendly Markdown; ReaderLM-v2 is a small HTML→Markdown/JSON model. | Optional: hosted `r.jina.ai/<url>` for zero-infra, or self-host the oss reader; ReaderLM as a local model for AI-assisted field mapping. |

### 1e. JS-rendered pages

Static-HTML extractors (Defuddle/Readability) fail on SPA/JS-only sites. Options: a headless browser (**Playwright** — already provisioned in our infra) as an opt-in "render then extract" path, or delegate to Firecrawl/Jina which handle rendering. Heavy; make it opt-in per feed.

### Licensing note
FeedFerret is **AGPL-3.0**. All primary picks (Defuddle, Readability, turndown, markdown-it/marked, RSSHub) are permissive (MIT/Apache) and compatible. AGPL engines (Firecrawl, morss) are fine to **run as separate self-hosted services**; we'd integrate over HTTP, not vendor their source. `full-text-rss` is dual-licensed — only its open site-config format is worth adopting, not its code.

---

## 2. Phase 1 — Auto full-text → clean Markdown in the reader

**Goal:** a user adds a truncated feed (or opens any article), and with no selector work sees the full, cleanly typeset article.

### Proposed pipeline
```
fetch article URL (SSRF-safe, existing)  →  Defuddle extract (JSDOM)
   ↳ empty? → Mozilla Readability fallback → still empty? → keep feed summary
→ Markdown (Defuddle/turndown)  →  markdown-it → DOMPurify → .article-content prose
```

### Where it plugs in
- Extend the existing per-feed full-text flow (`lib/feed-fetcher.ts` `autoFetchFullText`, Scout Studio) with an **"Automatic (readability)"** extraction mode alongside the current manual selectors. Selector mode stays for sites that need it; auto becomes the default suggestion.
- Add `lib/readability-extract.ts` (Defuddle + Readability fallback) and a Markdown render path in `components/article-reader.tsx`.
- Storage: store extracted **Markdown** (portable, clean) and/or sanitized HTML. Reuse `Article.content`; consider a `contentFormat` flag ("html" | "markdown") so old articles keep rendering.
- Reuse existing infra: `lib/ssrf.ts` for fetch, `isomorphic-dompurify` for the final sanitize, the auto-full-text trigger + retention already in place.

### Decisions to make
- **Auto per feed vs on-open:** auto-extract on sync for feeds flagged "full-text", plus a manual "fetch full text" on any article (already exists). Watch storage growth (retention already runs — good).
- **Markdown storage vs HTML storage:** Markdown is cleaner/portable and enables the "nice aligned" look; but it's a content-model change. Recommendation: introduce `contentFormat`, extract to Markdown for the new path, render old HTML as-is.
- **Rendering fidelity:** GFM tables, code blocks (we already theme code), images (proxy? we already allow `https:` images via CSP), footnotes, math (Defuddle handles MathJax/KaTeX — nice-to-have).

### Effort & risk
- **Effort:** **M** (extractor + fallback + MD render + a settings toggle). Low architectural risk — the fetch/DOM/sanitize/AI plumbing already exists.
- **Risks:** extraction quality varies by site (mitigate with Readability fallback + keep manual selectors); paywalls/JS-only sites (out of scope for v1 — defer to the Playwright/Firecrawl opt-in); storage growth (retention covers it); rendering edge cases (iterate with real feeds).
- **Nice add-on:** our **AI** can *assist* — e.g. "the auto-extract looks truncated, ask the model to clean/reflow" — but keep AI optional and off the hot path (cost/latency).

---

## 3. Phase 2 — Turn anything into a feed

This is a spectrum, not one feature. Realistic framing: **most value comes from three layered tiers**, from "we already almost have it" to "genuinely hard."

### Tier A — Selector-based page→feed (extends Scout Studio) — *most achievable*
We already parse a page with XPath/CSS and extract fields. Reframe it as a **feed builder**:
- User pastes a *listing* URL (a blog index, a forum, a search-results page).
- We fetch it (SSRF-safe), let them pick the **repeating item** selector + per-field selectors (title/link/date/summary) — with **ranked candidate suggestions** like the current Scout Studio preview.
- Save as a synthetic feed that re-scrapes on the normal sync schedule.
- Import/export via the existing OPML `ffx:*` extension → interoperable with FreshRSS.
- **Effort:** **M–L** (mostly UX + generalizing existing extraction to "list of items from an arbitrary page"). **This is the recommended first deliverable of Phase 2.**

### Tier B — Platform routes via RSSHub — *high coverage, low build*
For YouTube/Reddit/GitHub/X/Telegram/… hand-rolled scraping is a losing battle; RSSHub already maintains 5,000+ routes.
- Integrate by letting users add an **RSSHub route** as a feed, and optionally **bundle/point at a self-hosted RSSHub** (Node/TS, docker sidecar — same stack as us).
- We provide a friendly picker ("Add YouTube channel → we build the RSSHub route"); RSSHub does the dirty work.
- **Effort:** **S–M** to integrate as an optional external service; **L** to bundle + curate a route UI. **Risk:** it's another service to run; upstream routes break; anti-bot on some platforms.

### Tier C — AI-assisted "just give me a feed" — *highest magic, highest caution*
Use our BYOK LLM to make Tier A self-driving:
- Point the model (via Defuddle-cleaned HTML or Jina/ReaderLM Markdown) at a listing page → it **proposes the item + field selectors**, which we save as a Tier-A config (user confirms). **AI generates config once**, not per fetch — cheap, cacheable, reliable.
- Optional heavier mode: per-fetch LLM extraction (Jina Reader / Firecrawl / local ReaderLM) for pages too messy for selectors — but this costs tokens/latency on every refresh, so make it opt-in and rate-limited.
- **Effort:** **M** for AI-assisted config generation on top of Tier A; **L+** for robust per-fetch LLM extraction. **Risk:** cost, hallucinated selectors (always keep a human-confirm step), provider variance.

### JS-rendered sites (cross-cutting)
Opt-in "render with headless browser (Playwright) before extract" for SPA sites, or delegate to Firecrawl/Jina. Heavy; per-feed opt-in; clearly the last resort.

### Phase 2 realistic assessment
- **Very doable now:** Tier A (we own the pieces) and Tier B integration-as-service. These deliver "turn *many* things into a feed" without magic.
- **Doable with care:** Tier C AI-assisted **config generation** — great UX, contained cost.
- **Hard / ongoing:** truly *anything* (aggressive anti-bot, auth-walled, JS-only, ToS-restricted). Set expectations: FeedFerret can turn **most static/list-shaped pages and every RSSHub-covered platform** into feeds; "literally anything, zero config" is a moving target even for the big players (morss gets banned, Jina/Firecrawl fight Cloudflare).

---

## 4. Cross-cutting concerns

- **Security (SSRF):** all Phase-2 fetching must route through `lib/ssrf.ts` (it already blocks private IPs + re-validates redirects). Arbitrary user-supplied URLs are exactly the SSRF surface we hardened in the security audit — do **not** regress that. Headless/render paths and any external engine (RSSHub/Firecrawl/Jina) must be reachable only via the guarded path or an admin-allowlisted host.
- **Abuse / cost:** per-fetch LLM and headless rendering are expensive; gate behind per-user opt-in, rate limits (`lib/rate-limit.ts`), and admin caps.
- **Legality / ToS:** scraping and re-serving content has legal/ToS nuance; keep it user-initiated, self-hosted, and personal-use framed (same posture as FreshRSS/rss-bridge). Respect `robots.txt` where reasonable; don't ship platform scrapers that obviously violate ToS — prefer RSSHub, which manages that community-side.
- **Storage/perf:** full-text + scraped feeds grow the DB; retention (already automated) and the content-size cap matter. Cache extraction results; honor conditional GET (already added).
- **Interop:** lean on the FreshRSS `ffx:*` OPML extension we already support, and consider importing `full-text-rss` **site-config** format — instant compatibility with a large existing corpus of site rules.

---

## 4b. Architecture: where does the scraping/extraction run? (the key trade-off)

This is the decision that shapes everything in Phase 2. There are three models; they are **not** mutually exclusive — the recommendation is to layer them.

### Model A — In-process (inside FeedFerret's own Node server)
Static HTML via `jsdom` + Defuddle/Readability; optionally **Playwright** (Chromium is already provisioned in our infra) for JS-rendered pages.

- **Pros:** zero extra services — one container, one deploy (matches how most self-hosters run us, incl. Coolify/tiny boxes). Everything flows through our existing **SSRF guard**; content never leaves the user's box (privacy). No cross-service auth, no version skew. Same language (Node). Works air-gapped.
- **Cons:** heavy JS rendering (Playwright) is **RAM/CPU-hungry** and would run *on the same process that serves the app* — a scraping spike can degrade the reader. No giant library of platform scrapers — we'd reinvent RSSHub route-by-route (a losing battle for YouTube/Reddit/X/…). We own and maintain every scraper (fragile, ongoing). Anti-bot/Cloudflare is largely unsolved here.
- **Best for:** Phase 1 (auto full-text on static HTML) and Tier-A selector page→feed. This is the **default, always-available** layer.

### Model B — Optional sidecar service(s) we self-host (RSSHub / changedetection.io / Firecrawl / Jina-oss), integrated over HTTP
FeedFerret calls the sidecar's API; if none is configured, those features are simply hidden.

- **Pros:** enormous capability for near-zero build — RSSHub's **5,000+ maintained routes**, changedetection's **any-page→RSS + JS rendering + REST API**, Firecrawl's crawl/extract. **Isolation:** a scraper OOM/crash/hang takes down the sidecar, not the reader. The upstream community maintains the fragile parts. Scales and rate-limits independently. Still fully **self-hosted** (data stays on the user's infrastructure).
- **Cons:** **more moving parts** — extra containers + docker-compose complexity that minimal deployments won't want (must be strictly optional and degrade gracefully). Mixed languages/ops (RSSHub=Node, changedetection/morss=Python, Firecrawl=AGPL Node). The sidecar itself fetches arbitrary URLs, so it's an **SSRF surface** — we must only reach it via an admin-allowlisted host and keep it network-isolated. Version-skew and "another thing to update."
- **Best for:** power users who want broad coverage; expose as **admin-configured connectors** ("paste your RSSHub / changedetection.io base URL + API key").

### Model C — Third-party **hosted** APIs (Jina `r.jina.ai`, Firecrawl cloud, changedetection SaaS)
No infra at all; they handle Cloudflare/JS.

- **Pros:** zero setup, instant, best at anti-bot/JS. Great for the occasional hard page.
- **Cons:** **not self-hosted** — the article URL and often its content leave the user's server, which cuts against FeedFerret's whole ethos; API keys, per-call cost, rate limits, outages, ToS. 
- **Best for:** a clearly-labelled **per-user opt-in** (exactly like our AI BYOK model — the user brings their own key and accepts that content leaves their box). Never a default.

### Recommended posture
**Layer them, default to the least invasive:**
1. **In-process (Model A) is the baseline** — everyone gets auto full-text + selector page→feed with zero extra setup.
2. **Optional self-hosted connectors (Model B)** — admins who want RSSHub-scale coverage or changedetection's JS/any-page monitoring point us at their sidecar; hidden if unconfigured.
3. **Hosted APIs (Model C)** — per-user BYO-key opt-in for the hard cases, flagged "content leaves your server."

This keeps the "5-minute, single-container" promise intact while giving power users a clear upgrade path — and it's exactly the staged build-out the maintainer asked for (see §5).

**On the AI tiers (decision #3):** the same layering applies. Cheapest/most-private first — **(a) AI proposes a reusable selector config once** (in-process LLM call via our BYOK provider; user confirms; then it's plain selector scraping forever after, no per-fetch cost). If a site is too unstable for selectors, **(b) per-article AI extraction** (higher ongoing token cost — opt-in, rate-limited). **changedetection.io** slots in as a Model-B connector for the "monitor any page → feed" path, and can also shoulder JS rendering so we don't have to run Playwright in-process.

---

## 5. Recommended roadmap (phased, with effort)

| Step | Deliverable | Effort | Depends on |
|---|---|---|---|
| **P1.1** | `lib/readability-extract.ts`: Defuddle + Readability-fallback auto-extractor; "Automatic" mode in the full-text flow | **M** | — |
| **P1.2** | `Article.contentFormat` (**user-selectable Markdown / HTML**, per feed + per-article override) + Markdown render path (`markdown-it` → DOMPurify → prose); extract-to-Markdown | **M** | P1.1 |
| **P1.3** | Polish: GFM tables/code/footnotes/math, image handling, per-feed default toggle | **S–M** | P1.2 |
| **P2.A** | Page→feed builder (generalize Scout Studio to "items from a listing page" + ranked candidates + save as feed) — **in-process (Model A)** | **M–L** | P1.1 |
| **P2.C1** | **AI selector detection** (LLM proposes a Tier-A config once, user confirms → plain scraping after) | **M** | P2.A |
| **P2.B1** | **RSSHub** connector (admin URL; add-a-route UX) — **Model B** | **S–M** | — |
| **P2.B2** | **changedetection.io** connector (create watches via its REST API → subscribe to its RSS; leans on its JS rendering) — **Model B** | **M** | — |
| **P2.C2** | **Per-article AI extraction** fallback for sites too unstable for selectors (opt-in, rate-limited) | **M–L** | P2.C1 |
| **P2.D** *(optional)* | In-process **Playwright** render, or **Firecrawl/Jina** (self-host Model B or BYO-key Model C) for JS/anti-bot pages | **L** | P2.A |

**Suggested first moves:** ship **P1.1 + P1.2** (auto full-text as user-selectable clean Markdown — the mission's first ask), then **P2.A + P2.C1** (in-process page→feed builder made delightful by one-shot AI selector detection, all self-hosted). After that, the **Model-B connectors** (P2.B1 RSSHub for platform coverage, P2.B2 changedetection.io for any-page monitoring + JS) are the highest coverage-per-effort. Per-article AI (P2.C2) and heavy rendering (P2.D) are the top of the difficulty ramp — add as demand warrants.

---

## 6. Open questions — answered (2026-07-16)

1. **Markdown storage:** ✅ user-selectable Markdown/HTML via `Article.contentFormat` (see Decisions #1).
2. **External services:** ✅ layered — in-process default, optional self-hosted connectors, per-user hosted opt-in (see §4b + Decisions #2).
3. **AI budget:** ✅ multi-stage — one-shot AI selector detection first, per-article AI as fallback, changedetection.io connector for monitoring (Decisions #3, §4b).
4. **Scope:** ✅ "the more the better", delivered in ascending stages (Decisions #4, roadmap §5).

Next: turn P1.1 + P1.2 into a concrete implementation plan (tasks/PRs) and start.

---

### Sources (research 2026-07)
- Defuddle: [npm](https://www.npmjs.com/package/defuddle) · [overview](https://biggo.com/news/202505240122_Defuddle_Web_Content_Extractor)
- Mozilla Readability wrapper: [ArchiveBox/readability-extractor](https://github.com/ArchiveBox/readability-extractor)
- article-extractor: [extractus/article-extractor](https://github.com/extractus/article-extractor)
- HTML→MD: [turndown](https://github.com/mixmark-io/turndown) · [node-html-markdown](https://www.npmjs.com/package/node-html-markdown)
- Web→feed: [RSSHub](https://github.com/DIYgod/RSSHub) · [RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge) · [morss.it](https://morss.it/)
- AI extraction: [Jina Reader](https://github.com/jina-ai/reader) · [Firecrawl](https://www.firecrawl.dev/) · [Jina vs Firecrawl](https://blog.apify.com/jina-ai-vs-firecrawl/)
