# Example Feeds & Pages — Smoke-Testing Every Fetch Path

A curated set of stable, public, legitimate sources to manually exercise each of FeedFerret's fetch/ingestion paths — useful after a fresh deploy, after enabling a connector, or whenever you want to confirm a code path actually works end to end. These are **suggestions, not requirements** — any real feed or page works — but they were picked to reliably exercise a specific path.

> Confidence varies by row. Core feed formats and the documented connector smoke-test route are rock solid (long-standing, official, unlikely to change). The Feed-Intelligence and heavy-fetch rows depend on the target site's own behavior, which shifts over time — treat those as good starting points to try, not guarantees.

---

## 1. Core feed formats (baseline sync)

| Format | Example URL | What it proves |
|---|---|---|
| RSS 2.0 | `https://news.ycombinator.com/rss` | Standard feed parsing, sync scheduling, conditional GET. |
| Atom | `https://github.com/<owner>/<repo>/releases.atom` (e.g. `https://github.com/vercel/next.js/releases.atom`) | Atom-specific parsing (GitHub natively serves `.atom` for releases/commits/tags on any public repo). |
| JSON Feed | `https://www.jsonfeed.org/feed.json` | JSON Feed format support (the spec's own site serves its canonical example). |

## 2. Feed Intelligence

| Feature | Example | Notes |
|---|---|---|
| **Truncated-feed detection** (auto full-text suggestion) | Any feed your publisher ships as teaser-only (common with WordPress "Summary" mode) | Publisher-dependent and changes over time — add any feed, open an article, click **"Fetch full text"** once manually. If the fetched text is dramatically longer than the feed's own content, FeedFerret should offer *"enable automatic full text for this feed?"* — that's `looksLikeTruncatedFeed` firing. |
| **Page → Feed builder** (Scout Studio, no AI needed) | `https://github.com/trending` | A real repeating list with no native RSS feed — the canonical "this page needs a feed built for it" case. Paste it into **Add Feed → From a web page**; the heuristic should rank a repo-row selector highly with a live preview. |
| **AI config proposal** ("✨ Let AI set this up") | Same as above (`https://github.com/trending`), *with your own AI key configured first* (Settings → AI Summaries) | Exercises the BYOK proposal + mandatory real-engine validation before anything is saved. |
| **Per-article AI extraction fallback** (`Feed.fullTextMode: "ai"`) | *(no fixed target)* | This tier only ever runs after **every** free deterministic extractor (ftr-site-config, Defuddle, Readability, extractus, JSON-LD) already failed — by design, you shouldn't be able to force it on demand with a "normal" site. Enable it on a feed you suspect is extraction-resistant and check whether full-text quality improves; if the deterministic tiers already handle it, the AI tier simply never fires, which is the correct/expected behavior, not a bug. |

## 3. Optional self-hosted connectors

| Connector | Example | Notes |
|---|---|---|
| **RSSHub** — wiring smoke test | Route path `/github/repos/DIYgod/RSSHub` | Needs no platform credentials — if this returns items via **Add Feed → From platform**, FeedFerret ↔ RSSHub is wired correctly and any other route's failure is that route's own requirement (see the troubleshooting table in [`self-hosting.md`](self-hosting.md#rsshub-connector)). |
| **RSSHub** — platform routes (YouTube/Reddit/etc.) | Look up the current route path for your target in [RSSHub's own route directory](https://docs.rsshub.app/) | Deliberately not hardcoded here — exact route syntax, required identifiers, and auth requirements vary by RSSHub version/build and change over time; always confirm against your instance's own docs link. |
| **changedetection.io** | `https://news.ycombinator.com/` | Updates frequently — the same demo changedetection.io's own tutorials use. Via **Add Feed → Monitor page**. Remember: **the resulting feed has zero items until changedetection.io completes two checks** — temporarily lower the check interval to a minute or two for the smoke test, then set it back afterward. |

## 4. Heavy-fetch / anti-bot stack (harder to force deliberately)

These four tiers (browser-fingerprint fetch → embedded-data extraction → optional render sidecar → optional BYOK hosted API) are an adaptive fallback chain — each one only engages when the tier before it fails, and *which* tier a given site needs depends on that site's own anti-bot posture, which changes over time. Rather than hunting for an adversarial target, the practical test is: add feeds/pages you actually care about and confirm they come through with full content; if one doesn't, that's the signal to look at which tier it's landing on.

| Tier | A reasonable starting point | Notes |
|---|---|---|
| T1 — embedded-data extraction (`__NEXT_DATA__` / JSON-LD) | A Next.js-powered blog, e.g. `https://vercel.com/blog` | Confirms full-text/page→feed extraction can recover content shipped only in embedded JSON on JS-rendered pages, without needing the render sidecar. |
| T0 (fingerprinted fetch), T2 (render sidecar), T3 (BYOK hosted API) | *(no fixed target — situational)* | These specifically exist for sites that actively block plain automated fetches; which one a given page needs isn't predictable in advance. Trust the fallback chain on your real feeds rather than deliberately provoking a specific anti-bot system. |

---

## See also

- [`self-hosting.md`](self-hosting.md) — connector setup, network isolation, RSSHub route troubleshooting.
- [`scout-studio.md`](scout-studio.md) — the page→feed builder in depth.
- [`api.md`](api.md) / [`mcp.md`](mcp.md) — every path above is also reachable over REST and MCP (`suggest_page_feed`, `create_rsshub_feed`, `create_changedetection_feed`, `fetch_full_text`, …), useful for scripting these same smoke tests.
