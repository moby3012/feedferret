# Changelog

All notable changes to FeedFerret are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

Work merged since v1.1.1 (PRs #88–#150), targeting the next release.

### Added (2026-07-20 — M6: per-article AI extraction fallback)

- **"AI extraction" full-text mode, a new opt-in 4th option per feed** (Settings → feed → Full Text tab, alongside off/automatic/custom-selector, only offered once an AI provider is configured) — when the free deterministic extraction tiers (bundled per-site rules, Defuddle, Readability, `@extractus/article-extractor`, JSON-LD recovery) all come up empty on a page whose structure trips up every one of them, the same already-fetched HTML is sent to the feed's configured BYOK model to pull out the clean article body directly, in strict JSON (`lib/ai-extraction.ts`). Runs before the (slower, whole-page-refetching) render sidecar tier, since it's a smarter *parser* fallback rather than a JS-rendering one. Guardrails: opt-in per feed (never runs unless explicitly switched on), the page HTML sent to the model is size-capped, and at most 5 articles per sync batch go through this tier (a feed's initial backfill can't blow through a user's API budget in one tick) — articles beyond the cap still get the free tiers, just not this one.

### Added (2026-07-20 — AI auto-tagging, OPML serializer hardening)

- **AI auto-tagging of new articles (F8)** — a new opt-in "Auto-tag on sync" toggle (Settings → AI, next to auto-summarize) asks the user's configured AI provider to propose up to 4 short topical tags per newly-synced article. Rather than a new tag concept, it reuses the existing user-facing Label/ArticleLabel schema: AI-proposed tags become real Labels, so they show up for free in the existing label badges, the article-reader's label dropdown, and the sidebar's "Label:" filter — no new UI needed. The prompt is nudged to reuse the user's existing label names before minting a near-duplicate (e.g. "AI" vs "Artificial Intelligence"). A new `Article.aiTaggedAt` marks processed articles so a small per-sync cap (mirroring the existing auto-summarize cap) doesn't mean older articles are silently never reached.
- **OPML serializer hardened against a real control-character bug** — audited `lib/opml.ts`'s hand-written XML serializer (considered adopting the `feed` npm package instead; decided not to — see `docs/scraping-engines-research.md`). XML 1.0 forbids most C0 control characters outright — unlike `<`/`&`, escaping doesn't make them legal — and malformed RSS/Atom feed metadata occasionally carries one (a stray NUL or vertical-tab byte in a title). Previously, a single such feed made `generateOpml()` emit a document that our own `parseOpml()` (JSDOM, strict XML mode) throws a hard `SyntaxError` on, poisoning the whole exported file for every other feed too. `escapeXml()` now strips these characters instead of passing them through.

### Added (2026-07-20 — 4th extraction tier + M2 full-text-polish)

- **`@extractus/article-extractor` as a 4th extraction tier** (`lib/readability-extract.ts`) — inserted after Defuddle and Readability, before the JSON-LD `articleBody` recovery step: it uses a different (unfluff-derived) content-scoring heuristic than either, occasionally succeeding on pages where both fail. Only runs when the earlier tiers came back empty/too-thin; never throws, same as every other tier in the waterfall. `ExtractionResult.extractedBy` gained `"extractus"` for observability.
- **M2 full-text-polish, closing out `docs/feed-intelligence-roadmap.md`'s M2 milestone**: GFM tables and inline images were confirmed already working natively (no plugin needed); newly added were GFM task-list checkboxes (`markdown-it-task-lists`, real `<table>`/checkbox markup instead of literal `[x]` text), fenced-code syntax highlighting (`highlight.js`, a single dark theme — Tailwind Typography already gives code blocks a fixed dark background in both site themes), server-rendered KaTeX math (`@vscode/markdown-it-katex`, no client-side JS needed to display formulas), and `loading="lazy"` on markdown-rendered images. Found and fixed a real bug along the way: the shared sanitizer's width-stripping hook (added for untrusted scraped-page styles) was also stripping KaTeX's own layout-critical inline widths, breaking math alignment — `lib/sanitize-html.ts` now exempts width/min-width (but not color) stripping for anything inside a `.katex` subtree, since that markup is our own server output, not attacker-controlled.

### Fixed (2026-07-20 — visual/a11y and polish findings from the 2026-07-19 audit)

- **Logo invisible on light-mode auth pages** — `logo.svg` is a solid-white mark with no dark variant, sitting on a `bg-card` badge that's near-white in light mode. Login, register, and setup pages now use `bg-accent` for that badge, which stays a real color in both themes.
- **Manage Feeds looked empty for users with no categories** — every feed group (including "Uncategorized") started collapsed; a separate effect auto-expanded them, but only when `categories.length > 0` — so a user with zero categories, whose only group IS "Uncategorized", never got it, and the tab looked empty rather than "click to expand". Fixed the effect's condition.
- **Hardcoded blue/amber tutorial-banner colors with poor contrast** (`components/feed-management.tsx`, Rules & Alerts tabs) — the `-400` shades read fine on a dark background but have poor contrast on a light one. Added the light-mode `-700` variant, matching the pattern already used for the AI/content-fetch privacy warnings elsewhere in settings.
- **Unlabeled icon-only sidebar buttons** (Manage Feeds, Server Settings, Notifications, Sign-out) — each only had a visual hover tooltip, with no `aria-label`, so screen-reader and keyboard-only users had no accessible name for them at all. Added one to each, reusing the same tooltip text.
- **"Unknown"/"Unbekannt" author noise** — articles without author metadata got a literal placeholder baked into `article.author` at fetch time, shown unconditionally everywhere. Left it empty instead and hide the author (and its separator) entirely when there isn't one — many feeds simply don't provide this field, and showing "Unknown" on every one of their articles was pure noise.
- **Unauthenticated-page server-error noise** — `components/theme-color-applier.tsx` is mounted globally in the root layout, so it also rendered (and queried `getReadingPreferences`, which requires a session) on public pages like `/login`. Gated the query on `useSession()`'s status.
- **Missing Cmd/Ctrl+K row in the keyboard-shortcuts dialog and settings-page summary** — the command palette shortcut existed but was undocumented in both places it's listed. Added it.
- **Google favicon-fallback privacy** — the fallback for feeds/articles without their own icon fetches `google.com/s2/favicons`, leaking the viewing page's URL as a referrer on every request. Added `referrerPolicy="no-referrer"` to all three call sites (the domain being looked up still necessarily goes to Google — that's inherent to using the service — but the referring page no longer does).

### Fixed (2026-07-20 — UX-flow bugs from the 2026-07-19 audit)

- **"Test connection" tested stale saved settings, not the current form** — reported directly: the AI-summary and content-fetch "Test connection" buttons (`app/actions/settings.ts`) read provider/API key/model straight from the database, ignoring whatever the user had just typed into the form. It only "worked" once you clicked Save first, which is exactly backwards from what the button implies. Both server actions now accept optional overrides (provider, API key, model, base URL) that the form passes from its current, possibly-unsaved state, falling back to the saved values only for fields left untouched.
- **Test-connection error messages were English-only regardless of locale** — same two actions built their friendly error strings (invalid API key, rate limited, etc.) as hardcoded English literals. Now localized via `next-intl/server`'s `getTranslations`, using the user's own `uiLanguage`.
- **Mobile `/?addFeed=1` deep link did nothing** — `app/page.tsx`'s deep-link handler incremented a counter meant to open the add-feed flow inside the sidebar, but on mobile the sidebar only mounts inside a `Sheet` gated by a separate `sidebarOpen` state that this handler never touched — so the sheet stayed closed and the deep link was silently inert. Now also opens the sheet.
- **Email digest section vanished with no explanation when SMTP isn't configured** — `components/settings-form.tsx`'s `DigestSection` returned `null` outright, giving a user no way to tell "not available on this instance" apart from "failed to load". Now shows the section's title and a short explanation (with a pointer to Server Settings → Email) instead of disappearing.
- **No self-service password-change flow** — there was no way to change an email/password account's password anywhere in the app. Added a `changePassword` server action (verifies the current password, matches the same 8-character minimum as registration, bumps `sessionVersion` to invalidate other sessions — mirroring the existing 2FA actions' pattern) and a new "Change password" section in Settings → Account.

### Fixed (2026-07-20 — i18n/locale gaps from the 2026-07-19 audit)

- **Header title showed raw internal sentinel values untranslated** — `app/page.tsx`'s `headerTitle` fell through to `selectedCategory` verbatim for the built-in views (All Articles / Starred / Read Later / Spoiler), which are also used internally as sidebar `categoryId`s — so a German UI would show "All" or "Read Later" in English in the list header even though the sidebar itself already translates the same values correctly. Real user-created category names still pass through untouched.
- **Hardcoded "unread" in the list header** (`components/rss-header.tsx`) — now translated, matching the same fix already applied to the sidebar's unread count.
- **Non-localized date format in the article list** (`components/article-list.tsx`) — a hand-rolled `formatDate` always rendered `DD.MM - HH:MM` regardless of locale. Replaced with `next-intl`'s `useFormatter().dateTime`, consistent with the reader and everywhere else dates are shown.
- **Reading time never translated** — `reading-time` (npm package) always renders English text ("4 min read") baked directly into `article.readTime`; that string got stored and displayed as-is regardless of locale. `readTime` is now a plain number (minutes) computed in `app/page.tsx`, formatted at display time via a proper ICU message in `components/article-reader.tsx`.
- **"dup" badge literal and a broken singular/plural translation call** (`components/article-list.tsx`) — the duplicate-article badge's visible text was the hardcoded English word "dup"; separately, its tooltip called a `t("otherFeed")` key that was never defined (the actual key, `otherFeeds`, already handles singular/plural via ICU) — so the singular case (exactly one other feed) rendered a missing-message fallback. Both fixed.
- **Retention line concatenated three independently-translated fragments in a fixed English word order** (`components/feed-management.tsx`, feed health tab) — `"Retention:" + count + "days"` can't adapt to other languages' word order or grammar, and always said "X days" even for `1` (no singular). Replaced with a single ICU plural message per locale.
- **Server Settings dialog's subtitle duplicated its own title** — a copy-paste bug (`t("title")` used for both `title` and `description`) meant the dialog showed "Server Settings" twice instead of an actual description. Added a real description string.
- **Hardcoded "New starter pack" default name** (`components/server-management-dialog.tsx`) — now translated.
- **`Accept-Language` ignored entirely for anonymous visitors** (`i18n/request.ts`) — locale was only ever read from a cookie that's exclusively set by a logged-in user explicitly picking a UI language; a first-time visitor on `/login`, `/register`, or `/setup` always saw English regardless of their browser's language. Now falls back to parsing `Accept-Language` (respecting `q` weights) before defaulting to English.
- **Hardcoded "Close" aria-label** on the PWA install prompt's dismiss button — now translated.

### Fixed (2026-07-20 — dark-mode prose, service worker install, unreachable alerts tab)

- **Dark-mode article text rendering near-black** — traced to source-page inline `style="color: ..."`/`background`/`background-color` declarations surviving sanitization: they beat our prose/dark-mode CSS on specificity every time (an inline style always outranks a class), so a source page's dark-gray-on-white text renders as near-black-on-dark in our reader's dark mode. `lib/sanitize-html.ts`'s existing DOMPurify hook (already used to strip layout-breaking `width`/`min-width`) now also strips `color`, `background`, and `background-color` from inline styles, letting our own theme-aware prose styling handle text color entirely.
- **Service worker never installing, for any user** — `public/sw.js`'s install handler calls `cache.addAll()` on a fixed list of URLs to precache; per spec this is all-or-nothing, so a single 404 anywhere in the list fails the *entire* install. Two of the nine listed files (`/screenshots/mobile-narrow.svg`, `/screenshots/desktop-wide.svg`) don't exist — the actual PWA screenshot files use different names (`feedlist-mobile-light-393x852.png`, `hero-desktop-light-1440x900.png`, matching `manifest.json`) — and screenshots aren't served through the SW's fetch handler anyway (browsers fetch them directly for the install-prompt UI). Removed both from the precache list.
- **Keyword-alerts management UI unreachable** — the "alerts" tab was dropped from `components/feed-management.tsx`'s tab bar when keyword alerts started being migrated into the newer auto-read-rules system (there's a "Rules & Alerts" tab with a migration banner and a "Migrate to Rules" button), but the full alerts management UI (create/edit/delete/test existing alerts) was left in the code with no way to reach it — dead once the tab trigger disappeared. Users with existing alerts who haven't migrated yet (or want to review them first) had no way in. The tab now reappears whenever `keywordAlerts.length > 0`, and goes away on its own once a user has migrated everything.

### Fixed (2026-07-19 — reader content still overflowing on some feeds)

- **Reader panel could still overflow horizontally after the earlier header fix** — 2026-07-19's header `min-w-0` fix (below, "sidebar close/search overlap...") turned out to be one instance of a wider pattern: the AI-summary card's label/button row (`components/article-reader.tsx`) had the same missing `min-w-0` on its flex children, so on articles where it rendered tight it would overflow its own row and get hard-clipped by an ancestor's `overflow-hidden` instead of truncating gracefully — visually indistinguishable from "the reader is broken" even though the fix from a few commits ago was working correctly on the header itself. Gave the row the same `min-w-0`/`shrink-0`/`truncate` treatment as the header. Also added `overflow-x: hidden` to `html`/`body` (`app/globals.css`) as a last-resort net: any future flex/truncate chain that's missed can no longer widen the whole document and shift what's visible on screen, only get clipped in place — a much cheaper failure mode to debug from a bug report than "some element somewhere is cut off".
- **Still overflowing on iPhone Safari specifically after the above** — confirmed via a headless-Chromium repro of the exact reader markup that it renders correctly there, pointing at a WebKit-specific issue instead. Two changes: (1) dropped `text-balance` from the article `<h1>` — Safari has shipped `text-wrap: balance` with real interop bugs where it stops respecting `overflow-wrap` on long headlines, letting them overflow instead of wrapping, which isn't worth the purely cosmetic line-balancing; (2) added `overflow-hidden` directly on the sticky header's feed-name button (in addition to its existing `min-w-0`), since WebKit's flex-shrink handling of native `<button>` elements is less reliable than plain `div`s at computing the intrinsic minimum size `min-w-0` is supposed to override.
- **Still overflowing after both of the above — found the actual shared root cause** — every previous round fixed a real but *local* issue (one row, one button) while multiple, already-individually-protected elements (header, headline, AI-summary card) kept overflowing together at the exact same edge — the signature of one shared ancestor leaking, not several unrelated bugs. `ArticleReader`'s own root `<div>` (`components/article-reader.tsx`) is a flex item in its parent's row (the fixed mobile reader panel in `app/page.tsx`, and the desktop split view) but never had `min-w-0`. Per spec, an `overflow: hidden` descendant's intrinsic size shouldn't propagate past it into this calculation at all — which is exactly why this never reproduced in Chromium — but Safari has known interoperability bugs in this exact area of flexbox intrinsic sizing, letting oversized content deep in the tree inflate this outer box regardless of what `overflow-hidden`/`min-w-0` protections exist further down. Added `min-w-0` here — the correct architectural fix one level up, not another per-element patch.
- **Confirmed on a second, unrelated feed (Formel1.de) and found two more instances** — same signature (multiple already-protected elements cut at once) reported on a different feed, ruling out anything content-specific. Added `contain: layout` (belt-and-suspenders on top of `min-w-0`, same guarantee already used on `.article-content`) to `ArticleReader`'s root and its sticky header, making their own size fully independent of their content regardless of engine-specific sizing bugs. Also found and fixed a genuinely new, distinct bug in the same family: the mobile bottom toolbar's 6-button row (`components/article-reader.tsx`) had no `min-w-0` on its buttons and no `overflow-hidden` on its pill container — the unread-toggle button is wider than the rest (the one icon button without `size="icon"`'s fixed square), and when the row didn't fit, the last button (next-article) visibly escaped past the pill's rounded edge onto the raw screen edge instead of clipping into it.

### Added (2026-07-19 — truncated-feed detection)

- **"This feed looks truncated" suggestion after a manual full-text fetch** — some feeds (WordPress's "Summary" feed mode, common on sites that want readers to click through — e.g. Caschys Blog / stadt-bremerhaven.de) deliberately ship only a short teaser, with the real article living on the linked page. Rather than guess this from link/teaser text patterns, `lib/full-text-mode.ts`'s new `looksLikeTruncatedFeed` detects it empirically: a manual "Fetch full text" that lands dramatically more content than the feed itself provided (existing content under 800 chars, new content ≥2.5× longer and ≥1200 chars) is a strong, reliable signal. `fetchFullText` (`app/actions/feeds.ts`) surfaces this as a `suggestAutoFullText` field on its return value when the feed's full-text mode is still "off"; the reader shows an actionable toast ("Enable" → sets `Feed.fullTextMode = "auto"`, "Don't ask again" → sets the new `Feed.fullTextAutoSuggestDismissed` flag) via `useFetchFullText` (`hooks/use-rss-data.ts`). Works retroactively for any feed added before this shipped, triggered exactly when the user first notices via their own manual fetch — no separate add-time heuristic needed.

### Added (2026-07-19 — Firecrawl keyless free tier)

- **Firecrawl's BYOK connector now works without an API key** — Firecrawl recently launched a free, no-signup "keyless" tier for its `/v1/scrape` endpoint (verified directly against the live API: a plain request with no `Authorization` header succeeds), rate-limited per server IP per day rather than per user. Selecting Firecrawl in Settings → Integrations → Full-Text Fetch Fallback with the API key field left blank now opts into this tier — a good way to try the feature, and to gauge whether it's worth a paid Firecrawl key, before committing to one. Since the daily cap is shared across every user on a self-hosted instance (they all share one outbound IP), hitting it surfaces a specific, actionable message — both from the settings "Test connection" button and from a real "Fetch full text" click — pointing at adding a real API key instead of a generic failure. Jina Reader is unaffected (still requires a key).

### Removed (2026-07-19)

- **Article reader's Markdown source-view toggle** — the desktop toolbar button that switched between the rendered article and its raw Markdown source (`turndown`-derived for HTML-format articles). The "Copy as Markdown" action it was originally paired with was already removed on 2026-07-18; this removes the remaining toggle + source view for a simpler reader toolbar.

### Added (2026-07-19 — M7-T3: BYOK hosted-fetch connector)

- **Full-text fetch fallback via Jina Reader / Firecrawl Cloud (BYOK)** — the final "heavy fetch" tier: for pages that beat even the browser-render sidecar (an active anti-bot challenge), a user can now bring their own API key for a commercial "URL to clean content" service. Per-user (unlike the admin-global render sidecar), strictly opt-in, and clearly labelled: content is sent to a third party, which every other extraction tier avoids. `lib/hosted-fetch.ts` implements both providers (Jina's `r.jina.ai` reader endpoint, Firecrawl Cloud's `/v1/scrape`), each returning clean Markdown rendered to sanitized HTML via the existing Markdown pipeline. Wired into `fetchAndExtractReadable` as the last fallback, after the in-process and sidecar tiers both come up empty.
  - Manual **"Fetch full text"** always tries it when configured (a deliberate, single, user-initiated action).
  - **Automatic background sync** only uses it when the user explicitly enables **"Also use during automatic sync"** — otherwise a silent per-article cost/privacy surprise.
  - New Settings → Integrations section ("Full-Text Fetch Fallback (BYOK)"), mirroring the existing AI-summary BYOK UX: provider select, encrypted API key, a privacy-warning callout, and a **Test connection** button. `FEEDFERRET_DISABLE_HOSTED_FETCH=1` kill-switch.
  - Honest limits: even these commercial services cannot guarantee success against every active challenge — never advertised as "always works".

### Fixed (2026-07-19)

- **Sidecar-rendered full text could break the reader's layout** — the first real M7-T2 sidecar success (formel1.de, via a real headless-Chromium render) exposed a gap the earlier `<style>`-block/inline-`style` hardening didn't cover: a browser-rendered page's DOM can carry a `position: fixed`/`sticky`/`absolute` element (common in lightbox/sticky-image widgets), which escapes a plain `overflow: hidden` ancestor entirely — those position relative to the viewport (or the nearest positioned ancestor), not any ancestor with `overflow: hidden`, so it isn't clipped. `lib/sanitize-html.ts`'s style-cleaning hook (used by every article-HTML sanitize call) now also drops `position: fixed|sticky|absolute` declarations (keeping `relative`/`static`, which stay in normal flow and are harmless); `.article-content` also gains `contain: layout`, making it the containing block for any such element that still slips through, so it's confined and clipped there instead of breaking out to the viewport. Verified with a Playwright repro: without the fix a `position: fixed` test element escaped its container entirely; with it, it stayed correctly contained.

### Changed (2026-07-19)

- **Render sidecar reads `SIDECAR_PORT`, not `PORT`** — a real Coolify deploy surfaced the cause behind the sidecar being unreachable at its documented port: some deploy platforms (Coolify included) inject environment variables at the project/resource level across *every* service in a Docker Compose stack, not scoped per-service. FeedFerret's own required `PORT` variable was landing on the `render-sidecar` container too, making it listen on the app's port instead of 8080 — so the Sidecar URL (`:8080`) found nothing there. `docker/render-sidecar/server.mjs` now reads `SIDECAR_PORT` (a name nothing else defines), pinned explicitly to `8080` in both `docker-compose.yaml` and the standalone `docker-compose.example.yml`.

- **Render sidecar "Test" button now reports the actual failure reason** — previously any failure (token mismatch, unreachable host, the sidecar responding with an error, an unexpected response shape) collapsed into one generic "Sidecar returned no usable HTML for the test URL" message, making misconfiguration undiagnosable from the admin UI alone. `lib/render-sidecar.ts` gains `renderWithConfigDetailed`, which surfaces the specific cause (HTTP status + the sidecar's own error body, a distinguishable network-error vs. timeout message, or the response's content-type when it parsed but had no usable `html`/`content` field); `testRenderSidecar` now returns that reason directly. The best-effort fallback path (`renderWithConfig`/`renderViaSidecar`, used during real extraction) is unchanged — still resilient, still returns `null` on any failure, never throws.

- **Browser-render sidecar wired up by default in `docker-compose.yaml`** — the repo's top-level compose file now includes the `render-sidecar` service (built from `docker/render-sidecar/`) and points `feedferret` at it via `FEEDFERRET_RENDER_SIDECAR_URL=http://render-sidecar:8080/`, sharing one `RENDER_SIDECAR_TOKEN` between both services. A fresh `docker compose up -d` — or a Coolify deploy of this repo — now gets a working sidecar with no admin-UI step required; only `RENDER_SIDECAR_TOKEN` needs changing from its `change-me` default before a public deploy. No hard startup dependency between the two services: `feedferret` starts and works fully even if the sidecar is still building or unavailable (every call site already falls back gracefully). Remove the service + the `FEEDFERRET_RENDER_SIDECAR_URL` line to opt back out. See [`docs/render-sidecar.md`](docs/render-sidecar.md#setup) for how the ENV wiring interacts with the admin-UI toggle (ENV wins, by design).

### Added (2026-07-18 — Feed Intelligence M7-T0/T1/T2: extraction robustness)

- **Optional browser-render sidecar** (M7-T2) — for genuinely client-only pages (the article/list is drawn by JS and never appears in the static HTML), FeedFerret can now call out to an **admin-configured** external render service and use the returned HTML as a **fallback** — only when the in-process path returns nothing — on both full-text extraction and the "Create feed from a web page" builder. `lib/render-sidecar.ts` POSTs `{ "url": … }` and accepts `text/html` or a JSON envelope (`html`/`content`/`cleaned_html`/`markdown`, incl. crawl4ai's `results[0]`), so a self-hosted **crawl4ai** or a ~30-line Playwright service both work. Configure in **Server Management → Sync** (URL + encrypted bearer token + Test button, plus an in-app **copy-paste Docker Compose setup guide**) or via `FEEDFERRET_RENDER_SIDECAR_URL`/`_TOKEN`; `FEEDFERRET_DISABLE_RENDER_SIDECAR=1` kill-switch. A ready-to-run reference sidecar ships under [`docker/render-sidecar/`](docker/render-sidecar/) (Dockerfile + tiny Playwright service + example compose). The default image stays untouched (no bundled Chromium) and the browser is isolated in the sidecar. The rendered target URL is still SSRF-validated, so the sidecar is not an SSRF bypass. See [`docs/render-sidecar.md`](docs/render-sidecar.md).
- **Per-site extraction rules (ftr-site-config importer)** — full-text extraction now applies a bundled subset of FiveFilters [`ftr-site-config`](https://github.com/fivefilters/ftr-site-config) (CC0/public domain) rules **before** the generic Defuddle/Readability heuristics. `lib/ftr-site-config.ts` parses the `body`/`title`/`author`/`date`/`strip`/`strip_id_or_class` XPath directives and applies them in-process (jsdom `document.evaluate`) as the first extraction tier (`extractedBy: "ftr"`), falling through to the generic path when no rule matches or a rule yields too little. Ships a curated 44-host set (major EN + DE outlets) compiled into `lib/ftr-site-configs.ts` — **no runtime fs/network/Docker impact**; regenerate/extend with `scripts/gen-ftr-site-configs.mjs`. `FEEDFERRET_DISABLE_FTR=1` kill-switch.
- **Browser-fingerprint page fetches** (PR #160, M7-T0) — the page-fetch paths (page→feed builder, AI config, manual full-text) now use the `impit` HTTP client for real Chrome TLS/HTTP2 fingerprints, still routed through `lib/ssrf.ts` with per-hop redirect re-validation. Routine feed-XML sync is unchanged. `FEEDFERRET_DISABLE_IMPIT=1` kill-switch + graceful fallback if the native binary is absent.
- **JSON-LD full-text recovery** (PR #162) — when the visible DOM is a thin teaser (paywalled/truncated), the extractor recovers the full body from schema.org `articleBody` structured data.

### Removed (2026-07-18)

- **"Copy as Markdown" article action** — the reader toolbar button and overflow-menu item (and their `turndown`-backed copy handler) were removed to trim reader UI. The Markdown **source-view toggle** is unaffected.

### Fixed (2026-07-18)

- **Full-text extraction crash on modern CSS** (PR #162) — jsdom's CSS engine threw on `border: var(--border-width, …)` shorthands, aborting extraction on Wired and similar sites (and surfacing as a "border-width" error in feed-sync logs). `<style>` blocks are now stripped before parsing across the extraction, page→feed and XPath paths.
- **Mobile add-feed input focus on iOS** (PR #161) — the add-feed sheet's inputs could not be focused (no cursor/keyboard) on iOS Safari; the mobile sidebar/add-feed drawer was reimplemented on Radix `Sheet` instead of vaul, restoring focus.
- **Feed sync crash on XenForo/null-prototype category objects** — `Cannot convert object to primitive value` from xml2js `{_, $}` category nodes is handled by reading the text member explicitly.
- **Full-text fetch crash ("An error occurred in the Server Components render")** — two gaps in the M7-T2 extraction path could crash the whole request instead of degrading gracefully: (1) `getRenderSidecarConfig()` queried the new `renderSidecar*` `GlobalSettings` columns on every full-text/page→feed fetch with no error handling, so a deployment that hadn't yet applied that migration threw on every single extraction, sidecar configured or not; (2) the final sanitize/Markdown-conversion step in `extractReadableContent` had no crash guard (every earlier stage — ftr, Defuddle, Readability, JSON-LD — already does), so a page whose extracted content trips jsdom's CSS engine in a novel way (the same class of bug as the earlier Wired `border-width` crash, but via an inline `style="…"` attribute rather than a `<style>` block) could still bring down the request. Both now degrade gracefully (config resolution falls back to "no sidecar"; sanitizing retries once with inline styles stripped, then falls back to a clean "no content extracted" result) instead of throwing.
- **Full-text fetch crash on a live anti-bot connection reset** — a real production case (formel1.de) surfaced a third gap in the same crash class: `impit`'s Rust core rejects with a native (non-`Error`) object when a site's anti-bot layer resets the HTTP/2 connection mid-request, and that native rejection propagated uncaught through the `fetchFullText` Server Action instead of a normal, catchable failure. `lib/impit-fetch.ts` now normalizes every impit rejection into a clean, short `Error`, and `fetchFullText` catches any extraction-fetch failure and runs it through the same `describePageFetchError` helper `suggestFeedFromUrl` already uses (a status-aware message for a blocked/rate-limited/missing page, or a clean generic "Could not read that page" otherwise) instead of letting it escape as an opaque crash.

### Added (2026-07-17 — Feed Intelligence M1/M3/M4 + Phase 0 + a11y CI)

- **Automatic full-text extraction** (PR #141, M1 slice 1) — `lib/readability-extract.ts` runs **Defuddle** (primary) with a **Mozilla Readability** fallback on the existing SSRF-safe fetch/JSDOM pipeline; falls back to the feed's own summary if both fail.
- **Selectable content format** (PR #142, M1 slice 2) — new `Feed.fullTextMode` (`off`/`auto`/`selector`) and `Feed.defaultContentFormat`/`Article.contentFormat` (`html`/`markdown`). "Auto" mode wires the new extractor into the existing sync path; manual per-article "fetch full text" keeps working unchanged; already-configured selector feeds migrate to `"selector"` mode with no behavior change.
- **Markdown reader rendering** (PR #143, M1 slice 3) — `markdown-it` → DOMPurify → the existing `.article-content` prose styles; a reader toolbar toggle switches a Markdown article between rendered view and raw source. Feed Settings gained "Full text: Off / Automatic / Custom selector" + "Preferred format: Markdown / HTML" controls (i18n en/de).
- **"Create feed from a web page" builder** (PRs #145–#147, M3) — paste a listing-page URL (blog index, forum, search results) and FeedFerret proposes ranked, engine-validated candidate item/field selectors (`lib/page-feed-suggest.ts`); accepting saves it as a normal HTML+XPath feed that re-scrapes on schedule, dedups normally, and round-trips through the `ffx:*` OPML extension.
- **AI feed-config proposal engine** (PR #149, M4 slice 1) — `lib/ai-feed-config.ts`: given a URL, fetches + Defuddle-cleans the page and asks the user's BYOK AI provider to propose a full-text or page→feed config as strict JSON, then **validates it through the real extraction engine** before it would ever be shown. Engine + unit tests only — no UI yet ("✨ Let AI set this up" is slice 2).
- **Command palette** (⌘K / Ctrl-K) (PR #135, Phase 0 F4) — fuzzy jump-to for feeds/categories/labels/actions (refresh, mark-all-read, focus search, add feed, settings, theme toggle, keyboard shortcuts).
- **Copy article as Markdown** (PR #135, Phase 0 F3) — toolbar/menu action that copies the article title, link, and body as Markdown via `turndown`.
- **Per-feed reader defaults** (PR #137, Phase 0 F2) — nullable `Feed.readerFontSizeOverride` / `readerWidthOverride` / `openOriginalOverride` (null = inherit the global default); configurable in the feed-edit dialog's "Reader defaults" block.
- **Automated accessibility (axe) CI gate** (PR #139, Phase 0 0.2) — `@axe-core/playwright` runs the WCAG 2.1 A/AA rule set against `/setup`, `/register`, `/accessibility` in a dedicated `accessibility` CI job; fails the build on any `serious`/`critical` violation. The `color-contrast` rule is intentionally excluded (Chromium/axe misreads this app's `oklch()` tokens; contrast is guaranteed at the design-token level — see `docs/accessibility-todo.md` A-4.1).

### Security & robustness (PR #150 — full-app audit)

- **`AUTH_SECRET` now fails closed at production runtime** instead of falling back to a hardcoded secret. `auth.ts`, `lib/crypto.ts` and `lib/greader.ts` previously substituted a built-in secret when `AUTH_SECRET` was unset — which let anyone forge Google Reader API tokens for any user and made every "encrypted at rest" credential decryptable with a public key. The build-phase carve-out (`NEXT_PHASE=phase-production-build`) is preserved so `next build` still works.
- **Size caps on the new full-text/page-feed/AI fetches** (2 MB + timeout/redirect/`allowInternal`), matching every other fetch site — the auto full-text path runs unattended per sync.
- **Markdown articles render to sanitized HTML before external API delivery** (Fever, v1 REST, Google Reader) via `lib/markdown-render.ts`, so markdown feeds no longer reach third-party clients as raw text.
- **Fever `since_id`/`max_id` pivot lookups scoped to `userId`**; **`summarizeArticle` update scoped to `userId`**; **page-feed XPath class tokens escaped**; **`rel="noopener noreferrer"` forced** on sanitized anchors with `target`.

### Changed

- **Inline width/min-width stripped from untrusted article HTML** (PR #136, Phase 0 0.1) — a shared `lib/sanitize-html.ts` `getSanitizer()` DOMPurify hook strips `width`/`min-width` attributes and inline styles (keeps `max-width`) across every article-HTML sanitize site, closing a mobile-overflow issue.

### Docs

- Added `docs/feed-intelligence-plan.md`, `docs/feed-intelligence-roadmap.md`, `docs/feature-ideas.md`, `docs/MASTER-ROADMAP.md` (single consolidated ordered backlog) and `docs/qa-checklist-2026-07-17.md` (step-by-step manual test checklist for this batch).

### Security

Work merged since v1.1.1 (PRs #88–#106):

A four-domain design audit (`docs/design-audit-todo.md`) was run and **all 54 findings resolved** — the four tiers in PRs #99–#102, the deferred features in PRs #104–#106, and the design-system items documented in `docs/design-system.md`. Security fixes (PR #99):

- **SSRF hardening** — auto-read-rule **webhook** actions, **Gotify/Ntfy** notification-channel URLs, and per-user **Ollama** base URLs now go through the same SSRF guard as feed fetching (blocks localhost/private/link-local, re-validates at call time). Previously any authenticated user could make the server issue requests to internal hosts or cloud metadata.
- **Telegram mark-read links** — HMAC now uses `AUTH_SECRET` (was the never-set `NEXTAUTH_SECRET`, so a guessable open-source constant was always the signing key, allowing forged cross-tenant read/unread writes); verification is constant-time and fails closed when `AUTH_SECRET` is unset. ⚠️ *Local Ollama users:* a default `http://localhost:11434` now requires the admin to opt into internal fetching.
- **Timing-safe comparison** for the internal provisioning API key; **`/api/register`** now rate-limited and zod-validated; web-push `endpoint` validated; `categoryId` ownership verified before attaching to a feed.

### Added

- **Indexed full-text search** (PR #104) — free-text search is now index-backed: SQLite gets an FTS5 table with the `trigram` tokenizer (substring-equivalent to the old `LIKE`, kept in sync via triggers), PostgreSQL gets `pg_trgm` GIN indexes. Setup is automatic and idempotent at startup; results are never narrower than before (LIKE fallback for <3-char terms or any FTS failure). See `docs/database.md`.
- **Unsaved-changes warning in the feed-edit dialog** (PR #106) — closing the dialog (backdrop / Escape / X / Cancel) with pending edits now prompts to confirm; a successful save closes without the prompt.
- **Undo for swipe-to-next-feed mark-all-read** (PR #101) — the auto-mark now shows an Undo toast (backed by a new user-scoped `markArticlesAsUnread` action).
- **Automatic retention enforcement** (PR #100) — `defaultRetentionDays` / per-feed retention now run daily from the background scheduler (previously only via a manual settings action).
- **Conditional GET for feed sync** (PR #100) — feeds are re-downloaded only when changed (`If-None-Match` / `If-Modified-Since`; new `Feed.etag` / `Feed.lastModifiedHeader`).
- **Design system documentation** (`docs/design-system.md`) — formalizes the radius scale, icon-size scale and Dialog/AlertDialog conventions the codebase follows.

### Changed

- **Settings page split into five themed tabs** (PR #91) — Appearance, Reading, Account, Notifications, Integrations; replaces the previous 2100+-line single scroll page. Mobile uses a Select dropdown via `ResponsiveTabsNav` (PR #92).
- **Auth pages are now theme-aware** (PR #102) — login / register / setup used hardcoded dark styling and were unusable in light mode; they now use semantic design tokens and render correctly in both themes.
- **Faster feed sync** (PR #100) — the per-article `findUnique → upsert → findFirst → update` loop is replaced by a batched insert/update path (one `findMany` + `createManyAndReturn` + targeted updates), with identical dedup semantics and 8 new unit tests. GReader bulk tag edits, dynamic-OPML sync and retention were similarly de-N+1'd; `getArticles` no longer serializes the full `Feed` row (incl. `authPassword`) to the client.
- **Lighter long article lists** (PR #105) — `content-visibility:auto` + lazy images cut the layout/paint cost of long lists without changing the scroll/gesture behavior.

### Added (email digest & search — earlier in this cycle)

- **Expanded email digest** (PR #95) — configurable article count with min/max thresholds, fixed lookback windows (6 h–30 d), IANA-timezone-aware scheduling, weekdays frequency, feed-grouped layout, and optional AI summaries (overall or per feed) via the user's configured AI provider.
- **Digest polish** (PR #96) — deduplication of already-featured articles (`Article.digestedAt` + `digestSkipFeatured` setting), label filter alongside the feed filter, pause mode with duration picker (tomorrow / 3 d / 1 w / 2 w / indefinite), article-count preview with feed breakdown, RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers across all mail providers, and AI-generated subject lines when AI summary mode is active.
- **Dedicated search results view** (PR #93) — new `SearchResultsView` with a header showing the active query, result/unread counts, a prominent close button and an edit-query affordance; mobile bottom controls gain a search-active variant with thumb-reachable actions. New `searchResults` i18n namespace (de/en).
- **Granular SMTP TLS settings** (PR #89) — new `smtpSecure` (auto/ssl/starttls/plain) and `smtpRejectUnauthorized` fields so admins can explicitly control TLS mode instead of relying on port-based auto-detection.

### Fixed

- **UX / i18n polish** (PR #101) — extracted the remaining hardcoded strings (search modal, spoiler gate, offline banner, rules-action labels) into the i18n message files; search counts use proper ICU plurals; the delete-account confirm phrase now derives from the same translation key as its placeholder (was unsatisfiable for non-English users); summarize failures surface a toast + inline message; the "Fetch Full Text" action shows a spinner; added `aria-expanded`/`aria-label` to settings disclosures, the mobile sidebar toggle and the sidebar category chevron. Also **mounted `<Toaster/>`** — it was never mounted, so every `toast.*` call in the app had been a silent no-op.
- **Visual token discipline** (PR #102) — restored visible keyboard focus rings on auth inputs and nav-menu links (WCAG 2.4.7); tokenized custom toggle-switch knobs, loading spinners, feed-name badges and the theme-color applier so they render correctly in both themes.
- **SMTP authentication** (PR #89) — `smtpPassword` was stored AES-encrypted but passed raw to nodemailer, causing 535 auth failures; it is now decrypted before sending.
- **Search spans hidden feeds** (PR #94) — global search no longer applies the `hideFromAllFeeds` exclusion, so articles in feeds hidden from "All Articles" are findable again. Browsing and mark-all-read keep the exclusion.
- **Mark-all-read respects hidden feeds** (PR #88) — "Mark all read" in the All Articles scope no longer touches articles from feeds/categories marked `hideFromAllFeeds`.
- **Log timestamps in local timezone** (PR #90) — audit log, login attempts and system log tables now render timestamps in the browser's timezone instead of the server's (usually UTC).
- **TypeScript strict mode** (PR #91) — resolved all pre-existing implicit-any and type-mismatch errors; `tsc --noEmit` is clean under strict settings.
- **Sidebar empty-state contrast** (PR #91) — removed 50 % opacity and 10 px font size from the "no feeds" empty-state text.

---

## [1.1.1] — 2026-05-21 — Post-Release Patch

Fixes found during release testing.

### Fixed

- **Empty feed scroll navigation** — Hovering over an empty feed and scrolling the mouse wheel now correctly advances to the next/previous feed. Previously the empty-state rendered outside `<ScrollArea>`, leaving `scrollRoot` null so the wheel handler never attached.
- **Overscroll threshold** — Raised from 280 → 500 px accumulated `deltaY` before a feed switch fires, preventing accidental feed jumps when scrolling to the last article normally.
- **Label unread badges** — Three gaps caused badges to show stale counts:
  - `useLabels` now refetches every 60 s (same cadence as feeds) so badges self-correct in the background.
  - Toggling an individual article read/unread now optimistically adjusts the badge for every label the article belongs to, and invalidates `["labels"]` on success.
  - "Mark all read" on a label scope now optimistically zeros that label's badge immediately instead of waiting for the server round-trip.
- **Search input padding** — Changed `px-0` → `px-2` on the search dialog input so typed text no longer clips against the element boundary.
- **Case-insensitive search** — All `contains` queries in `lib/search.ts` now use `mode: 'insensitive'` on PostgreSQL (ILIKE) and plain LIKE on SQLite (already case-insensitive for ASCII). Searching `wordpress`, `WordPress`, or `WORDPRESS` returns identical results.
- **Lockfile / CI** — Regenerated `pnpm-lock.yaml` to reflect `ws` and `@hono/node-server` overrides added in v1.1.0; fixes `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` in CI and Coolify.

---

## [1.1.0] — 2026-05-21 — Internationalization, Full API Coverage, Security Hardening & UX Polish

### Internationalization (i18n)

- **next-intl integration** — English and German translations ship with this release. All 945 user-visible strings managed in `messages/en.json` (canonical) and `messages/de.json`. ICU MessageFormat plurals throughout.
- **Language picker in Settings** — new "Language" row in Settings → Appearance. Persisted per user in `User.uiLanguage` and a `locale` cookie. Cookie-based locale (no URL prefix restructuring).
- **Locale detection** — middleware reads `Accept-Language` on first visit and sets the locale cookie automatically.
- **Admin default language** — Server Management → Registrations: admins set the instance-wide default language for new users.
- **All components wired** — `settings-form`, `rss-sidebar`, `article-list`, `article-reader`, `rss-header`, `discovery-panel`, `keyboard-shortcuts-dialog`, `pwa-install-prompt`, `server-management-dialog`, `mobile-bottom-controls`, `feed-management`, `feed-edit-dialog`, all page routes.
- **Email localization** — digest and sign-in emails rendered in recipient's `uiLanguage`. Subject uses ICU plural (`{count, plural, one {# new article} other {# new articles}}`). `<html lang>` set per user.
- **RTL CSS** — physical directional Tailwind classes (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, etc.) replaced with logical equivalents (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`) across all components. Directional icons get `rtl:rotate-180`.
- **Translation tooling** — `pnpm run translations:check` CI script; GitHub PR template for community translation contributions; `docs/contributing-translations.md` guide.

### REST API v1 Extensions

- **New endpoints**: `/api/v1/alerts` (CRUD keyword alerts), `/api/v1/rules` (CRUD auto-read rules), `/api/v1/notifications` (list + mark read), `/api/v1/stats`.
- **`POST /api/v1/articles/batch`** — applies `read`/`unread`/`star`/`unstar`/`label`/`unlabel`/`read_later`/`remove_read_later` to up to 500 article IDs in one request. Eliminates round-trip overhead for sync clients.
- **Token scopes** — `read`, `write`, `admin` enforced per endpoint. Read-only tokens blocked from all POST/PATCH/DELETE operations. Scope picker in Settings → API Access.
- **OpenAPI spec** bumped to 1.1.0; all new endpoints documented at `GET /api/v1/openapi.json`.

### MCP Server (AI Agent Integration)

- Expanded from 10 → 28 tools: `delete_feed`, `update_feed`, `create/update/delete_category`, `update/delete_label`, `label_article`, `batch_update_articles`, `list/create/delete_saved_search`, `list/create/update/delete_keyword_alert`, `list_notifications`, `get_stats`.
- An AI agent can now control every operational aspect of the app at the user level via MCP.
- `GET /api/mcp` returns `version: "1.1.0"`, `tools: 28`.

### Rules & Keyword Alerts

- **OR operator** — `openclaw OR hermes` now correctly matches articles containing *either* word. Previously AND-joined all tokens including the literal "OR".
- **Unified label action** — replaced the per-label `Add label: XYZ` action catalog entries with a single "Add label…" / "Remove label…" picker that lists all user labels in a dropdown. No more catalog bloat.
- **Availability filter** — notification actions (Telegram, Gotify, ntfy, email, push) only appear in the action picker when the corresponding channel is configured by the user.

### Sidebar & Labels

- **Label unread counts** — sidebar label badges now show *unread* article count instead of total.
- **Hide empty labels** — new user setting (Settings → Reading): hides labels with 0 unread articles from the sidebar. Mirrors the existing "Hide empty feeds" toggle. Schema: `User.hideEmptyLabels Boolean @default(false)`.

### Admin

- **Storage dashboard** — new "Storage" tab in Server Management shows per-user article/feed/AI-summary counts, sorted by article count descending. Foundation for future quota enforcement.
- **Public saved search kill-switch** — `GlobalSettings.disablePublicSharedSearches` toggle in Server Management → Registrations. Already active: shared search page returns 404 when disabled.

### Security Hardening (Pre-Release Audit — PRs #77–80)

- **Rate limiting — Fever API** — `checkRateLimit` with 120 req/min per user applied after authentication. Prevents article scraping and ID enumeration.
- **Rate limiting — Google Reader API** — same `checkRateLimit` guard in both GET and POST handlers.
- **Email enumeration fix** — `/api/register` now returns a generic `Registration failed` response for existing accounts instead of `User already exists`.
- **Push subscribe input validation** — `platform` and `pushFrequency` validated against explicit allowlists before DB write. Arbitrary strings no longer accepted.
- **Sync error leakage** — `/api/sync` catch blocks replaced `String(error)` in response body with generic `"Sync failed"`. Raw exception messages no longer reach clients.
- **`pnpm audit --audit-level=high`** added as a CI step; fails the build on any high-severity vulnerability.
- **`pnpm.overrides`** — `ws>=8.20.1` and `@hono/node-server>=1.19.13` patched via overrides to resolve moderate dev-dependency CVEs.
- **Husky pre-commit hook** — made executable; `lint-staged` now runs ESLint + TypeScript on every commit.
- **ESLint config** — `.claude/` worktree directory excluded to prevent false positives in container environments.

### TypeScript & Code Quality (PRs #78–79)

- **`as any` elimination** — removed all `as any` casts in `app/page.tsx` (3 instances), `components/feed-management.tsx` (7 instances), and `components/server-management-dialog.tsx` (all typed with Prisma-derived types via `Awaited<ReturnType<...>>`).
- **`useCallback`/`useMemo` deps** — exhaustive-deps ESLint violations fixed across `settings-form.tsx`, `server-management-dialog.tsx`, and `app/page.tsx`.
- **`.catch(console.error)` cleanup** — replaced with `.catch(() => {})` for intentional fire-and-forget operations; server-side errors already logged by the route handler.

### i18n Completions (PRs #77–80)

- **Server management toasts** — all 28+ hardcoded English toast messages in `server-management-dialog.tsx` replaced with `useTranslations("serverManagement.toast")` keys. Admins on DE locales now see translated feedback.
- **Author fallback** — `"Unknown"` author → `tList("unknownAuthor")` (`"Unbekannt"` in DE).
- **Header fallbacks** — `"Feed"`, `"Label"`, `"Saved Search"` → `t("feedFallback")`, `t("labelFallback")`, `t("savedSearchFallback")`.
- **ARIA region labels** — `aria-label="Article list"`, `"Article reader"`, `"Clear search"`, `"Close search"` all translated via `useTranslations("accessibility")`.
- **Sidebar ARIA** — `aria-label` on sidebar `<aside>` and feed action buttons translated via `t("sidebar.feedNavigation")`, `t("sidebar.feedActions")`.
- **Feed management scope labels** — rule scope selects now render `t("rules.feedScope", { name })` and `t("rules.categoryScope", { name })` instead of template literals.
- **Final translation count: 1052 keys** in `de.json`.

### Tests

- **85 Vitest tests** across 6 suites (was 76). New: 9 OR-operator tests for `buildAdvancedSearchWhere`.
- All existing tests continue to pass.

### Documentation

- `docs/api.md` — batch endpoint, token scopes, OR operator syntax
- `docs/mcp.md` — all 28 tools documented
- `docs/releases/backlog.md` — completed items marked
- `docs/releases/v1.1-i18n.md` — milestone checklist updated
- `docs/deferred.md` — new file documenting what was explicitly scoped out of v1.1 and why

---

## [1.0.0] — 2026-05-18 — Initial Public Release 🎉

First stable release. Full feature set, production-hardened, self-hosting ready.

### Highlights

- **License** — switched from MIT to AGPL-3.0 (copyleft; SaaS loophole closed; attribution required; forks must use same license)
- **Notification channels** — Telegram, Gotify, ntfy alongside browser push, email, and webhooks
- **Google Reader API** — full client compatibility for Reeder, NetNewsWire, FeedMe, ReadKit
- **CI pipeline** — lint + type-check + build on every PR
- **Centralized logger** — `lib/logger.ts`, production-safe log levels
- **Dependency updates** — Radix UI, React 19.2.6, Tailwind 4.3, TanStack Query 5.100
- **Coolify deployment guide** — step-by-step with troubleshooting
- **GitHub Issue Templates** — bug report + feature request forms
- **README** — streamlined to < 5-minute read
- **CONTRIBUTING.md** — contribution guide with CLA explanation

See [0.9.0] below for the full pre-release feature list.

---

---

## [0.9.0] — 2026-05-18 — Pre-Launch Release

### Added

**Notification Channels (Telegram, Gotify, ntfy)**
- `lib/notification-channels.ts`: send functions for Telegram Bot API (MarkdownV2), Gotify (`/message?token=`), and ntfy (topic URL + optional Bearer token)
- All three channels wired into keyword alert dispatch and auto-read rule actions (`notify_telegram`, `notify_gotify`, `notify_ntfy`)
- Settings UI: per-channel enable/disable toggle, credential inputs, "Send test" button
- Server actions: `getNotificationChannels`, `updateNotificationChannels`, `testNotificationChannel`
- New User schema fields: `telegramEnabled/BotToken/ChatId`, `gotifyEnabled/Url/Token`, `ntfyEnabled/Url/Token`

**Google Reader API Compatibility**
- `POST stream/items/contents`: batch-fetch articles by item ID list (required by Reeder, NetNewsWire, FeedMe, ReadKit)
- `r=o` oldest-first sort order in stream endpoints
- `ot` older-than timestamp filter (Unix seconds)
- `mark-all-as-read`: honors `ts` microsecond cutoff to protect freshly-synced articles
- `user-info`: real `signupTimeSec` from DB
- `unread-count`: real `newestItemTimestampUsec` for reading-list, starred, and per-feed streams
- Per-client setup guides added to `docs/google-reader-api.md`

**CI Pipeline**
- `.github/workflows/ci.yml`: lint + type-check + build on every PR and push to main

**Infrastructure**
- `lib/logger.ts`: centralized logger — `warn`/`error` always active, `log`/`info`/`debug` suppressed in production
- Migrated all 56 `console.*` calls in server-side code to `logger.*`

### Changed

**Dependency Updates** (patch/minor only, no breaking changes)
- Radix UI primitives: all ~20 packages updated to latest 1.x/2.x
- `react` + `react-dom`: 19.2.0 → 19.2.6
- `tailwindcss` + `@tailwindcss/postcss`: 4.1.18 → 4.3.0
- `@tanstack/react-query`: 5.90 → 5.100.10
- `react-hook-form`: 7.71 → 7.76
- `tailwind-merge`: 3.4 → 3.6
- `cmdk`: 1.0.4 → 1.1.1, `embla-carousel-react`: 8.5.1 → 8.6.0, `input-otp`: 1.4.1 → 1.4.2
- `isomorphic-dompurify`: 3.12 → 3.13, `autoprefixer`: 10.4 → 10.5, `tw-animate-css`: 1.3 → 1.4

**Documentation**
- `docs/self-hosting.md`: full Coolify deployment guide with step-by-step instructions and troubleshooting table
- `docs/google-reader-api.md`: complete rewrite with per-client setup guides and parameter reference table
- `docs/marketing-landing-page-brief.md`: updated with new notification channels and Google Reader API features

---

## [0.8.0] — 2026-05-17

### Added

- Rate limiting for all API surfaces (auth, MCP, internal, v1 read/write)
- Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- API token hardening: SHA-256 hashing, `ff_`-prefix
- Input validation: URL/OPML/length limits across all endpoints
- CVE patching via `pnpm.overrides` for high/moderate findings
- Admin & session hardening: audit log, 2FA enforcement, session invalidation
- Docker secrets warning for default credentials
- Accessibility sprint: ARIA labels, focus management, keyboard navigation (A-1, A-2, A-3)
- Empty states for all views
- Onboarding flow redesign: 6-step wizard, starter packs
- `/api/health` endpoint with DB ping check
- Docker Compose reviewed and hardened
- Self-hosting guide (`docs/self-hosting.md`)
- SEO basics: Open Graph tags, sitemap, robots.txt

---

## [0.1.0] — 2026-04-01 — Initial Release

### Added

- Multi-user RSS reader with per-user data isolation
- Feed management: add, edit, delete, sync, categorize
- Article reader with multiple layout modes
- Advanced search with 15+ query tokens
- Saved searches with public sharing and RSS export
- Labels, starred, read-later workflows
- Auto-mark-as-read rules with query-based matching
- Keyword alerts with push, email, and webhook delivery
- AI article summaries (BYOK: OpenAI, Anthropic, Gemini, Ollama)
- Full-text extraction with CSS selector editor (Scout Studio)
- Retention policies per feed
- Outbound webhooks with HMAC signing and retry logic
- Duplicate detection via SHA-256 URL normalization
- Browser push notifications (Web Push / VAPID)
- Email digests (configurable frequency, scope, AI summaries)
- Multiple email providers: SMTP, Resend, Postmark, Mailgun, SendGrid
- REST API v1 with OpenAPI schema
- MCP endpoint for AI agent integration
- Google Reader API (initial implementation)
- OPML import/export, JSON data export
- PWA: installable, offline fallback, app shortcuts
- Mobile UX: bottom navigation, swipe gestures, safe-area handling
- Auth: local accounts, magic link, Google OAuth, GitHub OAuth, Authelia OIDC, TOTP 2FA
- Docker Compose deployment with PostgreSQL and SQLite support
- Admin UI: user management, email config, instance branding, starter packs
- Keyboard shortcuts
- Dynamic theming: accent color, secondary color, dark mode
