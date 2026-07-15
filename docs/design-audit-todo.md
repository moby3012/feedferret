# FeedFerret — Design Audit TODO

> **Conducted:** 2026-07-15 · **Scope:** Performance · User Experience · Security · Visual Design
> **Method:** Four parallel read-only audits across the codebase; every item below was verified against real source with a `file:line` reference.
> **Status:** Backlog for v1.2 (Theming & Accessibility) and continuous security/perf workstreams.

This is a working checklist. Tick items as they land, link the PR next to the checkbox. Severity drives ordering **within** each domain; the "Suggested order" section at the top sequences work **across** domains.

Legend — **Severity:** 🔴 critical · 🟠 high · 🟡 medium · ⚪ low  **Effort:** S (hours) · M (≤1 day) · L (multi-day)

---

## Suggested order of attack

1. **Security 🔴/🟠 first** — SSRF via webhooks/notification channels and the Telegram HMAC fallback are exploitable today. Small fixes, high payoff. (S-1, S-2, S-3)
2. **Visual light-mode blockers** — auth pages are unusable in light mode; ships with the v1.2 theming work anyway. (V-1, V-2, V-3)
3. **Performance quick wins** — search debounce, conditional GET, N+1 in sync; these are the biggest runtime costs. (P-1, P-2, P-4)
4. **UX i18n + feedback gaps** — hardcoded strings and the silent sync failure. (U-1, U-2, U-3, U-4)
5. **Everything else** as capacity allows.

**Totals:** Security 10 (1🔴 · 2🟠 · 4🟡 · 3⚪) · Performance 16 (5🟠 · 1🟠 · 6🟡 · 4⚪) · UX 12 (3🟠 · 4🟡 · 5⚪) · Visuals 17 (5🟠 · 8🟡 · 4⚪)

---

## 1. Security

### Blockers / High

- [ ] **🔴 S-1 · SSRF via user-configurable webhook actions** — `S`
  `lib/webhooks.ts:112` (`executeWebhookCall`), configs saved in `app/actions/feeds.ts:1159` (`sanitizeWebhookConfigs`), fired from `lib/auto-read-rules.ts:206,469`.
  Any authenticated user can attach a webhook action to an auto-read rule with an arbitrary URL. `sanitizeWebhookConfigs` only checks protocol (`http:`/`https:`) — no private-IP/localhost/link-local block — and `executeWebhookCall` calls `fetch(url)` directly, bypassing `lib/ssrf.ts`. The rule fires automatically on a user-controlled match, giving a general-purpose server-side SSRF primitive (internal services, cloud metadata `169.254.169.254`). *Verified 2026-07-15.*
  **Fix:** Route the fetch through `assertSafeFetchUrl`/`fetchTextWithSsrfProtection` with the same `isTrustedFeedFetchingAllowed` gate feeds use, and re-validate the resolved IP at call time (DNS can change between save and fire).

- [ ] **🟠 S-2 · SSRF via Gotify/Ntfy notification channel URLs** — `S`
  `lib/notification-channels.ts:72` (`sendGotifyNotification`), `:99` (`sendNtfyNotification`); invoked from `lib/auto-read-rules.ts`, `lib/keyword-alerts.ts`, and the "send test notification" action `app/actions/settings.ts:674,681`.
  Same class as S-1: per-user `config.url` is `fetch()`'d directly with no SSRF guard, and the test action lets a user fire it on demand against any URL.
  **Fix:** Wrap both calls with the feed-fetch SSRF guard (private-IP/localhost block + DNS re-resolution).

- [ ] **🟠 S-3 · Telegram mark-read HMAC key falls back to a hardcoded public constant** — `S`
  `lib/telegram-callback.ts:3` — `const SECRET = process.env.NEXTAUTH_SECRET || "feedferret-telegram-callback";`
  This app is Auth.js v5 and only ever sets `AUTH_SECRET`; `NEXTAUTH_SECRET` is never set, so the guessable open-source constant is **always** the HMAC key for `generateMarkReadUrl`/`verifyMarkReadUrl`. Anyone can forge a valid `sig` for any `articleId`+`userId` and flip `isRead` on any user's articles (cross-tenant, unauthenticated write). *Verified 2026-07-15.*
  **Fix:** Read `AUTH_SECRET`, fail closed if unset (drop the string fallback), and use `crypto.timingSafeEqual` instead of `sig === expected` at `lib/telegram-callback.ts:18`.

### Medium

- [ ] **🟡 S-4 · Internal provisioning API key compared with non-constant-time `===`** — `S`
  `lib/internal-auth.ts:9` — `return token === key;`. Gates `/api/internal/provision-user` and `/api/internal/suspend-user`. Mirror the `crypto.timingSafeEqual` pattern already in `lib/greader.ts:27`.

- [ ] **🟡 S-5 · Per-user Ollama base URL is an unguarded SSRF vector** — `M`
  `lib/ai-summary.ts:152` (`summarizeOllama`), config from `aiOllamaBaseUrl` (`lib/digest-scheduler.ts:188`). Any user can POST attacker-chosen prompts to an arbitrary URL on a recurring (digest) or on-demand schedule. Gate configurable base URLs behind `isTrustedFeedFetchingAllowed` or an admin allowlist.

- [ ] **🟡 S-6 · `/api/register` has no rate limiting and no zod validation** — `S`
  `app/api/register/route.ts:8-66`. Unlimited automated account creation + bcrypt CPU-exhaustion DoS; `email`/`password`/`name` used with only a truthiness check (no format/length caps). Add `checkRateLimit` and a zod schema consistent with `lib/validation.ts`.

### Low

- [ ] **⚪ S-7 · Web Push `endpoint` never validated (SSRF-adjacent)** — `S`
  `app/api/push/subscribe/route.ts:27-49`, `lib/push.ts:58-97`. Accepted verbatim and POSTed to on demand via `/api/push/test`. Validate `https:` + a known push-service host allowlist, or run the private-IP check.

- [ ] **⚪ S-8 · `categoryId` ownership not verified when attaching to a feed** — `S`
  `app/actions/feeds.ts:330-363` (`addFeed`), `:375-417` (`updateFeed`), `app/api/v1/[...path]/route.ts:259-274`. Client-supplied `categoryId` written without a `Category.userId === session.user.id` check → cross-tenant relation leak via `include: { category: true }`. Add a `findFirst({ where: { id, userId } })` guard.

- [ ] **⚪ S-9 · SMTP `rejectUnauthorized:false` has no admin warning** — `S`
  `lib/mail.ts:124-153`, set via `app/actions/admin.ts:87-89`. Silently downgrades TLS/MITM protection for outgoing mail (magic links, digests). Surface a UI warning and annotate `logAdminAction`.

- [ ] **⚪ S-10 · In-memory rate limiter has no cross-instance/restart durability** — `M` (only if multi-instance is a goal)
  `lib/rate-limit.ts:11`. Single process-local `Map`; resets on deploy, bypassable behind a load balancer. Document as a single-instance limitation or move to a shared store. *(Also flagged by the performance audit — see P-13.)*

---

## 2. Performance

### High

- [ ] **🟠 P-1 · Per-article N+1 upsert loop in feed sync** — `M`
  `lib/rss-sync.ts:80-131` (`syncFeed`). Up to 3 sequential round trips per article (`findUnique` → `upsert` → cross-feed `findFirst` → conditional `update`); a 50-item feed = ~100-150 sequential DB calls, repeated for every feed every ~5 min. **Fix:** batch-fetch existing rows by dedupe key with one `findMany`, split into `createMany` + minimal `updateMany`, and do cross-feed dedup with one `findMany` over content hashes.

- [ ] **🟠 P-2 · No conditional GET — every sync re-downloads and re-parses the full feed** — `M`
  `lib/feed-fetcher.ts:213-250` (`fetchText`), `lib/rss-sync.ts:32`. No `If-None-Match`/`If-Modified-Since`, and `Feed` has no `etag`/`lastModified` column, so unchanged feeds are fully downloaded, decompressed, parsed and DOMPurify-sanitized every tick. **Fix:** add `etag`/`lastModifiedHeader` columns, send conditional-GET headers, short-circuit on 304.

- [ ] **🟠 P-3 · Redundant per-feed settings lookup duplicates the outer feed query** — `M`
  `lib/rss-sync.ts:319-359`/`:361-394`, `lib/settings.ts:11-22`. Feeds are loaded once (with `include: { user: true }` pulling password hash + encrypted AI keys that are discarded), then `getEffectiveSettings` re-fetches each feed with nested `category`/`parent`/`user` includes just to read `updateFrequency`. **Fix:** fetch once with `select`, compute effective frequency in memory.

- [ ] **🟠 P-4 · Article search fires a full DB query on every keystroke (no debounce)** — `S`
  `app/page.tsx:1082` → `hooks/use-rss-data.ts:77-84` → `app/actions/feeds.ts:631-753`. `searchQuery` is wired straight into the TanStack Query key with no debounce, so every keystroke runs `buildAdvancedSearchWhere` (multi-column `LIKE`) + a 200-row `findMany`. **Fix:** debounce 250-300 ms (the pattern already exists in `components/discovery-panel.tsx:36`).

- [ ] **🟠 P-5 · GReader bulk tag-edit loops per article instead of batching** — `M`
  `app/api/greader/[...path]/route.ts:459-466` (`edit-tag`), `:130-174` (`applyTagEdit`). `for (const id of ids) await applyTagEdit(...)` — a 200-id "mark all read" from Reeder/NetNewsWire = 200+ sequential round trips. **Fix:** one `updateMany` for the read/star bit, batched `createMany`/`deleteMany` with `articleId: { in: ids }`.

### Medium

- [ ] **🟡 P-6 · Full article `content` and full `Feed` row shipped in list payloads** — `S-M`
  `app/actions/feeds.ts:737-753` (`include: { feed: true }`), `app/api/v1/[...path]/route.ts:16-45`. List views return full `content` HTML for every article, and `getArticles`'s `include: { feed: true }` serializes the entire `Feed` row (**incl. `authPassword`, `scraperConfig`, `httpOptions`** — also a data-exposure concern) to the client. **Fix:** `select` only rendered fields; fetch `content` lazily on open. *(Overlaps with S-8-adjacent data exposure — worth prioritizing.)*

- [ ] **🟡 P-7 · Retention policy never runs automatically → unbounded growth** — `S`
  `app/actions/feeds.ts:474-530` (`applyRetentionPolicies`) is only reachable via a manual settings action; `lib/background-sync.ts:28-54` never calls it. `User.defaultRetentionDays`/per-feed `retentionDays` exist but nothing enforces them, so read articles with full HTML accumulate forever. **Fix:** call it from the scheduler on a daily cadence.

- [ ] **🟡 P-8 · `applyRetentionPolicies` is itself a per-feed N+1 when it runs** — `M`
  `app/actions/feeds.ts:485-526`. `findMany` + per-feed `count` + per-feed `deleteMany`; 100 feeds ≈ 300 sequential queries. **Fix:** one `groupBy` for counts (as `getFeedHealth` already does at `:433-454`), batched deletes.

- [ ] **🟡 P-9 · Dynamic OPML sync fetches every user's remote OPML sequentially each tick** — `S`
  `lib/dynamic-opml.ts:84-104`, called from `lib/rss-sync.ts:362-364` every ~5 min. `for … await fetchSafeOpml(...)` (15 s timeout each) blocks the start of the feed-refresh batch. **Fix:** bounded concurrency (reuse the `concurrency = 4` pattern from `rss-sync.ts:329`).

- [ ] **🟡 P-10 · No virtualization in the article list** — `M`
  `components/article-list.tsx:177,283,331-345`. Incremental "load more" keeps up to 200 full cards (each with a favicon `<img>`) mounted. **Fix:** windowed list via `@tanstack/react-virtual` for list/grid/minimal modes.

- [ ] **🟡 P-11 · Search uses unindexed `LIKE '%term%'` scans with no FTS** — `L`
  `lib/search.ts:6-10,141-153`. Leading-wildcard `contains` across `title`/`content`/`excerpt`/`author`/`link`/feed/labels can't use any index; combined with P-4 it runs on every keystroke. **Fix:** SQLite FTS5 / Postgres `pg_trgm`/`tsvector` for free-text, keep structured `field:value` filters as indexed `where`.

### Low

- [ ] **⚪ P-12 · `DiscoveryPanel` statically bundled into the always-loaded sidebar** — `S`
  `components/rss-sidebar.tsx:60` imports the 404-line `discovery-panel.tsx` into the initial client bundle though it only renders in the "Add feed → Discover" tab. **Fix:** `next/dynamic(() => import(...), { ssr: false })`.

- [ ] **⚪ P-13 · Digest/push schedulers do full `User` scans with no supporting index** — `S`
  `lib/digest-scheduler.ts:162-191`, `lib/notifications.ts:98-111`. `User` has no `@@index` besides unique `email`; these run every tick. **Fix:** `@@index([digestEnabled])`, `@@index([pushEnabled])`.

- [ ] **⚪ P-14 · Offline cache does synchronous full-content `localStorage` writes on every list change** — `S`
  `hooks/use-offline-articles.ts:32-44`. `JSON.stringify`s up to 100 full-`content` articles on every `articles` change (incl. after each optimistic mark-read), blocking the main thread. **Fix:** strip `content` before caching and/or debounce.

- [ ] **⚪ P-15 · In-memory rate-limit store: no cap, no cross-instance sharing** — `S`/`L`
  `lib/rate-limit.ts:11-19`. Same store as S-10; add a max-entries cap as a cheap mitigation regardless of the Redis decision.

---

## 3. User Experience

### High (i18n gaps — small effort, high impact)

- [ ] **🟠 U-1 · Hardcoded strings in the main search modal** — `S`
  `app/page.tsx:1083,1106,1114,1123`. Placeholder, help text and button labels are English-only. Extract to a `search`/`searchResults` namespace.

- [ ] **🟠 U-2 · Hardcoded strings in spoiler gate and offline banner** — `S`
  `app/page.tsx:218,870,987`. "Take me back" and "Offline mode: showing cached articles…" are hardcoded. Move to `t()`.

- [ ] **🟠 U-3 · Hardcoded fallback strings for deleted labels in rules UI** — `S`
  `components/feed-management.tsx:173,178`. "label (deleted)" / "remove label (deleted)" hardcoded in `actionLabel()`. Add i18n keys.

### Medium

- [ ] **🟡 U-4 · Silent auto-sync failure on page load** — `M`
  `app/page.tsx:260-272`. `/api/sync` errors are swallowed with `.catch(() => {})` — no toast, state, or retry. **Fix:** `toast.error(...)` and/or a sync-status indicator in the header.

- [ ] **🟡 U-5 · Delete-account confirmation phrase mismatch** — `M`
  `components/settings-form.tsx:1652`. Button enabled by hardcoded `confirmText !== "delete my account"` while the placeholder is translated — a non-English user can never satisfy the check. **Fix:** derive both from the same i18n key/constant.

- [ ] **🟡 U-6 · Summarize mutation lacks error feedback / orphaned state** — `M`
  `components/article-reader.tsx:522-539`. No `onError` toast; closing the article mid-summarize orphans the state. **Fix:** add `onError` + an inline "Summary failed — try again" state.

- [ ] **🟡 U-7 · Search-results count uses English-only pluralization** — `M`
  `app/page.tsx:1121-1123,1105`. `result${n === 1 ? "" : "s"}` / "matches" built by hand; breaks for languages with other plural rules. **Fix:** `format.plural()` / ICU plural keys.

### Low

- [ ] **⚪ U-8 · No loading indicator during "Fetch Full Text" on mobile** — `M`
  `components/article-reader.tsx:588-608`. Only the button disables; no spinner/skeleton in the content area. **Fix:** show a spinner while `isFetchingFullText`.

- [ ] **⚪ U-9 · Feed edit dialog gives no unsaved-changes warning** — `L`
  `components/feed-edit-dialog.tsx`. Closing discards edits silently; no retry on failed save. **Fix:** track a dirty flag, confirm on close.

- [ ] **⚪ U-10 · Auto-mark-all-read on swipe-to-next-feed has no confirmation/undo** — `M`
  `app/page.tsx:536-539,1014-1015`. Easy to bulk-mark-read by accident. **Fix:** separate navigation from marking, or add an undo toast. *(Related to the deferred "swipe-down marks all read" item in `deferred.md`.)*

- [ ] **⚪ U-11 · Missing `aria-expanded`/`aria-label` on settings disclosures & sidebar toggle** — `S`
  `components/settings-form.tsx` (disclosure sections), `app/page.tsx:751-758` (sidebar toggle). Screen readers can't tell open/closed state. **Fix:** add `aria-expanded`/`aria-label`.

- [ ] **⚪ U-12 · Toasts may hide behind the fixed mobile bottom bar** — `S`
  `components/mobile-bottom-controls.tsx`, `components/article-reader.tsx:634-770`. Sonner defaults to bottom; the `h-16` bar overlaps it. **Fix:** offset toast position above the bar / use safe-area inset.

---

## 4. Visual Design

> The v1.2 release is themed "Theming & Accessibility" (`docs/releases/v1.2-theming.md`) — these findings should land there. The recurring root cause is that **auth/onboarding pages bypass the semantic-token system** the rest of the app uses correctly.

### High

- [ ] **🟠 V-1 · Auth pages hardcoded to dark styling → unusable in light mode** — `L`
  `app/login/page.tsx:152,172,186`, `app/register/page.tsx:81,114`, `app/setup/page.tsx:222+`. 75+ instances of `bg-black`, `text-white`, `text-zinc-*`, `border-white/10`, `bg-white/5` → white-on-white in light mode. **Fix:** replace with semantic tokens (`bg-background`, `text-foreground`, `border-border`, `bg-secondary/…`). *Highest-priority theming blocker.*

- [ ] **🟠 V-2 · Focus rings removed without replacement (WCAG 2.4.7)** — `M`
  `app/login/page.tsx:186,203,222`, `app/register/page.tsx:114-147`, `app/setup/page.tsx:279+`, `components/ui/navigation-menu.tsx:94` (`focus:ring-0`/`focus:outline-none`). 15+ inputs give keyboard users no visible focus. **Fix:** `focus-visible:ring-2 focus-visible:ring-ring`.

- [ ] **🟠 V-3 · Hardcoded dark hex on loading screens breaks light mode** — `S`
  `app/page.tsx:704,726` (`bg-[#05060a]`); spinner borders `app/setup/page.tsx:315,364,446,496` (`border-black/20 border-t-black`, invisible on light). **Fix:** `bg-background`; spinner `border-primary/20 border-t-primary`.

- [ ] **🟠 V-4 · Custom toggle-switch knobs hardcoded `bg-white`/`bg-black`** — `M`
  `components/settings-form.tsx:1174,1361,1486` (`bg-white`), `app/setup/page.tsx:394,482` (`bg-black`). Invisible on the wrong theme; these bypass the shadcn Switch. **Fix:** `bg-primary-foreground` or a `--toggle-indicator` token — or migrate to the shadcn Switch.

- [ ] **🟠 V-5 · Inline hardcoded hex in settings color preview** — `S`
  `components/settings-form.tsx:261,274,278` (`#5BA4CF`, `#F0963C` fallbacks). Diverges from brand tokens if they change. **Fix:** read `--brand`/`--brand-secondary` from CSS custom properties. *(Same root cause as V-9.)*

### Medium

- [ ] **🟡 V-6 · Placeholder text hardcoded `text-zinc-600`** — `M`
  auth pages, same lines as V-1. Contrast risk on light backgrounds. **Fix:** `placeholder:text-muted-foreground`.

- [ ] **🟡 V-7 · Opacity-on-white borders/backgrounds invisible in light mode** — `M`
  `app/login/page.tsx:172-322`, `app/register/page.tsx:101-147`, `app/setup/page.tsx:258,279+` (`border-white/10`, `bg-white/5`, `bg-white/[0.02]`). **Fix:** `border-border`, `bg-background/50`.

- [ ] **🟡 V-8 · Text below 12px on user-facing content** — `S`
  `app/login/page.tsx:353`, `app/setup/page.tsx:616`, `components/article-list.tsx:682` (`text-[10px]`). Version label + article timestamp. **Fix:** `text-xs`, or document the exception before the axe-playwright run.

- [ ] **🟡 V-9 · `theme-color-applier` hardcodes fallback hex** — `M`
  `components/theme-color-applier.tsx:41,51,52` (`#08111d`/`#f8fbff`, `#5ba4cf`, `#f0963c`). Will mismatch if brand tokens change. **Fix:** read from `:root` custom properties.

- [ ] **🟡 V-10 · Article feed-name badge low-contrast / no dark fallback** — `S`
  `components/article-list.tsx:660` (`bg-black/50 backdrop-blur-md`), `:668` (`bg-black/10 dark:bg-white/10`). **Fix:** `bg-secondary/30` / `bg-muted` or a semantic overlay token.

- [ ] **🟡 V-11 · Hardcoded colors in email HTML templates** — `M`
  `app/api/digest/unsubscribe/route.ts:41-45`, `app/api/internal/provision-user/route.ts:76-85` (`#f9fafb`, `#4b5563`, etc.). Light-mode-only, won't reflect per-instance brand. **Fix:** inline dynamic brand colors or a theme-aware inliner. *(Lower urgency — email dark mode is client-dependent.)*

- [ ] **🟡 V-12 · Sidebar active item lacks a strong visual indicator** — `S`
  `components/rss-sidebar.tsx` nav items use `bg-accent` only; when the accent is near the background the active state is faint. **Fix:** add `font-semibold` or a start-border indicator. *(Contrast-sensitive; pairs with the v1.2 accent-color work.)*

- [ ] **🟡 V-13 · `navigation-menu` link focus outline removed** — `S`
  `components/ui/navigation-menu.tsx:94`. Covered by V-2's fix; tracked separately because it's a modified shadcn primitive.

### Low

- [ ] **⚪ V-14 · Inconsistent border-radius scale** — `M`
  Codebase-wide mix of `rounded-lg/xl/2xl/3xl/[2rem]/[1.5rem]`. **Fix:** standardize (buttons/inputs `rounded-lg`, cards `rounded-xl`, large surfaces `rounded-2xl`) against the `--radius` scale.

- [ ] **⚪ V-15 · Inconsistent icon sizes in similar contexts** — `M`
  `app/setup/page.tsx:270+` (`w-5 h-5`), `app/login/page.tsx:175+` (`w-4 h-4`), `components/article-list.tsx:683` (`w-3 h-3`). **Fix:** a sizing scale (form `size-4`, headers `size-5`, badges `size-3`).

- [ ] **⚪ V-16 · No documented modal/dialog convention** — `L`
  Mix of `Dialog`, `AlertDialog`, and custom modals with divergent styling. **Fix:** document "all modals use `DialogContent` + `ui-surface`" in a design-system doc; consider a lint rule.

- [ ] **⚪ V-17 · Google OAuth icon hardcoded `#4285F4`** — `S` (informational)
  `components/icons/google-icon.tsx:14`. Intentional brand color — keep as-is, document as a brand exception and verify visibility in both themes.

---

## What is already solid (preserve these)

- **SSRF guard for feed fetching** (`lib/ssrf.ts`) blocks localhost/private/link-local for IPv4+IPv6, re-validates on every redirect hop (defeats DNS-rebind-via-redirect), and is consistently reused by feed fetch/discovery/preview. The gaps above are only in the newer webhook/notification code that didn't reuse it.
- **Stored-XSS handling**: DOMPurify at ingestion (`lib/rss-sync.ts`) and preview (`app/actions/feeds.ts:1667`); consistent HTML/XML escaping in digest emails and shared-search RSS output. No raw-SQL injection surface.
- **IDOR discipline**: nearly all server actions and the v1 API scope every read/write with `{ id, userId }`; admin actions uniformly call `checkAdmin()` with last-admin self-protection.
- **Auth/session hygiene**: login-attempt logging, `sessionVersion` invalidation on password/2FA change, proper TOTP window, `crypto.timingSafeEqual` for GReader tokens, strong token entropy.
- **Query patterns**: `getFeedHealth` and `getStats` batch with `groupBy`/`$transaction`; feed sync uses bounded concurrency; `Article` has good composite indexes for the common list filters; TanStack Query scopes invalidations narrowly and uses optimistic updates with rollback.
- **UX/visual foundation**: comprehensive toast error handling, loading skeletons, clear empty states, destructive-action confirmations, keyboard shortcuts, `prefers-reduced-motion`-gated animations, dedicated sidebar tokens, and correct semantic-token usage everywhere **except** the auth/onboarding pages.

---

*Generated from four parallel read-only audits (security, performance, UX, visuals) on 2026-07-15. Each finding was verified against source at the cited `file:line`. Update this file as items land; link the PR next to each checkbox.*
