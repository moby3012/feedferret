# Performance baseline — November 2026

Taken **before** the audit refactors (`.pm` audit PRs: payload `select`, URL navigation, bundle splitting, …) so every later PR can state a before/after number.
Produced by `scripts/perf-measure.mjs` (see [testing.md](../releases/testing.md#performance-baseline)) on commit `11822df` (`main` at the time), darwin/arm64, Node v22.23.4.

Profile: mid-range phone — Pixel 7 emulation (390×844, touch), CDP **4× CPU throttle**, **Slow 4G** (1.6 Mbps down / 750 Kbps up / 150 ms RTT), service workers blocked, **cold browser cache** per run, warm session (login is not measured). Production build (`next build` + `next start`), SQLite, seeded dataset: 8 feeds / 3 categories / 300 articles (some ~8 KB long articles, images, code blocks), 2 labels. 5 runs, median shown; run-to-run spread was < 3 % for LCP / first-row.

Commit `11822df` · darwin/arm64 · Node v22.23.4 · 5 cold runs, median · Pixel 7 (viewport 390x844, touch), 4x CPU, Slow 4G (1.6 Mbps / 150 ms RTT) · seeded: 300 articles / 8 feeds

| Metric | Median | Budget (audit §4.1) |
|---|---:|---|
| LCP | 5392 ms | ≤ 2500 ms |
| FCP | 3756 ms | |
| CLS | 0.000 | ≤ 0.05 |
| TBT (long tasks, cold load) | 84 ms (3 tasks) | ≤ 300 ms |
| Time to first article row | 5306 ms | ≤ 2000 ms |
| Requests at cold start | 41 (6 Next-Action POSTs, 3 /api) | ≤ 4 parallel data requests |
| Transferred at cold start | 814 KB (JS 417 KB) | |
| INP-proxy: open article (tap) | 64 ms | ≤ 200 ms |
| Tap → reader title painted | 499 ms | ≤ 100 ms (P1-09) |
| INP-proxy: mark read (tap) | 56 ms | ≤ 200 ms |
| INP-proxy: star (tap) | 56 ms | ≤ 200 ms |
| First-load JS `/` (gz), route entry | 266.8 KB (849 KB raw, 14 chunks) | ≤ 180 KB |
| First-load JS `/` (gz), incl. runtime | 435.2 KB (1392.9 KB raw, 21 chunks) | |

INP-proxy = longest Event Timing entry with an interactionId during the action (input → next paint, 8 ms granularity); "n/a" means the interaction stayed under the 16 ms reporting threshold.

## Reading the numbers

- Lab numbers on one Apple-silicon laptop under CDP throttling. **Compare runs from the same machine / runner type only**; use these as the order-of-magnitude "before" for the audit budgets, not as an absolute truth. The GitHub Actions `Perf baseline` workflow (manual) will produce its own, different-but-comparable numbers.
- First-load JS for `/` (266.8 KB gz, 14 chunks) is the same method and value as `.pm/audit-perf.md` §2.2 (267 KB), so the bundle number is directly comparable with the audit.
- The cold start issues **41 requests** (of which 6 Next-Action POSTs and 3 `/api/*` calls) and the first article row only appears after the data round-trips (≈5.3 s here) — i.e. LCP ≈ time-to-first-row; the list is client-rendered after the data fetch (audit D2/C1).
- Interaction latencies (INP-proxy) are already low (< 100 ms): the audit's INP estimate (300–800 ms) is not reproduced with a 300-article seed; revisit with the 50k-article perf seed from audit §4.2 step 1 (not part of this harness).
- Tap → reader title painted ≈ 499 ms is the number P1-09 targets (≤ 100 ms).

Re-run: `pnpm run build && pnpm run perf:measure -- --runs 5 --label baseline-2026-11`.
