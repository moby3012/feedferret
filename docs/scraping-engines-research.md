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

## Recommended staged path

1. **In-process headless render, opt-in per feed** *(M7 slot, effort ~M)* — promote Playwright+Chromium
   from devDependency to runtime dependency; a "render with headless browser before extract" toggle in
   the page→feed builder + full-text pipeline. Routed through the SSRF guard, hard timeout, concurrency
   cap, memory ceiling. **Fixes the JS-listing case (till-freitag) with zero new services** — off by
   default, minimal deployments unaffected.
2. **crawl4ai as optional M5 connector** *(effort S–M)* — admin-configured sidecar (base URL + API key,
   hidden if unconfigured), same UX as the planned RSSHub/changedetection.io connectors. Incremental
   anti-bot coverage without touching our image.
3. **BYOK hosted API opt-in** *(Model C)* — for genuinely Cloudflare-challenged sites: Jina Reader or
   Firecrawl **Cloud** with the user's own key, clearly labelled "content leaves your server". The only
   tier that reliably clears active challenges.

## Honest limits (do not overpromise)

- **Enterprise anti-bot** (Akamai/DataDome/Kasada) stays out of reach for all seven without paid solvers.
- **IP reputation ≥ fingerprint**: a VPS/Coolify IP is pre-scored suspicious by Cloudflare regardless of
  browser fingerprint quality; only residential proxies change that (paid, ToS grey area — not for us).
- **Moving target**: any "we handle Cloudflare" claim is probabilistic and can silently regress after
  the next vendor update. Frame hard targets (e.g. the XenForo forum HTML) as "sometimes works", never solved.
  (For XenForo specifically the clean answer remains its native RSS: `…/index.rss` works since #153.)
- CAPTCHAs and login/paywall content: different problem, out of scope.
