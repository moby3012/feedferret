# Heavy-Fetch Engines — Research (2026-07-17)

> Evaluation of 7 candidate tools for the two real failure cases blocking "convert
> anything into RSS": **(1) JS-rendered listing pages** (e.g. till-freitag.com/blog —
> the post list never appears in static HTML) and **(2) bot-protected pages**
> (e.g. xenforo.com/community behind an active Cloudflare challenge, HTTP 403).
> Evaluated against our architecture doctrine ([`feed-intelligence-plan.md`](feed-intelligence-plan.md) §4b):
> in-process by default → optional self-hosted sidecar connector → per-user BYOK hosted API.

## Verdict table

| Tool | What it is | Runtime | Solves JS render? | Solves Cloudflare? | Fit | Verdict |
|---|---|---|---|---|---|---|
| **Crawlee** (Apache-2.0, active) | Node/TS scraping framework wrapping Playwright | **Node — in-process!** | ✅ first-class | ❌ | M7, in-process | ✅ **Adopt (step 1)** — or just thin Playwright wrapper |
| **crawl4ai** (Apache-2.0, very active) | URL→clean-Markdown service, REST out of the box, single container | Python sidecar | ✅ | ⚠️ stealth mode, probabilistic | M5 connector | ✅ **Adopt (step 2)** — best sidecar of the group |
| **Scrapling** (BSD-3, very active) | Python scraping framework + stealth browser | Python sidecar | ✅ | ⚠️ claims Turnstile/interstitial | M5 alternative | ⏸ Redundant with crawl4ai — documented alternative, don't run both |
| **Firecrawl** (AGPL/open-core, very active) | Self-hostable scrape API + SaaS | 7-container stack | ✅ | ❌ **self-hosted** (anti-bot engine is cloud-only!) | M7 (was named there) | ⬇️ **Demote self-host** — 7 containers, ~12 CPU/RAM, and the actual anti-bot ("Fire-engine") is closed-source cloud-only. Cloud = step-3 BYOK option |
| **curl-impersonate** (MIT; original frozen 2024, fork active) | Browser-TLS-fingerprint curl build | C binary | ❌ | ⚠️ passive TLS only, no JS challenges | ingredient | ❌ Skip directly — already embedded inside the tools above |
| **autoscraper** (MIT, unmaintained since 2022) | Learn-by-example static-HTML extractor | Python | ❌ | ❌ | — | ❌ Skip — our own M3 Scout Studio already does this better, in Node |
| **browser-use** (MIT, very active) | LLM agent drives a live browser step-by-step | Python + LLM per step | ✅ technically | ⚠️ sometimes | — | ❌ Skip — wrong shape (interactive one-off tasks, per-fetch LLM cost; violates our "no AI on the fetch hot path" rule) |

Key insight: Scrapling, crawl4ai and Firecrawl all solve the **same** "URL in → rendered clean content out"
problem — pick **one** (crawl4ai: REST-native, single container, permissive license, honest docs), don't layer three.
Crawlee is the odd one out in a good way: the only **in-process Node** option.

## Staged path — DECIDED 2026-07-18 (maintainer)

Revised after implementation experience (T0 shipped; Wired proved much "JS-only" content is
actually embedded in the page's HTML/JSON). Ordered by cost/risk, lean default image preserved:

0. **T0 — `impit` browser-fingerprint HTTP** ✅ shipped (#160). Soft anti-bot, no browser.
1. **Embedded-data extraction (in-process, no Docker impact)** — *in progress*. Many "JS-rendered" pages
   still ship their content in the HTML: `__NEXT_DATA__`, `<script type="application/json">` blobs,
   JSON-LD lists. Extract those for article full-text AND listing→feed. Covers a real slice of
   "JS" sites with **zero new services** (Wired's body lived in JSON-LD — same class of fix). Two
   pieces **shipped**: JSON-LD `articleBody` recovery (#162) and the **ftr-site-config importer**
   below. `__NEXT_DATA__` listing→feed extraction deferred (no confirmed target).
   - ✅ **ftr-site-config importer** *(shipped)* — a bundled subset of FiveFilters
     [`ftr-site-config`](https://github.com/fivefilters/ftr-site-config) (CC0/public-domain), the
     1,000+-site community ruleset. We compile a **curated 44-host subset** (major EN + DE outlets)
     into a generated TS module (`lib/ftr-site-configs.ts`) — no runtime fs/network/Docker impact —
     and a ~200-line parser+applier (`lib/ftr-site-config.ts`) runs the `body/title/author/date/
     strip/strip_id_or_class` XPath rules in-process (jsdom `document.evaluate`) as the **first
     extraction tier** ahead of Defuddle/Readability. `FEEDFERRET_DISABLE_FTR=1` kill-switch;
     regenerate/extend via `scripts/gen-ftr-site-configs.mjs`. This is the "dataset-import, not a
     dependency" project flagged in round 2 below, delivered at effort **S–M**.
2. **Sidecar browser connector (Option 3)** — for *genuinely* client-only pages that step 1 can't
   reach: an **optional** admin-configured container (crawl4ai / a lean Playwright service), called
   over HTTP (base URL + key, hidden if unconfigured — the RSSHub/changedetection.io connector
   pattern). Keeps the **default image untouched** and **isolates the browser** (a render crash/OOM
   stays in the sidecar, not the reader). Chosen over an in-process browser (which would add
   ~400–500 MB Chromium to *every* deployment and run the browser in the reader's own container).
3. **BYOK hosted API opt-in** *(Model C)* — for actively Cloudflare-challenged sites: Jina Reader or
   Firecrawl **Cloud** with the user's own key, labelled "content leaves your server". The only tier
   that reliably clears active challenges.

> **Rejected: in-process headless render in the default image.** Bloats every self-hosted image with
> Chromium (~400–500 MB) even for users who never render JS, and runs an untrusted-page browser inside
> the reader's container. The sidecar (step 2) delivers the same capability opt-in, isolated, and lean.

## Honest limits (do not overpromise)

- **Enterprise anti-bot** (Akamai/DataDome/Kasada) stays out of reach for all seven without paid solvers.
- **IP reputation ≥ fingerprint**: a VPS/Coolify IP is pre-scored suspicious by Cloudflare regardless of
  browser fingerprint quality; only residential proxies change that (paid, ToS grey area — not for us).
- **Moving target**: any "we handle Cloudflare" claim is probabilistic and can silently regress after
  the next vendor update. Frame hard targets (e.g. the XenForo forum HTML) as "sometimes works", never solved.
  (For XenForo specifically the clean answer remains its native RSS: `…/index.rss` works since #153.)
- CAPTCHAs and login/paywall content: different problem, out of scope.

---

# Round 2 — Node/npm-native candidates (2026-07-18)

Round 1 was framework/service-heavy. This round hunts **in-process Node** wins (our preferred tier)
plus complementary prior-art. Verdicts below; full reasoning in commit history.

## New verdicts

| Tool | What / runtime | Solves | Verdict |
|---|---|---|---|
| **`impit`** (`impit-node`, Apache-2.0, active) | Rust-core HTTP client w/ **real Chrome/Firefox TLS+HTTP2 fingerprints**, Node bindings, fetch-like API | Soft anti-bot (TLS/WAF fingerprinting); some "JS-looking" pages that are really just soft-blocked | ✅ **Adopt — new Tier 0.** In-process, drop-in behind `lib/ssrf.ts`. Our fetch path has **zero** impersonation today. Effort **S** |
| **`header-generator`** (Apify, Apache-2.0, active) | Statistically-consistent header sets (Sec-CH-UA etc.) | pairs with impit + future Playwright | ✅ **Bundle with impit.** Effort **S** |
| **`got-scraping`** (Apify) | predecessor of impit | — | ❌ **EOL** — maintainers redirect to impit |
| **`rebrowser-playwright`** (active, MIT-ish) | Playwright fork patching the CDP `Runtime.enable` leak Cloudflare/DataDome key off | hardens the browser tier | ✅ **Use instead of vanilla Playwright when M7-T1 ships** — near-zero-cost import swap. Effort **S** |
| **`puppeteer-extra-plugin-stealth`** | classic stealth plugin | — | ❌ **Dead** (no release since 2023; fails modern JA4/CH-UA/CDP signals). Do not adopt — false confidence |
| **`@extractus/article-extractor`** (MIT, active) | linkedom+sanitize-html extraction, different heuristic than Readability | thin-extraction edge cases | ⏸ Possible **third-tier extraction fallback** after Defuddle→Readability. Effort **S**, value **S** |
| **`@postlight/parser`** (Mercury) | per-site extractors | — | ❌ Stale since 2022; its per-site idea is better served by ftr-site-config below |
| **`@extractus/feed-extractor`** / **`article-parser`** / **`node-unfluff`** | — | — | ❌ Redundant with our `rss-parser`/Defuddle, or unmaintained |
| **`feed`** (jpmonette, MIT, active) | RSS/Atom/JSON-Feed **generator** | — | ⏸ We hand-roll feed/OPML XML today (`lib/opml.ts`) — **audit that serializer** for namespace/CDATA edge cases before deciding to add. Effort **S** |

## Prior-art "anything → RSS" (reference / interop only — do not port)

- **`rss-bridge`** (PHP, ~447 site-specific bridges, public-domain) — **best reference for site-rule design** + plausible interop target (consume its Atom output like the planned RSSHub connector).
- **`rss-proxy`** (TypeScript, GPLv3) — heuristics close to our own `page-feed-suggest.ts`; author moved advanced features to a successor ("feedless"). Compare heuristics, don't adopt.
- **`morss`** (Python) — single-file version of what our Defuddle/Readability + page-feed already do. Skip.
- **Five Filters `ftr-site-config`** — **1,000+ community-maintained per-site extraction rules**, healthy repo, but **no Node parser exists**. The format is a simple key:value text — a ~100-line parser + ingest job would import 1,000+ pre-solved sites as a fallback ruleset. **Effort M, value M — a dataset-import project, not a dependency.**

## Round-2 synthesis

**Top in-process wins to `npm install` now:** ① **impit** (+ **header-generator**) — the cheap "Tier 0" anti-bot layer round 1 lacked a Node option for. ② **rebrowser-playwright** — held for M7-T1 (swap for vanilla Playwright, avoids a known-exploited CDP leak). ③ (optional) **article-extractor** as a third extraction fallback.

**Cloudflare verdict unchanged:** impit + rebrowser raise the ceiling on *soft* anti-bot (TLS fingerprints, CDP tells) but **neither solves active JS challenges or IP reputation** — the XenForo-class case still needs the sidecar (crawl4ai) or BYOK tier. Tier 0/1 just shrink how many sites land in that bucket.

**Revised M7 tiering:**
- **Tier 0** *(new, cheap, in-process, effort S)* — wrap outbound fetch with **impit + header-generator** for non-render requests. Pure upside: no browser, no new service, still through the SSRF guard; closes soft-bot gaps today misdiagnosed as "needs a browser."
- **Tier 1** *(= M7-T1)* — in-process headless render for genuinely JS-rendered pages, built on **rebrowser-playwright** (not vanilla Playwright / dead stealth plugins).
- **Tier 2/3** *(unchanged)* — optional crawl4ai sidecar, then BYOK hosted API for active-challenge sites.
