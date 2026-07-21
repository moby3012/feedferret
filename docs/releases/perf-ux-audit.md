# FeedFerret — Performance & UX Audit (planned)

> **Status: ⬜ planned — not started.** A dedicated, measurement-first initiative to make the app **snappier, faster, and more pleasant** to use. This is the next major quality release after the Feed-Intelligence core and the full REST/MCP surface shipped.
>
> **Guiding principle:** measure first, set budgets, then fix the biggest offenders — no speculative rewrites. Every change ships as its own PR with a before/after number attached.

Effort scale: **S** < 1 day · **M** 1–3 days · **L** 1–2 weeks.

---

## 0. Baseline & instrumentation *(do this first — everything else is judged against it)*

| # | Task | Effort |
|---|---|---|
| P0-1 | **Establish Web-Vitals baselines** (LCP, INP, CLS, TTFB) on the three hot paths — cold app load, open-article, feed-switch — on a mid-tier phone profile (throttled CPU 4×, Fast-3G) and desktop. Record numbers in this doc. | S |
| P0-2 | **Bundle analysis** — add `@next/bundle-analyzer` (dev-only), capture the current client-bundle treemap, list the top 10 heaviest client modules and which routes pull them. | S |
| P0-3 | **Server timing baseline** — log query counts + durations for the article list, feed list, and sync path (dev-only middleware). Identify N+1s and slow queries. | S |
| P0-4 | **Set budgets** — agree target numbers (e.g. INP < 200 ms, LCP < 2.5 s on the phone profile, first-load JS per route under an agreed KB budget) and wire a soft CI check that flags regressions. | S |

**Acceptance:** a short "Baselines" table at the bottom of this doc filled in with real numbers, plus a bundle treemap committed to `docs/archive/` for reference.

---

## 1. Perceived speed / snappiness *(highest user-visible impact)*

| # | Task | Effort |
|---|---|---|
| PS-1 | **Optimistic UI for state changes** — read/unread, star, read-later, label should update instantly and reconcile in the background (audit every mutation for a round-trip wait; adopt TanStack Query optimistic updates uniformly). | M |
| PS-2 | **Instant article open** — the reader should paint immediately from already-loaded list data, then hydrate full content; no blank frame while the article fetch resolves. | M |
| PS-3 | **Prefetch on intent** — prefetch the next/adjacent article and hovered feeds so navigation feels instant (`j`/`k`, swipe, hover). | S–M |
| PS-4 | **Preserve scroll & state** across navigation (list ⟷ reader ⟷ back) so returning never re-scrolls or re-fetches unnecessarily. | M |
| PS-5 | **Consistent skeletons / loading states** — replace spinners and layout jumps with content-shaped skeletons on the list, reader, and settings; eliminate "flash of empty state." | M |

**Acceptance:** read/star/label feel instant (no visible round-trip); opening and going back between articles never shows a blank frame or loses scroll position.

---

## 2. Client performance / bundle *(faster cold load, less main-thread work)*

| # | Task | Effort |
|---|---|---|
| CP-1 | **Code-split heavy client islands** — command palette (`cmdk`), feed-edit dialog, charts/stats, syntax highlighter, KaTeX, the Scout-Studio/add-feed advanced panels: dynamic-import so they're not in the initial bundle. | M |
| CP-2 | **Trim/replace heavy deps** identified in P0-2 (e.g. large date/markdown/icon imports → per-icon imports, lighter alternatives) without regressing features. | M |
| CP-3 | **RSC boundary audit** — push work to Server Components where a component doesn't need interactivity; shrink the `"use client"` surface. | M |
| CP-4 | **Reduce re-renders** — split oversized contexts, memoize hot list rows, stabilize callbacks; verify with the React Profiler that list scroll and typing in search don't re-render the world. | M |
| CP-5 | **Font loading** — ensure `next/font` with `display: swap`/subsetting; no layout shift or blocking on webfonts. | S |
| CP-6 | **Route-level streaming/Suspense** — stream the shell and let slow data (stats, counts) fill in, rather than blocking the first paint. | M |

**Acceptance:** first-load JS per route is under the P0-4 budget; the initial bundle no longer contains the heavy islands; INP on the article list improves against baseline.

---

## 3. Server / data performance

| # | Task | Effort |
|---|---|---|
| SP-1 | **Query audit** — kill N+1s from P0-3; add missing indexes (article list filters/sorts, unread counts, dedupe key, label joins) for both SQLite and Postgres; confirm `EXPLAIN`/query plans. | M |
| SP-2 | **Unread/label count caching** — the sidebar count queries run often; cache/aggregate them so they don't re-scan on every navigation. | M |
| SP-3 | **Payload trimming** — the article-list API/action should `select` only the fields the list needs (no full `content` in list responses); paginate/virtualize consistently. | S–M |
| SP-4 | **Sync-path profiling** — confirm the batched sync (already `createManyAndReturn`) has no per-article surprises at scale; parallelism caps sane; conditional GET honored. | M |

**Acceptance:** article-list and sidebar-count queries hit the P0-4 server budget; no N+1 remains on the hot paths.

---

## 4. UX polish / pleasantness *(the "angenehmer" part)*

| # | Task | Effort |
|---|---|---|
| UX-1 | **Animation/transition pass** — audit durations/easings for jank; respect `prefers-reduced-motion` everywhere; ensure 60 fps on list scroll and reader open on a mid phone. | M |
| UX-2 | **Empty / error / loading states** — every list, panel and settings tab gets a considered empty state and a recoverable error state (retry), not a dead end. | M |
| UX-3 | **Mobile gesture responsiveness** — swipe/tap latency, hit-target sizes, safe-area, one-handed reach re-checked on a real phone profile (ties into the deferred gesture-system rework in v1.2). | M |
| UX-4 | **Keyboard/focus completeness** — every primary flow reachable and visible-focus correct; the command palette covers the real top actions. | S–M |
| UX-5 | **Micro-feedback** — toasts/haptics/subtle affordances on the actions that currently feel silent (mark-all-read, send-to, sync started/finished). | S |

**Acceptance:** a second pass of the reduced-motion + mid-phone smoke test shows no jank; no flow ends in a dead-end empty/error state.

---

## 5. Measurement close-out

| # | Task | Effort |
|---|---|---|
| MC-1 | **Re-run P0 baselines**, fill an after column, and write a short results summary (what moved, by how much). Archive this doc once the numbers are in. | S |

---

## Baselines (fill in during P0)

| Metric | Path | Baseline (before) | Target | After |
|---|---|---|---|---|
| LCP | cold load | — | < 2.5 s (phone) | — |
| INP | article list | — | < 200 ms | — |
| CLS | cold load | — | < 0.1 | — |
| First-load JS | / (home) | — | budget TBD (P0-4) | — |
| Article-list query | server | — | budget TBD (P0-4) | — |

---

## Notes / relationship to other docs

- The **gesture & animation system consolidation** (finger-synced swipe, swipe-down-marks-all-read, desktop drag-nav) is tracked in the v1.2 Theming/Layout release ([`v1.2-theming.md`](v1.2-theming.md)) and `deferred.md`; UX-1/UX-3 here coordinate with it rather than duplicate it.
- **List virtualization** already shipped for the article list — SP-3/PS-4 build on it, and CP/PS extend the same idea to other long lists (sidebar, management screens) where measured worthwhile.
- Security/testing/ops hardening continues under [`maintenance.md`](maintenance.md) and [`testing.md`](testing.md) in parallel — the Playwright E2E suite there also gives us regression cover for the UX flows touched here.
