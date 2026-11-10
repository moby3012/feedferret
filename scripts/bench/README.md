# Feed-everything live benchmark

This is an opt-in exploratory benchmark, **not a CI test**. It contacts 88 public
URLs and additional feed discovery paths. Run it manually from the repo root.
Use Node 22+, pnpm, and a disposable SQLite database with the current schema:

```sh
pnpm install --frozen-lockfile
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db pnpm run prisma:generate
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db pnpm run prisma:push
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db \
  pnpm dlx tsx@4.23.15 scripts/bench/feed-everything.mts --live \
  --output /tmp/feed-everything.results.json
```

`--only blogs-8` runs one case. `--timeout-ms 90000` sets the per-site process
budget (1–300 seconds). Output checkpoints after every site. Runtime can exceed
an hour on slow connections. Raw page bodies and connector keys are never logged.
CI environments are refused even with `--live`; no package script/test/CI job
invokes this tool. `tsx` is downloaded on demand, not added to app dependencies.

The runner executes one site at a time, waits 750 ms between sites, and caps
native fetch requests (including response reading) at three. App-owned headers,
redirect handling, response size limits, DNS checks, and SSRF protection stay in
place. Selector fetching uses the app's default impit transport, sequentially.
The benchmark does not introduce a crawler or bypass app policy. Currently these
entry points do not enforce robots.txt; this tool adds no robots bypass.

The worker strips connector environment configuration and trust overrides,
requires SQLite, and refuses an internal-fetch-enabled DB. **Use a fresh DB**:
existing DB connector configuration would still be read by the application.
RSSHub/render/BYOK services are intentionally absent in the baseline. Radar
matches are recorded as routes requiring RSSHub, not counted as successful feeds.
A missing render fallback is recorded as untested, not proof that rendering
would fix the page. Changedetection requires a configured service and two
snapshots; this runner does not create remote watches or use paid APIs.

## What the numbers mean

- Calls `discoverFeeds` from `lib/feed-discovery.ts`, the implementation behind
  authenticated `GET /api/discover`. Explicit feed URLs use `fetchFeedArticles`
  directly, as `addFeed` does. HTTP authentication and UI state are out of scope.
- Tries at most the first three candidates, then the actual
  `fetchAndSuggestFeedCandidates` implementation behind `suggestFeedFromUrl` /
  “Von Webseite”. Those are separate UI flows; this harness combines them to
  measure reachable coverage. JSON candidates use the fetcher's explicit
  `JSONFeed` mode, which is available in advanced feed configuration.
- `native-converter` is a deterministic platform-to-native-feed rule;
  `converter-RSSHub` requires a validated RSSHub route. `discovered` includes
  HTML-advertised and common-path feeds (the candidate's `source` distinguishes).
- A nonempty parse/selector preview is **technical extraction**, not proof of a
  useful feed. Review `sample`, `selected`, `selectorConfig`, and expected scope.
  Common-path feeds may be site-wide; issue URLs may resolve to releases;
  selectors may pick menus, duplicate links, or unrelated cards.
- Feed quality counts cover all parsed items. Selector quality covers only the
  returned preview (at most ten items), while `itemCount` is the full suggestion
  count. `parsedDates` measures valid normalized dates, not correct chronology.
  `images` counts presence, not reachability/absoluteness; `absoluteLinks` counts
  HTTP(S) item URLs. Long-term deduplication/refresh stability is not tested.
- `trace` records native transport statuses/errors only. impit selector requests
  are not in this trace; selector exceptions are retained in `errors`.
  Discovery itself swallows many failed probes, so an empty discovery result
  cannot reliably distinguish “no feed” from every upstream failure.
- The parent kills the worker at its deadline, terminating outstanding requests
  rather than letting Promise.race leave background crawls running. A timeout
  can discard partial work and is not evidence of permanent unsupported status.

Results are network-, region-, time-, deployment-, and URL-dependent. Use the
category expectations and manual semantic review alongside extraction rates.
Newsletter inbox ingestion is not implemented and is outside this public-URL run.
