# Feed Intelligence — Project Plan

> **Status:** Research & planning (2026-07-16). No code yet — this is the thinking document.
> **Mission:** make FeedFerret great at *getting the actual content*. Two phases:
> 1. **Auto full-text** — automatically de-truncate partial feeds and render the full article as clean, well-typeset content ("nice markdown") in the reader, with no manual selector work.
> 2. **Turn anything into a feed** — generate a feed from an arbitrary web page/source that has no RSS.
>
> This is the FreshRSS/rss-bridge problem space. We already ship a chunk of it — this plan builds on it rather than starting over.

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
| **Automatic** (no-selector) readability extraction | ❌ missing | — |
| HTML → Markdown pipeline | ❌ missing | — |
| Page → feed (scrape a listing page into items) | ⚠️ partially possible via Scout Studio XPath, but not framed/UX'd as "make a feed from this page" | — |

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

## 5. Recommended roadmap (phased, with effort)

| Step | Deliverable | Effort | Depends on |
|---|---|---|---|
| **P1.1** | `lib/readability-extract.ts`: Defuddle + Readability-fallback auto-extractor; "Automatic" mode in the full-text flow | **M** | — |
| **P1.2** | Markdown render path (`markdown-it` → DOMPurify → prose) + `Article.contentFormat`; extract-to-Markdown | **M** | P1.1 |
| **P1.3** | Polish: GFM tables/code/footnotes/math, image handling, per-feed default toggle | **S–M** | P1.2 |
| **P2.A** | Page→feed builder (generalize Scout Studio to "items from a listing page" + ranked candidates + save as feed) | **M–L** | P1.1 |
| **P2.B** | RSSHub integration (add-a-route UX; optional self-hosted sidecar) | **S–M** (int.) / **L** (bundle) | — |
| **P2.C** | AI-assisted selector/config generation (LLM proposes Tier-A config, user confirms) | **M** | P2.A |
| **P2.D** *(optional)* | Headless-render (Playwright) / external-engine (Firecrawl/Jina) fallback for JS/hard pages | **L** | P2.A |

**Suggested first two moves:** ship **P1.1 + P1.2** (the concrete, high-value "auto full-text as clean markdown" the mission asks for first), then **P2.A** (page→feed builder) since it reuses the most of what we already own. RSSHub (P2.B) is the highest coverage-per-effort add after that. AI (P2.C) makes A delightful without betting the reliability on the model.

---

## 6. Open questions for the maintainer

1. **Markdown storage:** OK to introduce `Article.contentFormat` and store extracted content as Markdown, or keep everything HTML and treat "markdown" purely as a rendering/typography goal?
2. **External services:** willing to run an optional **RSSHub sidecar** (and maybe Firecrawl/Jina) for coverage, or keep everything in-process (limits us to static-HTML + selector scraping)?
3. **AI budget:** AI-assisted **config generation** (cheap, one-shot) only — or also per-fetch LLM extraction for hard pages (ongoing token cost)?
4. **Scope of "anything":** are we happy positioning it as "most static/list pages + all RSSHub platforms," or is JS-heavy/anti-bot coverage a hard requirement (→ Playwright/Firecrawl, much heavier)?

---

### Sources (research 2026-07)
- Defuddle: [npm](https://www.npmjs.com/package/defuddle) · [overview](https://biggo.com/news/202505240122_Defuddle_Web_Content_Extractor)
- Mozilla Readability wrapper: [ArchiveBox/readability-extractor](https://github.com/ArchiveBox/readability-extractor)
- article-extractor: [extractus/article-extractor](https://github.com/extractus/article-extractor)
- HTML→MD: [turndown](https://github.com/mixmark-io/turndown) · [node-html-markdown](https://www.npmjs.com/package/node-html-markdown)
- Web→feed: [RSSHub](https://github.com/DIYgod/RSSHub) · [RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge) · [morss.it](https://morss.it/)
- AI extraction: [Jina Reader](https://github.com/jina-ai/reader) · [Firecrawl](https://www.firecrawl.dev/) · [Jina vs Firecrawl](https://blog.apify.com/jina-ai-vs-firecrawl/)
